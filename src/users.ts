import type { Env } from './types';
import * as spotify from './spotify';

export const DEFAULT_MAX_USERS = 5;
const SESSION_TTL_MS = 400 * 86_400_000;

export function maxUsers(env: Env): number {
  return Math.max(1, Number(env.MAX_USERS) || DEFAULT_MAX_USERS);
}

export interface UserRow {
  id: number;
  spotify_id: string | null;
  display_name: string | null;
  created_at: number;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Secret for the cron → per-user fan-out calls; derived so there's nothing extra to configure. */
export function internalKey(env: Env): Promise<string> {
  return sha256(`internal:${env.SPOTIFY_CLIENT_SECRET}`);
}

/* ---------- users ---------- */

export async function getUser(env: Env, id: number): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

/** Users who have connected Spotify (the ones the crons work for). */
export async function connectedUserIds(env: Env): Promise<number[]> {
  const { results } = await env.DB.prepare('SELECT user_id FROM auth ORDER BY user_id').all<{ user_id: number }>();
  return results.map((r) => r.user_id);
}

export async function countUsers(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>();
  return row?.n ?? 0;
}

export class SeatsFullError extends Error {
  constructor(public max: number) {
    super(`All ${max} seats are taken.`);
  }
}

/** Find the user for a Spotify account, creating one if there's a free seat. */
export async function findOrCreateUser(env: Env, spotifyId: string, displayName: string | null): Promise<{ user: UserRow; created: boolean }> {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE spotify_id = ?').bind(spotifyId).first<UserRow>();
  if (existing) {
    if (displayName && displayName !== existing.display_name) {
      await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(displayName, existing.id).run();
    }
    return { user: { ...existing, display_name: displayName ?? existing.display_name }, created: false };
  }
  const max = maxUsers(env);
  // Insert only while under the seat limit, in one statement so two sign-ups can't both take the last seat.
  const user = await env.DB.prepare(
    `INSERT INTO users (spotify_id, display_name, created_at)
     SELECT ?, ?, ? WHERE (SELECT count(*) FROM users) < ?
     RETURNING *`,
  )
    .bind(spotifyId, displayName, Date.now(), max)
    .first<UserRow>();
  if (!user) throw new SeatsFullError(max);
  return { user, created: true };
}

/**
 * Users carried over from the single-user version have no Spotify id yet.
 * Look it up with their stored token so their next "Sign in with Spotify" lands on their own data.
 */
export async function resolveMissingSpotifyIds(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    'SELECT u.id FROM users u JOIN auth a ON a.user_id = u.id WHERE u.spotify_id IS NULL',
  ).all<{ id: number }>();
  let resolved = 0;
  for (const { id } of results) {
    try {
      const me = await spotify.getProfile(env, id);
      if (!me?.id) continue;
      await env.DB.prepare('UPDATE users SET spotify_id = ?, display_name = ? WHERE id = ? AND spotify_id IS NULL')
        .bind(me.id, me.display_name ?? null, id)
        .run();
      resolved++;
    } catch (e) {
      console.error('could not resolve spotify id for user', id, e);
    }
  }
  return resolved;
}

/** Remove a user and everything stored for them. Their Spotify playlists are left untouched. */
export async function deleteUser(env: Env, userId: number): Promise<void> {
  const tables = ['plays', 'markers', 'chains', 'settings', 'player_state', 'auth', 'sessions', 'api_tokens'];
  await env.DB.batch([
    ...tables.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId)),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
  spotify.forgetToken(userId);
}

/* ---------- dashboard sessions ---------- */

export async function createSession(env: Env, userId: number): Promise<{ token: string; maxAgeS: number }> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(
      await sha256(token),
      userId,
      now,
      now + SESSION_TTL_MS,
    ),
  ]);
  return { token, maxAgeS: SESSION_TTL_MS / 1000 };
}

export async function userFromSession(env: Env, token: string): Promise<number | null> {
  if (!token) return null;
  const row = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(await sha256(token), Date.now())
    .first<{ user_id: number }>();
  return row?.user_id ?? null;
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

/* ---------- personal Siri Shortcut tokens ---------- */

/** Make a new Shortcut token for the user, replacing any previous one. Only shown once. */
export async function rotateApiToken(env: Env, userId: number): Promise<string> {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM api_tokens WHERE user_id = ?').bind(userId),
    env.DB.prepare('INSERT INTO api_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)').bind(await sha256(token), userId, Date.now()),
  ]);
  return token;
}

export async function userFromApiToken(env: Env, token: string): Promise<number | null> {
  if (!token) return null;
  const row = await env.DB.prepare('SELECT user_id FROM api_tokens WHERE token_hash = ?').bind(await sha256(token)).first<{ user_id: number }>();
  return row?.user_id ?? null;
}

export async function hasApiToken(env: Env, userId: number): Promise<boolean> {
  return Boolean(await env.DB.prepare('SELECT 1 AS ok FROM api_tokens WHERE user_id = ?').bind(userId).first());
}
