import { describe, expect, it } from 'vitest';
import { planAppend, playsFrom, seedFromSnapshot, summarizeChain } from '../src/chains';
import { play } from './fixtures';
import type { PlayRow } from '../src/types';

const opts = { minSongs: 8, copyThreshold: 0.8 };
const MIN = 60_000;
const DAY = 86_400_000;

function songs(n: number, over: Partial<PlayRow> = {}, offset = 0) {
  return Array.from({ length: n }, (_, i) => play({ track_id: `t${offset + i}`, started_at: (offset + i) * 4 * MIN, ...over }));
}

describe('seedFromSnapshot', () => {
  it('uses the context you picked from', () => {
    expect(seedFromSnapshot({ contextUri: 'spotify:album:a', contextType: 'album', trackUri: 'spotify:track:t', name: 'Song' })).toEqual({
      type: 'album',
      uri: 'spotify:album:a',
      name: 'Song',
    });
  });
  it('names Liked Songs', () => {
    expect(seedFromSnapshot({ contextUri: 'spotify:user:me:collection', contextType: 'collection', trackUri: 'x', name: 'Song' }).name).toBe('Liked Songs');
  });
  it('falls back to the song itself', () => {
    expect(seedFromSnapshot({ contextUri: null, contextType: null, trackUri: 'spotify:track:t', name: 'Song' })).toEqual({
      type: 'track',
      uri: 'spotify:track:t',
      name: 'Song',
    });
  });
});

describe('summarizeChain', () => {
  const albumSeed = { seed_type: 'album', seed_uri: 'spotify:album:L' };

  it('is too short below the minimum number of kept songs', () => {
    const s = summarizeChain({ seed_type: 'track', seed_uri: 'x' }, songs(7), opts);
    expect(s).toMatchObject({ keptUnique: 7, eligible: false, reason: 'too_short' });
  });

  it('a straight play-through of an album is a copy', () => {
    const s = summarizeChain(albumSeed, songs(12, { context_uri: 'spotify:album:L' }), opts);
    expect(s).toMatchObject({ copyRatio: 1, eligible: false, reason: 'copy' });
  });

  it('becomes eligible once autoplay carries on past the album', () => {
    const plays = [...songs(10, { context_uri: 'spotify:album:L' }), ...songs(4, { context_uri: null, kind: 'autoplay' }, 10)];
    const s = summarizeChain(albumSeed, plays, opts);
    expect(s.copyRatio).toBeCloseTo(10 / 14);
    expect(s).toMatchObject({ eligible: true, reason: 'ok' });
  });

  it('a chain seeded by a single song is never a copy', () => {
    const s = summarizeChain({ seed_type: 'track', seed_uri: 'spotify:track:t0' }, songs(9, { context_uri: null }), opts);
    expect(s).toMatchObject({ copyRatio: 0, eligible: true });
  });

  it('skipped songs, duplicates, episodes and local files do not count', () => {
    const plays = [
      ...songs(8),
      play({ track_id: 't0', started_at: 100 * MIN }), // repeat of t0
      play({ track_id: 'skip', started_at: 101 * MIN, skipped: 1 }),
      play({ track_id: 'ep', started_at: 102 * MIN, item_type: 'episode' }),
      play({ track_id: 'loc', started_at: 103 * MIN, is_local: 1 }),
    ];
    const s = summarizeChain({ seed_type: 'track', seed_uri: 'x' }, plays, opts);
    expect(s).toMatchObject({ songs: 12, keptUnique: 8, skips: 1 });
  });

  it('a chain paused overnight is still one chain spanning both days', () => {
    const plays = [...songs(5), ...songs(5, {}, 5).map((p) => ({ ...p, started_at: p.started_at + DAY }))];
    const s = summarizeChain({ seed_type: 'track', seed_uri: 'x' }, plays, opts);
    expect(s.keptUnique).toBe(10);
    expect(s.lastAt! - s.firstAt!).toBeGreaterThan(DAY);
  });
});

describe('planAppend', () => {
  it('holds back the song still playing', () => {
    const plays = songs(3);
    expect(planAppend(plays, plays[2].id).uris).toEqual(['spotify:track:t0', 'spotify:track:t1']);
    expect(planAppend(plays, null).uris).toHaveLength(3);
  });

  it('holds back by id, not by start time (start times are estimates)', () => {
    const plays = songs(3);
    const current = { ...plays[1], started_at: -1 };
    expect(planAppend([plays[0], current, plays[2]], current.id).uris).toEqual(['spotify:track:t0', 'spotify:track:t2']);
  });

  it('skips duplicates and songs already in the playlist, but marks everything settled', () => {
    const plays = [
      play({ track_id: 'a', started_at: 1, added: 1 }),
      play({ track_id: 'a', started_at: 2 }),
      play({ track_id: 'b', started_at: 3, skipped: 1 }),
      play({ track_id: 'c', started_at: 4 }),
      play({ track_id: 'c', started_at: 5 }),
    ];
    const plan = planAppend(plays, null);
    expect(plan.uris).toEqual(['spotify:track:c']);
    expect(plan.settledIds).toEqual(plays.slice(1).map((p) => p.id));
  });

  it('re-running after marking adds nothing (idempotent)', () => {
    const plays = songs(4);
    const first = planAppend(plays, null);
    const marked = plays.map((p) => (first.settledIds.includes(p.id) ? { ...p, added: 1 } : p));
    expect(planAppend(marked, null)).toEqual({ uris: [], settledIds: [] });
  });
});

describe('playsFrom', () => {
  it('returns the split song and everything after it', () => {
    const plays = songs(5);
    expect(playsFrom(plays, plays[2]).map((p) => p.track_id)).toEqual(['t2', 't3', 't4']);
  });
});
