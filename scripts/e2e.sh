#!/usr/bin/env bash
# Runs the real Worker locally (fresh local D1) against the mock Spotify and plays a full scenario.
set -euo pipefail
cd "$(dirname "$0")/.."
STATE=.wrangler/e2e-state
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
rm -rf "$STATE"

d1() { npx wrangler d1 execute spotify-chains --local --persist-to "$STATE" "$@" >/dev/null; }
# Start from the single-user schema with some existing data, then upgrade, like production.
d1 --file migrations/0001_init.sql
d1 --command "INSERT INTO auth (id, refresh_token, expires_at) VALUES (1, 'rt-owner', 0);
  INSERT INTO chains (id, started_at, seed_type, seed_uri, seed_name, start_kind, status, playlist_status, finalized, created_at)
    VALUES (1, 1000, 'track', 'spotify:track:old', 'Legacy chain', 'first', 'closed', 'discarded', 1, 1000);
  INSERT INTO plays (chain_id, track_id, track_uri, name, artists, duration_ms, started_at, source, kind)
    VALUES (1, 'old', 'spotify:track:old', 'Old song', 'Someone', 1000, 1000, 'poller', 'first');"
d1 --file migrations/0002_multi_user.sql

node scripts/mock-spotify.mjs & MOCK_PID=$!
npx wrangler dev --port 8787 --persist-to "$STATE" --env-file scripts/e2e.vars --test-scheduled --log-level warn > .wrangler/e2e-dev.log 2>&1 & DEV_PID=$!
trap 'kill $MOCK_PID $DEV_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -sf -o /dev/null http://127.0.0.1:8787/ && break
  sleep 1
done
node scripts/e2e.mjs
