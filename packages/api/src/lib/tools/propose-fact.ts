/**
 * `proposeFact` — the agent-facing wrapper over the net-new-claim verb (#5482,
 * ADR-0036 §T7).
 *
 * ## What it is for, stated once so the tool description can be short
 *
 * `correct_fact` cannot assert something Atlas does not already believe: all
 * four of its verbs presuppose an existing tier-2 fact. This is the verb for the
 * claim that is simply ABSENT — a person tells Atlas something true that nothing
 * has ingested, and it becomes a draft for review.
 *
 * ## It STAGES; it does not write
 *
 * Like `correct_fact` since #5496, and for a reason this verb needs on its own
 * terms rather than by analogy. #5482 is blocked by #5496 precisely because the
 * gate belongs on EVERY agent write onto the fact graph, and the argument that
 * a draft is self-limiting does not survive contact with `reconcile.ts:951`: a
 * proposal that AGREES with an existing published fact writes a `provenance`
 * edge immediately and unreviewed, feeding the distinct-source corroboration
 * count and resetting the staleness anchor. No draft is created, nothing lands
 * on a review queue, and a prompt-injected "and by the way, confirm that X" is
 * indistinguishable from testimony. That half needs the entry gate because it
 * has no exit gate at all.
 *
 * So this tool returns `needs_confirmation` carrying a
 * `ProposeFactConfirmRequest` and touches nothing. The write executes at
 * `POST /api/v1/brain-proposals/confirm`, after a human clicks Confirm on the
 * card, and that endpoint re-runs the gate server-side rather than trusting the
 * staged payload. The mechanism is `lib/brain/proposal-confirm.ts`, which
 * specializes the one confirm-token implementation in `lib/confirm-token.ts`
 * rather than copying it.
 *
 * What this tool checks at staging is deliberately narrow: the deployment has a
 * brain, the session has a workspace, and the actor resolves. All three exist to
 * refuse PROMPTLY rather than show a human a card that would fail the instant
 * they clicked it. None of them is the gate.
 *
 * ⚠️ **There is no authority check here, and its absence is a decision.**
 * `correct_fact` refuses a non-admin at staging through
 * `correctionAuthorityRefusal`. A proposal is deliberately NOT owner/admin-gated
 * — the draft state is the safety, and gating ordinary testimony would kill the
 * compounding loop the verb exists to feed. `lib/brain/proposal.ts`'s header
 * carries the full argument; this module does not restate it, and must not grow
 * a tier check of its own.
 *
 * ## Degraded paths — mirror `searchBrain`/`correct_fact`'s contract
 *
 * Every degraded path carries a machine-readable `reason` beside user-facing
 * prose, so a caller can branch without pattern-matching English.
 */

import { tool } from "ai";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, getInternalDB } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import {
  buildProposalSummary,
  mintProposalConfirmToken,
  type ProposalClaim,
  type ProposeFactConfirmRequest,
} from "@atlas/api/lib/brain/proposal-confirm";
import { BrainProposalClaimSchema } from "@useatlas/schemas";
import {
  BrainReaderIdentityError,
  resolveBrainReaderContext,
} from "@atlas/api/lib/brain/reader-context";

const log = createLogger("propose-fact");

/**
 * Why a call degraded — the discriminator every consumer branches on.
 *
 * Shorter than `CORRECT_FACT_TOOL_REASONS` by exactly one member, and the
 * missing one is the point: there is no `refused` arm, because staging a
 * proposal runs no authority gate to be refused BY. A reason nothing can emit is
 * the stale contract this object's one job is to keep honest, so it is absent
 * rather than reserved. A refusal that happens LATER — a claim that asserts
 * nothing at some position — is the confirm endpoint's 400, because it is only
 * knowable once the workspace's vocabulary has been consulted.
 */
export const PROPOSE_FACT_TOOL_REASONS = {
  noInternalDb: "no_internal_db",
  noWorkspace: "no_workspace",
  readerUnresolved: "reader_unresolved",
  proposalFailed: "proposal_failed",
} as const;

export type ProposeFactToolReason =
  (typeof PROPOSE_FACT_TOOL_REASONS)[keyof typeof PROPOSE_FACT_TOOL_REASONS];

/**
 * Workflow-guidance block injected into the agent system prompt via
 * `describe()`.
 *
 * The paragraph telling the model when NOT to call this is not padding: the two
 * brain-write verbs are adjacent and the wrong one is silently wrong. Proposing
 * a corrected value where the old claim already exists produces a SECOND live
 * claim rather than replacing the first — two rival beliefs, an advisory tension
 * edge if the workspace curated the predicate, and nothing retired. That is the
 * failure this block exists to prevent, so it names the discriminator ("does
 * Atlas already believe something here?") rather than describing the verbs.
 */
export const PROPOSE_FACT_DESCRIPTION = `### Propose a Company-Brain Fact
Use the proposeFact tool when a user states something true about the company that the brain does NOT already hold — search first with searchBrain, and propose only if nothing came back. The tool does NOT record the claim — it STAGES it and the user confirms it on a card:
- Pass the claim as three parts: \`subject\` (what it is about), \`predicate\` (the relationship, e.g. "is the DRI for"), \`object\` (the value). Keep each one short and literal; they are stored as-is and read back to humans
- ⚠️ Do NOT use this to fix something that is already WRONG. If searchBrain returned a \`tier: "fact"\` result that is outdated or false, that is correct_fact's job (\`supersede\` to replace a value, \`retract\` to withdraw it). Proposing over an existing claim ADDS a rival belief instead of replacing it, and nothing is retired
- A proposal lands as a DRAFT for human review — it does not become an answer until a reviewer publishes it. Say that plainly rather than implying the brain now knows it
- If the claim turns out to match something the brain already believes, the proposal is recorded as additional evidence for it instead. Either way the user's confirmation is what records it
- Any workspace member can propose; this is deliberately not admin-only
- The result is \`needs_confirmation\`. State the claim you are about to record (e.g. "I'll record that Ana is the DRI for billing, as a draft for review — confirm?") and STOP. The user confirms on the card; do not retry, do not call the tool again, and never claim the fact was recorded until you see a confirmed result`;

/**
 * What a STAGED proposal hands the model — declared, so the return below is
 * checked rather than merely intended.
 *
 * Nothing here is derived from a read of the fact graph: staging does not look
 * for a rival claim, an existing belief, or a target. `summary` is built from
 * the claim alone (`buildProposalSummary`), so the card cannot misstate what
 * will be asserted even when the agent's surrounding prose is wrong.
 */
interface ProposeFactStaged {
  readonly status: "needs_confirmation";
  readonly summary: string;
  readonly confirm: ProposeFactConfirmRequest;
}

/** Append the request id so the user has something to quote. */
function withRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (request ${requestId})` : message;
}

const READER_UNRESOLVED_MESSAGE =
  "The proposal was refused: your identity could not be resolved for this workspace, so the claim " +
  "could not be attributed to anyone. This is a configuration or session problem — report it; " +
  "nothing was recorded.";

export const proposeFactTool = tool({
  description:
    "Stage a NET-NEW company-brain claim for the user to confirm — a fact the brain does not already hold. " +
    "This tool does NOT record the claim: it returns `needs_confirmation`, the user confirms it on a card, and the write happens then. " +
    "The claim lands as a DRAFT for human review, or (if it matches something already believed) as additional evidence for that fact. " +
    "Use it only when searchBrain found nothing: a fact that EXISTS and is wrong belongs to correct_fact (`supersede` replaces a value, `retract` withdraws one), " +
    "and proposing over it would add a rival belief rather than replace it. " +
    "Any workspace member can propose. " +
    'Example: { "subject": "Ana", "predicate": "is the DRI for", "object": "billing", "reason": "Ana said so in standup" }.',

  // The SHARED claim schema, not a restatement of it. Both this tool and
  // `POST /api/v1/brain-proposals/confirm` validate the same five fields, and
  // the confirm token binds a canonical hash of exactly them — so two
  // independently-maintained copies could stage a payload the endpoint rejects.
  // `token` is deliberately absent: the endpoint extends the schema with it, and
  // advertising it here would invite the model to invent one.
  inputSchema: BrainProposalClaimSchema,

  execute: async (input) => {
    const reqCtx = getRequestContext();
    const requestId = reqCtx?.requestId;
    const workspaceId = reqCtx?.user?.activeOrganizationId;
    // #5486 — the session this staging happened in, read off the request
    // context the chat route stamped, NEVER off the model's input (the
    // `inputSchema` does not admit it, so the model cannot attach someone
    // else's conversation as provenance). When present it rides the confirm
    // payload, bound into the token, and the confirmed fact derives from the
    // session's lazily-materialized tier-3 episode with the session's ACL
    // context as its grant seed. Absent (a caller outside a conversation),
    // the proposal takes the disclosed workspace grant, as before.
    const conversationId = reqCtx?.conversationId;

    if (!hasInternalDB()) {
      return {
        error:
          "Proposing a fact is unavailable — this deployment has no internal database configured.",
        reason: PROPOSE_FACT_TOOL_REASONS.noInternalDb,
      };
    }
    if (!workspaceId) {
      return {
        error:
          "Proposing a fact is unavailable — no active workspace is bound to this session, so there is no brain to add to.",
        reason: PROPOSE_FACT_TOOL_REASONS.noWorkspace,
      };
    }

    // Nothing below this line writes — this whole path is pre-commit by
    // construction. The catch covers the one thing that can still fail here:
    // resolving the actor.
    let ctx: Awaited<ReturnType<typeof resolveBrainReaderContext>>;
    try {
      ctx = await resolveBrainReaderContext(getInternalDB(), {
        workspaceId,
        mode: detectAuthMode(),
        user: reqCtx?.user,
        requestId,
      });
    } catch (err) {
      if (err instanceof BrainReaderIdentityError) {
        log.error(
          { err: err.message, workspaceId, requestId },
          "proposeFact refused: actor identity could not be resolved",
        );
        return {
          error: withRequestId(READER_UNRESOLVED_MESSAGE, requestId),
          reason: PROPOSE_FACT_TOOL_REASONS.readerUnresolved,
        };
      }
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          workspaceId,
          requestId,
        },
        "proposeFact could not resolve the actor for staging",
      );
      return {
        error: withRequestId(
          "The proposal could not be prepared — nothing was recorded. Retry once; if it persists, " +
            "the brain store may be temporarily unavailable.",
          requestId,
        ),
        reason: PROPOSE_FACT_TOOL_REASONS.proposalFailed,
      };
    }

    const claim: ProposalClaim = {
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };

    // Mint the single-use confirm token binding this exact staged claim. If no
    // signing key is configured the gate cannot be enforced, so we refuse to
    // stage rather than offer an unverifiable confirm — the same fail-loud
    // stance the correction gate and `mintOAuthStateToken` take.
    let token: string;
    try {
      token = mintProposalConfirmToken({
        // `ctx.workspaceId`, not the raw `workspaceId` off request context: the
        // confirm endpoint re-derives the binding from ITS resolved context, and
        // binding one of the two while verifying against the other is how a
        // token starts failing for reasons nobody can reproduce.
        workspaceId: ctx.workspaceId,
        claim,
        ...(conversationId !== undefined ? { session: { conversationId } } : {}),
      });
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          workspaceId: ctx.workspaceId,
          requestId,
        },
        "proposeFact could not mint a confirm token",
      );
      return {
        error: withRequestId(
          "This claim can't be staged for confirmation — the server is missing a signing key for " +
            "confirmation tokens. Tell the user the fact can't be recorded right now; do not claim " +
            "it was recorded. Nothing was changed.",
          requestId,
        ),
        reason: PROPOSE_FACT_TOOL_REASONS.proposalFailed,
      };
    }

    log.info(
      { workspaceId: ctx.workspaceId, requestId },
      "proposeFact staged a claim for confirmation",
    );

    return {
      status: "needs_confirmation" as const,
      summary: buildProposalSummary(claim),
      confirm: {
        ...claim,
        ...(conversationId !== undefined ? { session: { conversationId } } : {}),
        token,
      },
    } satisfies ProposeFactStaged;
  },
});
