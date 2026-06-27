-- Migration 0157: Add `cli` to the two approval-surface origin CHECK enums
-- (ADR-0026 / #4043).
--
-- The `atlas login` device-authorization flow admits a workspace-scoped CLI
-- bearer audited as `origin=cli`. The agent-origin enum (ADR-0015) therefore
-- gains `cli` so an admin can scope an approval rule to the CLI transport and
-- so a `cli`-origin approval request validates against the queue CHECK.
--
-- Mirrors the per-platform enum bumps (0095 telegram … 0101 gchat) but against
-- the post-rename constraint names from 0133 (`chk_approval_rule_origin` /
-- `chk_approval_request_origin`, column `origin`). Widening a CHECK with one
-- more allowed value is expand-only — backward-compatible and single-release
-- safe (old code never writes `cli`; new code does; a reader sees a plain
-- string either way).
--
-- All statements are idempotent — DROP CONSTRAINT IF EXISTS then re-ADD, same
-- shape as 0095 / 0099 / 0100 / 0101.

-- ── approval_rules.origin ────────────────────────────────────────────

ALTER TABLE approval_rules DROP CONSTRAINT IF EXISTS chk_approval_rule_origin;
ALTER TABLE approval_rules
  ADD CONSTRAINT chk_approval_rule_origin
  CHECK (origin IN ('any', 'chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'whatsapp', 'gchat', 'webhook', 'cli'));

COMMENT ON COLUMN approval_rules.origin IS
  'Agent origin this rule applies to (renamed from "surface" in ADR-0015 / #3491). ''any'' fires for every request (pre-2072 default); ''chat'' / ''mcp'' / ''scheduler'' / ''slack'' / ''teams'' / ''telegram'' / ''discord'' / ''whatsapp'' / ''gchat'' / ''webhook'' / ''cli'' scope to the named transport (''cli'' = the atlas-login device flow, ADR-0026). See packages/api/src/lib/approvals/evaluate.ts.';

-- ── approval_queue.origin ────────────────────────────────────────────

ALTER TABLE approval_queue DROP CONSTRAINT IF EXISTS chk_approval_request_origin;
ALTER TABLE approval_queue
  ADD CONSTRAINT chk_approval_request_origin
  CHECK (origin IS NULL OR origin IN ('chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'whatsapp', 'gchat', 'webhook', 'cli'));

COMMENT ON COLUMN approval_queue.origin IS
  'Agent origin of the request that produced this approval row (renamed from "surface" in ADR-0015 / #3491). NULL for legacy rows or callers that did not stamp an origin; ''cli'' = the atlas-login device flow (ADR-0026).';
