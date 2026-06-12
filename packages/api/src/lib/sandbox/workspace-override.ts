/**
 * Workspace sandbox-backend override resolution.
 *
 * One statement of the `ATLAS_SANDBOX_BACKEND` read + #3375 normalization,
 * shared by the explore and Python tools: the two tools resolving the
 * override independently is how they would drift into reporting different
 * backends for the same stored setting (e.g. a future legacy-key alias
 * landing in one read path but not the other).
 *
 * Kept separate from `runtime.ts` so tests that mock the BYOC runtime
 * module wholesale don't have to stub settings plumbing too.
 */

import { normalizeSandboxBackendValue } from "@useatlas/schemas";
import { getSetting } from "@atlas/api/lib/settings";

/**
 * The workspace's `ATLAS_SANDBOX_BACKEND` override, normalized to backend-id
 * vocabulary (legacy stored provider keys like `"e2b"` resolve to
 * `"e2b-sandbox"`, #3375). `undefined` when there is no org or no override.
 */
export function getWorkspaceSandboxOverride(
  orgId: string | undefined,
): string | undefined {
  if (!orgId) return undefined;
  const raw = getSetting("ATLAS_SANDBOX_BACKEND", orgId);
  return raw ? normalizeSandboxBackendValue(raw) : undefined;
}
