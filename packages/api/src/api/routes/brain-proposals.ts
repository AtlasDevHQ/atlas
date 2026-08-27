/**
 * Brain-proposal confirm route (#5482, ADR-0036 §T7 under §T9's 2026-08-27b
 * entry-gate amendment).
 *
 * `POST /api/v1/brain-proposals/confirm` is the confirm-before-write execution
 * point: the ONLY place a chat-staged proposal actually enters the fact graph.
 * The `proposeFact` agent tool never records a claim — it returns a
 * `needs_confirmation` result, the chat surface renders a confirm card, and the
 * card POSTs the staged claim here after the human clicks Confirm.
 *
 * This endpoint is NOT a trusted fast-path. It re-resolves the caller's
 * workspace and principal set and calls `proposeFact` with THAT context, so the
 * attribution, the grant and the workspace's live vocabulary are all derived
 * server-side. A tampered client payload cannot assert a claim into another
 * workspace, attribute one to another principal, or widen its grant.
 *
 * ## Why the whole verb sits behind this endpoint, draft output notwithstanding
 *
 * `reconcile.ts` does not filter corroboration by review state: a proposal that
 * AGREES with a live fact writes a `provenance` edge immediately and unreviewed.
 * So "it only creates drafts" is true of novel claims and false of agreeing
 * ones, and the agreeing half never reaches a review queue at all. One entry
 * point behind one gate covers both; `lib/brain/proposal.ts`'s header carries
 * the argument, and `proposeFact` has no other production caller.
 *
 * Middleware mirrors `brain-corrections.ts`: standardAuth → requestContext, and
 * deliberately NO `mfaRequired` — the same posture, recorded there, for the same
 * reason. This route is additionally not admin-gated at all: an ordinary
 * workspace member may propose, which is the decision `lib/brain/proposal.ts`
 * argues for.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB, hasInternalDB } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { proposeFact, type ProposalOutcome } from "@atlas/api/lib/brain/proposal";
import {
  burnProposalConfirmNonce,
  verifyProposalConfirmToken,
} from "@atlas/api/lib/brain/proposal-confirm";
import {
  BrainReaderIdentityError,
  resolveBrainReaderContext,
} from "@atlas/api/lib/brain/reader-context";
import {
  VocabularyClosureError,
  loadWorkspaceVocabulary,
} from "@atlas/api/lib/brain/vocabulary";
import { BrainProposalClaimSchema } from "@useatlas/schemas";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("brain-proposals");

/**
 * The staged claim, echoed back verbatim by the card, plus the confirm token.
 *
 * The CLAIM half is the shared schema the tool validates with, extended rather
 * than restated. That is not tidiness: the token binds a canonical hash of
 * exactly these five fields, so two independently-maintained validators on one
 * write path could stage a payload this endpoint rejects — or coerce a field one
 * way here and another there, making every proposal carrying it fail its own
 * confirm. A payload outside the shared bounds was never mintable, so a request
 * carrying one is a client bug or a forgery attempt; either way it is rejected
 * before any token work.
 */
const ConfirmRequestSchema = BrainProposalClaimSchema.extend({
  // The single-use confirm token minted at staging. Required — a confirm POST
  // without it is a malformed request (rejected by the validation hook). Lives
  // HERE and not on the shared schema: it is this endpoint's concern, and a tool
  // `inputSchema` advertising it would invite the model to invent one.
  token: z.string().min(1, "confirm token is required"),
});

/**
 * What a confirmed proposal returns to the CARD.
 *
 * Two arms, and the discriminator is the whole value of the response: `proposed`
 * means a draft now waits for a reviewer, `corroborated` means the brain already
 * believed this and the claim was recorded as further evidence instead. The card
 * says different things for each, because telling a user their fact is "queued
 * for review" when nothing was queued is exactly the kind of confident wrongness
 * the confirm flow exists to remove.
 *
 * `status` is pinned to the literal `"draft"` on the created arm rather than
 * echoed from the row. Nothing on this path can write `brain_facts.status` — the
 * seam never names the column, and `scripts/check-brain-fact-promotion.sh`
 * refuses a second writer — so the literal is the guarantee restated on the
 * wire, and a change that broke it would fail to typecheck here first.
 */
const ConfirmResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("proposed"),
    factId: z.string(),
    status: z.literal("draft"),
    proposalEpisodeId: z.string(),
    provisional: z.boolean(),
    tensionEdges: z.number(),
  }),
  z.object({
    outcome: z.literal("corroborated"),
    factId: z.string(),
    proposalEpisodeId: z.string(),
    evidenceAdded: z.boolean(),
  }),
]);

/**
 * The one neutral rejection for every attacker-probeable token failure. The
 * specific reason is logged server-side and never returned: telling a caller
 * which check tripped is how a pipeline gets probed.
 */
const TOKEN_INVALID_BODY = {
  error: "confirm_token_invalid",
  message:
    "This confirmation is missing, invalid, expired, or already used. Ask Atlas to stage the proposal again.",
} as const;

const confirmRoute = createRoute({
  method: "post",
  path: "/confirm",
  tags: ["Company Brain"],
  summary: "Record a confirmed brain-fact proposal",
  description:
    "Records a previously-staged net-new claim after the user confirms it in the chat surface. " +
    "The claim enters the fact graph through the shared reconcile stage, landing as a DRAFT for review — " +
    "or, when it agrees with a fact the workspace already holds, as additional evidence for that fact. " +
    "The staged payload is never trusted: attribution, grant and vocabulary are all re-derived server-side.",
  request: {
    body: {
      content: { "application/json": { schema: ConfirmRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Proposal recorded",
      content: { "application/json": { schema: ConfirmResponseSchema } },
    },
    400: {
      description:
        "No active workspace / missing-invalid-expired-replayed confirm token / a claim that asserts nothing",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    422: {
      description: "Invalid request body",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    500: {
      description: "Server / configuration error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description: "The brain store is unavailable for this deployment",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function createBrainProposalsRoute() {
  const route = new OpenAPIHono<AuthEnv>();
  route.use(standardAuth);
  route.use(requestContext);

  // Match rest-operations.ts: normalize unparseable-JSON 400s into the standard
  // API error envelope rather than Hono's default text body.
  route.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.res;
      if (err.status === 400) {
        return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
      }
    }
    throw err;
  });

  route.openapi(
    confirmRoute,
    async (c) => {
      const auth = c.get("authResult");
      const requestId = c.get("requestId");
      const orgId = auth?.user?.activeOrganizationId;
      if (!orgId) {
        return c.json(
          {
            error: "no_workspace",
            message: "No active workspace — select one before confirming a proposal.",
          },
          400,
        );
      }
      if (!hasInternalDB()) {
        return c.json(
          {
            error: "brain_unavailable",
            message:
              "Proposing a fact is unavailable — this deployment has no internal database configured.",
            requestId,
          },
          503,
        );
      }

      const input = c.req.valid("json");

      // Re-resolve the actor from THIS request rather than trusting anything
      // staged. The proposal is attributed to this context and granted from it,
      // so a session that has since lost its membership is refused here even
      // though its token verifies.
      let ctx: Awaited<ReturnType<typeof resolveBrainReaderContext>>;
      try {
        ctx = await resolveBrainReaderContext(getInternalDB(), {
          workspaceId: orgId,
          mode: detectAuthMode(),
          user: auth?.user,
          requestId,
        });
      } catch (err) {
        if (err instanceof BrainReaderIdentityError) {
          log.error(
            { err: err.message, workspaceId: orgId, requestId },
            "Proposal confirm refused: actor identity could not be resolved",
          );
          return c.json(
            {
              error: "reader_unresolved",
              message:
                "Your identity could not be resolved for this workspace, so the claim could not be " +
                "attributed to anyone. This is a configuration or session problem — report it; nothing " +
                "was recorded.",
              requestId,
            },
            500,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err: message, workspaceId: orgId, requestId },
          "Proposal confirm could not resolve the actor",
        );
        return c.json(
          {
            error: "internal_error",
            message: "Couldn't verify who you are right now — nothing was recorded. Retry shortly.",
            requestId,
          },
          500,
        );
      }

      // The single-use confirm gate. Verify the token binds THIS re-resolved
      // request before anything else: a missing, forged, expired, or
      // workspace-/claim-mismatched token never reaches the verb. The nonce burn
      // runs just before the write.
      // Built ONCE and used for both the binding check and the write below, so
      // the claim the token is verified against is the same object the verb
      // records. Two constructions from the same `input` would be two places to
      // keep in agreement, and the direction that fails is silent: a field
      // included in one and omitted from the other verifies a claim that is not
      // the one written.
      const claim = {
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      };
      const verification = verifyProposalConfirmToken(input.token, {
        workspaceId: ctx.workspaceId,
        claim,
      });
      if (!verification.ok) {
        // `no-key` is a server/operator misconfiguration, not an
        // attacker-probeable token failure — a correlated 500, not the neutral
        // client 400. Near-unreachable in practice: mint fails loud on no-key,
        // so a confirmable proposal cannot have been staged without a key —
        // reachable only if the key is removed or rotated-to-empty between stage
        // and confirm.
        if (verification.reason === "no-key") {
          log.error(
            { workspaceId: ctx.workspaceId, requestId },
            "Proposal confirm rejected: no signing key configured for confirm tokens (server misconfiguration)",
          );
          return c.json(
            {
              error: "confirm_token_unverifiable",
              message:
                "The server can't verify proposal confirmations right now — its confirm-token signing key " +
                "isn't configured. This is a server configuration issue, not a problem with your request.",
              requestId,
            },
            500,
          );
        }
        log.warn(
          { workspaceId: ctx.workspaceId, reason: verification.reason, requestId },
          "Proposal confirm rejected: invalid confirm token",
        );
        return c.json(TOKEN_INVALID_BODY, 400);
      }

      // Burn the nonce — single-use. Synchronous, with no `await` between the
      // verification above and here, so two concurrent replays of the same token
      // cannot both reach the verb (the first burns it; the second is rejected).
      // A looping agent re-posting its staged payload hits this too.
      //
      // ⚠️ This is also what stops a confirmed proposal being spent twice on the
      // CORROBORATION path, where a second write is not a duplicate row but a
      // second attestation — silent, and exactly the self-echo the distinct-
      // source count exists to discount.
      if (!burnProposalConfirmNonce(verification.nonce, verification.expSeconds)) {
        log.warn(
          { workspaceId: ctx.workspaceId, requestId },
          "Proposal confirm rejected: confirm token already used (replay)",
        );
        return c.json(
          {
            error: "confirm_token_invalid",
            message:
              "This confirmation was already used. Ask Atlas to stage the proposal again if you need to repeat it.",
          },
          400,
        );
      }

      // ── The write, through the one seam every producer enters by ───────────
      let outcome: ProposalOutcome;
      try {
        outcome = await proposeFact({
          ctx,
          claim: {
            // The verified claim, with the ONE field the verb takes in another
            // representation. `validFrom` travels as an ISO string through the
            // gate because the token binds those bytes (`proposal-confirm.ts`);
            // it becomes a `Date` here, past the gate, on its way in.
            ...claim,
            validFrom: claim.validFrom ? new Date(claim.validFrom) : null,
          },
          requestId,
          // The workspace's real vocabulary. Loaded HERE rather than carried in
          // the staged payload for the reason this whole endpoint exists: the
          // staged payload is not trusted, and a vocabulary is workspace STATE
          // that may have moved since staging. It is never degraded — the empty
          // vocabulary would key the claim under a different identity function
          // than ingest used.
          vocabulary: await loadWorkspaceVocabulary(ctx.workspaceId),
        });
      } catch (err) {
        if (err instanceof VocabularyClosureError) {
          // Deterministic, workspace-scoped, and permanent until an operator
          // recomputes the closure. Retrying cannot clear it, so the copy says
          // so rather than inviting a loop.
          log.error(
            {
              err: err.message,
              workspaceId: ctx.workspaceId,
              position: err.position,
              norm: err.norm,
              requestId,
            },
            "Proposal confirm refused: the workspace's alias vocabulary is half-rebuilt",
          );
          return c.json(
            {
              error: "vocabulary_incomplete",
              message:
                "This workspace's alias vocabulary is incomplete, so a new claim cannot be keyed the way " +
                "ingest keys it — nothing was recorded. Retrying will not help: an operator has to " +
                "recompute the vocabulary's closure first.",
              requestId,
            },
            503,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err: message, workspaceId: ctx.workspaceId, requestId },
          "Proposal confirm failed",
        );
        return c.json(
          {
            error: "internal_error",
            message:
              "The proposal failed before it could be recorded — nothing was changed. Retry once; if it " +
              "persists, the brain store may be temporarily unavailable.",
            requestId,
          },
          500,
        );
      }

      if (outcome.kind === "refused") {
        // The token was burned above and this proposal did not land. Deliberate,
        // on `brain-corrections.ts`'s reasoning: the nonce is spent on the
        // ATTEMPT, so a caller cannot re-fire one confirmation against many
        // claims. The user re-states and the agent stages a fresh one.
        log.warn(
          { workspaceId: ctx.workspaceId, refusal: outcome.reason, requestId },
          "Proposal confirm refused by the machinery",
        );
        return c.json(
          { error: "proposal_refused", message: outcome.message, requestId },
          400,
        );
      }

      if (outcome.kind === "corroborated") {
        const { factId, proposalEpisodeId, evidenceAdded } = outcome.result;
        log.info(
          { workspaceId: ctx.workspaceId, factId, proposalEpisodeId, evidenceAdded, requestId },
          "Confirmed brain proposal corroborated an existing fact",
        );
        // Projected field by field rather than spread — see ConfirmResponseSchema.
        return c.json(
          { outcome: "corroborated" as const, factId, proposalEpisodeId, evidenceAdded },
          200,
        );
      }

      const { factId, proposalEpisodeId, provisional, tensionEdges } = outcome.result;
      log.info(
        { workspaceId: ctx.workspaceId, factId, proposalEpisodeId, provisional, requestId },
        "Confirmed brain proposal created a draft fact",
      );
      return c.json(
        {
          outcome: "proposed" as const,
          factId,
          status: "draft" as const,
          proposalEpisodeId,
          provisional,
          tensionEdges,
        },
        200,
      );
    },
    (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "validation_error",
            message: "Invalid request body.",
            details: result.error.issues,
          },
          422,
        );
      }
    },
  );

  return route;
}

/** The default route registered by `index.ts`. */
export const brainProposals = createBrainProposalsRoute();
