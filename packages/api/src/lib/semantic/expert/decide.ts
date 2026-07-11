/**
 * The single decide seam for semantic Amendments (#4506).
 *
 * `decideAmendment` owns the `pending → approved | rejected` transition for the
 * improve-loop callers — the admin review route, the interactive auto-approve
 * path (`proposeAmendment` tool), and the autonomous scheduler. Routing all
 * three through one function is what makes CONTEXT.md's "approved means applied"
 * hold by construction rather than by caller discipline: none of them can
 * reintroduce a ghost approval, because the only way THEY write `approved` is
 * this seam, and this seam writes it only after a successful apply. (The legacy
 * `admin-learned-patterns` route is a second approve path over these rows — it
 * still apply-first-then-flips; folding it into this seam is #4594.)
 *
 * Ordering is claim-then-apply with compensation:
 *   1. CLAIM — an atomic conditional UPDATE (`reviewSemanticAmendment`) that
 *      only succeeds on a still-`pending` row. Exactly one concurrent caller
 *      wins; the loser gets `already_reviewed` and never touches YAML.
 *   2. APPLY — `applyAmendmentFromPayload` (which fails if a rollback version
 *      snapshot can't be taken, or the payload is null/corrupt).
 *   3. COMPENSATE — on any apply failure, revert the claim to `pending` with a
 *      visible reason, so a stamped-`approved` row can never survive unapplied.
 *
 * A cross-group `AmbiguousEntityError` whose revert SUCCEEDED is rethrown so the
 * route maps it to 409 with the group list (the group-picker retry re-claims a
 * now-pending row; failure-case UI in PRD #4502). If the revert also failed the
 * row is stuck `approved`, so a 409 group-picker would send the admin into a
 * retry that 404s — that case returns `apply_failed` (surfacing the stuck row)
 * instead. Every other apply failure returns a structured `apply_failed`.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("semantic-amendment-decide");

/**
 * Structural check for a cross-group `AmbiguousEntityError` by its tagged
 * `_tag` — the same way `runHandler` classifies tagged errors at the HTTP
 * boundary. Checked structurally (not `instanceof`) so this seam does not
 * statically import the heavy `errors.ts` graph (which transitively pulls
 * content-mode → the semantic-entities adapter); a static import there breaks
 * every test that partial-mocks `lib/semantic/entities`.
 */
function isAmbiguousEntityError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "_tag" in err &&
    (err as { _tag?: unknown })._tag === "AmbiguousEntityError"
  );
}

/**
 * The outcome of a single decide. `apply_failed` carries the failure reason and
 * whether the compensating revert succeeded — a `false` there means the row may
 * genuinely still read `approved`-but-unapplied (both the apply AND the revert
 * failed), which the caller surfaces rather than swallows. An
 * `AmbiguousEntityError` is thrown, never returned (see module docstring).
 */
export type DecideAmendmentResult =
  | { outcome: "approved"; id: string }
  | { outcome: "rejected"; id: string }
  | { outcome: "already_reviewed" }
  | { outcome: "apply_failed"; id: string; reason: string; revertedToPending: boolean };

export interface DecideAmendmentParams {
  /** The Amendment (`learned_patterns`) row id to decide. */
  readonly id: string;
  /** Org scope; null = self-hosted global scope. */
  readonly orgId: string | null;
  /** The admin (or auto-approve pipeline) decision. */
  readonly decision: "approved" | "rejected";
  /** Recorded as `reviewed_by` (e.g. "admin", "auto-approve"). */
  readonly reviewedBy: string;
  /** Correlation id for logs and the apply's version summary. */
  readonly requestId: string;
}

/**
 * Decide a single Amendment. See the module docstring for the claim-then-apply
 * ordering and the compensation contract.
 *
 * @throws {AmbiguousEntityError} when the apply resolves a name shared across
 *   Connection groups — after reverting the claim to pending — so the route
 *   maps it to a 409 group-picker. All other apply failures are returned as
 *   `apply_failed` (the row is reverted to pending).
 */
export async function decideAmendment(
  params: DecideAmendmentParams,
): Promise<DecideAmendmentResult> {
  const { id, orgId, decision, reviewedBy, requestId } = params;

  const { reviewSemanticAmendment, revertAmendmentToPending } = await import(
    "@atlas/api/lib/db/internal"
  );

  // Reject is a single atomic transition — no apply, no compensation.
  if (decision === "rejected") {
    const rejected = await reviewSemanticAmendment(id, orgId, "rejected", reviewedBy);
    return rejected ? { outcome: "rejected", id: rejected.id } : { outcome: "already_reviewed" };
  }

  // Approve — step 1: CLAIM. The conditional UPDATE only matches a pending row,
  // so a concurrent approve/reject that already moved this row loses the race
  // here and no YAML is ever touched by the loser.
  const claimed = await reviewSemanticAmendment(id, orgId, "approved", reviewedBy);
  if (!claimed) return { outcome: "already_reviewed" };

  // Step 2: APPLY. On ANY failure, step 3 (COMPENSATE) reverts the claim so the
  // row never lingers `approved`-but-unapplied.
  try {
    const { applyAmendmentFromPayload } = await import(
      "@atlas/api/lib/semantic/expert/apply"
    );
    await applyAmendmentFromPayload({
      orgId,
      sourceEntity: claimed.source_entity,
      connectionGroupId: claimed.connection_group_id ?? null,
      rawPayload: claimed.amendment_payload,
      requestId,
      label: claimed.id,
    });
    log.info({ requestId, orgId, id: claimed.id }, "Amendment claimed and applied");
    return { outcome: "approved", id: claimed.id };
  } catch (err) {
    // Compensate: return the row to pending so it re-enters the review queue.
    const revertedToPending = await revertAmendmentToPending(claimed.id).catch(
      (revertErr: unknown) => {
        log.error(
          {
            err: revertErr instanceof Error ? revertErr.message : String(revertErr),
            requestId,
            orgId,
            id: claimed.id,
          },
          "Failed to revert claimed amendment to pending after apply failure — row may remain approved-but-unapplied",
        );
        return false;
      },
    );

    const reason = err instanceof Error ? err.message : String(err);

    // A cross-group ambiguity is a "please disambiguate", not a hard failure —
    // BUT only when the compensating revert actually returned the row to pending.
    // Rethrow then (→ 409 group-picker; the retry re-claims a pending row). If
    // the revert ALSO failed the row is stuck `approved`, so a 409 would send the
    // admin into a retry that 404s against the pending-only claim — surface the
    // stuck row via `apply_failed` instead of a group-picker they can't resolve.
    if (isAmbiguousEntityError(err) && revertedToPending) throw err;

    log.warn(
      { err: reason, requestId, orgId, id: claimed.id, revertedToPending },
      "Amendment apply failed after claim — reverted to pending",
    );
    return { outcome: "apply_failed", id: claimed.id, reason, revertedToPending };
  }
}
