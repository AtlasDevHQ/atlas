-- 0136: Flip mcp_action_policy.status column DEFAULT 'blocked' → 'allowed' (#3578).
--
-- 0134 created the column as `status TEXT NOT NULL DEFAULT 'blocked'`, which
-- CONTRADICTS the documented default-allowed posture: a category is `allowed`
-- and represented by the ABSENCE of a row; gate 1 only blocks on an explicit
-- `status = 'blocked'` row. The sole writer (#3510 dashboard) always supplies an
-- explicit status, so the bad default is never exercised today — but a future
-- status-omitting INSERT would silently create a `blocked` row, disabling a
-- category no admin chose.
--
-- This is a FORWARD migration (not an edit of 0134) on purpose: migrations run
-- once by name (`SELECT name FROM __atlas_migrations`), so any environment that
-- already applied 0134 keeps the old default — only a new ALTER reaches them.
-- The Drizzle mirror in db/schema.ts (`mcpActionPolicy.status.default("allowed")`)
-- already reflects this final desired state.

ALTER TABLE mcp_action_policy
  ALTER COLUMN status SET DEFAULT 'allowed';
