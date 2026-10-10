// End-to-end scenario: the real Worker (wrangler dev, local D1) against scripts/mock-spotify.mjs.
// Run via `npm run e2e` (scripts/e2e.sh starts both servers on a database migrated from the
// single-user schema, with MAX_USERS=2).
const WORKER = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8788';
const LEGACY_TOKEN = 'e2e-token';
const DUR = 200_000;

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond || detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

async function call(base, path, method = 'GET', body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
/** An API client acting as one person: Bearer token or session cookie. */
const as = (headers) => ({
  raw: (path, method, body) => call(WORKER, path, method, body, headers),
  api: (path, method, body) => call(WORKER, path, method, body, headers).then((r) => r.json),
});
const owner = as({ authorization: `Bearer ${LEGACY_TOKEN}` }); // the original single-user owner (user 1)
const worker = owner.api;
let mockUser = 'owner';
const mockSet = (s) => call(MOCK, '/__set', 'POST', { user: mockUser, ...s });
const mockState = () => call(MOCK, '/__state').then((r) => r.json);
const poll = () => worker('/api/run/poll', 'POST');
const sync = () => worker('/api/run/sync', 'POST');
const cron = (expr) => fetch(`${WORKER}/__scheduled?cron=${encodeURIComponent(expr).replace(/%20/g, '+')}`).then((r) => r.text());

/** Run the real "Sign in with Spotify" flow; the mock turns `code` into that Spotify user. */
async function signIn(code) {
  const start = await fetch(`${WORKER}/auth/login`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const stateCookie = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const done = await fetch(`${WORKER}/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
  const session = done.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('chains_session='));
  return { status: done.status, session, html: done.status === 302 ? '' : await done.text(), client: session ? as({ cookie: session }) : null };
}

const track = (id, duration_ms = DUR) => ({ id, uri: `spotify:track:${id}`, name: `Song ${id}`, type: 'track', duration_ms, artists: [{ name: `Artist ${id[0]}` }] });
const ctx = (type, id) => ({ type, uri: `spotify:${type}:${id}` });
function playing(id, { progress = 0, isPlaying = true, context = null, queue = [] } = {}) {
  return mockSet({
    player: { item: track(id), progress_ms: progress, is_playing: isPlaying, context, shuffle_state: false, repeat_state: 'off', device: { name: 'iPhone' } },
    queue: queue.map((q) => track(q)),
  });
}
const ENDING = DUR - 1_000; // one second left: the song will finish on its own before the next poll
const album = ctx('album', 'L');

console.log('— upgrade from single-user');
let r = await fetch(WORKER + '/');
check('signed-out visitors get "Sign in with Spotify"', (await r.text()).includes('Sign in with Spotify'));
check('legacy API token still works as user 1', (await worker('/api/status')).user?.name === 'You');
await cron('*/15 * * * *');
check('first sync looks up the owner’s Spotify id', (await worker('/api/status')).user?.name === 'User owner');

console.log('— setup');
check('settings: auto mode, min 3 songs', (await worker('/api/settings', 'POST', { mode: 'auto', minSongs: 3, timezone: 'UTC' })).mode === 'auto');

console.log('— chain 1: album → skip → autoplay → pause → resume');
// Real time barely moves between polls here, so every new song appears at position 0 and a
// song is moved to its last second with a same-song poll before the next one starts.
const nearEnd = async (id, opts) => { await playing(id, { ...opts, progress: ENDING }); return poll(); };

await playing('S1', { context: album, queue: ['S2', 'S3'] });
r = await poll();
check('first song starts chain', r.started != null, r);
const chain1 = r.started;
check('advancing within a song is the same song', (await nearEnd('S1', { context: album, queue: ['S2', 'S3'] })).same === 'Song S1');

await playing('S2', { context: album, queue: ['S3'] });
r = await poll();
check('S1 finished → S2 is auto_next', r.kind === 'auto_next' && !r.chainBreak, r);

await playing('S3', { context: album, queue: [] });
r = await poll();
check('S2 cut short (Next) → S3 is skip_next, chain continues', r.kind === 'skip_next' && r.chainId === chain1, r);
await nearEnd('S3', { context: album, queue: [] });

await playing('X1', { context: null, queue: ['X2'] });
r = await poll();
check('album ran out → X1 is autoplay, chain continues', r.kind === 'autoplay' && r.chainId === chain1, r);
await nearEnd('X1', { context: null, queue: ['X2'] });

await playing('X2', { context: null, queue: ['X3'] });
r = await poll();
check('X1 → X2 auto_next', r.kind === 'auto_next', r);

await playing('X2', { progress: 100_000, isPlaying: false, context: null, queue: ['X3'] });
r = await poll();
check('pause on X2 is the same song', r.same === 'Song X2', r);
await mockSet({ player: null });
r = await poll();
check('nothing playing is idle', r.idle === true, r);

await playing('X3', { context: null, queue: ['X4'] });
r = await poll();
check('resume onto next queued song keeps the chain (pauses never break)', r.chainId === chain1 && !r.chainBreak, r);

console.log('— sync: create the growing playlist');
r = await sync();
check('sync ran', r.chains && r.chains[chain1], r);
let st = await mockState();
let pl = Object.values(st.playlists)[0];
check('one playlist created', Object.keys(st.playlists).length === 1, Object.keys(st.playlists));
check('live name', pl?.name === `Album L · Chain · ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} (live)`, pl?.name);
check('skipped S2 and still-playing X3 left out', JSON.stringify(pl?.items) === JSON.stringify(['S1', 'S3', 'X1', 'X2'].map((x) => `spotify:track:${x}`)), pl?.items);
check('playlist is private', pl?.public === false, pl);

r = await sync();
st = await mockState();
check('second sync adds nothing (idempotent)', Object.values(st.playlists)[0].items.length === 4 && Object.keys(st.playlists).length === 1, r);

console.log('— manual pick ends chain 1');
await playing('X3', { progress: 150_000, context: null, queue: ['X4'] });
await poll(); // X3 mostly heard, then you pick something else
await playing('P1', { context: ctx('playlist', 'Q'), queue: ['P2'] });
r = await poll();
check('tapping a song outside the queue is manual_pick → new chain', r.kind === 'manual_pick' && r.chainBreak && r.chainId !== chain1, r);
const chain2 = r.chainId;

// recently-played: X3 (seen by the poller) and BF, a very short song that played between
// X2 and X3 without the poller ever seeing it.
const x3 = (await worker(`/api/chains/${chain1}`)).plays.find((p) => p.name === 'Song X3');
await mockSet({
  recent: [
    { played_at: new Date(x3.startedAt - 1).toISOString(), track: track('BF', 1), context: null },
    { played_at: new Date(Date.now()).toISOString(), track: track('X3'), context: null },
  ],
});
r = await sync();
check('reconcile matched 1, backfilled 1', r.reconciled?.matched === 1 && r.reconciled?.backfilled === 1, r.reconciled);
st = await mockState();
pl = Object.values(st.playlists)[0];
check('chain 1 finalized: backfilled BF and last song X3 appended in order', JSON.stringify(pl.items.slice(4)) === JSON.stringify(['spotify:track:BF', 'spotify:track:X3']), pl.items);
check('final name has the date, no (live)', !pl.name.includes('(live)') && pl.name.startsWith('Album L · Chain · '), pl.name);
check('final description', pl.description.includes('songs') && pl.description.includes('1 skip excluded'), pl.description);

let chains = (await worker('/api/chains')).chains;
const c1 = chains.find((c) => c.id === chain1);
const c2 = chains.find((c) => c.id === chain2);
check('chain 1 closed with a playlist', c1.status === 'closed' && c1.playlistStatus === 'created', c1);
check('chain 2 open, seeded by playlist name', c2.status === 'open' && c2.name === 'Playlist Q', c2);

console.log('— phone controls');
r = await worker('/api/break', 'POST');
check('break on a fresh chain is a no-op', typeof r.message === 'string', r);

await playing('P2', { progress: 0, context: ctx('playlist', 'Q'), queue: ['P3'] });
r = await poll();
check('Next from P1 to P2 continues chain 2', r.chainId === chain2 && r.kind === 'skip_next', r);

r = await worker('/api/break', 'POST');
check('break splits at the current song', r.newChainId > chain2, r);
const chain3 = r.newChainId;
let status = await worker('/api/status');
check('current chain is the new one', status.current?.id === chain3, status.current?.id);

r = await worker('/api/keep', 'POST');
check('keep merges it back', r.mergedInto === chain2, r);
status = await worker('/api/status');
check('current chain is chain 2 again', status.current?.id === chain2, status.current?.id);

const detail = await worker(`/api/chains/${chain2}`);
const p2 = detail.plays.find((p) => p.name === 'Song P2');
r = await worker(`/api/chains/${chain2}/split`, 'POST', { playId: p2.id });
check('split from the dashboard', r.newChainId > 0, r);
r = await worker(`/api/chains/${r.newChainId}/merge-prev`, 'POST');
check('merge with previous from the dashboard', r.mergedInto === chain2, r);

r = await owner.raw(`/api/chains/${chain1}/merge-prev`, "POST");
check('cannot merge a chain that already has a playlist', r.status === 409 || r.status === 400, r);

r = await worker(`/api/chains/${chain1}/rename`, 'POST', { name: 'Sunday drive' });
st = await mockState();
check('rename updates the Spotify playlist', Object.values(st.playlists)[0].name === 'Sunday drive', Object.values(st.playlists)[0].name);

r = await worker('/api/current-playlist');
check('current-playlist returns a link', r.url?.startsWith('https://open.spotify.com/playlist/'), r);

r = await worker(`/api/chains/${chain2}/create`, 'POST');
st = await mockState();
check('Create now makes chain 2 a playlist even though it is short', Object.keys(st.playlists).length === 2, r);

r = await worker('/api/tracking', 'POST', { on: false });
check('pause tracking', r.tracking === false, r);
r = await poll();
check('poll respects paused tracking', r.skipped === 'tracking is off', r);
await worker('/api/tracking', 'POST', { on: true });

console.log('— more people');
const alice = await signIn('alice');
check('alice signs in with Spotify and gets a session', alice.status === 302 && !!alice.session, alice);
let aliceStatus = await alice.client.api('/api/status');
check('alice is her own user', aliceStatus.user?.name === 'User alice' && aliceStatus.current === null, aliceStatus.user);
check('seat count shows 2 of 2', aliceStatus.seats?.used === 2 && aliceStatus.seats?.max === 2, aliceStatus.seats);

let bob = await signIn('bob');
check('a third person is refused when all seats are taken', bob.status === 403 && bob.html.includes('all 2 seats are taken'), bob.status);
const stranger = await signIn('stranger');
check('someone not on the Spotify allow-list gets a clear message', stranger.status === 403 && stranger.html.includes('allowed on this app'), stranger.status);

const ownerSpotify = await signIn('owner');
check('owner signing in with Spotify lands on their existing data', ownerSpotify.status === 302, ownerSpotify.status);
const ownerChains = (await ownerSpotify.client.api('/api/chains')).chains;
check('…including the chain from before the upgrade', ownerChains.some((c) => c.name === 'Legacy chain') && ownerChains.some((c) => c.id === chain1), ownerChains.map((c) => c.name));

console.log('— isolation');
check('alice sees none of the owner’s chains', (await alice.client.api('/api/chains')).chains.length === 0);
check('alice cannot open the owner’s chain', (await alice.client.raw(`/api/chains/${chain1}`)).status === 404);
check('alice cannot rename the owner’s chain', (await alice.client.raw(`/api/chains/${chain1}/rename`, 'POST', { name: 'x' })).status === 404);
check('alice cannot split the owner’s chain', (await alice.client.raw(`/api/chains/${chain2}/split`, 'POST', { playId: 1 })).status === 404);

console.log('— cron fans out one run per user');
mockUser = 'alice';
await mockSet({ player: { item: track('A1'), progress_ms: 0, is_playing: true, context: null, device: { name: 'Pixel' } }, queue: [track('A2')] });
mockUser = 'owner';
const before = (await mockState()).calls.length;
check('minute cron ran', (await cron('* * * * *')).includes('Ran scheduled event'));
const calls = (await mockState()).calls.slice(before);
check('the cron polled both users', calls.includes('alice GET /v1/me/player') && calls.includes('owner GET /v1/me/player'), calls);
aliceStatus = await alice.client.api('/api/status');
check('alice’s first song started her own chain', aliceStatus.current?.recent?.[0]?.name === 'Song A1' && aliceStatus.nowPlaying?.device === 'Pixel', aliceStatus.current);
check('the owner’s chain is untouched', (await worker('/api/status')).current?.id === chain2);
check('sync cron runs for every user', (await cron('*/15 * * * *')).includes('Ran scheduled event'));
r = await call(WORKER, '/internal/poll', 'POST', { userId: 1 });
check('the internal fan-out route is hidden from the internet', r.status === 404, r.status);

console.log('— personal Shortcut tokens');
const t1 = (await alice.client.api('/api/shortcut-token', 'POST')).token;
check('alice gets a Shortcut token', typeof t1 === 'string' && t1.length > 20);
check('it acts as alice', (await as({ authorization: `Bearer ${t1}` }).api('/api/status')).user?.name === 'User alice');
const t2 = (await alice.client.api('/api/shortcut-token', 'POST')).token;
check('a new token replaces the old one', (await as({ authorization: `Bearer ${t1}` }).raw('/api/status')).status === 401);
check('the new token works', (await as({ authorization: `Bearer ${t2}` }).api('/api/status')).user?.name === 'User alice');

console.log('— per-user settings');
check('bad ntfy topic is rejected', (await alice.client.raw('/api/settings', 'POST', { ntfyTopic: 'bad topic!' })).status === 400);
check('alice sets her own ntfy topic', (await alice.client.api('/api/settings', 'POST', { ntfyTopic: 'alice-chains' })).ntfyTopic === 'alice-chains');
check('…without changing the owner’s', (await worker('/api/settings')).ntfyTopic === '');

console.log('— leaving frees the seat');
check('alice deletes her data', (await alice.client.api('/api/account/delete', 'POST')).ok === true);
check('her session no longer works', (await alice.client.raw('/api/status')).status === 401);
check('her Shortcut token no longer works', (await as({ authorization: `Bearer ${t2}` }).raw('/api/status')).status === 401);
bob = await signIn('bob');
check('bob can now take the free seat', bob.status === 302, bob.status);
check('seats: 2 of 2 again', (await bob.client.api('/api/status')).seats?.used === 2);

console.log('— auth');
r = await fetch(WORKER + '/api/status');
check('API rejects requests without a token', r.status === 401, r.status);
check('API rejects a made-up token', (await as({ authorization: 'Bearer nope' }).raw('/api/status')).status === 401);
r = await fetch(WORKER + '/logout', { method: 'POST', redirect: 'manual', headers: { cookie: ownerSpotify.session } });
check('sign out ends the session', (await ownerSpotify.client.raw('/api/status')).status === 401);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
