// Minimal multi-user stand-in for the Spotify Web API + accounts service, used by scripts/e2e.mjs.
// Each access token maps to a user ("acc-<user>"); the test drives per-user state with POST /__set
// and inspects everything with GET /__state. Spotify user "stranger" is not on the allow-list (403).
import http from 'node:http';

const port = Number(process.env.MOCK_PORT || 8788);
const state = { users: {}, playlists: {}, calls: [] };
let nextPlaylist = 1;

const userState = (u) => (state.users[u] ??= { player: null, queue: [], recent: [] });

function send(res, status, body) {
  if (status === 204) return res.writeHead(204).end();
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;
  const ctype = req.headers['content-type'] ?? '';
  const body = !raw ? {} : ctype.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
  const user = (req.headers.authorization ?? '').match(/^Bearer acc-(.+)$/)?.[1];
  if (!path.startsWith('/__')) state.calls.push(`${user ?? '-'} ${req.method} ${path}`);

  if (path === '/__set') {
    const { user: u, ...rest } = body;
    Object.assign(userState(u), rest);
    return send(res, 200, { ok: true });
  }
  if (path === '/__state') return send(res, 200, state);

  if (path === '/api/token') {
    const who = body.grant_type === 'authorization_code' ? body.code : String(body.refresh_token).replace(/^rt-/, '');
    return send(res, 200, { access_token: `acc-${who}`, refresh_token: `rt-${who}`, expires_in: 3600 });
  }

  if (!user) return send(res, 401, { error: { status: 401, message: 'no token' } });
  if (path === '/v1/me') {
    if (user === 'stranger') return send(res, 403, { error: { status: 403, message: 'User not registered in the Developer Dashboard' } });
    return send(res, 200, { id: user, display_name: `User ${user}` });
  }
  const u = userState(user);
  if (path === '/v1/me/player') return u.player ? send(res, 200, u.player) : send(res, 204);
  if (path === '/v1/me/player/queue') return send(res, 200, { currently_playing: u.player?.item ?? null, queue: u.queue });
  if (path === '/v1/me/player/recently-played') return send(res, 200, { items: u.recent });

  if (path === '/v1/me/playlists' && req.method === 'POST') {
    const id = `pl${nextPlaylist++}`;
    state.playlists[id] = { owner: user, name: body.name, description: body.description, public: body.public, items: [] };
    return send(res, 201, { id, external_urls: { spotify: `https://open.spotify.com/playlist/${id}` } });
  }
  let m;
  if ((m = path.match(/^\/v1\/playlists\/([^/]+)\/items$/)) && req.method === 'POST') {
    const pl = state.playlists[m[1]];
    if (pl.owner !== user) return send(res, 403, { error: { status: 403, message: 'not your playlist' } });
    pl.items.push(...body.uris);
    return send(res, 201, { snapshot_id: 'x' });
  }
  if ((m = path.match(/^\/v1\/playlists\/([^/]+)$/))) {
    if (req.method === 'PUT') {
      const pl = state.playlists[m[1]];
      if (pl.owner !== user) return send(res, 403, { error: { status: 403, message: 'not your playlist' } });
      Object.assign(pl, body);
      return send(res, 200, {});
    }
    return send(res, 200, { name: `Playlist ${m[1]}` });
  }
  if ((m = path.match(/^\/v1\/albums\/([^/]+)$/))) return send(res, 200, { name: `Album ${m[1]}` });
  if ((m = path.match(/^\/v1\/artists\/([^/]+)$/))) return send(res, 200, { name: `Artist ${m[1]}` });

  send(res, 404, { error: { status: 404, message: `mock: no route ${req.method} ${path}` } });
});

server.listen(port, '127.0.0.1', () => console.log(`mock spotify on :${port}`));
