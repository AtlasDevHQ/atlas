-- 0166 — Per-conversation answer style (PRD #4292, issue #4302).
--
-- Adds `conversations.answer_style` to record the answer style (the
-- editorial voice of the agent's answers — lib/answer-styles.ts) the user
-- pinned the conversation to via the chat-header picker:
--
--   - 'plain-english' — short plain prose for business users;
--   - 'analyst'       — the answer-first web default;
--   - 'executive'     — headline + proof/provenance;
--   - 'conversational'— the chat-platform (Slack) voice; a legal persisted
--                       value but not offered by the web picker.
--
-- Nullable on purpose. NULL means "no explicit choice": prompt assembly
-- resolves it to the live default — the workspace default
-- (ATLAS_DEFAULT_ANSWER_STYLE, #4303) when set, else the surface default
-- (`analyst` for web via DEFAULT_ANSWER_STYLE; chat-platform surfaces pass
-- `conversational` explicitly) — so pre-#4302 rows and untouched pickers
-- keep tracking the default rather than freezing a copy of it.
--
-- No CHECK constraint at the DB layer. Validation lives in the chat
-- route's Zod schema (z.enum over ANSWER_STYLE_NAMES — single source of
-- truth); a CHECK here would only duplicate it while adding
-- migration-ordering risk for future styles (same rationale as
-- 0077_conversations_routing_mode.sql).

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS answer_style TEXT;
