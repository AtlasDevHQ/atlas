/**
 * `correct_fact` — the agent-facing wrapper over the four correction verbs
 * (#4915, ADR-0036 §Temporal, conflict & provenance).
 *
 * The verb machinery is `lib/brain/correction.ts`; this module is the adapter
 * that resolves the caller's workspace and principal set out of request
 * context and turns every failure into something an agent can act on. It
 * carries no SQL and no gating logic of its own — authority (owner/admin
 * only), ACL visibility, and the tier-1 refusal are all the machinery's, so
 * the tool and the admin API cannot drift into two correction policies.
 *
 * ## Degraded paths — mirror `searchBrain`'s contract
 *
 * Every degraded path carries a machine-readable `reason` beside user-facing
 * prose. A refused correction additionally carries the machinery's own
 * refusal code (e.g. `WAREHOUSE_TARGET`) so a caller can branch without
 * pattern-matching English.
 */

import { tool } from "ai";
import { z } from "zod";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { getInternalDB, hasInternalDB } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import {
  CORRECTION_VERBS,
  correctFact,
  type CorrectionOutcome,
} from "@atlas/api/lib/brain/correction";
import {
  BRAIN_CORRECTION_OBJECT_MAX_CHARS,
  BRAIN_CORRECTION_REASON_MAX_CHARS,
} from "@useatlas/schemas";
import {
  BrainReaderIdentityError,
  resolveBrainReaderContext,
} from "@atlas/api/lib/brain/reader-context";

const log = createLogger("correct-fact");

/** Why a call degraded — the discriminator every consumer branches on. */
export const CORRECT_FACT_TOOL_REASONS = {
  noInternalDb: "no_internal_db",
  noWorkspace: "no_workspace",
  readerUnresolved: "reader_unresolved",
  notFound: "not_found",
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
Use the correct_fact tool ONLY when a user with authority states that a reviewed fact (\`tier: "fact"\` from searchBrain) is wrong — it is a human-authoritative correction that takes effect immediately, with the user recorded as its author:
- \`retract\` withdraws a false or to-be-erased claim (the only deletion-like verb; dependents are flagged for human re-review, never auto-removed)
- \`supersede\` replaces an outdated value: pass \`replacement.object\` with the corrected value; the old fact stays readable as history
- \`re-authority\` / \`pin\` confirm a claim is still true on the user's authority, resetting its staleness clock
- Trust tiers: tier-1 warehouse numbers have NO correction path — the warehouse is authoritative, so route those to fixing the data or semantic layer, never this tool. Tier-3 raw episodes are records of what was said and are never corrected, only the facts drawn from them
- Requires workspace owner/admin authority; a refusal explains what to do instead. Confirm the user actually wants the brain changed before calling — this is a write, not a lookup`;

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
    "Apply a human-authoritative correction to a reviewed company-brain fact (tier-2), on the calling user's authority — it takes effect immediately, without the review queue. " +
    'Verbs: "retract" (withdraw the claim — the only deletion-like verb; facts derived from it are flagged for human re-review, never removed), ' +
    '"supersede" (replace an outdated value: same subject and predicate, corrected `replacement.object`; the old fact stays readable as history), ' +
    '"re-authority" and "pin" (confirm the claim is still true, resetting its staleness clock). ' +
    "Tier-1 warehouse-derived numbers have no correction path (fix the data or the semantic layer instead), and tier-3 raw episodes are never corrected. " +
    "Requires workspace owner/admin authority. " +
    'Example: { "factId": "6f2c…", "verb": "supersede", "replacement": { "object": "Bo" }, "reason": "Ana left the team" }.',

  inputSchema: z.object({
    factId: z
      .string()
      .describe("The fact id, exactly as returned by searchBrain (`tier: \"fact\"` results only)."),
    verb: z
      .enum(CORRECTION_VERBS)
      .describe(
        "retract = withdraw · supersede = replace with a corrected value · re-authority / pin = confirm still true.",
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

    // The `try` covers ONLY the code that runs before the correction commits,
    // so the catch's "nothing was changed — retry" instruction is true by
    // construction. Outcome mapping happens OUTSIDE it: a (today unreachable)
    // throw while shaping the success response must never tell the agent to
    // retry a correction that already committed.
    let outcome: CorrectionOutcome;
    try {
      const db = getInternalDB();
      const ctx = await resolveBrainReaderContext(db, {
        workspaceId,
        mode: detectAuthMode(),
        user: reqCtx?.user,
        requestId,
      });
      const replacementValidFrom = input.replacement?.validFrom
        ? new Date(input.replacement.validFrom)
        : null;
      outcome = await correctFact({
        ctx,
        factId: input.factId,
        verb: input.verb,
        reason: input.reason,
        replacement: input.replacement
          ? { object: input.replacement.object, validFrom: replacementValidFrom }
          : undefined,
        requestId,
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
        "correct_fact failed",
      );
      return {
        error: withRequestId(
          "The correction failed before it could be applied — nothing was changed. Retry once; " +
            "if it persists, the brain store may be temporarily unavailable.",
          requestId,
        ),
        reason: CORRECT_FACT_TOOL_REASONS.correctionFailed,
      };
    }

    switch (outcome.kind) {
      case "corrected":
        return {
          corrected: true as const,
          ...outcome.result,
          summary: summarize(outcome),
        };
      case "refused":
        // The machinery's prose is already actionable and secret-free; the
        // structured `refusal` code lets a caller branch without parsing it.
        return {
          error: outcome.message,
          reason: CORRECT_FACT_TOOL_REASONS.refused,
          refusal: outcome.reason,
        };
      case "not-found":
        return {
          error:
            "That fact could not be corrected. It may not exist, may already be retracted, or may not " +
            "be visible to you. Use searchBrain to find the current fact id and try again.",
          reason: CORRECT_FACT_TOOL_REASONS.notFound,
        };
      default: {
        const unexpected: never = outcome;
        throw new Error(`Unhandled correction outcome: ${JSON.stringify(unexpected)}`);
      }
    }
  },
});

/** One human sentence the agent can relay verbatim. */
function summarize(outcome: Extract<CorrectionOutcome, { kind: "corrected" }>): string {
  const { result } = outcome;
  switch (result.verb) {
    case "retract":
      return result.flaggedForReReview.length > 0
        ? `The fact was retracted, and ${result.flaggedForReReview.length} derived fact(s) were flagged for human re-review (nothing was removed automatically).`
        : "The fact was retracted. It leaves current answers immediately but stays readable as history.";
    case "supersede":
      return "The corrected fact is now the current belief; the old value stays readable as history with a recorded end date.";
    case "re-authority":
      return "The claim's authority was re-anchored on you — it now carries your confirmation as its freshest evidence.";
    case "pin":
      return "The fact was pinned: your confirmation is recorded as fresh evidence, resetting its staleness clock.";
    default: {
      const unexpected: never = result.verb;
      throw new Error(`Unhandled correction verb: ${JSON.stringify(unexpected)}`);
    }
  }
}
