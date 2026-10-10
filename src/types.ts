export interface Env {
  DB: D1Database;
  /** Service binding to this same Worker: the crons fan out one invocation per user. */
  SELF?: Fetcher;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  /** Legacy single-user token. Still signs in as user 1 (the original owner). */
  API_TOKEN?: string;
  /** Legacy notification topic for user 1; other users set their own in Settings. */
  NTFY_TOPIC?: string;
  LASTFM_KEY?: string;
  /** Seat limit. Spotify Development Mode allows 5 users per app. */
  MAX_USERS?: string;
  /** Testing only: point the Worker at a mock Spotify. */
  SPOTIFY_API_BASE?: string;
  SPOTIFY_ACCOUNTS_BASE?: string;
}

export interface QueueItem {
  id: string;
  uri: string;
  durationMs: number;
  name: string;
  artists: string;
  itemType: 'track' | 'episode';
}

/** What the poller saw at one moment. Stored as JSON in player_state.snapshot. */
export interface Snapshot {
  ts: number;
  trackId: string;
  trackUri: string;
  itemType: 'track' | 'episode';
  isLocal: boolean;
  name: string;
  artists: string;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  contextUri: string | null;
  contextType: string | null;
  shuffle: boolean;
  repeat: 'off' | 'track' | 'context';
  device: string | null;
  queue: QueueItem[];
}

export type TransitionKind =
  | 'first'
  | 'auto_next'
  | 'skip_next'
  | 'back'
  | 'autoplay'
  | 'manual_pick'
  | 'uncertain'
  | 'backfill'
  | 'manual_break';

export interface Transition {
  kind: TransitionKind;
  /** True when this change starts a new chain. */
  chainBreak: boolean;
  /** Whether the previous song should be excluded from the playlist. */
  prevSkipped: boolean;
  /** Songs that played (or were skipped past) between the two polls. */
  intermediate: Array<QueueItem & { skipped: boolean }>;
  evidence: Record<string, unknown>;
}

export interface ChainRow {
  id: number;
  user_id: number;
  started_at: number;
  ended_at: number | null;
  seed_type: string;
  seed_uri: string;
  seed_name: string;
  start_kind: string;
  status: 'open' | 'closed';
  playlist_status: 'none' | 'creating' | 'created' | 'copy' | 'too_short' | 'discarded';
  playlist_id: string | null;
  playlist_url: string | null;
  custom_name: string | null;
  finalized: number;
  created_at: number;
}

export interface PlayRow {
  id: number;
  user_id: number;
  chain_id: number;
  track_id: string;
  track_uri: string;
  item_type: string;
  is_local: number;
  name: string;
  artists: string;
  duration_ms: number;
  started_at: number;
  played_at: number | null;
  context_uri: string | null;
  context_type: string | null;
  shuffle: number | null;
  device: string | null;
  source: 'poller' | 'inferred' | 'recent';
  kind: TransitionKind;
  skipped: number;
  added: number;
  evidence: string | null;
}

export interface Settings {
  mode: 'review' | 'auto';
  minSongs: number;
  copyThreshold: number;
  tracking: boolean;
  timezone: string;
  trackingSince: number;
  ntfyTopic: string;
}
