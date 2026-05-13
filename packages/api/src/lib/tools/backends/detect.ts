/**
 * Runtime detection helpers for sandbox backend selection.
 *
 * Shared between explore.ts and python.ts to avoid duplicating
 * environment variable checks.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("sandbox-detect");

export interface VercelSandboxAccess {
  teamId: string;
  projectId: string;
  token: string;
}

let _partialCredsWarned = false;

/**
 * Returns explicit Vercel Sandbox API credentials when running off-Vercel
 * (e.g. Railway, Fly, bare metal). When unset, `@vercel/sandbox` falls back
 * to `VERCEL_OIDC_TOKEN` which is only present on the Vercel platform.
 *
 * Emits a one-time warn when some-but-not-all of the three vars are set —
 * the most likely cause is a typo or empty Railway service variable, and
 * without the breadcrumb the operator only sees the generic "all backends
 * failed" message far downstream.
 */
export function vercelSandboxAccess(): VercelSandboxAccess | undefined {
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const token = process.env.VERCEL_TOKEN;
  const allSet = !!(teamId && projectId && token);
  if (!allSet) {
    const anySet = !!(teamId || projectId || token);
    if (anySet && !_partialCredsWarned) {
      _partialCredsWarned = true;
      log.warn(
        {
          hasTeamId: !!teamId,
          hasProjectId: !!projectId,
          hasToken: !!token,
        },
        "Partial Vercel Sandbox credentials detected — all three of VERCEL_TEAM_ID / VERCEL_PROJECT_ID / VERCEL_TOKEN are required off-Vercel. Treating as unset.",
      );
    }
    return undefined;
  }
  return { teamId, projectId, token };
}

/**
 * Returns true when the Vercel Sandbox backend is usable, either because we're
 * on the Vercel platform (OIDC handles auth) or because explicit access-token
 * credentials are present (for Railway / external CI / off-Vercel deploys).
 */
export function useVercelSandbox(): boolean {
  return (
    process.env.ATLAS_RUNTIME === "vercel"
    || !!process.env.VERCEL
    || vercelSandboxAccess() !== undefined
  );
}

/** Returns true when ATLAS_SANDBOX_URL is set (sidecar backend available). */
export function useSidecar(): boolean {
  return !!process.env.ATLAS_SANDBOX_URL;
}
