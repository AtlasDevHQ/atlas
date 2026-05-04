-- 0046 — MCP bearer tokens for the hosted MCP endpoint (#2024).
--
-- Workspace-scoped credentials issued from Settings → MCP Tokens or via the
-- device-code OAuth flow (#2024 acceptance criterion 6, ships in a later PR).
-- A token authorizes its holder to query the issuing workspace's data via
-- the hosted MCP endpoint mounted on the per-region API server (#2028).
--
-- Storage model:
--   • token_prefix is the public, non-secret prefix shown to users in the
--     UI ("atl_mcp_<8 hex>") so they can identify a token in the list. It
--     is also the lookup index used by the bearer middleware to narrow
--     candidate rows without having to decrypt every token in the table —
--     prefix collisions are negligible at 32 bits per workspace.
--
--   • token_hash_encrypted holds the SHA-256 of the plaintext token,
--     encrypted at rest under the F-47 keyset (see INTEGRATION_TABLES in
--     packages/api/src/lib/db/integration-tables.ts). The plaintext token
--     is never persisted — the bearer middleware hashes the incoming
--     header, decrypts each candidate row's hash, and compares with
--     timingSafeEqual.
--
--   • Storing the hash *and* encrypting it is defense-in-depth: the hash
--     alone would be sufficient to authenticate (no plaintext recovery),
--     but encrypting the hash means an attacker with read-only access to
--     this table cannot trial bearer values offline against a bare digest.
--
--   • token_hash_key_version stamps the keyset version the row was
--     written under. F-47 rotation re-encrypts each row and bumps the
--     column; the bearer middleware honors whatever version it finds.
--
-- Revocation:
--   • revoked_at is a tombstone — the bearer middleware filters it out at
--     lookup. The row stays for the audit trail (action mcp.token.revoked
--     references the row id).
--   • Revocation is immediate, not eventually-consistent: there is no
--     in-process token cache. Each request decrypts and verifies on the
--     hot path. Latency is bounded by the prefix index returning O(1) rows
--     in steady state.
--
-- Content-mode carve-out:
--   This table is per-user/per-workspace credential metadata, not shared
--   workspace content. It is intentionally exempt from the draft/published
--   mode system (per the carve-out rule in CLAUDE.md). A token has no
--   preview/published lifecycle — it either authenticates (active and
--   not-yet-revoked) or it does not. Adding it to the publish endpoint
--   would conflate user-issued credentials with workspace content drafts.
--
-- Issue: #2024 (architecture from #2028)

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id                       TEXT        PRIMARY KEY,
  -- The workspace the token authenticates against. Joined to the user's
  -- active organization at issue time; the bearer middleware uses this
  -- column verbatim when constructing AuthContext.orgId.
  org_id                   TEXT        NOT NULL,
  -- The user who created the token. Survives user deletion as a string;
  -- joins to the user table are best-effort. NULL only for the device-code
  -- flow path that issues against a workspace identity rather than a
  -- specific user — that path lands in a follow-up PR.
  user_id                  TEXT,
  -- Optional human-readable label. The admin UI shows this in the list
  -- ("Claude Desktop", "VS Code") so users can identify which agent a
  -- token is issued to. Not used for any security decision.
  name                     TEXT,
  -- Public, non-secret prefix. Shape: "atl_mcp_<8 hex chars>". Used by
  -- the bearer middleware's prefix-narrowed lookup and by the UI's
  -- masked display ("atl_mcp_abcdef12…"). Indexed below.
  token_prefix             TEXT        NOT NULL,
  -- Encrypted SHA-256 of the plaintext bearer. See file header for the
  -- defense-in-depth rationale. INTEGRATION_TABLES catalog entry must
  -- match: { table: "mcp_tokens", encrypted: "token_hash_encrypted",
  -- keyVersionColumn: "token_hash_key_version" }.
  token_hash_encrypted     TEXT        NOT NULL,
  token_hash_key_version   INT         NOT NULL DEFAULT 1,
  -- Reserved for future scope-restriction (e.g. ['mcp:read'],
  -- ['mcp:read', 'mcp:write']). Empty array = full MCP access for the
  -- token's workspace. Stored as TEXT[] rather than JSONB because the
  -- shape is a flat list of identifiers and array-overlap operators
  -- ('@>', '&&') give the cleanest authorization-check SQL.
  scopes                   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Touched by the bearer middleware on first use within a window
  -- (sampled, not every call) so the admin UI can show "last used 2h ago"
  -- without an audit-log scan. Best-effort — write failures don't block
  -- the request.
  last_used_at             TIMESTAMPTZ,
  -- NULL = never expires. Set by the device-code flow (90-day default,
  -- final value lives with that PR) or admin-UI custom expiry.
  expires_at               TIMESTAMPTZ,
  -- Tombstone. Set on revocation; never cleared. The bearer middleware
  -- treats any non-NULL value as "rejected".
  revoked_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Snapshot of the issuing user's id at creation time. Distinct from
  -- user_id because user_id is the *bound* identity (the AuthContext.user
  -- when the token authenticates); created_by_user_id records who clicked
  -- "Create" in the UI. Today these are always equal — kept distinct so
  -- a future "issue on behalf of" flow doesn't have to migrate the schema.
  created_by_user_id       TEXT
);

-- Bearer middleware lookup: filters by prefix, drops revoked rows.
-- Partial index keeps the working set tight after revocation accumulates.
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_prefix_active
  ON mcp_tokens (token_prefix)
  WHERE revoked_at IS NULL;

-- Admin UI list view: "all tokens for my workspace". Includes revoked
-- rows because the UI surfaces them with a struck-through state until
-- the row is hard-deleted.
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_org_created
  ON mcp_tokens (org_id, created_at DESC);
