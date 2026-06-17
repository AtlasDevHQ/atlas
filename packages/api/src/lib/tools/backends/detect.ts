/**
 * Runtime detection helpers for sandbox backend selection.
 *
 * Shared between explore.ts and python.ts to avoid duplicating
 * environment variable checks.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getConfig } from "@atlas/api/lib/config";

const log = createLogger("sandbox-detect");

const REDACTED = "[REDACTED]";

export interface RedactedSecret {
  readonly __brand: "RedactedSecret";
  reveal(): string;
  toJSON(): string;
  toString(): string;
}

export function redactedSecret(value: string): RedactedSecret {
  return Object.freeze({
    __brand: "RedactedSecret" as const,
    reveal: () => value,
    toJSON: () => REDACTED,
    toString: () => REDACTED,
  });
}

export interface VercelSandboxAccess {
  teamId: string;
  projectId: string;
  token: RedactedSecret;
}

let _partialCredsWarned = false;

/**
 * Returns explicit Vercel Sandbox API credentials when running off-Vercel
 * (e.g. Railway, Fly, bare metal). When unset, `@vercel/sandbox` falls back
 * to `VERCEL_OIDC_TOKEN` which is only present on the Vercel platform.
 *
 * The team and project IDs resolve from env first, then from
 * `sandbox.vercel` in `atlas.config.ts` (#3706 — they're not secret and are
 * constant across regions, so SaaS bakes them into config rather than stamping
 * `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` per regional service). `VERCEL_TOKEN`
 * is the only secret and stays env-only.
 *
 * Emits a one-time warn when some-but-not-all of the three values are set —
 * the most likely cause is a typo or empty Railway service variable, and
 * without the breadcrumb the operator only sees the generic "all backends
 * failed" message far downstream.
 */
export function vercelSandboxAccess(): VercelSandboxAccess | undefined {
  const vercelConfig = getConfig()?.sandbox?.vercel;
  const teamId = process.env.VERCEL_TEAM_ID || vercelConfig?.teamId;
  const projectId = process.env.VERCEL_PROJECT_ID || vercelConfig?.projectId;
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
        "Partial Vercel Sandbox credentials detected — a team ID + project ID (VERCEL_TEAM_ID / VERCEL_PROJECT_ID, or sandbox.vercel in atlas.config.ts) and VERCEL_TOKEN are all required off-Vercel. Treating as unset.",
      );
    }
    return undefined;
  }
  return { teamId, projectId, token: redactedSecret(token) };
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

export function _resetVercelSandboxDetectForTest(): void {
  _partialCredsWarned = false;
}

export function _partialCredsWarnedForTest(): boolean {
  return _partialCredsWarned;
}
