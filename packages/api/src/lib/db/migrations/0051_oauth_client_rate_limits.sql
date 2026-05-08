-- Migration 0051: Per-OAuth-client rate-limit overrides for hosted MCP (#2071).
--
-- A separate table rather than a JSONB column on `oauthClient` because Better
-- Auth owns the `oauthClient` schema and runs its own migrations through
-- `ctx.runMigrations()`. ALTER TABLE on a Better-Auth-owned table risks the
-- next Better-Auth schema generation dropping or renaming the column. The
-- standalone table also keeps the override surface narrow — the limiter has
-- one knob today (`requests_per_minute`); future per-client knobs (concurrency
-- ceilings, scope-specific budgets) extend this table without touching auth.
--
-- The (client_id, reference_id) pair mirrors how `oauthAccessToken` and
-- `oauthRefreshToken` already key off the same composite identity in
-- `oauth-clients.ts`. `reference_id` is the workspace/org id stamped on the
-- DCR client by `oauthProvider({ clientReference })` in `lib/auth/server.ts`.
-- We don't add a foreign key to `oauthClient` because Better Auth doesn't
-- declare `clientId` as PRIMARY KEY (it's a separate `id` column with
-- `clientId` only UNIQUE) and binding via FK would couple Atlas's migration
-- ordering to Better Auth's schema generation. Application-level cleanup on
-- client revocation lives in `revokeOAuthClient()` in `lib/auth/oauth-clients.ts`.

CREATE TABLE IF NOT EXISTS oauth_client_rate_limits (
  client_id           TEXT        NOT NULL,
  reference_id        TEXT        NOT NULL,
  requests_per_minute INTEGER     NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  TEXT,
  PRIMARY KEY (client_id, reference_id),

  -- Defense-in-depth: the admin route already validates the input range, but
  -- a regression at the route layer (or a direct SQL write from a future
  -- migration) shouldn't be able to write a zero / negative quota that the
  -- limiter would silently treat as "deny everything". Cap at 3600/min — one
  -- per second — which is more than any legitimate single-client agent
  -- workload should need; values higher than this point at a misconfiguration
  -- we'd rather reject than honor.
  CONSTRAINT oauth_client_rate_limits_rpm_range
    CHECK (requests_per_minute >= 1 AND requests_per_minute <= 3600)
);

-- Lookup is always by (client_id, reference_id). The PRIMARY KEY already
-- supports that probe directly — no extra index needed. Including this
-- explicitly so future maintainers don't add a redundant covering index.
COMMENT ON TABLE oauth_client_rate_limits IS
  'Admin overrides for per-OAuth-client MCP rate limits (#2071). Absence of a row means the workspace falls back to DEFAULT_REQUESTS_PER_MINUTE (60).';
COMMENT ON COLUMN oauth_client_rate_limits.requests_per_minute IS
  'Weighted requests per minute. executeSQL costs 5, listEntities costs 1 — see TOOL_WEIGHTS in lib/rate-limit/oauth-client.ts.';
