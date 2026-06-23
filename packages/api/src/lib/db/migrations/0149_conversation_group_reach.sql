-- Migration 0149: per-conversation Group reach (#3895, ADR-0022 slice (c)).
--
-- Cross-group reach: the agent ranges across every visible Connection group by
-- default (All sources); a conversation may instead FOCUS on exactly one group
-- — a hard, exclusive narrowing where only that group is reachable. This column
-- persists that reach axis per-conversation:
--   - NULL (the default)    → All sources: every visible group is reachable and
--                             the agent routes per question via the Source
--                             catalog (ADR-0022 §4).
--   - <connection_group_id> → Focus → that group: only it is reachable;
--                             executeSQL REJECTS any other group target — never
--                             a silent re-route to a different source (#3867(b)).
--
-- Reach is the axis ABOVE member routing (`routing_mode` Auto/Pin/All), which
-- stays an intra-group concern. REST scope (`rest_*_datasource_id`) is a
-- separate axis and is unchanged. This column is what feeds the slice-(a) reach
-- resolver (#3893) so Focus actually bounds executeSQL. See ADR-0022 §5.
--
-- Clean break (pre-customer posture, CONTEXT.md §Deployment posture): a
-- conversation already bound to a single group (`connection_group_id`) was,
-- pre-ADR-0022, reachable only within that group — which IS Focus → that group.
-- Backfill it so the migration preserves behavior. New conversations default to
-- All sources (NULL). No deprecation shim — the two internal workspaces absorb
-- the break.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op on re-run; the backfill is
-- guarded on `group_reach IS NULL` so a re-run never re-stamps a row an operator
-- has since changed.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS group_reach text;

-- Behavior-preserving backfill: existing group-bound conversations → Focus.
UPDATE conversations
  SET group_reach = connection_group_id
  WHERE connection_group_id IS NOT NULL AND group_reach IS NULL;

COMMENT ON COLUMN conversations.group_reach IS
  'Per-conversation Group reach (#3895, ADR-0022). NULL = All sources (every visible Connection group reachable; the agent routes per question). A connection_group_id value = Focus → that group (hard/exclusive: only it is reachable, executeSQL rejects any other group — no substitution). Above member routing (routing_mode); REST scope is a separate axis. Existing group-bound rows backfilled to Focus (behavior-preserving).';
