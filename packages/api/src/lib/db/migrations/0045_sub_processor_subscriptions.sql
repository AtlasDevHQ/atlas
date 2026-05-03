-- 0045 — Sub-processor change-feed subscriptions + published snapshots (#1924).
--
-- Two tables, one logical feature:
--
--   sub_processor_subscriptions  Procurement-team-supplied webhook URLs +
--                                HMAC tokens. Rows are created via the
--                                /api/v1/sub-processor-subscriptions POST
--                                handler, gated by standardAuth so an
--                                authenticated Atlas user must register
--                                them. Tokens are encrypted at rest under
--                                the F-47 keyset (see INTEGRATION_TABLES
--                                in packages/api/src/lib/db/integration-tables.ts).
--
--   sub_processor_snapshots      Append-only history of every published
--                                sub-processor list. The publisher tick
--                                reads the most recent row, compares it
--                                against the live JSON (apps/www/data/
--                                sub-processors.json, served at the public
--                                URL configurable via ATLAS_SUBPROCESSORS_URL),
--                                fans out add/change/remove events to
--                                every subscription, and inserts a new row
--                                only when the payload differs.
--
-- Why two tables (and not one):
--   The subscription lifecycle (registered, valid, eventually deleted by
--   the customer) is independent of the snapshot lifecycle (immutable
--   audit log of what we published when). Coupling them would force
--   subscription deletes to ripple through the audit history, which
--   defeats the audit purpose.
--
-- Why no FK from snapshots → anything:
--   Snapshots are valuable independent of who was subscribed at the time.
--   The audit answer ("what did Atlas advertise as its sub-processor list
--   on 2026-04-15?") doesn't need a subscription join.
--
-- Issue: #1924

CREATE TABLE IF NOT EXISTS sub_processor_subscriptions (
  id                       TEXT        PRIMARY KEY,
  url                      TEXT        NOT NULL,
  token_encrypted          TEXT        NOT NULL,
  token_key_version        INT         NOT NULL DEFAULT 1,
  created_by_user_id       TEXT,
  created_by_email         TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Most queries (publisher delivery loop) walk the full table. No selective
-- index needed — the table is per-customer-team-procurement-contact small.
-- A unique index on (url) prevents accidental duplicate registrations from
-- the same procurement form double-submit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_processor_subscriptions_url
  ON sub_processor_subscriptions (url);

CREATE TABLE IF NOT EXISTS sub_processor_snapshots (
  id                       BIGSERIAL   PRIMARY KEY,
  payload                  JSONB       NOT NULL,
  payload_hash             TEXT        NOT NULL,
  published_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Latest-snapshot lookup (publisher tick reads ORDER BY published_at DESC LIMIT 1).
CREATE INDEX IF NOT EXISTS idx_sub_processor_snapshots_published_at
  ON sub_processor_snapshots (published_at DESC);
