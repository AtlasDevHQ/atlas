-- 0029 — per-user favorite starter prompts (#1475, PRD #1473).
--
-- Personal-productivity tier for the adaptive starter-prompt surface. A user
-- pins text from their own chat history and it always renders ahead of the
-- popular and library tiers in their empty state — even if an admin later
-- hides the underlying popular suggestion. This is an explicit carve-out
-- from the 1.2.0 draft/published mode system: pins are per-user, instant,
-- never drafted.
--
-- The hard cap on pins-per-user is enforced in `FavoritePromptStore` rather
-- than at the schema layer so the default (10) can be raised per deployment
-- via ATLAS_STARTER_PROMPT_MAX_FAVORITES without a migration.
--
-- `position` is a DOUBLE PRECISION to keep reorders O(1) — inserting between
-- two pins only requires writing the mean of their positions, not renumbering
-- the whole row. Created pins get MAX(position) + 1 so newest sorts first.

CREATE TABLE IF NOT EXISTS user_favorite_prompts (
  id         UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT             NOT NULL,
  org_id     TEXT             NOT NULL,
  text       TEXT             NOT NULL,
  position   DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- Prevent the same user from pinning the same text twice in a workspace.
-- md5() wrapping keeps the btree under Postgres's 8191-byte page-tuple limit
-- even when a user accidentally pins a very long message.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_favorite_prompts
  ON user_favorite_prompts(user_id, org_id, md5(text));

-- Resolver path: list all pins for (user, org), ordered by position DESC.
CREATE INDEX IF NOT EXISTS idx_user_favorite_prompts_user_org
  ON user_favorite_prompts(user_id, org_id, position DESC, created_at DESC);
