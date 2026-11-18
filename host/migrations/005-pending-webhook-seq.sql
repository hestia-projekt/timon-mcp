-- Occurrence counts for the pending webhook id. One row per card.
-- host_pending_cards drops resolved rows past the cap. These counts stay,
-- so a card that comes back after that still gets a fresh webhook-id.
-- A count is written when that occurrence is recorded, not before: a
-- restart that resends an unrecorded occurrence keeps the same id.

CREATE TABLE IF NOT EXISTS host_pending_webhook_seq (
  id TEXT PRIMARY KEY,
  pending_seq INTEGER NOT NULL DEFAULT 0,
  resolved_seq INTEGER NOT NULL DEFAULT 0
);
