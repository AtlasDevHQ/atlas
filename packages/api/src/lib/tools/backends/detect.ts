/**
 * Runtime detection helpers for sandbox backend selection.
 *
 * Shared between explore.ts and python.ts to avoid duplicating
 * environment variable checks.
 */

export interface VercelSandboxAccess {
  teamId: string;
  projectId: string;
  token: string;
}

/**
 * Returns explicit Vercel Sandbox API credentials when running off-Vercel
 * (e.g. Railway, Fly, bare metal). When unset, `@vercel/sandbox` falls back
 * to `VERCEL_OIDC_TOKEN` which is only present on the Vercel platform.
 */
export function vercelSandboxAccess(): VercelSandboxAccess | undefined {
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const token = process.env.VERCEL_TOKEN;
  if (!teamId || !projectId || !token) return undefined;
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
