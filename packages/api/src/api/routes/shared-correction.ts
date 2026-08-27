/**
 * The HTTP shape of a correction outcome, shared by the two endpoints that can
 * produce one.
 *
 * Lifted out of `admin-brain-facts.ts` by #5496, when `POST
 * /api/v1/brain-corrections/confirm` became the second route to run the
 * correction verbs. Both call the SAME machinery (`lib/brain/correction.ts`),
 * so a refusal must mean the same status on both — an admin retract refused for
 * an unrecognized source kind and a confirmed chat retract refused for the same
 * reason are one condition, and two hand-maintained switches over
 * {@link CorrectionRefusalReason} are how they stop being.
 *
 * It lives in `api/routes/` rather than beside the machinery deliberately: the
 * refusal REASONS are domain facts and belong in `lib/brain/`, but their
 * mapping to status codes is a transport decision, and `lib/` does not get to
 * hold one (see CLAUDE.md's layering note).
 */
import {
  CORRECTION_REFUSAL_REASONS,
  type CorrectionRefusalReason,
} from "@atlas/api/lib/brain/correction";

/**
 * Correction refusal → HTTP status. Request-shape mistakes are 400s, authority
 * is 403, and target-state mismatches are 409s — the state can change out from
 * under the client, so "try again after fixing the target" is the semantics.
 */
export function refusalStatus(reason: CorrectionRefusalReason): 400 | 403 | 409 {
  switch (reason) {
    case CORRECTION_REFUSAL_REASONS.notAuthorized:
      return 403;
    case CORRECTION_REFUSAL_REASONS.replacementMissing:
    case CORRECTION_REFUSAL_REASONS.replacementIdentical:
    // `replacementMalformed` is a request-shape mistake and not a target-state
    // one (#5047): the target is fine, the replacement TEXT asserts nothing.
    // Retrying the identical request can never succeed, which is what separates
    // it from every 409 below — those describe a target that can change.
    case CORRECTION_REFUSAL_REASONS.replacementMalformed:
      return 400;
    // 409 and not 501/503: the client-observable contract is this arm's — "the
    // verb cannot apply to this target". For `unrecognizedSourceKind` it is not
    // permanent; once this deployment runs a vocabulary that knows the kind the
    // correct gate takes over (tier-1 refusal if the kind is warehouse-class,
    // an ordinary correction otherwise). The retry condition is a DEPLOY rather
    // than anything the client or the target can change, which is unusual
    // though not unique here. `warehouseTarget` is permanent for the verb it
    // refused — but since #5331 it is no longer a dead end for the FACT: the
    // same row admits `retract`, and the refusal message names it, so the 409
    // carries a next step rather than only a no. `malformedSourceKind` is a
    // stored-data defect:
    // still a target-state 409, but no deploy resolves it (#4964).
    case CORRECTION_REFUSAL_REASONS.unrecognizedSourceKind:
    case CORRECTION_REFUSAL_REASONS.malformedSourceKind:
    case CORRECTION_REFUSAL_REASONS.warehouseTarget:
    case CORRECTION_REFUSAL_REASONS.targetNotPublished:
    case CORRECTION_REFUSAL_REASONS.validityAlreadyClosed:
    case CORRECTION_REFUSAL_REASONS.targetNotCurrent:
    case CORRECTION_REFUSAL_REASONS.replacementUnpublishable:
      return 409;
    default: {
      const unexpected: never = reason;
      throw new Error(`Unhandled correction refusal reason: ${JSON.stringify(unexpected)}`);
    }
  }
}

/** The one 404 body for the deliberately indistinguishable trio. */
export function correctionNotFoundBody(requestId: string) {
  return {
    error: "not_found",
    message:
      "That fact could not be corrected. It may not exist, may already be retracted, or may not be visible to you.",
    requestId,
  };
}
