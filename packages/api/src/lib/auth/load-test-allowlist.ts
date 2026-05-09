/**
 * Operator-set allowlist of workspace IDs explicitly authorized for load
 * testing — `ATLAS_LOADTEST_ALLOWED_ORGS=ws_a,ws_b,...`.
 *
 * Two consumers today:
 *   - Self-mint MCP load-test JWT endpoint (`api/routes/me-load-test.ts`)
 *     — when the allowlist is set, only listed workspaces may mint.
 *   - Abuse-prevention skip (`lib/security/abuse.ts`) — listed
 *     workspaces bypass the escalate→suspend chain so load tests don't
 *     auto-suspend themselves.
 *
 * `getLoadTestAllowlist()` returns `null` when unset/empty — "no
 * allowlist configured". Each consumer interprets that per its own
 * semantics: the mint endpoint is permissive on null (preserves
 * self-hosted single-instance load testing), abuse-prevention is
 * non-overriding on null (normal escalation).
 *
 * Re-read on every call so flipping the env var doesn't require a
 * restart; the parse cost is one trim + split, dwarfed by the
 * surrounding work.
 */

export function getLoadTestAllowlist(): ReadonlySet<string> | null {
  const raw = process.env.ATLAS_LOADTEST_ALLOWED_ORGS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length === 0 ? null : new Set(ids);
}

/**
 * Whether `workspaceId` is in the load-test allowlist. Returns `false`
 * when the allowlist is unset (which is the default in self-hosted
 * deployments) — callers that want "no allowlist = permissive" should
 * call `getLoadTestAllowlist()` directly and branch on `null`.
 */
export function isLoadTestWorkspace(workspaceId: string): boolean {
  return getLoadTestAllowlist()?.has(workspaceId) ?? false;
}
