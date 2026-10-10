import { describe, expect, it } from 'vitest';
import { classifyTransition, toSnapshot, OUTAGE_MS } from '../src/poller';
import type { QueueItem, Snapshot } from '../src/types';

const S = 1000;
const q = (id: string, durationMs = 200 * S): QueueItem => ({ id, uri: `spotify:track:${id}`, durationMs, name: id, artists: 'X', itemType: 'track' });

function snap(over: Partial<Snapshot> & Pick<Snapshot, 'trackId'>): Snapshot {
  return {
    ts: 0,
    trackUri: `spotify:track:${over.trackId}`,
    itemType: 'track',
    isLocal: false,
    name: over.trackId,
    artists: 'X',
    durationMs: 200 * S,
    progressMs: 0,
    isPlaying: true,
    contextUri: 'spotify:playlist:P',
    contextType: 'playlist',
    shuffle: false,
    repeat: 'off',
    device: 'iPhone',
    queue: [],
    ...over,
  };
}

const ctx = { pollGapMs: 60 * S, trackBeforePrev: null };

describe('classifyTransition', () => {
  it('next queued song after the previous one finished: auto_next, chain continues', () => {
    const prev = snap({ trackId: 'A', progressMs: 180 * S, queue: [q('B'), q('C')] });
    const now = snap({ trackId: 'B', ts: 60 * S, progressMs: 40 * S });
    const t = classifyTransition(prev, now, ctx);
    expect(t).toMatchObject({ kind: 'auto_next', chainBreak: false, prevSkipped: false });
  });

  it('next queued song while the previous was cut short: skip_next, previous excluded, chain continues', () => {
    const prev = snap({ trackId: 'A', progressMs: 30 * S, queue: [q('B')] });
    const now = snap({ trackId: 'B', ts: 60 * S, progressMs: 20 * S });
    const t = classifyTransition(prev, now, ctx);
    expect(t).toMatchObject({ kind: 'skip_next', chainBreak: false, prevSkipped: true });
  });

  it('several short songs played inside one poll: auto_next with the in-between songs kept', () => {
    const prev = snap({ trackId: 'A', progressMs: 190 * S, queue: [q('B', 30 * S), q('C')] });
    const now = snap({ trackId: 'C', ts: 60 * S, progressMs: 15 * S });
    const t = classifyTransition(prev, now, ctx);
    expect(t.kind).toBe('auto_next');
    expect(t.chainBreak).toBe(false);
    expect(t.intermediate.map((i) => [i.id, i.skipped])).toEqual([['B', false]]);
  });

  it('a few quick Next presses: skip_next, skipped songs marked, chain continues', () => {
    const prev = snap({ trackId: 'A', progressMs: 30 * S, queue: [q('B'), q('C'), q('D')] });
    const now = snap({ trackId: 'D', ts: 60 * S, progressMs: 10 * S });
    const t = classifyTransition(prev, now, ctx);
    expect(t).toMatchObject({ kind: 'skip_next', chainBreak: false, prevSkipped: true });
    expect(t.intermediate.map((i) => [i.id, i.skipped])).toEqual([
      ['B', true],
      ['C', true],
    ]);
  });

  it('jumping far down the queue is a manual pick', () => {
    const prev = snap({ trackId: 'A', progressMs: 30 * S, queue: ['B', 'C', 'D', 'E', 'F', 'G'].map((x) => q(x)) });
    const now = snap({ trackId: 'G', ts: 60 * S, progressMs: 10 * S });
    expect(classifyTransition(prev, now, ctx)).toMatchObject({ kind: 'manual_pick', chainBreak: true });
  });

  it('song ended naturally but queue order was off (shuffle): still auto_next', () => {
    const prev = snap({ trackId: 'A', progressMs: 190 * S, shuffle: true, queue: ['B', 'C', 'D', 'E', 'F'].map((x) => q(x)) });
    const now = snap({ trackId: 'F', ts: 60 * S, progressMs: 45 * S, shuffle: true });
    const t = classifyTransition(prev, now, ctx);
    expect(t).toMatchObject({ kind: 'auto_next', chainBreak: false });
    expect(t.evidence.queueOrderMismatch).toBe(true);
  });

  it('album ran out and autoplay took over (not in queue, new context): autoplay, chain continues', () => {
    const prev = snap({ trackId: 'A', progressMs: 190 * S, contextUri: 'spotify:album:L', contextType: 'album', queue: [] });
    const now = snap({ trackId: 'X', ts: 60 * S, progressMs: 45 * S, contextUri: null, contextType: null });
    expect(classifyTransition(prev, now, ctx)).toMatchObject({ kind: 'autoplay', chainBreak: false, prevSkipped: false });
  });

  it('tapping a different song mid-way through: manual pick, chain breaks, barely-heard song excluded', () => {
    const prev = snap({ trackId: 'A', progressMs: 60 * S, queue: [q('B')] });
    const now = snap({ trackId: 'X', ts: 60 * S, progressMs: 30 * S, contextUri: 'spotify:album:Z', contextType: 'album' });
    const t = classifyTransition(prev, now, ctx);
    expect(t).toMatchObject({ kind: 'manual_pick', chainBreak: true, prevSkipped: true });
  });

  it('manual pick late in a song keeps the mostly-heard song', () => {
    const prev = snap({ trackId: 'A', progressMs: 120 * S, queue: [q('B')] });
    const now = snap({ trackId: 'X', ts: 30 * S, progressMs: 25 * S });
    const t = classifyTransition(prev, now, ctx);
    expect(t).toMatchObject({ kind: 'manual_pick', chainBreak: true, prevSkipped: false });
  });

  it('playback stopped at the end, then something new started much later: manual pick', () => {
    const prev = snap({ trackId: 'A', progressMs: 190 * S, queue: [] });
    const now = snap({ trackId: 'X', ts: 3600 * S, progressMs: 20 * S });
    expect(classifyTransition(prev, now, ctx)).toMatchObject({ kind: 'manual_pick', chainBreak: true });
  });

  it('resuming from pause onto the next queued song keeps the chain (pauses never break)', () => {
    const prev = snap({ trackId: 'A', progressMs: 100 * S, isPlaying: false, queue: [q('B')] });
    const now = snap({ trackId: 'B', ts: 2 * 86_400 * S, progressMs: 30 * S });
    expect(classifyTransition(prev, now, ctx)).toMatchObject({ kind: 'auto_next', chainBreak: false, prevSkipped: false });
  });

  it('resuming from pause onto a song outside the queue is a manual pick', () => {
    const prev = snap({ trackId: 'A', progressMs: 100 * S, isPlaying: false, queue: [q('B')] });
    const now = snap({ trackId: 'X', ts: 86_400 * S, progressMs: 30 * S });
    expect(classifyTransition(prev, now, ctx)).toMatchObject({ kind: 'manual_pick', chainBreak: true });
  });

  it('Back button returns to the song before: back, chain continues', () => {
    const prev = snap({ trackId: 'B', progressMs: 10 * S, queue: [q('C')] });
    const now = snap({ trackId: 'A', ts: 20 * S, progressMs: 5 * S });
    expect(classifyTransition(prev, now, { ...ctx, trackBeforePrev: 'A' })).toMatchObject({ kind: 'back', chainBreak: false });
  });

  it('after a poller outage an unexplained change is uncertain and does not break the chain', () => {
    const prev = snap({ trackId: 'A', progressMs: 30 * S, queue: [q('B')] });
    const now = snap({ trackId: 'X', ts: 20 * 60 * S, progressMs: 30 * S });
    expect(classifyTransition(prev, now, { ...ctx, pollGapMs: OUTAGE_MS + 1 })).toMatchObject({ kind: 'uncertain', chainBreak: false });
  });

  it('device switch onto the next queued song keeps the chain', () => {
    const prev = snap({ trackId: 'A', progressMs: 185 * S, device: 'iPhone', queue: [q('B')] });
    const now = snap({ trackId: 'B', ts: 60 * S, progressMs: 40 * S, device: 'MacBook' });
    expect(classifyTransition(prev, now, ctx)).toMatchObject({ kind: 'auto_next', chainBreak: false });
  });
});

describe('toSnapshot', () => {
  it('returns null when nothing is playing', () => {
    expect(toSnapshot(null, null, 0)).toBeNull();
    expect(toSnapshot({ item: null }, null, 0)).toBeNull();
  });

  it('flattens the player and queue responses', () => {
    const s = toSnapshot(
      {
        item: { id: 't1', uri: 'spotify:track:t1', name: 'Song', type: 'track', duration_ms: 1000, artists: [{ name: 'A' }, { name: 'B' }] },
        progress_ms: 10,
        is_playing: true,
        context: { uri: 'spotify:playlist:p', type: 'playlist' },
        shuffle_state: true,
        repeat_state: 'off',
        device: { name: 'iPhone' },
      },
      { queue: [{ id: 't2', uri: 'spotify:track:t2', name: 'Next', type: 'track', duration_ms: 2000, artists: [{ name: 'C' }] }] },
      123,
    );
    expect(s).toMatchObject({ ts: 123, trackId: 't1', artists: 'A, B', shuffle: true, contextType: 'playlist', device: 'iPhone' });
    expect(s?.queue).toEqual([{ id: 't2', uri: 'spotify:track:t2', durationMs: 2000, name: 'Next', artists: 'C', itemType: 'track' }]);
  });

  it('uses the uri as id for local files', () => {
    const s = toSnapshot({ item: { id: null, uri: 'spotify:local:x', is_local: true, type: 'track', duration_ms: 1 }, is_playing: true }, null, 0);
    expect(s).toMatchObject({ trackId: 'spotify:local:x', isLocal: true });
  });
});
