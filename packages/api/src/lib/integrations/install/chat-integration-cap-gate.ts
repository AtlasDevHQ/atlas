/**
 * `makeChatIntegrationCapGate` — the shared {@link SingletonInstallCapGate}
 * for every chat-pillar singleton handler (the five static-bot handlers +
 * the Slack OAuth handler). Issue #4352.
 *
 * Each of the six used to carry its own copy of the same cap-decision block:
 * run {@link checkChatIntegrationLimitAndInstall} (the advisory-locked
 * check-and-UPSERT, #3001) and map its denied arm to a `429`
 * ({@link ChatIntegrationLimitError}) or a `503`
 * ({@link BillingCheckFailedError}). That mapping lives here now, so the six
 * call sites shrink to one line and the generic install spine
 * ({@link persistSingletonInstall}) stays free of billing/chat error types.
 *
 * A cap denial is RETURNED (via the `{ ok: false }` arm), never thrown, so the
 * spine can tell it apart from a raw write-path throw (a routing-id `23505`, a
 * driver fault) — the spine routes those through its
 * {@link RoutingConflictClassifier} / persist-failure log, while a denial
 * passes straight through to the route as its `429`/`503`. On success the gate
 * returns the UPSERT's `RETURNING` rows for the spine's returned-id invariant.
 *
 * @see ./persist-form-install.ts — {@link SingletonInstallCapGate}
 * @see ../../billing/enforcement.ts — {@link checkChatIntegrationLimitAndInstall}
 */

import type { createLogger } from "@atlas/api/lib/logger";
import { BillingCheckFailedError, ChatIntegrationLimitError } from "@atlas/api/lib/effect/errors";
import { checkChatIntegrationLimitAndInstall } from "@atlas/api/lib/billing/enforcement";
import type { WorkspaceId } from "@useatlas/types";
import type { SingletonInstallCapGate } from "./persist-form-install";

/** The gate only logs the block reason — narrow to exactly the levels it uses. */
type CapGateLogger = Pick<ReturnType<typeof createLogger>, "error" | "info">;

export interface ChatIntegrationCapGateParams {
  /** Workspace whose chat-integration cap is enforced (the atomic gate's `orgId`). */
  readonly orgId: WorkspaceId;
  /** Full `plugin_catalog.id` of the platform being installed ("catalog:telegram"). */
  readonly catalogId: string;
  /** Human-readable Platform name composed into the block log lines ("Telegram", "Slack"). */
  readonly displayName: string;
  /** The handler's own logger so the cap-block line stays attributable per platform. */
  readonly log: CapGateLogger;
}

/**
 * Build the {@link SingletonInstallCapGate} for one chat platform. The five
 * static-bot handlers and the Slack OAuth handler pass the result as
 * `persistSingletonInstall`'s `capGate` hook.
 */
export function makeChatIntegrationCapGate(
  params: ChatIntegrationCapGateParams,
): SingletonInstallCapGate {
  const { orgId, catalogId, displayName, log } = params;
  return async (insert) => {
    const result = await checkChatIntegrationLimitAndInstall<{ id: string }>(
      orgId,
      catalogId,
      insert,
    );
    if (result.allowed) return { ok: true, rows: result.rows };
    if (result.reason === "cap_reached") {
      // The workspace is genuinely at/over its plan cap — 429 "upgrade".
      log.info(
        { workspaceId: orgId, limit: result.limit },
        `${displayName} install blocked — workspace at chat-integration cap`,
      );
      return {
        ok: false,
        error: new ChatIntegrationLimitError({
          message: result.errorMessage,
          workspaceId: orgId,
          limit: result.limit,
        }),
      };
    }
    // `check_failed` — and, defensively, any future non-cap denial reason:
    // the count couldn't be determined, so fail closed as a transient 503
    // "try again", never a misleading 429 "upgrade your plan".
    log.error(
      { workspaceId: orgId },
      `${displayName} install blocked — chat-integration count check failed (failing closed)`,
    );
    return {
      ok: false,
      error: new BillingCheckFailedError({ message: result.errorMessage, workspaceId: orgId }),
    };
  };
}
