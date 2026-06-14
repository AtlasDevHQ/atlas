-- 0135: Add 'datasource' rule_type to approval_rules (#3573, ADR-0016 gate 4).
--
-- Gate 4 of the MCP dispatch pipeline (approval) matches destructive datasource
-- MCP actions against approval rules. Before this migration the `chk_approval_rule_type`
-- CHECK constraint allowed only 'table', 'column', 'cost'; a
-- `rule_type='datasource'` pattern was rejected on insert so no admin could
-- create a datasource-scoped rule, and `delete_datasource` (which stamps
-- `tablesAccessed: ['datasource:<id>']`) always got `required: false`.
--
-- This migration:
--   1. Drops the old CHECK constraint.
--   2. Re-adds it with 'datasource' included.
--
-- The corresponding `APPROVAL_RULE_TYPES` type + schema.ts mirror + matcher
-- logic in ee/src/governance/approval.ts land in the same PR (check-schema-drift
-- will fail without the schema.ts update).

ALTER TABLE approval_rules
  DROP CONSTRAINT IF EXISTS chk_approval_rule_type;

ALTER TABLE approval_rules
  ADD CONSTRAINT chk_approval_rule_type
    CHECK (rule_type IN ('table', 'column', 'cost', 'datasource'));
