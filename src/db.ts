import type { ChainRow, Env, PlayRow, Settings, Snapshot, TransitionKind } from './types';
import type { Seed } from './chains';

/* ---------- settings (per user) ---------- */

const DEFAULTS = {
  mode: 'review',
  min_songs: '8',
  copy_threshold: '0.8',
  tracking: 'on',
  timezone: 'UTC',
  tracking_since: '0',
  ntfy_topic: '',
};
export type SettingKey = keyof typeof DEFAULTS;

export async function getSettings(env: Env, userId: number): Promise<Settings> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings WHERE user_id = ?')
    .bind(userId)
    .all<{ key: string; value: string }>();
  const v: Record<string, string> = { ...DEFAULTS, ...Object.fromEntries(results.map((r) => [r.key, r.value])) };
  return {
    mode: v.mode === 'auto' ? 'auto' : 'review',
    minSongs: Math.max(1, Number(v.min_songs) || 8),
    copyThreshold: Math.min(1, Math.max(0, Number(v.copy_threshold) || 0.8)),
    tracking: v.tracking !== 'off',
    timezone: v.timezone || 'UTC',
    trackingSince: Number(v.tracking_since) || 0,
    ntfyTopic: v.ntfy_topic ?? '',
  };
}

export async function setSetting(env: Env, userId: number, key: SettingKey, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
  )
    .bind(userId, key, value)
    .run();
}

/* ---------- player state (per user) ---------- */

export interface PlayerState {
  snapshot: Snapshot | null;
  lastPolledAt: number | null;
  prevTrackId: string | null;
  currentPlayId: number | null;
  currentChainId: number | null;
}

export async function getPlayerState(env: Env, userId: number): Promise<PlayerState> {
  const row = await env.DB.prepare('SELECT * FROM player_state WHERE user_id = ?').bind(userId).first<{
    snapshot: string | null;
    last_polled_at: number | null;
    prev_track_id: string | null;
    current_play_id: number | null;
    current_chain_id: number | null;
  }>();
  return {
    snapshot: row?.snapshot ? (JSON.parse(row.snapshot) as Snapshot) : null,
    lastPolledAt: row?.last_polled_at ?? null,
    prevTrackId: row?.prev_track_id ?? null,
    currentPlayId: row?.current_play_id ?? null,
    currentChainId: row?.current_chain_id ?? null,
  };
}

export async function savePlayerState(env: Env, userId: number, s: PlayerState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO player_state (user_id, snapshot, last_polled_at, prev_track_id, current_play_id, current_chain_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET snapshot=excluded.snapshot, last_polled_at=excluded.last_polled_at,
       prev_track_id=excluded.prev_track_id, current_play_id=excluded.current_play_id,
       current_chain_id=excluded.current_chain_id, updated_at=excluded.updated_at`,
  )
    .bind(
      userId,
      s.snapshot ? JSON.stringify(s.snapshot) : null,
      s.lastPolledAt,
      s.prevTrackId,
      s.currentPlayId,
      s.currentChainId,
      Date.now(),
    )
    .run();
}

export async function touchPolled(env: Env, userId: number, ts: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO player_state (user_id, last_polled_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_polled_at = excluded.last_polled_at, updated_at = excluded.updated_at`,
  )
    .bind(userId, ts, ts)
    .run();
}

/* ---------- chains (always scoped to a user) ---------- */

export async function getChain(env: Env, userId: number, id: number): Promise<ChainRow | null> {
  return env.DB.prepare('SELECT * FROM chains WHERE id = ? AND user_id = ?').bind(id, userId).first<ChainRow>();
}

export async function listChains(env: Env, userId: number, limit: number): Promise<ChainRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM chains WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .bind(userId, limit)
    .all<ChainRow>();
  return results;
}

export async function previousChain(env: Env, userId: number, id: number): Promise<ChainRow | null> {
  return env.DB.prepare('SELECT * FROM chains WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
    .bind(userId, id)
    .first<ChainRow>();
}

export async function insertChain(env: Env, userId: number, seed: Seed, startedAt: number, startKind: TransitionKind): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO chains (user_id, started_at, seed_type, seed_uri, seed_name, start_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(userId, startedAt, seed.type, seed.uri, seed.name, startKind, Date.now())
    .first<{ id: number }>();
  return row!.id;
}

export function closeChainStmt(env: Env, userId: number, id: number, endedAt: number): D1PreparedStatement {
  return env.DB.prepare("UPDATE chains SET status = 'closed', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'open'").bind(
    endedAt,
    id,
    userId,
  );
}

/** Chains the sync job still has work to do on. */
export async function chainsNeedingSync(env: Env, userId: number, limit: number): Promise<ChainRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM chains
     WHERE user_id = ? AND finalized = 0 AND playlist_status IN ('none', 'created')
     ORDER BY id ASC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<ChainRow>();
  return results;
}

/* ---------- plays ---------- */

export interface NewPlay {
  chainId: number;
  trackId: string;
  trackUri: string;
  itemType: string;
  isLocal: boolean;
  name: string;
  artists: string;
  durationMs: number;
  startedAt: number;
  playedAt?: number | null;
  contextUri: string | null;
  contextType: string | null;
  shuffle?: boolean | null;
  device?: string | null;
  source: PlayRow['source'];
  kind: TransitionKind;
  skipped?: boolean;
  evidence?: Record<string, unknown> | null;
}

export function insertPlayStmt(env: Env, userId: number, p: NewPlay): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO plays (user_id, chain_id, track_id, track_uri, item_type, is_local, name, artists, duration_ms, started_at,
       played_at, context_uri, context_type, shuffle, device, source, kind, skipped, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING RETURNING id`,
  ).bind(
    userId,
    p.chainId,
    p.trackId,
    p.trackUri,
    p.itemType,
    p.isLocal ? 1 : 0,
    p.name,
    p.artists,
    p.durationMs,
    p.startedAt,
    p.playedAt ?? null,
    p.contextUri,
    p.contextType,
    p.shuffle == null ? null : p.shuffle ? 1 : 0,
    p.device ?? null,
    p.source,
    p.kind,
    p.skipped ? 1 : 0,
    p.evidence ? JSON.stringify(p.evidence) : null,
  );
}

export async function chainPlays(env: Env, userId: number, chainId: number): Promise<PlayRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM plays WHERE chain_id = ? AND user_id = ? ORDER BY started_at, id')
    .bind(chainId, userId)
    .all<PlayRow>();
  return results;
}

export async function playsSince(env: Env, userId: number, since: number): Promise<PlayRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM plays WHERE user_id = ? AND started_at >= ? ORDER BY started_at, id')
    .bind(userId, since)
    .all<PlayRow>();
  return results;
}

export function addMarkerStmt(env: Env, userId: number, kind: string, chainId: number | null, detail?: unknown): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO markers (user_id, at, kind, chain_id, detail) VALUES (?, ?, ?, ?, ?)').bind(
    userId,
    Date.now(),
    kind,
    chainId,
    detail == null ? null : JSON.stringify(detail),
  );
}
