/**
 * The single decide seam for semantic Amendments (#4506).
 *
 * `decideAmendment` owns the `pending → approved | rejected` transition for
 * EVERY caller — the admin review route, the interactive auto-approve path
 * (`proposeAmendment`), the scheduler, and the learned-patterns admin surface.
 * "Approved means applied" (CONTEXT.md) holds by construction, not caller
 * discipline:
 *
 *   approve:  claim (atomic conditional update on `pending` → `applying`)
 *             → apply from the STORED row payload (YAML mutation + version
 *               snapshot; a snapshot failure fails the apply)
 *             → stamp `approved` (conditional on the claim)
 *             On apply failure: compensate — release the claim back to
 *             `pending` with the failure reason in `last_apply_error` — then
 *             rethrow so the caller's error mapping runs (409 for
 *             AmbiguousEntityError at the route layer, logged-and-queued on
 *             the auto-approve paths).
 *
 *   reject:   one atomic conditional update `pending → rejected`. Never
 *             touches the semantic layer, and can never stamp an applied
 *             change as rejected: an approve that already claimed or stamped
 *             the row makes the reject match zero rows.
 *
 * Race outcomes are truthful: the loser of any concurrent decision gets
 * `not_pending` (already reviewed / under review), never a second apply and
 * never a silent success. A null/corrupt stored payload is an ERROR (the
 * apply seam throws before touching YAML; the claim is released, leaving the
 * row pending) — never a silent stamp.
 *
 * Crash safety: a process death between claim and stamp/release leaves the
 * row `applying`; the pending-queue reads resurface it after
 * `AMENDMENT_CLAIM_STALE_MINUTES` and the claim can be retaken (the apply is
 * idempotent via upsert-by-identity). The claim carries a token
 * (`claimed_at`), so a decision that outlives the stale window can never
 * stamp or release over a takeover's live claim — it observes `not_pending`
 * instead. The one qualified guarantee: the reject arm deliberately treats a
 * STALE claim as claimable (a crashed process must not strand rows), so an
 * apply that is still alive past the window can land YAML after a takeover
 * rejected the row — bounded to >stale-window applies, logged loudly, and
 * convergent on the next approve.
 */

import { createLogger } from "@atlas/api/lib/logger";
// Static value import — needed because the seam branches on `instanceof
// StaleBaselineError`, which requires the real class binding at module load.
// The decide-level unit suite (decide.test.ts) leaves `./diff` unmocked and
// imports the genuine class, so `instanceof` fires against it. A suite that DOES
// mock `./diff` (the route suite) must re-export the SAME class it raises from
// its apply mock, or the check silently misses — the DB + apply seams stay
// dynamic for the usual partial-mock reasons, but `./diff` is deliberately static.
import { StaleBaselineError } from "./diff";

const log = createLogger("semantic-expert-decide");

export type AmendmentDecision = "approved" | "rejected";

export type DecideAmendmentOutcome =
  /** Claim won, apply + version snapshot succeeded, row stamped `approved`. */
  | { kind: "approved"; id: string }
  /** Row atomically moved `pending → rejected`; the semantic layer untouched. */
  | { kind: "rejected"; id: string }
  /**
   * No pending row to decide: absent, wrong org, already reviewed, or
   * currently claimed by a concurrent decision. The caller reports this
   * truthfully (404/409/"queued") — it must never retry into a second apply.
   */
  | { kind: "not_pending"; id: string }
  /**
   * #4511 — the entity changed since the admin rendered the diff: the
   * hash-carried claim's baseline hash no longer matches the current baseline.
   * NOT a failure — the claim was returned to pending cleanly (no
   * `last_apply_error`) and this carries the FRESHLY-computed live diff + its
   * baseline hash so the caller presents inline update-and-confirm (a
   * continuation of review, never a dead-end). The confirm re-decides with this
   * `baselineHash`, which now matches, and applies.
   */
  | { kind: "stale"; id: string; diff: string; baselineHash: string };

/**
 * Decide a pending semantic amendment. See the module doc for the ordering
 * and race guarantees.
 *
 * @throws when the decision is `approved` and the apply fails (including a
 *   null/corrupt stored payload and a failed version snapshot). The row has
 *   already been compensated back to `pending` with a visible reason when the
 *   error reaches the caller; route callers let it propagate to the shared
 *   error mapping, the proposeAmendment tool catches and reports "queued",
 *   and the scheduler catches and counts an error.
 */
export async function decideAmendment(params: {
  id: string;
  orgId: string | null;
  decision: AmendmentDecision;
  /** Recorded in `reviewed_by` — an admin identifier or a machine actor. */
  reviewedBy: string;
  requestId: string;
  /**
   * #4511 — the baseline hash the admin rendered (hash-carried claim). When set,
   * an approve verifies the current baseline still matches before applying; a
   * mismatch returns a `stale` outcome carrying the fresh diff. Omitted by the
   * scheduler / auto-approve paths (no human rendered a diff).
   */
  expectedBaselineHash?: string;
  /**
   * #4511 — an admin-picked group for a legacy cross-group-ambiguous row,
   * honored only when default resolution is ambiguous. `undefined` = none.
   */
  group?: string | null;
}): Promise<DecideAmendmentOutcome> {
  const { id, orgId, decision, reviewedBy, requestId, expectedBaselineHash, group } = params;

  // Dynamic imports keep the DB + apply seams out of static graphs (matching
  // the scheduler and tool call sites) so partial `mock.module` stubs in
  // suites that never run the seam don't have to re-export everything.
  const {
    claimPendingAmendment,
    stampClaimedAmendmentApproved,
    releaseClaimedAmendment,
    rejectPendingAmendment,
  } = await import("@atlas/api/lib/db/internal");

  if (decision === "rejected") {
    const rejected = await rejectPendingAmendment(id, orgId, reviewedBy);
    return rejected ? { kind: "rejected", id } : { kind: "not_pending", id };
  }

  // Approve: claim → apply → stamp.
  const claimed = await claimPendingAmendment(id, orgId, reviewedBy);
  if (!claimed) return { kind: "not_pending", id };

  try {
    const { applyAmendmentFromPayload } = await import("./apply");
    // Apply from the STORED row — the thing the admin reviewed — never from a
    // caller-supplied copy that could diverge from it. Throws on a
    // null/corrupt payload before touching any YAML. #4511: threads the
    // hash-carried claim + the disambiguation group; a hash mismatch raises a
    // StaleBaselineError (handled below), not an apply failure.
    await applyAmendmentFromPayload({
      orgId,
      sourceEntity: claimed.source_entity,
      connectionGroupId: claimed.connection_group_id ?? null,
      rawPayload: claimed.amendment_payload,
      requestId,
      label: id,
      disambiguationGroup: group,
      expectedBaselineHash,
    });
  } catch (applyErr) {
    // #4511 — a stale baseline is NOT an apply failure: the entity changed
    // since the admin rendered the diff. Return the claim to pending CLEANLY
    // (null reason → no scary `last_apply_error`; the next `/pending` read
    // recomputes the live diff anyway) and hand back the fresh diff so the card
    // presents inline update-and-confirm. Distinguished before the generic
    // compensation so it never records a failure reason.
    if (applyErr instanceof StaleBaselineError) {
      try {
        const released = await releaseClaimedAmendment(id, claimed.claimed_at, null);
        if (!released) {
          log.warn(
            { id, orgId, requestId },
            "Stale-baseline claim was no longer held during release — a concurrent decision took the row over",
          );
        }
      } catch (releaseErr) {
        log.error(
          {
            err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
            id,
            orgId,
            requestId,
          },
          "Failed to release amendment claim after a stale-baseline mismatch — row stays 'applying' until the stale-claim window resurfaces it",
        );
      }
      return { kind: "stale", id, diff: applyErr.diff, baselineHash: applyErr.baselineHash };
    }

    const reason = applyErr instanceof Error ? applyErr.message : String(applyErr);
    // Compensate: the row must never linger `applying` (invisible) or reach
    // `approved` (a lie) — back to `pending` with the reason visible in the
    // review queue.
    try {
      const released = await releaseClaimedAmendment(id, claimed.claimed_at, reason);
      if (!released) {
        log.error(
          { id, orgId, requestId, reason },
          "Apply failed but the claim was no longer held during compensation — a stale-claim takeover decided the row concurrently",
        );
      }
    } catch (releaseErr) {
      log.error(
        {
          err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
          id,
          orgId,
          requestId,
          reason,
        },
        "Failed to release amendment claim after apply failure — row stays 'applying' until the stale-claim window resurfaces it",
      );
    }
    throw applyErr;
  }

  const stamped = await stampClaimedAmendmentApproved(id, claimed.claimed_at);
  if (!stamped) {
    // Pathological: the apply outlived the stale-claim window and another
    // decision took the row over mid-flight. The YAML change DID land (and is
    // idempotent), but this caller no longer owns the row's status — report
    // truthfully instead of pretending to have decided it.
    log.error(
      { id, orgId, requestId },
      "Apply succeeded but the claim was no longer held at stamp time — another decision took the row over; reporting not_pending",
    );
    return { kind: "not_pending", id };
  }

  return { kind: "approved", id };
}
