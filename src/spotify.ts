import type { Env } from './types';

// Overridable only so the local end-to-end test can point at a mock server.
const apiBase = (env: Env) => env.SPOTIFY_API_BASE ?? 'https://api.spotify.com/v1';
const accountsBase = (env: Env) => env.SPOTIFY_ACCOUNTS_BASE ?? 'https://accounts.spotify.com';

export const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'playlist-modify-private',
  'playlist-modify-public',
];

export class SpotifyError extends Error {
  constructor(
    public status: number,
    public body: string,
    public retryAfterS?: number,
  ) {
    super(`Spotify ${status}: ${body.slice(0, 200)}`);
  }
}

export class NotConnectedError extends Error {
  constructor() {
    super('Spotify is not connected for this user. Sign in with Spotify again.');
  }
}

/* ---------- OAuth ---------- */

export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri,
    state,
  });
  return `${accountsBase(env)}/authorize?${q}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

async function tokenRequest(env: Env, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${accountsBase(env)}/api/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new SpotifyError(res.status, await res.text());
  return res.json();
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<TokenResponse> {
  const t = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (!t.refresh_token) throw new Error('Spotify did not return a refresh token');
  return t;
}

export async function saveTokens(env: Env, userId: number, t: TokenResponse): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth (user_id, access_token, refresh_token, expires_at, scope, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token,
       expires_at=excluded.expires_at, scope=excluded.scope, updated_at=excluded.updated_at`,
  )
    .bind(userId, t.access_token, t.refresh_token, now + t.expires_in * 1000, t.scope ?? null, now)
    .run();
  tokenCache.set(userId, { token: t.access_token, expiresAt: now + t.expires_in * 1000 });
}

/** The signed-in Spotify profile, using a fresh access token from the OAuth callback. */
export async function getMe(env: Env, accessToken: string): Promise<{ id: string; display_name: string | null }> {
  const res = await fetch(`${apiBase(env)}/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new SpotifyError(res.status, await res.text());
  return res.json();
}

// Access tokens live for an hour; caching them in the isolate saves a D1 read per Spotify call,
// which matters because D1 queries count toward the 50-subrequests-per-invocation limit.
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

async function getAccessToken(env: Env, userId: number, forceRefresh = false): Promise<string> {
  const cached = tokenCache.get(userId);
  if (!forceRefresh && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const row = await env.DB.prepare('SELECT access_token, refresh_token, expires_at FROM auth WHERE user_id = ?').bind(userId).first<{
    access_token: string | null;
    refresh_token: string;
    expires_at: number;
  }>();
  if (!row) throw new NotConnectedError();
  if (!forceRefresh && row.access_token && row.expires_at - 60_000 > Date.now()) {
    tokenCache.set(userId, { token: row.access_token, expiresAt: row.expires_at });
    return row.access_token;
  }

  const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: row.refresh_token });
  const now = Date.now();
  // Spotify may rotate the refresh token; keep the newest one.
  await env.DB.prepare(
    'UPDATE auth SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated_at = ? WHERE user_id = ?',
  )
    .bind(t.access_token, t.refresh_token ?? null, now + t.expires_in * 1000, now, userId)
    .run();
  tokenCache.set(userId, { token: t.access_token, expiresAt: now + t.expires_in * 1000 });
  return t.access_token;
}

export function forgetToken(userId: number): void {
  tokenCache.delete(userId);
}

/* ---------- API ---------- */

/** Fetch a Web API path as `userId`. Returns null for 204 No Content. Retries once on 401 with a fresh token. */
export async function api<T = unknown>(env: Env, userId: number, path: string, init: RequestInit = {}): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(env, userId, attempt > 0);
    const res = await fetch(`${apiBase(env)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 204) return null;
    if (!res.ok) {
      const retry = Number(res.headers.get('retry-after')) || undefined;
      throw new SpotifyError(res.status, await res.text(), retry);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }
  throw new SpotifyError(401, 'unauthorized after token refresh');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const getPlayer = (env: Env, userId: number) => api<any>(env, userId, '/me/player?additional_types=episode');
export const getQueue = (env: Env, userId: number) => api<any>(env, userId, '/me/player/queue');
export const getProfile = (env: Env, userId: number) => api<{ id: string; display_name: string | null }>(env, userId, '/me');

export async function getRecentlyPlayed(env: Env, userId: number): Promise<any[]> {
  const res = await api<any>(env, userId, '/me/player/recently-played?limit=50');
  return res?.items ?? [];
}

export async function createPlaylist(env: Env, userId: number, name: string, description: string): Promise<{ id: string; url: string }> {
  const res = await api<any>(env, userId, '/me/playlists', {
    method: 'POST',
    body: JSON.stringify({ name, description, public: false }),
  });
  return { id: res.id, url: res.external_urls?.spotify ?? `https://open.spotify.com/playlist/${res.id}` };
}

export async function addItems(env: Env, userId: number, playlistId: string, uris: string[]): Promise<void> {
  for (let i = 0; i < uris.length; i += 100) {
    await api(env, userId, `/playlists/${playlistId}/items`, {
      method: 'POST',
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
  }
}

export async function updatePlaylistDetails(
  env: Env,
  userId: number,
  playlistId: string,
  details: { name?: string; description?: string },
): Promise<void> {
  await api(env, userId, `/playlists/${playlistId}`, { method: 'PUT', body: JSON.stringify(details) });
}

/** Human name of a playlist / album / artist context. Null when not readable (e.g. Spotify-owned mixes). */
export async function getContextName(env: Env, userId: number, type: string, uri: string): Promise<string | null> {
  const id = uri.split(':').at(-1);
  const path =
    type === 'playlist' ? `/playlists/${id}?fields=name` : type === 'album' ? `/albums/${id}` : type === 'artist' ? `/artists/${id}` : null;
  if (!path) return null;
  try {
    const res = await api<any>(env, userId, path);
    return res?.name ?? null;
  } catch {
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
