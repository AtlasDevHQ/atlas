-- Migration 0133: Rename the approval "surface" column to "origin" (#3491).
--
-- ADR-0015 renames the agent-invocation-channel concept (chat / mcp /
-- scheduler / slack / …) from "surface" to "agent origin", freeing the
-- bare word "surface" for the pillar admin-page concept. The enum VALUES
-- are unchanged — only the column, its CHECK constraints, and the lookup
-- index are renamed.
--
-- One-shot breaking rename, NOT an expand/contract dance: we are in the
-- pre-customer clean-break window (CONTEXT.md "Deployment posture";
-- ADR-0015 explicitly authorizes this), so there is no N-1↔N deploy
-- overlap to protect and no data to backfill — RENAME COLUMN is in-place
-- and preserves every existing row's value.
--
-- Idempotent AND schema-scoped: each rename is guarded so a re-run (or a
-- deploy that partially applied) is a no-op rather than an error. Every
-- existence check is pinned to `current_schema()` — the migrate-pg /
-- rotate-encryption-key tests run migrations under per-test schemas, and
-- an unscoped `information_schema`/`pg_constraint` probe would see another
-- schema's already-renamed `origin` column, skip the rename here, then
-- trip the unconditional COMMENT with "column origin does not exist".
-- Postgres has no `ALTER ... RENAME ... IF EXISTS` for columns/constraints,
-- hence the DO-block guards; `ALTER INDEX ... RENAME` does support IF EXISTS.

-- ── approval_rules.surface → origin ──────────────────────────────────

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'approval_rules' AND column_name = 'surface'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'approval_rules' AND column_name = 'origin'
  ) THEN
    ALTER TABLE approval_rules RENAME COLUMN surface TO origin;
  END IF;
END $$;

-- Rename the CHECK constraint. Renaming the column above auto-updates the
-- constraint's stored column reference; this only renames the constraint
-- identifier so it reads `chk_approval_rule_origin` to match.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_approval_rule_surface'
      AND connamespace = current_schema()::regnamespace
  ) THEN
    ALTER TABLE approval_rules
      RENAME CONSTRAINT chk_approval_rule_surface TO chk_approval_rule_origin;
  END IF;
END $$;

ALTER INDEX IF EXISTS idx_approval_rules_org_surface
  RENAME TO idx_approval_rules_org_origin;

COMMENT ON COLUMN approval_rules.origin IS
  'Agent origin this rule applies to (renamed from "surface" in ADR-0015 / #3491). ''any'' fires for every request (pre-2072 default); ''chat'' / ''mcp'' / ''scheduler'' / ''slack'' / ''teams'' / ''telegram'' / ''discord'' / ''whatsapp'' / ''gchat'' / ''webhook'' scope to the named transport. See packages/api/src/lib/approvals/evaluate.ts.';

-- ── approval_queue.surface → origin ──────────────────────────────────

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'approval_queue' AND column_name = 'surface'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'approval_queue' AND column_name = 'origin'
  ) THEN
    ALTER TABLE approval_queue RENAME COLUMN surface TO origin;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_approval_request_surface'
      AND connamespace = current_schema()::regnamespace
  ) THEN
    ALTER TABLE approval_queue
      RENAME CONSTRAINT chk_approval_request_surface TO chk_approval_request_origin;
  END IF;
END $$;

COMMENT ON COLUMN approval_queue.origin IS
  'Agent origin of the request that produced this approval row (renamed from "surface" in ADR-0015 / #3491). NULL for legacy rows or callers that did not stamp an origin.';
