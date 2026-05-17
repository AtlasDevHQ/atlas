-- 0080 — proactive_public_dataset (+ public_refused meter event type).
--
-- Slice #2297, PRD #2291. Closes the unlinked-asker stub left by #2293:
-- when a chat user reacts to an Atlas-suggested answer and isn't OAuth'd
-- to a workspace user, Atlas can still respond — but only against the
-- curated set of semantic entities a workspace admin has marked
-- "public". The HITL design decisions captured on issue #2297 (comment
-- dated 2026-05-17) shape this schema:
--
--   1. Granularity: entity-level for v1. One row per (workspace,
--      fully-qualified entity name). `deny_metrics` is the escape
--      hatch for "include `users` but never `users.email`" — list of
--      column / measure names that block a public-asker query even
--      when the entity itself is allowed.
--
--   2. Default state: empty allowlist. No auto-population. The admin
--      UI surfaces a "Start with these top-line metrics" preview button
--      so an admin can opt in without stealth defaults baking in.
--
--   3. Cross-entity joins: strict. If `revenue` joins to `customers`
--      and `customers` is not in the allowlist, the query is refused.
--      Enforcement lives in `isEntityAllowed` (see
--      `lib/proactive/public-dataset.ts`).
--
--   4. Refusal copy: content-blind. Listener emits a `public_refused`
--      meter event so the admin analytics panel can surface a "Refused
--      topics" rollup with an inline "Make `<entity>` public" button.
--      The `metadata.entityName` field on that row is what powers the
--      rollup. Adding the event type means extending the existing
--      `chk_proactive_meter_event_type` CHECK constraint — the only
--      change to `proactive_meter_events` in this migration.
--
-- One unique index on (workspace_id, entity_name) — POSTing the same
-- entity twice updates the existing row rather than creating a
-- duplicate. The admin UI uses this so a save-and-reopen idempotently
-- reproduces the allowlist.

CREATE TABLE IF NOT EXISTS proactive_public_dataset (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT NOT NULL,
  entity_name     TEXT NOT NULL,
  deny_metrics    TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_proactive_public_dataset_workspace_entity
  ON proactive_public_dataset (workspace_id, entity_name);

CREATE INDEX IF NOT EXISTS idx_proactive_public_dataset_workspace
  ON proactive_public_dataset (workspace_id);

-- Extend the proactive_meter_events CHECK constraint to admit the new
-- `public_refused` event type. Backwards compatible — every existing
-- value stays valid.
ALTER TABLE proactive_meter_events
  DROP CONSTRAINT IF EXISTS chk_proactive_meter_event_type;

ALTER TABLE proactive_meter_events
  ADD CONSTRAINT chk_proactive_meter_event_type
  CHECK (event_type IN ('classify', 'react', 'offer', 'accept', 'feedback', 'public_refused'));
