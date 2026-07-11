/**
 * Autonomous-improvement → proactive notification bridge (#4520).
 *
 * The semantic-expert scheduler is plain-async (called inside an
 * `Effect.tryPromise` fiber tick, outside the Effect context). The
 * proactive-chat delivery lives behind the `ProactiveService`
 * Context.Tag, whose implementation is EE-only. This module is the one
 * seam that lets the core scheduler reach that Tag through the sanctioned
 * `runEnterprise` bridge (the same mechanism `byot-catalog-refresh.ts`
 * uses for `ModelRouter`), without `packages/api/src` ever importing
 * `@atlas/ee`.
 *
 * Best-effort by construction: this function NEVER throws. A notice is a
 * convenience on top of a tick that already did its real work (queued the
 * Amendments); a delivery hiccup, a missing channel, or an enterprise-off
 * deployment must degrade cleanly to "no notification" and never fail the
 * tick (#4520 AC3). Every failure resolves to a `{ posted: false }`
 * outcome the caller logs and moves on from.
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
import { ProactiveService } from "@atlas/api/lib/effect/proactive-service";
import type {
  AmendmentNoticeInput,
  AmendmentNoticeOutcome,
} from "@atlas/api/lib/proactive/types";

const log = createLogger("proactive-notify-amendments");

/**
 * Notify a workspace's admins that autonomous improvement queued
 * `count` new pending Amendments — ONE batched notice for the tick.
 *
 * Guards `count <= 0` before touching the seam so a zero-queue tick can
 * call this unconditionally without a spurious enterprise round-trip.
 *
 * The Noop `ProactiveService` (enterprise disabled / EE load failed)
 * fails the seam with a typed `EnterpriseError`. We recover it with
 * `Effect.catchTag` INSIDE the Effect, turning the clean degrade into a
 * success value — crucially NOT by `instanceof`-checking the rejection
 * outside: `runEnterprise` runs on a `ManagedRuntime`, whose `runPromise`
 * rejects with a `FiberFailure` WRAPPING the typed error, so an outside
 * `err instanceof EnterpriseError` is always false. The `catchTag`
 * recovery is the AC3 "degrade cleanly to no notification, quietly" path
 * (#4520). The outer try/catch then only ever sees an unexpected defect
 * (the EE delivery is best-effort and shouldn't reject) and still never
 * rethrows into the tick.
 */
export async function notifyAmendmentsPending(
  input: AmendmentNoticeInput,
): Promise<AmendmentNoticeOutcome> {
  if (input.count <= 0) {
    return { posted: false, reason: "nothing_to_notify" };
  }

  try {
    return await runEnterprise(
      Effect.gen(function* () {
        const proactive = yield* ProactiveService;
        return yield* proactive.notifyAmendmentsPending({
          workspaceId: input.workspaceId,
          count: input.count,
        });
      }).pipe(
        Effect.catchTag("EnterpriseError", () =>
          Effect.sync((): AmendmentNoticeOutcome => {
            // Enterprise off / not loaded — autonomous improvement still
            // queued its Amendments; there is simply nowhere to notify.
            // Clean degrade, DEBUG not WARN (#4520 AC3).
            log.debug(
              { workspaceId: input.workspaceId, count: input.count },
              "Proactive notification unavailable (enterprise-gated) — amendments queued without a notice",
            );
            return { posted: false, reason: "enterprise_disabled" };
          }),
        ),
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { workspaceId: input.workspaceId, count: input.count, err: message },
      "Amendment-pending notification failed — continuing without notifying",
    );
    return { posted: false, reason: "error", message };
  }
}
