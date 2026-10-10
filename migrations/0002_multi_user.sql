-- Multi-user. Every row now belongs to a user.
-- Data from the single-user version becomes user 1; its Spotify id is filled in by the next sync.

CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  spotify_id   TEXT UNIQUE,
  display_name TEXT,
  created_at   INTEGER NOT NULL
);

INSERT INTO users (id, created_at)
SELECT 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM auth)
   OR EXISTS (SELECT 1 FROM chains)
   OR EXISTS (SELECT 1 FROM settings)
   OR EXISTS (SELECT 1 FROM player_state);

-- auth: one row per user.
CREATE TABLE auth_new (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  access_token  TEXT,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  scope         TEXT,
  updated_at    INTEGER
);
INSERT INTO auth_new (user_id, access_token, refresh_token, expires_at, scope, updated_at)
SELECT 1, access_token, refresh_token, expires_at, scope, updated_at FROM auth;
DROP TABLE auth;
ALTER TABLE auth_new RENAME TO auth;

-- player_state: one row per user.
CREATE TABLE player_state_new (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id),
  snapshot         TEXT,
  last_polled_at   INTEGER,
  prev_track_id    TEXT,
  current_play_id  INTEGER,
  current_chain_id INTEGER,
  updated_at       INTEGER
);
INSERT INTO player_state_new (user_id, snapshot, last_polled_at, prev_track_id, current_play_id, current_chain_id, updated_at)
SELECT 1, snapshot, last_polled_at, prev_track_id, current_play_id, current_chain_id, updated_at FROM player_state;
DROP TABLE player_state;
ALTER TABLE player_state_new RENAME TO player_state;

-- settings: per user.
CREATE TABLE settings_new (
  user_id INTEGER NOT NULL REFERENCES users(id),
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
INSERT INTO settings_new (user_id, key, value) SELECT 1, key, value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- chains / plays / markers get an owner.
ALTER TABLE chains ADD COLUMN user_id INTEGER REFERENCES users(id);
UPDATE chains SET user_id = 1;
CREATE INDEX chains_user ON chains(user_id, id);
CREATE INDEX chains_user_sync ON chains(user_id, finalized, playlist_status);

ALTER TABLE plays ADD COLUMN user_id INTEGER REFERENCES users(id);
UPDATE plays SET user_id = 1;
DROP INDEX plays_played_at;
CREATE UNIQUE INDEX plays_played_at ON plays(user_id, played_at) WHERE played_at IS NOT NULL;
CREATE INDEX plays_user_start ON plays(user_id, started_at);

ALTER TABLE markers ADD COLUMN user_id INTEGER REFERENCES users(id);
UPDATE markers SET user_id = 1;

-- Dashboard logins (cookie) and personal Siri Shortcut tokens. Only SHA-256 hashes are stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE api_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
