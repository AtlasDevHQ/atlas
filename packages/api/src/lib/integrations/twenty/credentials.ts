/**
 * Twenty per-workspace credential lookup adapter.
 *
 * Adapts {@link getTwentyIntegrationWithSecret} (the Postgres-backed
 * store) to the {@link DbCredentialLookup} shape expected by
 * `TwentyCredentialResolver.resolveCredentialsForWorkspace`. The
 * resolver lives in `plugins/twenty/` so it must stay portable; this
 * adapter is the seam that lets the plugin's resolver consult the
 * `@atlas/api` integration store WITHOUT a back-import.
 */

import type { DbCredentialLookup, DbCredentialLookupResult } from "@useatlas/twenty";
import { getTwentyIntegrationWithSecret } from "./store";

/**
 * Production implementation of {@link DbCredentialLookup}. Returns the
 * decrypted `(apiKey, baseUrl)` pair for the given workspace, or
 * `null` if no row exists.
 *
 * Errors propagate so the resolver's `catch` branch sees them and
 * falls back to env — keeping the store's logger as the single
 * structured-error surface (no double-log of the same failure).
 */
export const lookupTwentyDbCredentials: DbCredentialLookup = async (
  workspaceId: string,
): Promise<DbCredentialLookupResult | null> => {
  const row = await getTwentyIntegrationWithSecret(workspaceId);
  if (!row) return null;
  return {
    apiKey: row.apiKey,
    baseUrl: row.baseUrl,
  };
};
