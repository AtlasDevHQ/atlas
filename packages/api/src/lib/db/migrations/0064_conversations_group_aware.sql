-- 0064 — Group-aware conversation routing (PRD #2336, issue #2345).
--
-- Adds `conversations.connection_group_id` as the *content scope* for a
-- chat (entity resolution, semantic-layer reads, dashboard scope). The
-- existing `connection_id` column stays as the *execution target* (which
-- replica the SQL actually runs against). Two columns, two purposes —
-- they are deliberately decoupled so a single conversation can resolve
-- entities through a multi-member "prod" group while a per-turn override
-- targets a specific replica (e.g. "us-int" for one question, "eu" for
-- the next).
--
-- The legacy `connection_id` column does NOT go away in this slice; it
-- is the deprecation tail tracked in #2346 / #2347.
--
-- No hard FK on `connection_group_id`. Conversations already carry
-- `connection_id` as a soft text reference (no FK) — the column is
-- audit-shaped, not relational. Mirroring that choice here keeps the
-- ergonomics aligned: a group can be deleted without RESTRICT-blocking
-- on long-lived chat history, and append-only conversation rows survive
-- group renames intact. Org-cross-group isolation is enforced by the
-- composite FK on `connections.group_id` (0062) — there is no path for a
-- `conversations.connection_group_id` value to point at a foreign-org
-- group unless the operator hand-edits the DB.

-- ── 1. Column ─────────────────────────────────────────────────────────
--
-- Nullable initially. Legacy conversations created before 0064 lacked
-- any concept of group scope; the backfill below resolves their value
-- from the existing `connection_id`. Conversations that never had a
-- `connection_id` (rare — pre-0034 self-hosted shapes) keep
-- `connection_group_id = NULL` and the runtime falls back to legacy
-- single-connection behavior, matching the prompt's acceptance
-- criterion ("missing group falls back to legacy behavior").
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS connection_group_id TEXT;

-- Lookup index for the content-scope read paths (e.g. resolving the
-- conversation's group for entity overlays). Co-locates `org_id` so the
-- access pattern matches `connections.group_id` (0062).
CREATE INDEX IF NOT EXISTS idx_conversations_group
  ON conversations (connection_group_id, org_id);

-- ── 2. Backfill ───────────────────────────────────────────────────────
--
-- Resolve every existing conversation's `connection_group_id` from its
-- `connection_id` via 0062's 1:1 mapping. The join allows either an
-- org-scoped connection or a `__global__` shadow (built-in / demo
-- connections moved to `__global__` by migration 0060), matching the
-- visibility resolution `loadOrgWhitelist` already uses for semantic
-- entities.
--
-- Idempotent: the predicate `connection_group_id IS NULL` ensures
-- re-runs (mid-migration retry, follow-up sweep) take no action on
-- rows already resolved.
UPDATE conversations c
   SET connection_group_id = conn.group_id
   FROM connections conn
   WHERE c.connection_id IS NOT NULL
     AND c.connection_group_id IS NULL
     AND conn.id = c.connection_id
     AND (conn.org_id = c.org_id OR conn.org_id = '__global__');
