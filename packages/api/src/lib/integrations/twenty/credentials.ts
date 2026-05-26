/**
 * Twenty per-workspace credential lookup adapter.
 *
 * Adapts {@link getTwentyIntegrationWithSecret} (the Postgres-backed
 * store) to the {@link DbCredentialLookup} shape expected by
 * `TwentyCredentialResolver.resolveWorkspaceCredentials`. The resolver
 * lives in `plugins/twenty/` so it must stay portable; this adapter is
 * the seam that lets the plugin's resolver consult the `@atlas/api`
 * integration store WITHOUT a back-import.
 *
 * @internal Production wiring to plugin-action dispatch lands with
 *   #2849 (workspace-scoped outbox routing). This adapter is the
 *   stable seam — plugin action handlers thread `workspaceId` through
 *   to `resolveWorkspaceCredentials` and pass `lookupTwentyDbCredentials`
 *   as the lookup option.
 */

import type { DbCredentialLookup, DbCredentialLookupResult } from "@useatlas/twenty";
import { getTwentyIntegrationWithSecret } from "./store";

/**
 * Production implementation of {@link DbCredentialLookup}. Returns the
 * decrypted `(apiKey, baseUrl)` pair for the given workspace, or
 * `null` if no row exists.
 *
 * Error propagation: the store layer (`getTwentyIntegrationWithSecret`)
 * emits a structured warning on transport / decrypt failure and then
 * re-throws. This adapter does NOT log — keeping the store as the
 * single structured-error surface avoids double-logging. The resolver
 * distinguishes the two: transport errors are swallowed and surface as
 * the missing-credentials `TwentyCredentialError` (no env fallback per
 * #2850; the underlying error is attached as `cause`); decrypt errors
 * propagate as `TwentyDecryptError` so the dispatcher can fail closed.
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
