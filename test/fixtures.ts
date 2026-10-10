import type { PlayRow } from '../src/types';

let nextId = 1;

export function play(over: Partial<PlayRow> & Pick<PlayRow, 'track_id' | 'started_at'>): PlayRow {
  return {
    id: nextId++,
    user_id: 1,
    chain_id: 1,
    track_uri: `spotify:track:${over.track_id}`,
    item_type: 'track',
    is_local: 0,
    name: over.track_id,
    artists: 'Artist',
    duration_ms: 200_000,
    played_at: null,
    context_uri: null,
    context_type: null,
    shuffle: 0,
    device: 'iPhone',
    source: 'poller',
    kind: 'auto_next',
    skipped: 0,
    added: 0,
    evidence: null,
    ...over,
  };
}
