import { describe, expect, it } from 'vitest';
import { flattenRecent, reconcile, type RecentPlay } from '../src/reconcile';
import { play } from './fixtures';

const S = 1000;
const recent = (trackId: string, playedAt: number, durationMs = 200 * S): RecentPlay => ({
  playedAt,
  trackId,
  trackUri: `spotify:track:${trackId}`,
  name: trackId,
  artists: 'Artist',
  durationMs,
  isLocal: false,
  contextUri: null,
  contextType: null,
});

describe('reconcile', () => {
  it('matches recently-played entries to the plays the poller saw', () => {
    const a = play({ track_id: 'A', started_at: 0, chain_id: 1 });
    const b = play({ track_id: 'B', started_at: 200 * S, chain_id: 1 });
    const r = reconcile([recent('A', 200 * S), recent('B', 400 * S)], [a, b], 1);
    expect(r.matches).toEqual([
      { playId: a.id, playedAt: 200 * S },
      { playId: b.id, playedAt: 400 * S },
    ]);
    expect(r.inserts).toEqual([]);
  });

  it('backfills a short song the poller never saw into the chain running at the time', () => {
    const a = play({ track_id: 'A', started_at: 0, chain_id: 7 });
    const c = play({ track_id: 'C', started_at: 245 * S, chain_id: 7 });
    // B (40 s) played entirely between two polls.
    const r = reconcile([recent('A', 200 * S), recent('B', 240 * S, 40 * S), recent('C', 445 * S)], [a, c], 9);
    expect(r.inserts).toHaveLength(1);
    expect(r.inserts[0]).toMatchObject({ trackId: 'B', chainId: 7, startedAt: 200 * S });
  });

  it('matches a song that was paused for hours before it finished', () => {
    const a = play({ track_id: 'A', started_at: 0 });
    const r = reconcile([recent('A', 5 * 3600 * S)], [a], 1);
    expect(r.matches).toEqual([{ playId: a.id, playedAt: 5 * 3600 * S }]);
  });

  it('does not reuse one play for two recently-played entries (repeat-one)', () => {
    const a = play({ track_id: 'A', started_at: 0, chain_id: 3 });
    const r = reconcile([recent('A', 200 * S), recent('A', 400 * S)], [a], 3);
    expect(r.matches).toHaveLength(1);
    expect(r.inserts).toHaveLength(1);
  });

  it('ignores entries already reconciled', () => {
    const a = play({ track_id: 'A', started_at: 0, played_at: 200 * S });
    expect(reconcile([recent('A', 200 * S)], [a], 1)).toEqual({ matches: [], inserts: [] });
  });

  it('after a long outage, songs land in the current chain', () => {
    const r = reconcile([recent('Z', 10_000 * S)], [], 4);
    expect(r.inserts[0]).toMatchObject({ trackId: 'Z', chainId: 4 });
  });

  it('drops songs when there is no chain yet', () => {
    expect(reconcile([recent('Z', 10_000 * S)], [], null).inserts).toEqual([]);
  });
});

describe('flattenRecent', () => {
  it('sorts oldest first and parses timestamps', () => {
    const items = [
      { played_at: '2026-10-06T10:05:00.000Z', track: { id: 'b', uri: 'spotify:track:b', name: 'B', duration_ms: 1, artists: [{ name: 'X' }] }, context: null },
      { played_at: '2026-10-06T10:00:00.000Z', track: { id: 'a', uri: 'spotify:track:a', name: 'A', duration_ms: 1, artists: [] }, context: { uri: 'spotify:album:q', type: 'album' } },
    ];
    const out = flattenRecent(items);
    expect(out.map((r) => r.trackId)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({ contextType: 'album', playedAt: Date.parse('2026-10-06T10:00:00.000Z') });
  });
});
