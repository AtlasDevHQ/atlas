/**
 * Runtime detection helpers for sandbox backend selection.
 *
 * Shared between explore.ts and python.ts to avoid duplicating
 * environment variable checks.
 */

/** Returns true when running on Vercel or ATLAS_RUNTIME=vercel. */
export function useVercelSandbox(): boolean {
  return process.env.ATLAS_RUNTIME === "vercel" || !!process.env.VERCEL;
}

/** Returns true when ATLAS_SANDBOX_URL is set (sidecar backend available). */
export function useSidecar(): boolean {
  return !!process.env.ATLAS_SANDBOX_URL;
}
