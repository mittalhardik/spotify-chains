import type { QueueItem, Snapshot, Transition } from './types';

/** Slack for poll timing jitter when deciding whether a song could have finished. */
export const TOL_MS = 5_000;
/** Max delay between one song ending and the next starting that still counts as "kept flowing". */
export const IDLE_TOL_MS = 30_000;
/** A poll gap longer than this means the poller was down and we can't judge. */
export const OUTAGE_MS = 5 * 60_000;
/** More queue positions than this skipped within one poll is treated as a jump (manual pick). */
export const MAX_SKIPS_PER_POLL = 3;
/** A song interrupted by a manual pick is excluded if less than this fraction was heard. */
export const MIN_HEARD_FRACTION = 0.5;

const QUEUE_KEEP = 20;

/* eslint-disable @typescript-eslint/no-explicit-any */
function itemId(item: any): string {
  return item.id ?? item.uri;
}

function itemArtists(item: any): string {
  return item.type === 'episode' ? item.show?.name ?? '' : (item.artists ?? []).map((a: any) => a.name).join(', ');
}

/** Build a snapshot from GET /me/player and GET /me/player/queue responses. */
export function toSnapshot(player: any, queue: any, ts: number): Snapshot | null {
  const item = player?.item;
  if (!item) return null;
  const isEpisode = item.type === 'episode';
  return {
    ts,
    trackId: itemId(item),
    trackUri: item.uri,
    itemType: isEpisode ? 'episode' : 'track',
    isLocal: Boolean(item.is_local),
    name: item.name ?? '',
    artists: itemArtists(item),
    durationMs: item.duration_ms ?? 0,
    progressMs: player.progress_ms ?? 0,
    isPlaying: Boolean(player.is_playing),
    contextUri: player.context?.uri ?? null,
    contextType: player.context?.type ?? null,
    shuffle: Boolean(player.shuffle_state),
    repeat: player.repeat_state ?? 'off',
    device: player.device?.name ?? null,
    queue: ((queue?.queue ?? []) as any[])
      .filter(Boolean)
      .slice(0, QUEUE_KEEP)
      .map(
        (q): QueueItem => ({
          id: itemId(q),
          uri: q.uri,
          durationMs: q.duration_ms ?? 0,
          name: q.name ?? '',
          artists: itemArtists(q),
          itemType: q.type === 'episode' ? 'episode' : 'track',
        }),
      ),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Did `prev` reach its end on its own before `now` started?
 * `betweenMs` is the length of queue songs that played in between.
 * Returns null when it can't be known (prev was paused at the last poll).
 */
function endedNaturally(prev: Snapshot, now: Snapshot, betweenMs: number): boolean | null {
  if (!prev.isPlaying) return null;
  const elapsed = now.ts - prev.ts;
  const remaining = Math.max(0, prev.durationMs - prev.progressMs);
  if (elapsed + TOL_MS < remaining + betweenMs) return false;
  // If the new song is further along than it could be had it started at prev's
  // natural end, it started early, so prev was cut short.
  const expected = elapsed - remaining - betweenMs;
  if (now.isPlaying && now.progressMs > expected + 2 * TOL_MS) return false;
  return true;
}

/** Rough fraction of `prev` that was heard before something else started. */
function heardFraction(prev: Snapshot, now: Snapshot): number {
  if (prev.durationMs <= 0) return 1;
  const elapsed = now.ts - prev.ts;
  const extra = prev.isPlaying ? Math.max(0, elapsed - now.progressMs) : 0;
  return Math.min(1, (prev.progressMs + extra) / prev.durationMs);
}

/**
 * Decide how the song changed between two polls. Pure, so it is fully unit-tested.
 *
 * Only a manual pick ends a chain: Next/Back, autoplay, pauses and device
 * switches all keep it going.
 */
export function classifyTransition(
  prev: Snapshot,
  now: Snapshot,
  ctx: { pollGapMs: number; trackBeforePrev: string | null },
): Transition {
  const elapsed = now.ts - prev.ts;
  const remaining = Math.max(0, prev.durationMs - prev.progressMs);
  const idx = prev.queue.findIndex((q) => q.id === now.trackId);
  const evidence: Record<string, unknown> = {
    elapsedMs: elapsed,
    prevRemainingMs: remaining,
    prevPlaying: prev.isPlaying,
    nowProgressMs: now.progressMs,
    queueIndex: idx,
    contextChanged: prev.contextUri !== now.contextUri,
    pollGapMs: ctx.pollGapMs,
  };
  const keep = (kind: Transition['kind'], prevSkipped: boolean, extra: Partial<Transition> = {}): Transition => ({
    kind,
    chainBreak: false,
    prevSkipped,
    intermediate: [],
    evidence,
    ...extra,
  });

  const natural = endedNaturally(prev, now, 0);
  evidence.prevEndedNaturally = natural;
  const manualPick = (): Transition => {
    const heard = heardFraction(prev, now);
    evidence.prevHeardFraction = Number(heard.toFixed(2));
    return { ...keep('manual_pick', natural !== true && heard < MIN_HEARD_FRACTION), chainBreak: true };
  };

  // Next song in the queue: played through or Next pressed.
  if (idx === 0) {
    return natural === false ? keep('skip_next', true) : keep('auto_next', false);
  }

  // Further down the queue: several songs played inside one poll, a few quick
  // Next presses, or a jump straight to a later song.
  if (idx > 0) {
    const between = prev.queue.slice(0, idx);
    const betweenMs = between.reduce((s, q) => s + q.durationMs, 0);
    if (endedNaturally(prev, now, betweenMs) === true) {
      return keep('auto_next', false, { intermediate: between.map((q) => ({ ...q, skipped: false })) });
    }
    // Ended on its own but the queue order didn't match (Spotify's queue can be off under shuffle).
    if (natural === true) return keep('auto_next', false, { evidence: { ...evidence, queueOrderMismatch: true } });
    if (idx <= MAX_SKIPS_PER_POLL) {
      return keep('skip_next', natural === false, { intermediate: between.map((q) => ({ ...q, skipped: true })) });
    }
    return manualPick();
  }

  // Not in the queue.
  if (ctx.trackBeforePrev && now.trackId === ctx.trackBeforePrev) {
    return keep('back', natural === false);
  }
  if (ctx.pollGapMs > OUTAGE_MS) {
    return keep('uncertain', false);
  }
  if (natural === true) {
    // Nobody interrupted the previous song, and the new one began right as it ended:
    // autoplay/radio took over (or the queue listing was stale).
    const gap = elapsed - remaining - now.progressMs;
    evidence.startGapMs = gap;
    if (!now.isPlaying || gap <= IDLE_TOL_MS) {
      return keep(evidence.contextChanged || !now.contextUri ? 'autoplay' : 'auto_next', false);
    }
  }
  return manualPick();
}

/** Is the current snapshot the same song continuing (incl. paused/resumed/seeked)? */
export function sameSong(prev: Snapshot, now: Snapshot): boolean {
  return prev.trackId === now.trackId;
}
