import type { PlayRow } from './types';
import { byStart } from './chains';

/** A recently-played entry, flattened. `playedAt` is roughly when the song stopped playing. */
export interface RecentPlay {
  playedAt: number;
  trackId: string;
  trackUri: string;
  name: string;
  artists: string;
  durationMs: number;
  isLocal: boolean;
  contextUri: string | null;
  contextType: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function flattenRecent(items: any[]): RecentPlay[] {
  return items
    .filter((it) => it?.track)
    .map((it) => ({
      playedAt: Date.parse(it.played_at),
      trackId: it.track.id ?? it.track.uri,
      trackUri: it.track.uri,
      name: it.track.name ?? '',
      artists: (it.track.artists ?? []).map((a: any) => a.name).join(', '),
      durationMs: it.track.duration_ms ?? 0,
      isLocal: Boolean(it.track.is_local),
      contextUri: it.context?.uri ?? null,
      contextType: it.context?.type ?? null,
    }))
    .sort((a, b) => a.playedAt - b.playedAt);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const EARLY_SLACK_MS = 2 * 60_000;
const LATE_SLACK_MS = 3 * 60_000;

export interface ReconcileResult {
  matches: Array<{ playId: number; playedAt: number }>;
  inserts: Array<RecentPlay & { startedAt: number; chainId: number }>;
}

/**
 * Line up recently-played (what Spotify says actually played) with the plays the poller recorded.
 * - Matched plays get their `played_at` filled in.
 * - Songs the poller never saw (played and stopped within one minute) are added to the chain
 *   that was running at that time, labelled `backfill`.
 */
export function reconcile(recent: RecentPlay[], plays: PlayRow[], fallbackChainId: number | null): ReconcileResult {
  const sorted = [...plays].sort(byStart);
  const known = new Set(sorted.map((p) => p.played_at).filter((x): x is number => x != null));
  const used = new Set<number>();
  const result: ReconcileResult = { matches: [], inserts: [] };

  // A song can be paused mid-way, so it may finish long after started_at + duration:
  // allow a match any time before the following play started.
  const nextStart = new Map<number, number>();
  sorted.forEach((p, i) => nextStart.set(p.id, sorted[i + 1]?.started_at ?? Infinity));

  for (const r of recent) {
    if (known.has(r.playedAt)) continue;
    let best: PlayRow | null = null;
    let bestDist = Infinity;
    for (const p of sorted) {
      if (p.played_at != null || used.has(p.id) || p.track_id !== r.trackId) continue;
      const lo = p.started_at - EARLY_SLACK_MS;
      const hi = Math.max(p.started_at + p.duration_ms, nextStart.get(p.id)!) + LATE_SLACK_MS;
      if (r.playedAt < lo || r.playedAt > hi) continue;
      const dist = Math.abs(r.playedAt - (p.started_at + p.duration_ms));
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    if (best) {
      used.add(best.id);
      result.matches.push({ playId: best.id, playedAt: r.playedAt });
      continue;
    }
    // Unseen by the poller: attach to whichever chain was running when it started.
    const startedAt = r.playedAt - r.durationMs;
    const before = sorted.filter((p) => p.started_at <= startedAt).at(-1);
    const chainId = before?.chain_id ?? fallbackChainId;
    if (chainId == null) continue;
    result.inserts.push({ ...r, startedAt, chainId });
  }
  return result;
}
