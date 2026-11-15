-- Indexes for the standalone host lists.
-- host_missions and host_tasks are created by the host process. They are not
-- part of the plugin migrations in migrations/: the daemon applies that
-- directory and has neither table. This file stays next to the host and is
-- numbered after 001-oauth.sql.

CREATE INDEX IF NOT EXISTS host_missions_created ON host_missions (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS host_tasks_created ON host_tasks (created_at DESC, id DESC);
