-- 0213_workspace_action_credentials.sql
--
-- Atlas issue #3766 — WORKSPACE-tier action-target credentials, settable by
-- a workspace admin without operator involvement or a redeploy, encrypted at
-- rest. First target: Jira.
--
-- Background: action targets read a single global `process.env.*` — e.g.
-- `lib/tools/actions/jira.ts` read `JIRA_BASE_URL` / `JIRA_EMAIL` /
-- `JIRA_API_TOKEN` directly — so on SaaS every tenant's "create Jira ticket"
-- hit the one operator-configured Jira. That is the self-host shape, and it
-- is multi-tenant-broken. This table is the storage half of the fix; the
-- resolver half lives in `lib/tools/actions/credentials/`.
--
-- TIER: workspace-only. Per the maintainer decision recorded on #3766
-- (2026-08-30), the precedence ladder for action targets is
--
--     workspace row  →  process.env (SELF-HOSTED ONLY)  →  throw
--
-- with NO operator tier. An operator-configured shared Jira serving several
-- tenants is exactly the multi-tenant confusion this issue exists to
-- eliminate, so the middle tier that `operator_integration_credentials`
-- (0140) gives the chat platforms is deliberately NOT mirrored here. On SaaS
-- the env rung is absent entirely — a missing row throws.
--
-- Why a new table rather than extending `integration_credentials` (0089):
-- that table stores OAuth refresh-token BUNDLES for lazy-loaded integration
-- plugins, keyed by `(workspace_id, catalog_id)` against a catalog row, with
-- a rotation lifecycle driven by 401-triggered refresh. Action-target
-- credentials are static operator-entered field maps keyed by an action
-- TARGET slug, with no catalog row and no refresh lifecycle. Overloading one
-- table across the two would make the Jira *query* plugin's OAuth bundle and
-- the Jira *action* credentials collide on the same natural key while
-- carrying incompatible payload shapes. See ADR-0046.
--
-- Shape:
--   * `id` — uuid PK. Single-column PK so the F-47 rotation tooling and F-42
--     residue audit (both walk `INTEGRATION_TABLES` with one PK identifier)
--     work unchanged.
--   * `workspace_id` — the owning tenant. Composite-unique with `target`.
--   * `target` — action-target slug (`jira`, future `linear` / `github` /
--     `salesforce`). Matches `ActionTargetSpec.target` in
--     `lib/tools/actions/credentials/targets.ts`.
--   * `credentials_encrypted` — AES-256-GCM ciphertext (versioned
--     `enc:v<N>:iv:authTag:ciphertext`) from `db/secret-encryption.ts`,
--     wrapping a JSON object of `{ <ENV_VAR_NAME>: <value>, … }` (e.g.
--     `{ JIRA_BASE_URL: "...", JIRA_EMAIL: "...", JIRA_API_TOKEN: "..." }`).
--     Env-var names are the keys so a workspace row and the self-host env
--     fallback are read through one field spec, with no per-target mapping
--     table.
--   * `credentials_key_version` — companion column carrying the F-47 keyset
--     version the row's ciphertext was produced under. Mirrors every other
--     `INTEGRATION_TABLES` entry's `keyVersionColumn` convention so the
--     rotation script's UPDATE works generically.
--   * `created_at` / `updated_at` — `updated_at` bumps on every write; the
--     Admin UI surfaces it as "last updated."
--
-- No foreign keys: `target` is an Atlas-chosen slug, not a row in any table,
-- and `workspace_id` follows the FK-free convention of every other
-- integration credential table (0089, 0098, 0140).

CREATE TABLE IF NOT EXISTS workspace_action_credentials (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             TEXT NOT NULL,
  target                   TEXT NOT NULL,
  credentials_encrypted    TEXT NOT NULL,
  credentials_key_version  INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One credential row per (workspace, action target). The upsert in
-- `lib/tools/actions/credentials/store.ts` conflicts on this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_action_credentials_unique
  ON workspace_action_credentials (workspace_id, target);
