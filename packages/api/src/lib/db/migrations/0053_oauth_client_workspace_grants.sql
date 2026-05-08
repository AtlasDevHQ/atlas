-- Migration 0053: Cross-workspace agent identity (#2073).
--
-- Pre-2073, every OAuth client was scoped to exactly one workspace via Better
-- Auth's `oauthClient.referenceId`. A user with N workspaces had to install
-- the agent N times — N OAuth flows, N identical-looking servers in their
-- MCP client config. This migration adds the ACL surface that lets a SINGLE
-- OAuth client serve multiple workspaces, with the runtime picking which
-- workspace via X-Atlas-Workspace header / bridged env / path fallback.
--
-- Two-table design (mirrors #2071 precedent):
--   1. `oauth_client_workspace_scope` — per-client scope marker. Absence of a
--      row defaults to `'single'` (legacy behavior — `referenceId` is the
--      only valid workspace). Presence of a row with `scope = 'multi'`
--      enables the cross-workspace path.
--   2. `oauth_client_workspace_grants` — per-(client, workspace) admission
--      list. The user's CLI write-time choice ("install for all my
--      workspaces") creates one row per workspace they belong to. A grant
--      row is the AUTHORIZATION boundary at request time: even if the JWT
--      verifies and the user is currently a member of workspace X, the
--      MCP edge refuses unless a grant row exists for (clientId, X).
--
-- Why two tables instead of a column on `oauthClient.workspace_scope`:
--   Better Auth owns the `oauthClient` schema and runs its own migrations
--   when managed auth is enabled. ALTER TABLE on a Better-Auth-owned table
--   risks the next Better Auth schema generation dropping or renaming our
--   column (#2071's design note covers the same precedent). Atlas-owned
--   tables sit alongside Better Auth's without coupling our migration
--   ordering to upstream schema generation.
--
-- Why two tables instead of one (grants alone, presence-of-row = multi):
--   Inferring scope from grant-row presence breaks the audit story —
--   "this client used to be multi-scope but the user revoked all grants"
--   needs a place to record that. The explicit `scope` row decouples
--   "what mode is this client in?" from "which workspaces is it allowed
--   into?", so a future re-grant doesn't read as a fresh install.
--
-- Backwards compatibility:
--   Existing OAuth clients (registered before this migration) have NO row
--   in `oauth_client_workspace_scope`. The runtime treats them as
--   `'single'` — pathWorkspaceId must equal the JWT's `referenceId` claim,
--   no grant lookup, behavior identical to pre-2073. Migration is
--   non-destructive (acceptance criterion: "Existing single-workspace
--   clients continue to work unchanged").
--
-- Cleanup on revoke:
--   `revokeOAuthClient()` already cascades through Atlas-owned tables
--   inside the same transaction (see #2071's `oauth_client_rate_limits`
--   precedent). Both tables added here will be cleaned up alongside
--   access tokens / refresh tokens / consent / rate limits — the helper
--   in `lib/auth/oauth-clients.ts` is updated in the same PR.

CREATE TABLE IF NOT EXISTS oauth_client_workspace_scope (
  client_id           TEXT        PRIMARY KEY,
  reference_id        TEXT        NOT NULL,
  scope               TEXT        NOT NULL DEFAULT 'single',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  TEXT,

  CONSTRAINT oauth_client_workspace_scope_value
    CHECK (scope IN ('single', 'multi'))
);

COMMENT ON TABLE oauth_client_workspace_scope IS
  'Per-OAuth-client workspace-scope marker (#2073). Absence of a row defaults to ''single'' for backward compat. ''multi'' enables the cross-workspace runtime path.';

COMMENT ON COLUMN oauth_client_workspace_scope.reference_id IS
  'Origin workspace where DCR happened. Tracks which workspace the OAuth client was originally registered against — distinct from the workspaces it has been granted access to (which live in oauth_client_workspace_grants).';

-- Per-(client, workspace) ACL. Composite primary key prevents duplicate grants
-- for the same (clientId, workspaceId) pair; lookups go via the PK on the
-- request hot path (clientId + resolved workspace -> exists?).
CREATE TABLE IF NOT EXISTS oauth_client_workspace_grants (
  client_id            TEXT        NOT NULL,
  workspace_id         TEXT        NOT NULL,
  granted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by_user_id   TEXT        NOT NULL,
  PRIMARY KEY (client_id, workspace_id)
);

-- Reverse-direction lookup: "which clients have access to this workspace?"
-- Powers the per-workspace revocation flow in Settings → AI Agents and the
-- workspace-leave cleanup hook (revoking a user's workspace membership
-- removes their grants for that workspace).
CREATE INDEX IF NOT EXISTS idx_oauth_client_workspace_grants_workspace
  ON oauth_client_workspace_grants (workspace_id);

COMMENT ON TABLE oauth_client_workspace_grants IS
  'Per-(client, workspace) authorization entries (#2073). At request time, the MCP edge resolves a workspace via X-Atlas-Workspace header / bridged env / path fallback, then admits only if a row exists for (clientId, resolvedWorkspace) AND the user is a current member of resolvedWorkspace.';
