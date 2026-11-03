-- Long-lived credentials for the command-line tool (worker/tokens.ts). Like
-- sessions they are stored hashed and end when the site's auth epoch moves on.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
