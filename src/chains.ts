import type { ChainRow, PlayRow, Snapshot } from './types';

/** Seed contexts that are an existing collection you already own, so a straight copy is pointless. */
const COPYABLE_SEEDS = new Set(['playlist', 'album', 'collection']);

export interface Seed {
  type: string;
  uri: string;
  /** Fallback name; the poller replaces it with the playlist/album name when it can. */
  name: string;
}

/** A new chain's seed is the context you picked from, or the song itself. */
export function seedFromSnapshot(s: Pick<Snapshot, 'contextUri' | 'contextType' | 'trackUri' | 'name'>): Seed {
  if (s.contextUri && s.contextType) {
    const name = s.contextType === 'collection' ? 'Liked Songs' : s.name;
    return { type: s.contextType, uri: s.contextUri, name };
  }
  return { type: 'track', uri: s.trackUri, name: s.name };
}

/** Songs that may go into a playlist: heard (not skipped), real tracks, not local files. */
export function isKeepable(p: Pick<PlayRow, 'skipped' | 'item_type' | 'is_local'>): boolean {
  return !p.skipped && p.item_type === 'track' && !p.is_local;
}

function uniqueByUri<T extends { track_uri: string }>(plays: T[]): T[] {
  const seen = new Set<string>();
  return plays.filter((p) => (seen.has(p.track_uri) ? false : (seen.add(p.track_uri), true)));
}

export interface ChainSummary {
  songs: number;
  keptUnique: number;
  skips: number;
  listenMs: number;
  copyRatio: number;
  eligible: boolean;
  reason: 'ok' | 'too_short' | 'copy';
  firstAt: number | null;
  lastAt: number | null;
}

export function summarizeChain(
  chain: Pick<ChainRow, 'seed_type' | 'seed_uri'>,
  plays: PlayRow[],
  opts: { minSongs: number; copyThreshold: number },
): ChainSummary {
  const sorted = [...plays].sort(byStart);
  const kept = uniqueByUri(sorted.filter(isKeepable));
  const copyCount = COPYABLE_SEEDS.has(chain.seed_type)
    ? kept.filter((p) => p.context_uri === chain.seed_uri).length
    : 0;
  const copyRatio = kept.length ? copyCount / kept.length : 0;
  const reason = kept.length < opts.minSongs ? 'too_short' : copyRatio >= opts.copyThreshold ? 'copy' : 'ok';
  return {
    songs: sorted.length,
    keptUnique: kept.length,
    skips: sorted.filter((p) => p.skipped).length,
    listenMs: kept.reduce((s, p) => s + p.duration_ms, 0),
    copyRatio,
    eligible: reason === 'ok',
    reason,
    firstAt: sorted[0]?.started_at ?? null,
    lastAt: sorted.at(-1)?.started_at ?? null,
  };
}

export function byStart(a: Pick<PlayRow, 'started_at' | 'id'>, b: Pick<PlayRow, 'started_at' | 'id'>): number {
  return a.started_at - b.started_at || a.id - b.id;
}

/**
 * Which plays to push to the chain's playlist now.
 * `holdBackId` is the song playing right now: it may yet be skipped, so it waits.
 * Returns the URIs to add (deduped against what's already in the playlist) and
 * every play id that is now settled and should be marked as processed.
 */
export function planAppend(plays: PlayRow[], holdBackId: number | null): { uris: string[]; settledIds: number[] } {
  const sorted = [...plays].sort(byStart);
  const settled = sorted.filter((p) => p.id !== holdBackId);
  const present = new Set(sorted.filter((p) => p.added && isKeepable(p)).map((p) => p.track_uri));
  const uris: string[] = [];
  const settledIds: number[] = [];
  for (const p of settled) {
    if (p.added) continue;
    settledIds.push(p.id);
    if (isKeepable(p) && !present.has(p.track_uri)) {
      present.add(p.track_uri);
      uris.push(p.track_uri);
    }
  }
  return { uris, settledIds };
}

/** Plays from `fromPlay` onward, used by split / break. */
export function playsFrom(plays: PlayRow[], fromPlay: Pick<PlayRow, 'started_at' | 'id'>): PlayRow[] {
  return plays.filter((p) => byStart(p, fromPlay) >= 0);
}
