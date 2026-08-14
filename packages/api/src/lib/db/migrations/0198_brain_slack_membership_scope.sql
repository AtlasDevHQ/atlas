-- 0198 — One Slack install, not two (#5203, grill #5200 T3).
--
-- Retires `catalog:slack-history` as a separate install and moves the brain's
-- Slack ingest scope onto THE BOT'S CHANNEL MEMBERSHIP, minus an
-- admin-managed exclusion list.
--
-- ## What the retired install actually was
--
-- Not a credential and not an OAuth grant. Its own handler said so: it
-- "collects NO secret" and reused the workspace's existing Slack OAuth
-- install. It carried a channel list and nothing else, capped at 50, with
-- multiple installs expected beyond that. `slack-oauth-handler.ts` has granted
-- `channels:history` + `groups:history` since #4770, so there is no re-consent
-- here and never was — the double-install was never an auth problem.
--
-- It is also the documented cause of M1's failure: Atlas's own Slack was live
-- as a chat platform in all three prod regions with extraction enabled, and the
-- brain ingested nothing for four days — zero episodes, zero facts — because
-- the credential-free second install was never made. Every surface reported
-- green, because "the flag is on" and "the source is connected" were two facts
-- and the sync reported green on either.
--
-- ## The migration constraint this file exists to satisfy
--
-- **An existing workspace's ingest scope must not silently broaden.** A
-- workspace scoped to 3 channels out of 100 must not wake up ingesting 100.
--
-- The obvious implementation — enumerate the bot's channels here and write the
-- complement as exclusions — is refused on two counts. It is a Slack API call
-- per workspace inside a schema migration (the transaction below would hold
-- open across N network round-trips, on a runner that locks per FILE), and it
-- resolves membership at MIGRATION time for a scope that is defined at SYNC
-- time. So this file only CAPTURES the retired installs' channel sets, and the
-- first sync reconciles them against live membership
-- (`lib/brain/ingest/slack/scope.ts`).
--
-- ## `brain_slack_ingest_scope` — the three states, and the empty one is real
--
--   - **row absent** → the workspace never had a `slack-history` install. It
--     gets the new default: every channel the bot is in, minus exclusions.
--   - **row present, `reconciled_at IS NULL`, `legacy_channels` non-empty** →
--     the retired installs' union. Until the first sync reconciles, THIS is the
--     scope — narrower than membership, which is the point.
--   - **row present, `reconciled_at IS NULL`, `legacy_channels` EMPTY** → the
--     workspace HAD an install, but it contributed no usable channel scope: its
--     config was unparseable, or every install was disabled/archived. Scope is
--     EMPTY, so the workspace ingests nothing until reconcile — which is
--     exactly what it did before this migration, and it is the fail-closed
--     direction.
--   - **row present, `reconciled_at IS NOT NULL`** → reconciled; membership
--     minus exclusions governs from here on.
--
-- The empty array is admitted rather than forbidden BECAUSE of the third state.
-- An earlier cut used `NOT NULL` + a non-empty CHECK and skipped those
-- workspaces, which left them with no row — i.e. indistinguishable from a
-- workspace that never had an install, i.e. broadened from "ingests nothing" to
-- "ingests every channel the bot is in". The one class the constraint was
-- meant to make impossible was the one it silently admitted.

-- ---------------------------------------------------------------------------
-- The channel relation: observed membership + admin intent + probe health
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain_slack_channel (
  -- Better-Auth organization id. Workspace-global, TEXT/no-FK like every other
  -- org-scoped Atlas table.
  workspace_id text NOT NULL,
  channel_id text NOT NULL,

  -- ── Observed, refreshed from `users.conversations` every sync ────────────
  -- Nullable because a row can exist BEFORE the bot has ever been seen in the
  -- channel: an admin may exclude a channel pre-emptively, which writes intent
  -- with nothing observed yet.
  name text,
  -- ⚠️ DISPLAY ONLY. Grant derivation does NOT read this column — the client
  -- calls `conversations.info` per channel per pass and derives the
  -- `audience:` grant from THAT (`brain/ingest/slack/client.ts`,
  -- `getConversationInfo`'s header). A stale `false` here would publish an
  -- invite-only channel's contents org-wide, so the column that decides
  -- visibility is deliberately the live one and this is the one an admin reads.
  is_private boolean,
  is_archived boolean NOT NULL DEFAULT false,
  -- The scope predicate's first half. Default `false` so a row created by an
  -- exclusion is out of scope until membership is actually observed.
  is_member boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz,
  last_seen_at timestamptz,

  -- ── Admin intent: durable, and NOT derived from membership ───────────────
  -- Survives the bot leaving and rejoining the channel. That is the whole
  -- reason it is a column here rather than a diff computed per cycle: an
  -- exclusion is a confidentiality decision, and a decision that evaporates
  -- when someone kicks and re-invites the bot is not one.
  excluded_at timestamptz,
  exclusion_reason text,
  excluded_by text,

  -- ── The surviving two-probe verification (#5203 AC-4) ────────────────────
  -- The retired install handler probed every channel TWICE before persisting:
  -- `conversations.info` for existence/membership/visibility, and a
  -- ONE-MESSAGE `conversations.history` read for the history scopes, which
  -- `conversations.info` structurally cannot see (it is gated on
  -- `channels:read`, which the chat adapter's token already holds, so it
  -- returns fine for a token that cannot read a single message).
  --
  -- With the install gone the probes have no install-time to run at, so they
  -- become a PER-CHANNEL HEALTH CHECK recorded here and surfaced in admin.
  -- Losing them would turn three legible failures — "the bot isn't in that
  -- channel", "that channel doesn't exist", "the token can't read history" —
  -- back into silent per-cycle errors, which is the failure mode this whole
  -- ticket is about.
  health_status text,
  health_error text,
  health_checked_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, channel_id),

  -- Mirrors `SLACK_CHANNEL_ID_PATTERN`. `D…` (1:1 DM) ids are refused here as
  -- they were at the retired install's form: a DM's audience is two people, and
  -- ADR-0036 puts source-principal-resolution failure on the BLOCK side.
  -- Enforced in the schema as well as the writers because this id is
  -- interpolated into a `source_id` and into an `audience:` grant token, both
  -- stored keys.
  CONSTRAINT ck_brain_slack_channel_id_shape
    CHECK (channel_id ~ '^[CG][A-Z0-9]{2,}$'),
  CONSTRAINT ck_brain_slack_channel_health_status
    CHECK (health_status IS NULL OR health_status IN ('ok', 'error')),
  -- An `error` health with no message is a red dot an admin cannot act on, and
  -- the probe always has a reason (it is Slack's own error code, mapped).
  CONSTRAINT ck_brain_slack_channel_health_error_present
    CHECK (health_status <> 'error' OR (health_error IS NOT NULL AND health_error <> '')),
  -- An exclusion is a confidentiality decision, so it carries its author. NOT
  -- NULL alone would admit `''`, which is an unattributed decision wearing the
  -- shape of an attributed one — `brain_predicate_cardinality`'s rule, and for
  -- the same reason: this is the first column an audit of "why did we stop
  -- reading that channel?" reads.
  CONSTRAINT ck_brain_slack_channel_exclusion_attributed
    CHECK (excluded_at IS NULL OR (excluded_by IS NOT NULL AND excluded_by <> ''))
);

-- The scope read: one workspace's in-scope channels. Partial, because the
-- out-of-scope rows are read by IDENTITY through the PK (the webhook's
-- per-event check) and never listed.
CREATE INDEX IF NOT EXISTS idx_brain_slack_channel_in_scope
  ON brain_slack_channel (workspace_id, channel_id)
  WHERE is_member = true AND excluded_at IS NULL;

-- The admin exclusion list: small, and read whole when the surface renders.
CREATE INDEX IF NOT EXISTS idx_brain_slack_channel_excluded
  ON brain_slack_channel (workspace_id, excluded_at DESC)
  WHERE excluded_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The per-workspace reconcile state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain_slack_ingest_scope (
  workspace_id text PRIMARY KEY,
  -- The union of the retired installs' channel sets. MAY BE EMPTY — see the
  -- three-state table in this file's header; empty means "had an install,
  -- contributed no usable scope", which is fail-closed and distinct from the
  -- absent row.
  legacy_channels text[] NOT NULL,
  -- NULL until the first sync has reconciled this workspace against live
  -- membership. While NULL, `legacy_channels` IS the scope.
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A NULL element would read as a channel id that matches nothing, silently
  -- narrowing the legacy allowlist by one.
  CONSTRAINT ck_brain_slack_ingest_scope_no_null_channels
    CHECK (array_position(legacy_channels, NULL) IS NULL)
);

-- ---------------------------------------------------------------------------
-- Capture the retired installs' scope, THEN retire them
-- ---------------------------------------------------------------------------
-- Order matters and this file is one transaction (the runner wraps each
-- migration in BEGIN/COMMIT): the capture reads `workspace_plugins`, and the
-- catalog delete below cascades those rows away.

-- One row for EVERY workspace holding a `slack-history` install in any state.
-- The row's existence is what distinguishes "had one" from "never had one", and
-- that distinction is the entire no-broadening guarantee — so the outer scan is
-- deliberately unfiltered by `enabled`/`status` while only enabled,
-- non-archived installs CONTRIBUTE channels. A workspace whose install was
-- archived on purpose lands an empty array and keeps ingesting nothing.
INSERT INTO brain_slack_ingest_scope (workspace_id, legacy_channels)
SELECT w.workspace_id,
       COALESCE(
         (SELECT array_agg(DISTINCT c.channel_id ORDER BY c.channel_id)
            FROM (
              SELECT upper(btrim(raw)) AS channel_id
                FROM workspace_plugins wp
                CROSS JOIN LATERAL jsonb_array_elements_text(wp.config -> 'channels') AS raw
               WHERE wp.workspace_id = w.workspace_id
                 AND wp.catalog_id = 'catalog:slack-history'
                 AND wp.pillar = 'knowledge'
                 AND wp.enabled = true
                 AND wp.status <> 'archived'
                 AND jsonb_typeof(wp.config -> 'channels') = 'array'
            ) c
           -- The same pattern the writers enforce. A stored id that does not
           -- match it could never have been read anyway (the connector's
           -- `parseSlackHistoryConfig` refused the whole config), so admitting
           -- it here would WIDEN the legacy allowlist past what the install
           -- ever ingested.
           WHERE c.channel_id ~ '^[CG][A-Z0-9]{2,}$'),
         '{}'::text[]
       )
  FROM (
    SELECT DISTINCT workspace_id
      FROM workspace_plugins
     WHERE catalog_id = 'catalog:slack-history'
  ) w
ON CONFLICT (workspace_id) DO NOTHING;

-- Orphaned sync bookkeeping. The per-workspace dispatch that replaces the
-- install keeps the id `slack-history` — the retired handler's DEFAULT install
-- slug — precisely so the common single-install workspace carries its
-- per-channel cursor and high-water mark forward untouched.
--
-- A workspace that ran MULTIPLE installs had extra slugs, and those rows would
-- outlive the installs they describe: unreferenced (admin joins from
-- `workspace_plugins`), but a stale `status='success'` row that reads as a live
-- green source to anything that ever queries this table directly. Deleted.
--
-- The stated cost: those channels lose their per-channel cursor and re-read
-- their backfill window once. Episodes are keyed by `<channelId>:<ts>` and the
-- ingest is append-only with source-id dedupe, so every already-stored message
-- comes back `duplicate` — the cost is Slack calls on one pass, not duplicated
-- evidence.
DELETE FROM knowledge_sync_state kss
 USING (
   SELECT workspace_id, install_id
     FROM workspace_plugins
    WHERE catalog_id = 'catalog:slack-history'
      AND install_id <> 'slack-history'
 ) retired
 WHERE kss.workspace_id = retired.workspace_id
   AND kss.collection_id = retired.install_id;

-- Retire the catalog row. `workspace_plugins.catalog_id` is
-- `REFERENCES plugin_catalog(id) ON DELETE CASCADE`, so this deletes every
-- `slack-history` install with it — which is the point, and why the capture
-- above had to run first.
--
-- The row does not come back on the next boot: `seedBuiltinKnowledgeCatalog`
-- is insert-only (`ON CONFLICT DO NOTHING`) over a hard-coded list, and #5203
-- removes `BUILTIN_SLACK_HISTORY_CATALOG_ROW` from that list in the same
-- change. Deleting here without that edit would have the seeder re-create the
-- catalog row on every deploy — an installable card whose install path no
-- longer exists.
DELETE FROM plugin_catalog WHERE id = 'catalog:slack-history';
