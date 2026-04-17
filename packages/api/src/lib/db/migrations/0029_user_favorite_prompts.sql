-- 0029 — per-user favorite starter prompts.
--
-- The hard cap on pins-per-user is enforced in the service layer rather than
-- at the schema so the default (10) can be raised per deployment via
-- ATLAS_STARTER_PROMPT_MAX_FAVORITES without a schema migration.
--
-- `position` is DOUBLE PRECISION so a future drag-handle reorder can write a
-- float between two neighbors without renumbering the whole row. Today's
-- create path writes MAX(position) + 1 so new pins sort to the top.

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
