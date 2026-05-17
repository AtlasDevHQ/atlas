-- 0083 — Per-user staged destructive ops on dashboards (#2365, PRD #2362).
--
-- The bound chat agent's destructive ops (`removeCard`, `updateCardSql`)
-- do NOT mutate the user's draft directly. They stage as ghost changes
-- the user accepts or discards inline. Acceptance applies the change to
-- the user's draft via the versioning module (#2364); discard drops the
-- stage with no side-effects.
--
-- Shape (id, dashboard_id, user_id, kind, payload, status):
--
--   * `id` uuid — surrogate so multiple stages against the same card
--     coexist (e.g. agent stages a delete, user clarifies, agent restages
--     an SQL edit instead). Each stage is independently accepted /
--     discarded; we don't pre-collapse them server-side.
--   * `dashboard_id` uuid — FK ON DELETE CASCADE. A deleted dashboard
--     takes its stages with it (matches `dashboard_cards` /
--     `dashboard_user_drafts` cascade behavior).
--   * `user_id` text — per-user scope; teammates never see each other's
--     pending stages. Same `text` storage choice as `dashboards.owner_id`
--     + `dashboard_user_drafts.user_id` so the table works in every
--     auth mode without an FK to Better Auth's managed `user` table.
--   * `kind` text CHECK constrained to `remove_card` / `edit_sql` — the
--     only two destructive ops the bound agent has at #2365.
--   * `payload` jsonb — `{ cardId }` for `remove_card`,
--     `{ cardId, newSql, currentSql }` for `edit_sql`. Snapshotting
--     `currentSql` at stage time means the diff overlay in the UI never
--     drifts even if the underlying card changes (e.g. another safe-op
--     edit lands between stage and accept).
--   * `status` text CHECK constrained to `pending` / `applied` /
--     `discarded`. New stages default to `pending`. Acceptance flips to
--     `applied`; discard flips to `discarded`. We keep terminal rows
--     around (rather than DELETEing) so a future audit / history view
--     can show "what staged op resolved which card change."
--   * `applied_at` / `discarded_at` timestamptz — set at the moment of
--     the terminal transition. NULL until then. Both being NULL with
--     status != 'pending' is forbidden by the per-state CHECK on
--     `applied_at` / `discarded_at`.
--
-- No `org_id` column: org scope flows through the parent dashboard FK
-- and the route layer's `getDashboard(id, { orgId })` gate before any
-- stage operation. Duplicating org_id here would force a backfill on
-- every dashboard org move and create a second source of truth.
--
-- Intentionally OUT of the global content-mode publish system: stages
-- are per-user, transient, scoped to a draft. They never become workspace-
-- shared content; the workspace publish path is `dashboards.publishDraft`
-- (#2364) downstream of `acceptStagedChange`.

CREATE TABLE IF NOT EXISTS dashboard_stage_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  -- `remove_card` payload: { cardId }.
  -- `edit_sql`    payload: { cardId, newSql, currentSql }.
  kind text NOT NULL CHECK (kind IN ('remove_card', 'edit_sql')),
  payload jsonb NOT NULL,
  -- New stages default to `pending`. The two terminal states (`applied`
  -- and `discarded`) freeze the row — `acceptStagedChange` /
  -- `discardStagedChange` are no-ops on rows that aren't pending.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  discarded_at timestamptz,
  -- Terminal-state invariants: an `applied` row MUST have applied_at set
  -- and discarded_at NULL; a `discarded` row vice versa; `pending` rows
  -- have both NULL. Catches "we forgot to stamp the timestamp" bugs at
  -- INSERT/UPDATE time rather than at audit-read time.
  CONSTRAINT dashboard_stage_changes_timestamps_chk CHECK (
    (status = 'pending'   AND applied_at IS NULL AND discarded_at IS NULL)
    OR (status = 'applied'   AND applied_at IS NOT NULL AND discarded_at IS NULL)
    OR (status = 'discarded' AND discarded_at IS NOT NULL AND applied_at IS NULL)
  )
);

-- "List pending stages for THIS user on THIS dashboard" — powers the
-- per-user overlay query that runs every time the dashboard renders.
-- Cheap because pending stages per dashboard per user are typically <10.
CREATE INDEX IF NOT EXISTS idx_dashboard_stage_changes_user_pending
  ON dashboard_stage_changes (dashboard_id, user_id, status)
  WHERE status = 'pending';

-- "Look up a stage by id and verify dashboard ownership in one shot" —
-- powers accept/discard. The primary-key lookup is index-backed already
-- but we want the dashboard_id correlation cached too.
CREATE INDEX IF NOT EXISTS idx_dashboard_stage_changes_dashboard
  ON dashboard_stage_changes (dashboard_id);
