# Spotify Chains

Automatically turns what you listen to into Spotify playlists, one playlist per **chain**.

A chain is a run of songs that keeps playing from the queue **without you picking anything**:
- It starts when you tap a song, playlist or album, or a search result.
- It keeps going through the playlist or album, into Spotify autoplay, and across pauses. It can run for days.
- It ends the next time you pick something yourself.

Runs for $0 on a Cloudflare Worker with a D1 database. Up to **5 people** can use it, each signing in with their own Spotify account and getting their own chains, settings and playlists. Everyone controls it from their phone through a Home Screen web app and Siri Shortcuts.

## How it works

| Every minute | Every 15 minutes |
|---|---|
| Reads the player and the queue (`/me/player`, `/me/player/queue`) and classifies each song change | Lines the poller's plays up with `/me/player/recently-played`, then creates or grows playlists |

Each cron run hands every user's work to a separate run of the same Worker, through the `SELF` service binding (`src/index.ts`). That gives each user their own free-plan budget of 50 subrequests and 10 ms CPU, so one user's busy sync can't starve another's.

The API has no field saying *why* a song started, so the poller works it out from the queue and timing (`src/poller.ts`):

| What happened | Recorded as | Chain |
|---|---|---|
| Next queued song after the previous one finished | `auto_next` | continues |
| Next queued song after you pressed Next | `skip_next` | continues; the skipped song is left out |
| Back button | `back` | continues |
| Previous song finished and something outside the queue began right away | `autoplay` | continues |
| Pause, resume, nothing playing, switching device | — | continues |
| A song outside the queue while the previous one was cut short, resuming onto a different song, or jumping far down the queue | `manual_pick` | **new chain** |
| The poller was down for more than 5 minutes | `uncertain` | continues; flagged in the dashboard |

When a chain becomes a playlist (`src/chains.ts`, `src/jobs.ts`):
- **When it's created:** once the chain has at least 8 unique songs that weren't skipped. It is not created if 80% or more of those came from the one playlist or album you started it from, since you already have that.
- **While it grows:** new songs are added every 15 minutes. The song playing right now waits until it either finishes or is skipped.
- **When it's finalized:** at your next manual pick, the name changes to `Seed · Chain · Oct 6–8` and you get a push notification.
- **Review mode** is the default. Chains are tracked, but a playlist is only created when you tap **Create**. Switch to **Auto** in Settings once the chains look right.

## One-time setup

You need: Spotify **Premium** (Spotify requires it for Development Mode apps), a free Cloudflare account, and a GitHub account.

1. **Install dependencies and log in to Cloudflare**
   ```bash
   npm install
   ```
   ```bash
   npx wrangler login
   ```
2. **Create the database.** Copy the printed `database_id` into `wrangler.toml`.
   ```bash
   npx wrangler d1 create spotify-chains
   ```
   ```bash
   npm run db:migrate:remote
   ```
3. **Deploy once** to get your URL, `https://spotify-chains.<you>.workers.dev`.
   ```bash
   npx wrangler deploy
   ```
4. **Create the Spotify app** at <https://developer.spotify.com/dashboard>.
   - Redirect URI: `https://spotify-chains.<you>.workers.dev/auth/callback`
   - APIs used: Web API
   - Under **User Management**, add the email of your Spotify account.
5. **Set the secrets.** Each command prompts for the value.
   ```bash
   npx wrangler secret put SPOTIFY_CLIENT_ID
   ```
   ```bash
   npx wrangler secret put SPOTIFY_CLIENT_SECRET
   ```
   Optional: `LASTFM_KEY` adds genre tags to playlist names. Keys are free at <https://www.last.fm/api/account/create>.
   ```bash
   npx wrangler secret put LASTFM_KEY
   ```
6. **On your iPhone**, open the Worker URL in Safari and tap **Sign in with Spotify**. Then Share → **Add to Home Screen**.
   - The Home Screen app keeps its own login, so sign in once more the first time you open it.
   - In **Settings**, create your Siri Shortcuts token and, optionally, set your ntfy topic for push notifications.
7. **Auto-deploy (optional).** Push this folder to a **private** GitHub repo and add two repo secrets:
   - `CLOUDFLARE_API_TOKEN`: a token made from the "Edit Cloudflare Workers" template, with D1 edit access added.
   - `CLOUDFLARE_ACCOUNT_ID`.

   After that, every push to `main` runs the tests, applies migrations and deploys.

## Inviting people

Spotify only lets allow-listed accounts use a Development Mode app, at most 5 including you.
1. In the Spotify Developer Dashboard, open your app → **User Management**, then add the person's name and the email of their Spotify account.
2. Send them the Worker URL. They tap **Sign in with Spotify**; that creates their account here.

Each person sees only their own chains. If someone isn't on the allow-list, the sign-in page tells them so. Once all seats are taken, new sign-ins are refused. A seat frees up when someone taps **Delete my data** in Settings, which removes everything stored about them; playlists already in their Spotify stay there.

## iPhone Siri Shortcuts

Create each one in the Shortcuts app with the **Get Contents of URL** action:
- **Method:** POST, unless noted otherwise.
- **Header:** `Authorization` = `Bearer <your token>`. Each person creates their own token in **Settings → Siri Shortcuts token**.

| Shortcut (say it to Siri) | URL | Then |
|---|---|---|
| "Break chain" | `…/api/break` | Show Notification with the result |
| "Keep chain" (undo the last break) | `…/api/keep` | Show Notification |
| "Pause tracking" (toggles) | `…/api/tracking` | Get Dictionary Value `message` → Show Notification |
| "Open chain playlist" | `…/api/current-playlist` (GET) | Get Dictionary Value `url` → Open URLs |

## Dashboard

- **Live:** the song playing now, the current chain's stats, Break / Keep buttons, and the latest songs. Each song shows why it was classified the way it was.
- **Chains:** the history. Open a chain to Create, Rename, Merge with previous, Split at a song, or Discard.
  - Discarding never deletes a playlist that already exists in Spotify.
- **Settings:** Review/Auto mode, minimum songs, the copy threshold, timezone, ntfy topic, pause tracking, Shortcut token, seats used, and Delete my data.

## Development

```bash
npm test
```
```bash
npm run typecheck
```
```bash
npm run e2e
```

- `npm test` runs the unit tests for the classifier, chains, reconcile and naming.
- `npm run e2e` runs the real Worker and a local D1 database against a multi-user mock Spotify (`scripts/mock-spotify.mjs`). The database starts in the old single-user shape and is upgraded with migration 0002. The scenario then covers the chain logic (skip, autoplay, pause, manual pick; playlist create, grow, finalize), the phone controls, Spotify sign-in, the seat limit, data isolation between users, the cron fan-out, Shortcut tokens, and deleting an account.

To run against your real account locally:
1. Copy `.dev.vars.example` to `.dev.vars` and fill it in.
2. Add `http://127.0.0.1:8787/auth/callback` as a second redirect URI in the Spotify app.
3. Run the commands below, then trigger the crons by hand:
   ```bash
   npm run db:migrate:local
   ```
   ```bash
   npm run dev
   ```
   ```bash
   curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"
   ```
   ```bash
   curl "http://127.0.0.1:8787/__scheduled?cron=*/15+*+*+*+*"
   ```

## Capacity

**5 users**, including you. That limit is Spotify's: Development Mode allows 5 allow-listed users per app, and getting more requires Spotify's extended quota, which needs a registered business with 250K monthly users.

The Cloudflare free plan has room for far more, so it isn't the bottleneck. Rough per-user cost, assuming about 5 hours of listening a day:

| Free-plan limit | Per user per day | Users it would allow |
|---|---|---|
| 100K Worker requests | ~1,540 (1,440 polls + 96 syncs, each its own run) | ~60 |
| 100K D1 rows written | ~2,500–3,500 (1,440 player-state updates, plus plays and their indexes) | **~30** (lowest) |
| 5M D1 rows read | ~50K | ~100 |
| 500 MB database | ~30 MB a year | 5 users fit for ~3 years |
| 50 subrequests and 10 ms CPU per run | ~6–14 per poll, ≤40 per sync, ~1–2 ms CPU (per user, since each user gets their own run) | not a limit |
| 50 subrequests for the cron that fans out | 1 per user | ~45 |

Spotify's rate limit is per app over a rolling 30 seconds. At 2–3 calls per user per minute it isn't a concern.

## Limits and known gaps

- **Spotify Development Mode:** at most 5 allow-listed users, and the app owner needs Premium.
- **Queue order under shuffle:** Spotify's queue endpoint can list the wrong order when shuffle is on. A song that finishes on its own still counts as continuing. But pressing Next under shuffle onto a song the queue didn't list will look like a manual pick; use **Keep** to undo it.
- **Picking the very next queued song yourself** looks the same as pressing Next.
- **Legacy owner access:** the `API_TOKEN` and `NTFY_TOPIC` secrets from the single-user version still work, for user 1 only, so existing Shortcuts keep working. You can switch to a personal token in Settings and then delete `API_TOKEN`.
