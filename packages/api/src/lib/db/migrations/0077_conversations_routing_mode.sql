-- 0077 — Per-conversation routing-mode picker state (PRD #2515, issue #2518).
--
-- Adds `conversations.routing_mode` to record which of the three picker
-- states the user pinned the conversation to:
--
--   - 'auto'  — agent decides per-turn (default for new conversations
--               created via the Auto picker mode);
--   - 'pin'   — force single-env execution against the row's stored
--               `connection_id`; agent's `scope` override is ignored;
--   - 'all'   — force fanout across every member of the active group;
--               agent's `scope` override is ignored.
--
-- Nullable on purpose. Pre-#2518 rows have no concept of picker mode but
-- carry a non-null `connection_id`. The runtime reads NULL as "pin"
-- (back-compat — the conversation already names a single member; the
-- safest interpretation is "stay pinned to that member") so existing
-- chats behave unchanged after migration.
--
-- No CHECK constraint at the DB layer. Validation lives in the chat
-- route's Zod schema (single source of truth); a CHECK here would only
-- duplicate it while adding migration-ordering risk for future picker
-- modes.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS routing_mode TEXT;

