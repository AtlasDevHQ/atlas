-- Migration 0052: Surface-scoped approval rules (#2072).
--
-- Pre-2072, an approval rule fired regardless of where the query came from —
-- chat, MCP, scheduler, Slack, etc. all triggered identically. The new
-- `surface` column lets admins narrow rules to a single transport so they
-- can author "MCP-only requires approval; chat doesn't" or "scheduler is
-- pre-approved" without forcing the all-or-nothing tradeoff.
--
-- Backwards compatibility:
--   - DEFAULT 'any' on `approval_rules.surface` preserves pre-2072 firing
--     semantics — every existing row reads `'any'` and matches every request
--     surface via the rule-evaluator's `surface = 'any' OR surface = $req`
--     predicate. Migration is non-destructive (acceptance criterion).
--
-- CHECK constraint shapes:
--   - `approval_rules.surface` includes `'any'` (rule-side) so admins can
--     opt out of surface scoping. Pinned to the seven canonical values; a
--     typo like 'msc' is rejected at write-time rather than silently
--     mismatching every request.
--   - `approval_queue.surface` is request-side and does NOT include `'any'`
--     (a real request always originated from a specific surface). NULL is
--     allowed for legacy rows and for callers that haven't stamped surface
--     yet — these read as "unknown origin" and only match `'any'` rules.
--
-- Index choice: btree on `(org_id, surface)`. The hot lookup is
-- "rules for this workspace where surface = X OR surface = 'any'", so the
-- composite key supports both branches with a single index. No partial
-- WHERE because the column is NOT NULL on `approval_rules`.

ALTER TABLE approval_rules
  ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'any';

DO $$ BEGIN
  ALTER TABLE approval_rules
    ADD CONSTRAINT chk_approval_rule_surface
    CHECK (surface IN ('any', 'chat', 'mcp', 'scheduler', 'slack', 'teams', 'webhook'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_approval_rules_org_surface
  ON approval_rules (org_id, surface);

-- Audit dimension: stamp the request's origin on each queued approval
-- row so reviewers can break down approvals by surface (queryable via
-- direct SQL against admin_action_log.metadata->>'surface' and this
-- column today; a filterable admin UI is planned, not yet shipped).
-- NULL for legacy rows preserved on existing data.
ALTER TABLE approval_queue
  ADD COLUMN IF NOT EXISTS surface TEXT;

DO $$ BEGIN
  ALTER TABLE approval_queue
    ADD CONSTRAINT chk_approval_request_surface
    CHECK (surface IS NULL OR surface IN ('chat', 'mcp', 'scheduler', 'slack', 'teams', 'webhook'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN approval_rules.surface IS
  'Origin surface this rule applies to. ''any'' fires for every request (pre-2072 default); ''chat'' / ''mcp'' / ''scheduler'' / ''slack'' / ''teams'' / ''webhook'' scope to the named transport. See packages/api/src/lib/approvals/evaluate.ts (#2072).';
COMMENT ON COLUMN approval_queue.surface IS
  'Origin surface of the request that produced this approval row. NULL for legacy rows or callers that did not stamp surface (#2072).';
