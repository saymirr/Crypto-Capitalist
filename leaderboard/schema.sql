-- Crypto Capitalist leaderboard schema (Cloudflare D1 / SQLite).
-- Apply locally:  npm run db:local
-- Apply remotely: npm run db:remote
-- Safe to run more than once.

-- One row per wallet: its best (highest lifetime earnings) signed score.
CREATE TABLE IF NOT EXISTS scores (
  wallet     TEXT PRIMARY KEY,      -- base58 Solana address (ed25519 public key)
  all_time   REAL NOT NULL,         -- lifetime earnings across hard forks, exactly as signed
  diamonds   INTEGER NOT NULL,      -- Diamond Hands, exactly as signed
  forks      INTEGER NOT NULL,      -- hard forks, exactly as signed
  updated_at INTEGER NOT NULL       -- server time (ms since epoch) the best score was stored
);
CREATE INDEX IF NOT EXISTS idx_scores_all_time ON scores(all_time DESC);

-- Per-wallet rate limit: time of the wallet's last accepted (validly signed) submission,
-- whether or not it improved the stored score. Kept apart from `scores` so that a
-- non-improving submission leaves the score row untouched.
CREATE TABLE IF NOT EXISTS submit_throttle (
  wallet         TEXT PRIMARY KEY,
  last_submit_at INTEGER NOT NULL   -- ms since epoch
);

-- Small counters. 'wallets' = number of rows in `scores`, kept up to date by the Worker when a
-- new wallet is stored, so requests never need COUNT(*) over the whole table. Seeded from the
-- current table; if you delete score rows by hand, re-sync it with:
--   UPDATE meta SET value = (SELECT COUNT(*) FROM scores) WHERE key = 'wallets';
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) SELECT 'wallets', COUNT(*) FROM scores;

-- Per-network rate limit for POST /submit: SHA-256 of the client IP (IPv6: its /64), the start
-- of its current one-hour window and how many validly signed submissions it made in it.
-- Expired rows are deleted by the Worker from time to time.
CREATE TABLE IF NOT EXISTS ip_throttle (
  ip_hash      TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,     -- ms since epoch
  hits         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ip_throttle_window ON ip_throttle(window_start);
