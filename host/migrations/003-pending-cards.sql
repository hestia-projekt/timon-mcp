-- Cards the pending poller has already announced.
-- The plugin migrations do not create this table: the daemon does not poll,
-- and this file is applied only by the standalone host.

CREATE TABLE IF NOT EXISTS host_pending_cards (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL CHECK (event IN ('pending', 'resolved')),
  projection TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS host_pending_cards_event ON host_pending_cards (event);
