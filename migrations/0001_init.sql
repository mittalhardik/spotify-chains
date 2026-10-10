-- Spotify OAuth tokens (single row).
CREATE TABLE auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  access_token  TEXT,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  scope         TEXT,
  updated_at    INTEGER
);

-- Last thing the poller saw (single row).
CREATE TABLE player_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot         TEXT,
  last_polled_at   INTEGER,
  prev_track_id    TEXT,
  current_play_id  INTEGER,
  current_chain_id INTEGER,
  updated_at       INTEGER
);

-- A chain = songs that kept playing from the queue without a manual pick.
CREATE TABLE chains (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  seed_type       TEXT NOT NULL,
  seed_uri        TEXT NOT NULL,
  seed_name       TEXT NOT NULL,
  start_kind      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',      -- open | closed
  playlist_status TEXT NOT NULL DEFAULT 'none',      -- none | creating | created | copy | too_short | discarded
  playlist_id     TEXT,
  playlist_url    TEXT,
  custom_name     TEXT,
  finalized       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- One row per song play. `kind` is how this song started (see src/poller.ts).
CREATE TABLE plays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id    INTEGER NOT NULL REFERENCES chains(id),
  track_id    TEXT NOT NULL,
  track_uri   TEXT NOT NULL,
  item_type   TEXT NOT NULL DEFAULT 'track',
  is_local    INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  artists     TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  played_at   INTEGER,
  context_uri TEXT,
  context_type TEXT,
  shuffle     INTEGER,
  device      TEXT,
  source      TEXT NOT NULL,                         -- poller | inferred | recent
  kind        TEXT NOT NULL,
  skipped     INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,            -- processed for the chain's playlist
  evidence    TEXT
);
CREATE INDEX plays_chain ON plays(chain_id, started_at);
CREATE INDEX plays_track ON plays(track_id, started_at);
CREATE UNIQUE INDEX plays_played_at ON plays(played_at) WHERE played_at IS NOT NULL;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Optional Last.fm tag cache, used only for playlist names.
CREATE TABLE artist_tags (
  artist     TEXT PRIMARY KEY,
  tags       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Manual actions from the dashboard / Shortcuts, kept for auditing.
CREATE TABLE markers (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  chain_id INTEGER,
  detail   TEXT
);
