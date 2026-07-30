-- 0185 — backfill `botUserId` into Slack installation rows (#4907).
--
-- #4907: Atlas's OAuth handler replaced the chat-adapter's own OAuth
-- callback, which was the only writer of `botUserId` into
-- `chat_cache:slack:installation:<teamId>`. The handler captured
-- `bot_user_id` from `oauth.v2.access` and wrote it to
-- `workspace_plugins.config` — the Atlas-side store — but never to the
-- row the adapter actually reads.
--
-- With that field absent, `@chat-adapter/slack`'s `isMessageFromSelf`
-- has no working input in multi-workspace mode: its two instance-field
-- checks are null without a single-workspace bot token, leaving only the
-- request-context check that this row feeds. Every message Atlas posts
-- then reads back as a user message, and in a subscribed thread or a DM
-- that is an unbounded reply loop.
--
-- The code fix only takes effect on the NEXT install. Every workspace
-- installed before it keeps looping, so this closes the residual set the
-- same way 0184 did for ownerless SCIM providers. The repair data is
-- already on disk: `workspace_plugins.config->>'bot_user_id'` has been
-- written correctly all along.
--
-- Idempotent (skips rows that already carry the key) and conservative:
-- it only fills from a Slack install whose recorded `team_id` matches the
-- cache key's team, so it can never staple one workspace's bot id onto
-- another's row. Workspaces whose install predates `bot_user_id` capture
-- have nothing to copy and are left alone — they need a reconnect, and
-- the install-time warning now says so.
--
-- NOTE: targets the default `chat_cache` table. A self-hosted deploy
-- that overrides `ATLAS_SLACK_INSTALL_TABLE` must run the equivalent
-- statement against its own table; migrations cannot read that env var.

UPDATE chat_cache c
SET value = c.value || jsonb_build_object('botUserId', wp.config->>'bot_user_id')
FROM workspace_plugins wp
WHERE c.key LIKE 'slack:installation:%'
  AND c.value->>'botUserId' IS NULL
  AND wp.catalog_id = 'catalog:slack'
  AND wp.config->>'bot_user_id' IS NOT NULL
  AND wp.config->>'team_id' = substring(c.key FROM length('slack:installation:') + 1);
