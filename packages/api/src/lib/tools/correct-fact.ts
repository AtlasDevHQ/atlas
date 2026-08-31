/**
 * `correct_fact` — the agent-facing wrapper over the four correction verbs
 * (#4915, ADR-0036 §Temporal, conflict & provenance).
 *
 * ## It STAGES; it does not write (#5496)
 *
 * Until #5496 this tool applied the correction the moment the model called it,
 * inside the agent loop, gated only by the CALLING USER holding owner/admin —
 * the human's intent to make this particular correction was assumed by a
 * sentence in {@link CORRECT_FACT_DESCRIPTION} telling the model to ask first.
 * A sentence in a prompt is not a gate.
 *
 * It now returns `needs_confirmation` carrying a `CorrectFactConfirmRequest`
 * and touches nothing. The write executes at
 * `POST /api/v1/brain-corrections/confirm`, after a human clicks Confirm on the
 * card, and that endpoint re-runs the WHOLE gate server-side rather than
 * trusting the staged payload. The decision and its reasoning are ADR-0036
 * §T9's 2026-08-27b amendment (#5485); the mechanism is
 * `lib/brain/correction-confirm.ts`, which mirrors the REST write gate (#3007).
 *
 * What this tool checks at staging is deliberately narrow: the deployment has a
 * brain, the session has a workspace, the actor resolves, and the actor holds
 * authority. All four exist to refuse PROMPTLY — so the agent says "you need
 * admin for that" instead of showing a human a card that would be refused the
 * instant they clicked it. None of them is the gate. Authority is checked here
 * through `correctionAuthorityRefusal`, the same predicate `correctFact` runs on
 * every path, so there is one policy rather than a copy; everything else the
 * machinery gates — ACL visibility, the tier-1 refusal, vocabulary closure, the
 * target's existence — is left to the confirm endpoint, which is where it is
 * load-bearing.
 *
 * The verb machinery is `lib/brain/correction.ts`; this module is the adapter
 * that resolves the caller's workspace and principal set out of request context
 * and turns every failure into something an agent can act on. It carries no SQL
 * and no gating logic of its own.
 *
 * ## Degraded paths — mirror `searchBrain`'s contract
 *
 * Every degraded path carries a machine-readable `reason` beside user-facing
 * prose. A refused correction additionally carries the machinery's own refusal
 * code (e.g. `NOT_AUTHORIZED`) so a caller can branch without pattern-matching
 * English.
 *
 * ## The #4939 projection moved with the write
 *
 * `BrainFactCorrectionResponse` is the ADMIN shape, and the one field that must
 * not cross to a lesser surface verbatim is `flaggedForReReview`: those ids come
 * from a deliberately un-ACL-gated query, so a subset of them names facts the
 * actor cannot read. This tool no longer returns a correction result at all, so
 * the hazard cannot arise HERE — it moved to the confirm endpoint, which makes
 * the same projection to a bare count, for the same reason, and carries the same
 * `satisfies` guard. `correct-fact-tool.test.ts`'s scan of the serialized result
 * still applies to what this tool returns, which is now only a staged payload.
 */

import { tool } from "ai";
import { z } from "zod";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, getInternalDB } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import {
  CORRECTION_VERBS,
  correctionAuthorityRefusal,
} from "@atlas/api/lib/brain/correction";
import {
  buildCorrectionSummary,
  mintCorrectionConfirmToken,
  type CorrectFactConfirmRequest,
  type CorrectionConfirmPayload,
} from "@atlas/api/lib/brain/correction-confirm";
import {
  BRAIN_CORRECTION_OBJECT_MAX_CHARS,
  BRAIN_CORRECTION_REASON_MAX_CHARS,
} from "@useatlas/schemas";
import type { BrainCorrectionVerb } from "@useatlas/types";
import {
  BrainReaderIdentityError,
  resolveBrainReaderContext,
} from "@atlas/api/lib/brain/reader-context";

const log = createLogger("correct-fact");

/**
 * Why a call degraded — the discriminator every consumer branches on.
 *
 * `not_found` was removed by #5496 rather than kept "just in case": staging
 * never reads the fact graph, so no path here can produce it. The condition
 * still exists — it is a 404 from the confirm endpoint — but a consumer
 * branching on `not_found` FROM THIS TOOL would be writing dead code, and a
 * reason nothing can emit is exactly the kind of stale contract this object's
 * one job is to keep honest.
 */
export const CORRECT_FACT_TOOL_REASONS = {
  noInternalDb: "no_internal_db",
  noWorkspace: "no_workspace",
  readerUnresolved: "reader_unresolved",
  refused: "correction_refused",
  correctionFailed: "correction_failed",
} as const;

export type CorrectFactToolReason =
  (typeof CORRECT_FACT_TOOL_REASONS)[keyof typeof CORRECT_FACT_TOOL_REASONS];

/**
 * Workflow-guidance block injected into the agent system prompt via
 * `describe()`. Trust-tier-aware by requirement: the tool acts on tier-2
 * reviewed facts only, and the agent must know why tier-1 is out of reach
 * before it offers a correction that will be refused.
 */
export const CORRECT_FACT_DESCRIPTION = `### Correct a Company-Brain Fact
Use the correct_fact tool when a user with authority states that a reviewed fact (\`tier: "attested"\` from searchAtlas) is wrong. The tool does NOT apply the correction — it STAGES it and the user confirms it on a card:
- \`retract\` withdraws a false or to-be-erased claim (the only deletion-like verb; dependents are flagged for human re-review, never auto-removed)
- \`supersede\` replaces an outdated value: pass \`replacement.object\` with the corrected value; the old fact stays readable as history
- \`re-authority\` / \`pin\` confirm a claim is still true on the user's authority, resetting its staleness clock — refused once a claim's validity window has closed, since nothing serves it any more; if a newer claim replaced it, vouch for that one instead
- Trust tiers: tier-1 warehouse numbers have NO correction path — the warehouse is authoritative, so route those to fixing the data or semantic layer, never this tool. Tier-3 raw episodes are records of what was said and are never corrected, only the facts drawn from them
- Requires workspace owner/admin authority; a refusal explains what to do instead
- The result is \`needs_confirmation\`. Say plainly what the correction will do (e.g. "This will retract the claim that Ana is the DRI for billing — confirm?") and STOP. The user confirms on the card; do not retry, do not call the tool again, and never claim the correction was applied until you see a confirmed result`;

/**
 * What a STAGED correction hands the model — declared, so the return below is
 * checked rather than merely intended.
 *
 * Nothing here is derived from a read of the fact graph: the staging path does
 * not read the target. `summary` is built from the verb and the replacement
 * alone (`buildCorrectionSummary`), so the card cannot misstate what was staged
 * even when the agent's surrounding prose is wrong.
 */
interface CorrectFactStaged {
  readonly status: "needs_confirmation";
  readonly factId: string;
  readonly verb: BrainCorrectionVerb;
  readonly summary: string;
  readonly confirm: CorrectFactConfirmRequest;
}

/** Append the request id so the user has something to quote. */
function withRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (request ${requestId})` : message;
}

const READER_UNRESOLVED_MESSAGE =
  "The correction was refused: your identity could not be resolved for this workspace, so the " +
  "fact's visibility could not be checked safely. This is a configuration or session problem — " +
  "report it; the fact was not changed.";

export const correctFactTool = tool({
  description:
    "Stage a human-authoritative correction to a reviewed company-brain fact (tier-2) for the user to confirm. " +
    "This tool does NOT apply the correction: it returns `needs_confirmation`, the user confirms it on a card, and the write happens then. " +
    'Verbs: "retract" (withdraw the claim — the only deletion-like verb; facts derived from it are flagged for human re-review, never removed), ' +
    '"supersede" (replace an outdated value: same subject and predicate, corrected `replacement.object`; the old fact stays readable as history), ' +
    '"re-authority" and "pin" (confirm the claim is still true, resetting its staleness clock — refused on a claim whose validity window has already closed, because no current read serves it; vouch for whatever replaced it). ' +
    "Tier-1 warehouse-derived numbers have no correction path (fix the data or the semantic layer instead), and tier-3 raw episodes are never corrected. " +
    "Requires workspace owner/admin authority. " +
    'Example: { "factId": "6f2c…", "verb": "supersede", "replacement": { "object": "Bo" }, "reason": "Ana left the team" }.',

  inputSchema: z.object({
    factId: z
      .string()
      .describe("The fact id, exactly as returned by searchAtlas (`tier: \"attested\"` results only)."),
    verb: z
      .enum(CORRECTION_VERBS)
      .describe(
        "retract = withdraw · supersede = replace with a corrected value · re-authority / pin = confirm still true (only for a claim still current).",
      ),
    reason: z
      .string()
      // The shared bounds, imported rather than restated — the admin API's
      // schema and this one must not drift into two different caps on the
      // same write path.
      .max(BRAIN_CORRECTION_REASON_MAX_CHARS)
      .optional()
      .describe("The user's stated rationale, recorded verbatim in the correction episode."),
    replacement: z
      .object({
        object: z
          .string()
          .min(1)
          .max(BRAIN_CORRECTION_OBJECT_MAX_CHARS)
          .describe("The corrected value (the claim's new object)."),
        validFrom: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("ISO-8601 timestamp: when the corrected value began to hold. Defaults to now."),
      })
      .optional()
      .describe("Required for `supersede`, ignored by the other verbs."),
  }),

  execute: async (input) => {
    const reqCtx = getRequestContext();
    const requestId = reqCtx?.requestId;
    const workspaceId = reqCtx?.user?.activeOrganizationId;

    if (!hasInternalDB()) {
      return {
        error:
          "Fact correction is unavailable — this deployment has no internal database configured.",
        reason: CORRECT_FACT_TOOL_REASONS.noInternalDb,
      };
    }
    if (!workspaceId) {
      return {
        error:
          "Fact correction is unavailable — no active workspace is bound to this session, so there is no brain to correct.",
        reason: CORRECT_FACT_TOOL_REASONS.noWorkspace,
      };
    }

    // Nothing below this line writes, so the old "the try covers only the code
    // that runs before the correction commits" reasoning no longer has anything
    // to protect — this whole path is pre-commit by construction now. The catch
    // is kept for the one thing that can still fail here: resolving the actor.
    let ctx: Awaited<ReturnType<typeof resolveBrainReaderContext>>;
    try {
      ctx = await resolveBrainReaderContext(getInternalDB(), {
        workspaceId,
        mode: detectAuthMode(),
        user: reqCtx?.user,
        ...(requestId !== undefined ? { requestId } : {}),
      });
    } catch (err) {
      if (err instanceof BrainReaderIdentityError) {
        log.error(
          { err: err.message, workspaceId, requestId },
          "correct_fact refused: actor identity could not be resolved",
        );
        return {
          error: withRequestId(READER_UNRESOLVED_MESSAGE, requestId),
          reason: CORRECT_FACT_TOOL_REASONS.readerUnresolved,
        };
      }
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          workspaceId,
          factId: input.factId,
          verb: input.verb,
          requestId,
        },
        "correct_fact could not resolve the actor for staging",
      );
      return {
        error: withRequestId(
          "The correction could not be prepared — nothing was changed. Retry once; if it persists, " +
            "the brain store may be temporarily unavailable.",
          requestId,
        ),
        reason: CORRECT_FACT_TOOL_REASONS.correctionFailed,
      };
    }

    // Refuse an unauthorized correction here rather than staging a card whose
    // Confirm button would be refused. The SHARED predicate, not a copy — see
    // the module header, and `correctFact` runs it again at confirm time, which
    // is what makes a role revoked in between still refuse.
    const authorityRefusal = correctionAuthorityRefusal(ctx);
    if (authorityRefusal) {
      return {
        error: authorityRefusal.message,
        reason: CORRECT_FACT_TOOL_REASONS.refused,
        refusal: authorityRefusal.reason,
      };
    }

    const payload: CorrectionConfirmPayload = {
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.replacement !== undefined
        ? {
            replacement: {
              object: input.replacement.object,
              ...(input.replacement.validFrom !== undefined
                ? { validFrom: input.replacement.validFrom }
                : {}),
            },
          }
        : {}),
    };

    // Mint the single-use confirm token binding this exact staged correction. If
    // no signing key is configured the gate cannot be enforced, so we refuse to
    // stage rather than offer an unverifiable confirm — the same fail-loud stance
    // `mintOAuthStateToken` and the REST write gate take. A staged correction the
    // server cannot later prove a human approved is worse than no correction.
    let token: string;
    try {
      token = mintCorrectionConfirmToken({
        // `ctx.workspaceId`, not the raw `workspaceId` off request context: the
        // confirm endpoint re-derives the binding from ITS resolved context, and
        // binding one of the two while verifying against the other is how a
        // token starts failing for reasons nobody can reproduce.
        workspaceId: ctx.workspaceId,
        factId: input.factId,
        verb: input.verb,
        payload,
      });
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          workspaceId: ctx.workspaceId,
          factId: input.factId,
          verb: input.verb,
          requestId,
        },
        "correct_fact could not mint a confirm token",
      );
      return {
        error: withRequestId(
          "This correction can't be staged for confirmation — the server is missing a signing key for " +
            "confirmation tokens. Tell the user the correction can't be confirmed right now; do not claim " +
            "it was applied. Nothing was changed.",
          requestId,
        ),
        reason: CORRECT_FACT_TOOL_REASONS.correctionFailed,
      };
    }

    log.info(
      { workspaceId: ctx.workspaceId, factId: input.factId, verb: input.verb, requestId },
      "correct_fact staged a correction for confirmation",
    );

    return {
      status: "needs_confirmation" as const,
      factId: input.factId,
      verb: input.verb,
      summary: buildCorrectionSummary(input.verb, payload),
      confirm: { factId: input.factId, verb: input.verb, ...payload, token },
    } satisfies CorrectFactStaged;
  },
});
