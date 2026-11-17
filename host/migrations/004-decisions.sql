-- Decisions the host recorded after the daemon accepted them.
-- decided_by is an account id or the literal daemon-token. relayed_by is
-- the OAuth subject digest, or the literal static, and the channel.
-- An address cannot be stored: both columns reject '@'.
-- The plugin migrations do not create this table.

CREATE TABLE IF NOT EXISTS host_decisions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('question', 'series_plan', 'approval')),
  status TEXT NOT NULL CHECK (status IN ('allow', 'deny', 'answered', 'cancelled')),
  decided_by TEXT NOT NULL CHECK (length(decided_by) > 0 AND instr(decided_by, '@') = 0),
  relayed_by TEXT NOT NULL CHECK (length(relayed_by) > 0 AND instr(relayed_by, '@') = 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS host_decisions_created ON host_decisions (created_at, id);
