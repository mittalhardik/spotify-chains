import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ChainRow, Env, PlayRow, Settings } from './types';
import { summarizeChain } from './chains';
import { runPoll, runSync } from './jobs';
import * as db from './db';
import * as ops from './ops';
import * as spotify from './spotify';
import * as users from './users';
import { dashboardHtml, loginHtml, manifest, iconSvg } from './ui/dashboard';

type App = { Bindings: Env; Variables: { userId: number } };
const SESSION_COOKIE = 'chains_session';
const LEGACY_COOKIE = 'chains_token';
const STATE_COOKIE = 'chains_oauth_state';

/** The original single-user owner (user 1), reachable with the legacy API_TOKEN. */
async function legacyOwner(env: Env): Promise<number | null> {
  return (await users.getUser(env, 1)) ? 1 : null;
}

/** Who is calling: a Shortcut token (Bearer), a dashboard session cookie, or the legacy API_TOKEN. */
async function resolveUser(c: Context<App>): Promise<number | null> {
  const env = c.env;
  const header = c.req.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7);
    if (env.API_TOKEN && users.safeEqual(token, env.API_TOKEN)) return legacyOwner(env);
    return users.userFromApiToken(env, token);
  }
  const fromSession = await users.userFromSession(env, getCookie(c, SESSION_COOKIE) ?? '');
  if (fromSession) return fromSession;
  const legacy = getCookie(c, LEGACY_COOKIE) ?? '';
  if (env.API_TOKEN && users.safeEqual(legacy, env.API_TOKEN)) return legacyOwner(env);
  return null;
}

function chainView(chain: ChainRow, plays: PlayRow[], settings: Settings) {
  const s = summarizeChain(chain, plays, settings);
  return {
    id: chain.id,
    name: chain.custom_name ?? chain.seed_name,
    seedType: chain.seed_type,
    startKind: chain.start_kind,
    status: chain.status,
    playlistStatus: chain.playlist_status,
    playlistUrl: chain.playlist_url,
    startedAt: chain.started_at,
    endedAt: chain.ended_at,
    summary: s,
  };
}

function playView(p: PlayRow) {
  return {
    id: p.id,
    name: p.name,
    artists: p.artists,
    startedAt: p.started_at,
    kind: p.kind,
    skipped: Boolean(p.skipped),
    added: Boolean(p.added),
    source: p.source,
    shuffle: p.shuffle == null ? null : Boolean(p.shuffle),
    device: p.device,
    evidence: p.evidence ? JSON.parse(p.evidence) : null,
  };
}

const app = new Hono<App>();

app.onError((err, c) => {
  if (err instanceof ops.HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof spotify.NotConnectedError) return c.json({ error: err.message }, 409);
  if (err instanceof spotify.SpotifyError) return c.json({ error: err.message }, 502);
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});

/* ---------- pages ---------- */

app.get('/', async (c) => c.html((await resolveUser(c)) ? dashboardHtml : loginHtml()));
app.get('/manifest.webmanifest', (c) => c.json(manifest, 200, { 'content-type': 'application/manifest+json' }));
app.get('/icon.svg', (c) => c.body(iconSvg, 200, { 'content-type': 'image/svg+xml' }));

app.post('/logout', async (c) => {
  await users.deleteSession(c.env, getCookie(c, SESSION_COOKIE) ?? '');
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  deleteCookie(c, LEGACY_COOKIE, { path: '/' });
  return c.redirect('/');
});

/* ---------- Sign in with Spotify (also how new people join) ---------- */

app.get('/auth/login', (c) => {
  const state = crypto.randomUUID();
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth', maxAge: 600 });
  const redirectUri = new URL('/auth/callback', c.req.url).toString();
  return c.redirect(spotify.authorizeUrl(c.env, redirectUri, state));
});

app.get('/auth/callback', async (c) => {
  const env = c.env;
  const { code, state, error } = c.req.query();
  const expected = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/auth' });
  if (error) return c.html(loginHtml(error === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify said: ${error}`), 400);
  if (!code || !state || !expected || !users.safeEqual(state, expected)) return c.html(loginHtml('Sign-in expired, please try again.'), 400);

  const tokens = await spotify.exchangeCode(env, code, new URL('/auth/callback', c.req.url).toString());
  let me;
  try {
    me = await spotify.getMe(env, tokens.access_token);
  } catch (e) {
    if (e instanceof spotify.SpotifyError && e.status === 403) {
      return c.html(
        loginHtml("Your Spotify account isn't allowed on this app yet. Ask the owner to add your Spotify email under User Management in the Spotify developer dashboard."),
        403,
      );
    }
    throw e;
  }
  // Data from the single-user version belongs to whoever owns that Spotify account.
  await users.resolveMissingSpotifyIds(env);
  let user;
  try {
    ({ user } = await users.findOrCreateUser(env, me.id, me.display_name ?? null));
  } catch (e) {
    if (e instanceof users.SeatsFullError) {
      return c.html(loginHtml(`This app is full: all ${e.max} seats are taken (Spotify allows ${users.DEFAULT_MAX_USERS} users per app).`), 403);
    }
    throw e;
  }
  await spotify.saveTokens(env, user.id, tokens);
  const settings = await db.getSettings(env, user.id);
  if (!settings.trackingSince) await db.setSetting(env, user.id, 'tracking_since', String(Date.now()));

  const session = await users.createSession(env, user.id);
  setCookie(c, SESSION_COOKIE, session.token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: session.maxAgeS });
  return c.redirect('/');
});

/* ---------- cron fan-out: one invocation per user (called through the SELF service binding) ---------- */

app.post('/internal/:job', async (c) => {
  if (!users.safeEqual(c.req.header('x-internal-key') ?? '', await users.internalKey(c.env))) return c.notFound();
  const { userId } = await c.req.json<{ userId: number }>();
  const job = c.req.param('job');
  if (job === 'poll') return c.json(await runPoll(c.env, userId));
  if (job === 'sync') return c.json(await runSync(c.env, userId));
  return c.notFound();
});

/* ---------- JSON API (dashboard + Siri Shortcuts) ---------- */

app.use('/api/*', async (c, next) => {
  const userId = await resolveUser(c);
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);
  c.set('userId', userId);
  await next();
});

app.get('/api/status', async (c) => {
  const env = c.env;
  const userId = c.get('userId');
  const [settings, state, connected, user, seats, hasToken] = await Promise.all([
    db.getSettings(env, userId),
    db.getPlayerState(env, userId),
    env.DB.prepare('SELECT 1 AS ok FROM auth WHERE user_id = ?').bind(userId).first(),
    users.getUser(env, userId),
    users.countUsers(env),
    users.hasApiToken(env, userId),
  ]);
  let current = null;
  if (state.currentChainId != null) {
    const chain = await db.getChain(env, userId, state.currentChainId);
    if (chain) {
      const plays = await db.chainPlays(env, userId, chain.id);
      current = { ...chainView(chain, plays, settings), recent: plays.slice(-8).reverse().map(playView) };
    }
  }
  const s = state.snapshot;
  return c.json({
    connected: Boolean(connected),
    user: { name: user?.display_name ?? user?.spotify_id ?? 'You', hasShortcutToken: hasToken },
    seats: { used: seats, max: users.maxUsers(env) },
    settings,
    lastPolledAt: state.lastPolledAt,
    nowPlaying: s ? { name: s.name, artists: s.artists, isPlaying: s.isPlaying, device: s.device, shuffle: s.shuffle, seenAt: s.ts } : null,
    current,
  });
});

app.get('/api/chains', async (c) => {
  const env = c.env;
  const userId = c.get('userId');
  const limit = Math.min(100, Number(c.req.query('limit')) || 30);
  const [settings, chains] = await Promise.all([db.getSettings(env, userId), db.listChains(env, userId, limit)]);
  if (!chains.length) return c.json({ chains: [] });
  const ids = chains.map((ch) => ch.id);
  const { results } = await env.DB.prepare(`SELECT * FROM plays WHERE user_id = ? AND chain_id IN (${ids.map(() => '?').join(',')})`)
    .bind(userId, ...ids)
    .all<PlayRow>();
  const byChain = new Map<number, PlayRow[]>();
  for (const p of results) byChain.set(p.chain_id, [...(byChain.get(p.chain_id) ?? []), p]);
  return c.json({ chains: chains.map((ch) => chainView(ch, byChain.get(ch.id) ?? [], settings)) });
});

app.get('/api/chains/:id', async (c) => {
  const userId = c.get('userId');
  const id = Number(c.req.param('id'));
  const [settings, chain] = await Promise.all([db.getSettings(c.env, userId), db.getChain(c.env, userId, id)]);
  if (!chain) return c.json({ error: 'Not found' }, 404);
  const plays = await db.chainPlays(c.env, userId, id);
  return c.json({ ...chainView(chain, plays, settings), plays: plays.map(playView) });
});

const chainId = (c: Context<App>) => Number(c.req.param('id'));
app.post('/api/chains/:id/create', async (c) => c.json({ result: await ops.createNow(c.env, c.get('userId'), chainId(c)) }));
app.post('/api/chains/:id/discard', async (c) => {
  await ops.discard(c.env, c.get('userId'), chainId(c));
  return c.json({ ok: true, note: 'If a playlist was already created it stays in Spotify; delete it there if you like.' });
});
app.post('/api/chains/:id/merge-prev', async (c) => c.json(await ops.mergeIntoPrevious(c.env, c.get('userId'), chainId(c))));
app.post('/api/chains/:id/split', async (c) => {
  const body = await c.req.json<{ playId: number }>();
  return c.json(await ops.splitAt(c.env, c.get('userId'), chainId(c), Number(body.playId)));
});
app.post('/api/chains/:id/rename', async (c) => {
  const body = await c.req.json<{ name: string }>();
  await ops.rename(c.env, c.get('userId'), chainId(c), String(body.name ?? ''));
  return c.json({ ok: true });
});

// Siri Shortcut endpoints.
app.post('/api/break', async (c) => c.json(await ops.breakNow(c.env, c.get('userId'))));
app.post('/api/keep', async (c) => c.json(await ops.keepCurrent(c.env, c.get('userId'))));
app.post('/api/tracking', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ on?: boolean }>().catch(() => ({}) as { on?: boolean });
  const current = (await db.getSettings(c.env, userId)).tracking;
  const on = typeof body.on === 'boolean' ? body.on : !current;
  await db.setSetting(c.env, userId, 'tracking', on ? 'on' : 'off');
  return c.json({ tracking: on, message: on ? 'Tracking is on' : 'Tracking paused' });
});
app.get('/api/current-playlist', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    `SELECT playlist_url FROM chains WHERE user_id = ? AND playlist_url IS NOT NULL
     ORDER BY (id = (SELECT current_chain_id FROM player_state WHERE user_id = ?)) DESC, id DESC LIMIT 1`,
  )
    .bind(userId, userId)
    .first<{ playlist_url: string }>();
  if (!row) return c.json({ error: 'No chain playlist yet' }, 404);
  return c.json({ url: row.playlist_url });
});

app.get('/api/settings', async (c) => c.json(await db.getSettings(c.env, c.get('userId'))));
app.post('/api/settings', async (c) => {
  const env = c.env;
  const userId = c.get('userId');
  const body = await c.req.json<Partial<Record<'mode' | 'minSongs' | 'copyThreshold' | 'timezone' | 'ntfyTopic', unknown>>>();
  if (body.mode === 'auto' || body.mode === 'review') await db.setSetting(env, userId, 'mode', body.mode);
  if (body.minSongs != null) await db.setSetting(env, userId, 'min_songs', String(Math.max(1, Math.round(Number(body.minSongs)) || 8)));
  if (body.copyThreshold != null) {
    await db.setSetting(env, userId, 'copy_threshold', String(Math.min(1, Math.max(0, Number(body.copyThreshold) || 0.8))));
  }
  if (typeof body.timezone === 'string' && body.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
      await db.setSetting(env, userId, 'timezone', body.timezone);
    } catch {
      return c.json({ error: 'Unknown timezone' }, 400);
    }
  }
  if (typeof body.ntfyTopic === 'string') {
    const topic = body.ntfyTopic.trim();
    if (topic && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return c.json({ error: 'Topic can only use letters, numbers, - and _' }, 400);
    await db.setSetting(env, userId, 'ntfy_topic', topic);
  }
  return c.json(await db.getSettings(env, userId));
});

// Personal Siri Shortcut token (replaces the previous one). Shown once.
app.post('/api/shortcut-token', async (c) => c.json({ token: await users.rotateApiToken(c.env, c.get('userId')) }));

// Leave: delete everything stored for this user. Their Spotify playlists stay in Spotify.
app.post('/api/account/delete', async (c) => {
  await users.deleteUser(c.env, c.get('userId'));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  deleteCookie(c, LEGACY_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// Run a job by hand for yourself (handy for testing from the dashboard).
app.post('/api/run/:job', async (c) => {
  const job = c.req.param('job');
  if (job === 'poll') return c.json(await runPoll(c.env, c.get('userId')));
  if (job === 'sync') return c.json(await runSync(c.env, c.get('userId')));
  return c.json({ error: 'Unknown job' }, 404);
});

export default app;
