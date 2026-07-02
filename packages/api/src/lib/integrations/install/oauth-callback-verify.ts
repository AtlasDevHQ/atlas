/**
 * `verifyCallbackState` — the shared step-1 of every OAuth install
 * handler's `handleCallback` (#4188).
 *
 * Seven OAuth handlers (Slack, Salesforce, Jira, Linear, GitHub App,
 * GitHub single-tenant, OAuth-datasource) opened `handleCallback` with a
 * structurally identical two-step guard (differing only in the
 * per-platform rejection log copy and statement order):
 *
 *   1. `verifyOAuthStateToken(stateToken)` → `null` on every failure
 *      mode (forged / expired / invalid signature). Return `null`.
 *   2. Catalog-slug binding check — the dispatch routes by slug, so a
 *      token bound to a *different* catalog reaching this handler is a
 *      bug or a cross-catalog forge attempt. Log + return `null`.
 *
 * Extracting it to one seam means the fail-closed invariant "a state
 * token bound to a different catalog is rejected" exists once, with a
 * direct unit test, instead of being re-asserted across seven handler
 * suites. See {@link ./types.ts} `OAuthPlatformInstallHandler`.
 *
 * The per-platform rejection log copy is threaded through
 * `rejectionLogMessage` so the operator-facing wording each handler
 * shipped ("Jira OAuth callback received state bound to a different
 * catalog — rejecting") is preserved verbatim.
 *
 * @see ./oauth-state-token.ts — the verify primitive this wraps
 */

import type { WorkspaceId } from "@useatlas/types";
import type { createLogger } from "@atlas/api/lib/logger";
import { verifyOAuthStateToken } from "./oauth-state-token";
import type { CatalogId } from "./types";

/** Minimal logger surface — the guard only ever `warn`s on rejection. */
type CallbackVerifyLogger = Pick<ReturnType<typeof createLogger>, "warn">;

/**
 * The verified, catalog-matched result: the branded workspace id the
 * state token was minted from. The token's signature guarantees the
 * round-trip preserved the exact bytes minted at `startInstall`, so the
 * brand promotion is sound (mirrors the per-handler comment the seam
 * replaces — we don't pull `assertWorkspaceId` from `@useatlas/chat`
 * because the verifier already filtered empty strings and that would add
 * a cross-package dep this module otherwise doesn't need).
 */
export interface VerifiedCallbackState {
  readonly workspaceId: WorkspaceId;
}

/**
 * Verify an OAuth callback's CSRF state token and assert it is bound to
 * `expectedSlug`. Returns the branded `workspaceId` on success, or
 * `null` on ANY failure (invalid signature OR catalog mismatch) — the
 * caller returns `null` from `handleCallback`, which the route maps to a
 * benign "install could not be verified" without leaking which check
 * failed.
 */
export function verifyCallbackState(
  stateToken: string,
  expectedSlug: CatalogId,
  log: CallbackVerifyLogger,
  rejectionLogMessage: string,
): VerifiedCallbackState | null {
  const verified = verifyOAuthStateToken(stateToken);
  if (!verified) return null;
  if (verified.catalogId !== expectedSlug) {
    log.warn({ expected: expectedSlug, got: verified.catalogId }, rejectionLogMessage);
    return null;
  }
  return { workspaceId: verified.workspaceId as WorkspaceId };
}
