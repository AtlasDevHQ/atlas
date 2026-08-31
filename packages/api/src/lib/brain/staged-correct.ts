/**
 * `correct_fact` as a {@link StagedVerb} — the wire contract, the binding, and
 * the card summary for the correction gate (#5496, implementing [ADR-0036 §T9]'s
 * 2026-08-27b amendment decided in #5485; reshaped into a descriptor by #5571).
 *
 * `correct_fact` used to fire inside the agent loop the moment the model called
 * it, gated only by the CALLING USER holding owner/admin — the human's intent
 * was assumed by a sentence in the tool description. It now **stages**: the tool
 * returns a `needs_confirmation` result carrying a {@link CorrectFactConfirmRequest},
 * the chat surface renders a confirm card, and the correction executes at
 * `POST /api/v1/brain-corrections/confirm` after the human clicks — never
 * silently in the loop.
 *
 * This module is the single source of truth for that wire shape + the
 * human-facing summary, so the staging tool and the confirming endpoint cannot
 * drift. The GATE itself is no longer here: the ordering and the ladder that
 * this module and `staged-propose.ts` each wrapped separately now live once in
 * `staged-write.ts` (#5571), and what remains is what is genuinely this verb's.
 *
 * ## The three load-bearing properties, inherited rather than re-argued
 *
 *   - **Token binding.** The token signs
 *     `(workspaceId, factId, verb, canonical reason+replacement, nonce, exp)`
 *     with the resolved encryption keyset (`ATLAS_ENCRYPTION_KEYS` →
 *     `ATLAS_ENCRYPTION_KEY` → `BETTER_AUTH_SECRET`) — no new signing secret.
 *   - **Server-side re-validation.** The confirm endpoint is NOT a trusted
 *     fast-path. It re-runs the WHOLE gate — authority, ACL visibility, the
 *     tier-1 refusal, vocabulary closure — by calling `correctFact` exactly as
 *     the tool used to, rather than trusting anything in the staged payload. The
 *     token proves the human confirmed THIS correction; it proves nothing about
 *     whether the correction is still allowed, and those are different questions
 *     (a role can be revoked, a fact can be retracted, between stage and confirm).
 *   - **Nonce burn.** A replay — or a looping agent re-posting the same staged
 *     payload — is rejected. `staged-write.ts` is where that ordering now lives.
 *
 * ## Why the summary does not preview the fact's text
 *
 * The card names the verb, the fact id, and (for `supersede`) the replacement
 * value. It deliberately does NOT render the target claim's subject/predicate/
 * object, and that is the same call the REST card makes when it shows
 * `DELETE /people/{id}` rather than the three people it would delete.
 *
 * Two reasons. The claim text is only readable through an ACL-gated query, so
 * previewing it means a second visibility decision on a surface whose whole job
 * is to be trustworthy — and a preview that silently degrades to "(hidden)" is
 * worse than none. And the readable framing already exists: the agent says
 * "I'll retract the claim that Ana is the DRI for billing — confirm?" in its
 * turn. What the card adds is the part the agent's prose CANNOT be trusted for:
 * the verb and target actually staged, derived server-side, so a confidently
 * wrong sentence cannot get a different write confirmed than the one described.
 */
import { claimsHash, type ConfirmClaims } from "@atlas/api/lib/confirm-token";
import type { StagedVerb } from "@atlas/api/lib/brain/staged-write";
import type { BrainCorrectionVerb } from "@useatlas/types";

/**
 * The correction's payload as it travels on the wire — `validFrom` is an
 * ISO-8601 string here, not a `Date`, and that is load-bearing rather than
 * incidental: the token binds a hash of THIS shape, so mint and verify must
 * canonicalize identical bytes. A `Date` would serialize one way at staging and
 * (after a JSON round-trip through the browser) another at confirm, and the
 * binding check would reject every `supersede` that carried one. The conversion
 * to `Date` happens once, past the gate, on its way into `correctFact`.
 */
export interface CorrectionConfirmPayload {
  /** The user's stated rationale, recorded verbatim in the correction episode. */
  readonly reason?: string;
  /** Required for `supersede`, ignored by the other verbs. */
  readonly replacement?: {
    readonly object: string;
    /** ISO-8601 with offset. See the note on this interface. */
    readonly validFrom?: string;
  };
}

/**
 * The replay payload for a staged correction — the exact body the confirm card
 * POSTs to `POST /api/v1/brain-corrections/confirm`.
 *
 * Mirror this shape on the web-local types
 * (`packages/web/src/ui/lib/correct-fact-types.ts`); the card POSTs it verbatim
 * and never inspects `token`.
 */
export interface CorrectFactConfirmRequest extends CorrectionConfirmPayload {
  readonly factId: string;
  readonly verb: BrainCorrectionVerb;
  /**
   * Server-signed, single-use confirm token binding this exact staged
   * correction to `(workspace, factId, verb, canonical reason+replacement,
   * nonce, exp)`. Minted at staging; required + verified + burned by the
   * confirm endpoint. Opaque to the card.
   */
  readonly token: string;
}

/** The binding a correction confirm token is signed over and re-verified against. */
export interface CorrectionConfirmBinding {
  readonly workspaceId: string;
  readonly factId: string;
  readonly verb: BrainCorrectionVerb;
  /** Bound via a canonical hash, so the token stays small and leaks nothing readable. */
  readonly payload: CorrectionConfirmPayload;
}

/**
 * The signed claims. `ph` covers reason AND replacement together, so swapping a
 * `supersede`'s replacement value after staging — the one tamper that would
 * change what the human actually agreed to — fails the binding check.
 *
 * The payload is normalized before hashing rather than hashed as received:
 * `{}`, `{ reason: undefined }` and a payload with an absent `reason` are the
 * same correction, and must hash the same, or a client that round-trips the
 * staged JSON (dropping `undefined` keys, as `JSON.stringify` does) would fail
 * its own confirm. `canonicalize` already drops `undefined` values, so this is
 * belt-and-braces on the one field where the difference is observable.
 */
function correctionClaims(binding: CorrectionConfirmBinding): ConfirmClaims {
  const { reason, replacement } = binding.payload;
  return {
    /** Workspace (org) id. */
    w: binding.workspaceId,
    /** The fact being corrected. */
    f: binding.factId,
    /** The correction verb. */
    v: binding.verb,
    /** sha256(canonical reason + replacement). */
    ph: claimsHash({
      ...(reason !== undefined ? { reason } : {}),
      ...(replacement !== undefined
        ? {
            replacement: {
              object: replacement.object,
              ...(replacement.validFrom !== undefined ? { validFrom: replacement.validFrom } : {}),
            },
          }
        : {}),
    }),
  };
}

/**
 * The brain-correction gate.
 *
 * `typ` is the domain separator carried in the signed header: it is why a
 * REST write confirm token — signed with the same keyset — cannot be presented
 * at the correction confirm endpoint, and vice versa.
 */
export const CORRECTION_STAGED_VERB: StagedVerb<CorrectionConfirmBinding> = {
  name: "correction",
  kind: {
    typ: "AtlasBrainCorrectionConfirm",
    ttlEnvVar: "ATLAS_BRAIN_CONFIRM_TTL_SECONDS",
  },
  claims: correctionClaims,
  copy: {
    staging: {
      storeUnavailable:
        "Fact correction is unavailable — this deployment has no internal database configured.",
      noWorkspace:
        "Fact correction is unavailable — no active workspace is bound to this session, so there is no brain to correct.",
      readerUnresolved:
        "The correction was refused: your identity could not be resolved for this workspace, so the " +
        "fact's visibility could not be checked safely. This is a configuration or session problem — " +
        "report it; the fact was not changed.",
      actorFailed:
        "The correction could not be prepared — nothing was changed. Retry once; if it persists, " +
        "the brain store may be temporarily unavailable.",
      mintFailed:
        "This correction can't be staged for confirmation — the server is missing a signing key for " +
        "confirmation tokens. Tell the user the correction can't be confirmed right now; do not claim " +
        "it was applied. Nothing was changed.",
    },
    confirm: {
      noWorkspace: "No active workspace — select one before confirming a correction.",
      storeUnavailable:
        "Fact correction is unavailable — this deployment has no internal database configured.",
      readerUnresolved:
        "Your identity could not be resolved for this workspace, so the fact's visibility could " +
        "not be checked safely. This is a configuration or session problem — report it; the fact " +
        "was not changed.",
      actorFailed: "Couldn't verify who you are right now — nothing was changed. Retry shortly.",
      tokenUnverifiable:
        "The server can't verify correction confirmations right now — its confirm-token signing key " +
        "isn't configured. This is a server configuration issue, not a problem with your request.",
      tokenInvalid:
        "This confirmation is missing, invalid, expired, or already used. Ask Atlas to stage the correction again.",
      tokenReplayed:
        "This confirmation was already used. Ask Atlas to stage the correction again if you need to repeat it.",
      vocabularyIncomplete:
        "This workspace's alias vocabulary is incomplete, so a correction cannot be keyed the way " +
        "ingest keys it — nothing was changed. Retrying will not help: an operator has to recompute " +
        "the vocabulary's closure first.",
      executeFailed:
        "The correction failed before it could be applied — nothing was changed. Retry once; if it " +
        "persists, the brain store may be temporarily unavailable.",
    },
  },
};

/**
 * A concise, factual one-line description of a staged correction for the card
 * header, e.g. `supersede — replace this fact's value with "Bo"`.
 *
 * Derives ONLY from the verb and the replacement the tool staged; it takes no
 * agent prose, so the card cannot misstate the verb or the new value even when
 * the agent's surrounding sentence is wrong. See the module header for why it
 * does not preview the target claim's text.
 */
export function buildCorrectionSummary(
  verb: BrainCorrectionVerb,
  payload: CorrectionConfirmPayload,
): string {
  switch (verb) {
    case "retract":
      return "retract — withdraw this claim (facts derived from it are flagged for human re-review, never removed)";
    case "supersede":
      return `supersede — replace this fact's value with ${JSON.stringify(payload.replacement?.object ?? "")}; the old value stays readable as history`;
    case "re-authority":
      return "re-authority — confirm this claim is still true on your authority, resetting its staleness clock";
    case "pin":
      return "pin — record your confirmation as fresh evidence, resetting this claim's staleness clock";
    default: {
      // Fail closed on a future verb rather than rendering an empty header: a
      // card that describes nothing is a card a human cannot meaningfully
      // confirm, and this string is the whole basis of their consent.
      const unexpected: never = verb;
      throw new Error(`Unhandled correction verb in confirm summary: ${JSON.stringify(unexpected)}`);
    }
  }
}
