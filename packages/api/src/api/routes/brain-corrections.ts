/**
 * Brain-correction confirm route (#5496, implementing ADR-0036 §T9's
 * 2026-08-27b amendment decided in #5485).
 *
 * `POST /api/v1/brain-corrections/confirm` is the confirm-before-write
 * execution point: the ONLY place a chat-staged correction actually fires. The
 * `correct_fact` agent tool never applies a correction — it returns a
 * `needs_confirmation` result, the chat surface renders a confirm card, and the
 * card POSTs the staged payload here after the human clicks Confirm.
 *
 * This endpoint is NOT a trusted fast-path, and that is the whole design. It
 * re-resolves the caller's workspace and principal set and calls `correctFact`
 * exactly as the tool used to — so authority, ACL visibility, the tier-1
 * refusal, the temporal gates and vocabulary closure are ALL re-run server-side.
 * A tampered client payload cannot escalate past any of them.
 *
 * The confirm token proves a human approved THIS correction. It proves nothing
 * about whether the correction is still permitted, and those are different
 * questions: a role can be revoked, a fact retracted, a validity window closed
 * between staging and confirming. Treating the token as a permission grant is
 * the exact mistake `rest-write-confirm.ts`'s header warns about one subsystem
 * over.
 *
 * Middleware mirrors `rest-operations.ts`: standardAuth → requestContext.
 *
 * ⚠️ That is NOT the admin correction routes' middleware, and the difference is
 * recorded here rather than left to whoever notices it next. `createAdminRouter`
 * mounts `adminAuth → mfaRequired → requestContext`, so an owner/admin who has
 * not enrolled TOTP cannot reach `/admin/brain-facts/:id/retract`. This route
 * carries no `mfaRequired`, so the same person CAN apply the same verb through
 * the chat confirm card.
 *
 * Deliberate, and not a regression: the chat path never carried MFA, and #5496
 * makes it strictly stronger than what shipped (it used to fire in the agent
 * loop with no human act at all). The asymmetry is that one write now has two
 * entry points with different second-factor postures — worth knowing before
 * anyone concludes MFA gates every correction. If that becomes unacceptable,
 * the fix is `mfaRequired` here, not weakening the admin router.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB, hasInternalDB } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import {
  CORRECTION_VERBS,
  correctFact,
  type CorrectionOutcome,
} from "@atlas/api/lib/brain/correction";
import {
  burnCorrectionConfirmNonce,
  verifyCorrectionConfirmToken,
} from "@atlas/api/lib/brain/correction-confirm";
import {
  BrainReaderIdentityError,
  resolveBrainReaderContext,
} from "@atlas/api/lib/brain/reader-context";
import {
  VocabularyClosureError,
  loadWorkspaceVocabulary,
} from "@atlas/api/lib/brain/vocabulary";
import {
  BRAIN_CORRECTION_OBJECT_MAX_CHARS,
  BRAIN_CORRECTION_REASON_MAX_CHARS,
} from "@useatlas/schemas";
import { ErrorSchema } from "./shared-schemas";
import { correctionNotFoundBody, refusalStatus } from "./shared-correction";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("brain-corrections");

/**
 * The staged correction, echoed back verbatim by the card.
 *
 * The bounds are the shared ones, imported rather than restated — this schema,
 * the tool's `inputSchema` and the admin API's body schema must not drift into
 * three different caps on one write path. A payload exceeding them was never
 * mintable, so a request carrying one is either a client bug or a forgery
 * attempt; either way it is rejected before any token work.
 */
const ConfirmRequestSchema = z.object({
  factId: z.string().min(1, "factId must not be empty"),
  verb: z.enum(CORRECTION_VERBS),
  reason: z.string().max(BRAIN_CORRECTION_REASON_MAX_CHARS).optional(),
  replacement: z
    .object({
      object: z.string().min(1).max(BRAIN_CORRECTION_OBJECT_MAX_CHARS),
      validFrom: z.string().datetime({ offset: true }).optional(),
    })
    .optional(),
  // The single-use confirm token minted at staging. Required — a confirm POST
  // without it is a malformed request (rejected by the validation hook).
  token: z.string().min(1, "confirm token is required"),
});

/**
 * What a confirmed correction returns to the CARD.
 *
 * `flaggedForReReviewCount`, never the ids — the same projection
 * `lib/tools/correct-fact.ts` made for #4939, made here for the same reason now
 * that this is the surface a correction result reaches. `DEPENDENT_FACTS_SQL` is
 * deliberately un-ACL-gated (it flags every dependent, including ones this actor
 * cannot read, because skipping those would leave exactly them unflagged
 * forever). Sound for the WRITE; wrong as a disclosure — and the actor on the
 * far side of this response is the chat user, not an admin. The admin routes
 * keep the ids; this one does not.
 */
const ConfirmResponseSchema = z.object({
  status: z.literal("corrected"),
  verb: z.enum(CORRECTION_VERBS),
  factId: z.string(),
  correctionEpisodeId: z.string(),
  invalidatedAt: z.string().nullable(),
  supersededBy: z.string().nullable(),
  validTo: z.string().nullable(),
  flaggedForReReviewCount: z.number(),
});

/**
 * The one neutral rejection for every attacker-probeable token failure. The
 * specific reason is logged server-side and never returned: telling a caller
 * which check tripped is how a pipeline gets probed.
 */
const TOKEN_INVALID_BODY = {
  error: "confirm_token_invalid",
  message:
    "This confirmation is missing, invalid, expired, or already used. Ask Atlas to stage the correction again.",
} as const;

const confirmRoute = createRoute({
  method: "post",
  path: "/confirm",
  tags: ["Company Brain"],
  summary: "Apply a confirmed brain-fact correction",
  description:
    "Applies a previously-staged correction after the user confirms it in the chat surface. " +
    "Re-runs the full correction gate server-side — authority, ACL visibility, the tier-1 refusal, " +
    "the temporal gates and vocabulary closure — before applying the verb. The staged payload is " +
    "never trusted.",
  request: {
    body: {
      content: { "application/json": { schema: ConfirmRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Correction applied",
      content: { "application/json": { schema: ConfirmResponseSchema } },
    },
    400: {
      description:
        "Invalid request / no active workspace / missing-invalid-expired-replayed confirm token / a request-shape refusal",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: { description: "Forbidden — the actor does not carry the correction verb", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Fact absent, already retracted, or not visible to this actor", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "The verb cannot apply to this target", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid request body", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    500: { description: "Server / configuration error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "The brain store is unavailable for this deployment", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function createBrainCorrectionsRoute() {
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
            message: "No active workspace — select one before confirming a correction.",
          },
          400,
        );
      }
      if (!hasInternalDB()) {
        return c.json(
          {
            error: "brain_unavailable",
            message:
              "Fact correction is unavailable — this deployment has no internal database configured.",
            requestId,
          },
          503,
        );
      }

      const input = c.req.valid("json");

      // Re-resolve the actor from THIS request rather than trusting anything
      // staged. Every gate below reads this context, so a session that has since
      // lost its role is refused here even though its token verifies.
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
            "Correction confirm refused: actor identity could not be resolved",
          );
          return c.json(
            {
              error: "reader_unresolved",
              message:
                "Your identity could not be resolved for this workspace, so the fact's visibility could " +
                "not be checked safely. This is a configuration or session problem — report it; the fact " +
                "was not changed.",
              requestId,
            },
            500,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err: message, workspaceId: orgId, factId: input.factId, requestId },
          "Correction confirm could not resolve the actor",
        );
        return c.json(
          {
            error: "internal_error",
            message: "Couldn't verify who you are right now — nothing was changed. Retry shortly.",
            requestId,
          },
          500,
        );
      }

      // The single-use confirm gate. Verify the token binds THIS re-resolved
      // request before anything else: a missing, forged, expired, or
      // workspace-/fact-/verb-/payload-mismatched token never reaches the verb.
      // The nonce burn runs just before the correction.
      const verification = verifyCorrectionConfirmToken(input.token, {
        workspaceId: ctx.workspaceId,
        factId: input.factId,
        verb: input.verb,
        payload: {
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.replacement !== undefined ? { replacement: input.replacement } : {}),
        },
      });
      if (!verification.ok) {
        // `no-key` is a server/operator misconfiguration (no signing key
        // configured), not an attacker-probeable token failure — a correlated
        // 500, not the neutral client 400. Near-unreachable in practice: mint
        // fails loud on no-key, so a confirmable correction cannot have been
        // staged without a key — reachable only if the key is removed or
        // rotated-to-empty between stage and confirm.
        if (verification.reason === "no-key") {
          log.error(
            { workspaceId: ctx.workspaceId, factId: input.factId, requestId },
            "Correction confirm rejected: no signing key configured for confirm tokens (server misconfiguration)",
          );
          return c.json(
            {
              error: "confirm_token_unverifiable",
              message:
                "The server can't verify correction confirmations right now — its confirm-token signing key " +
                "isn't configured. This is a server configuration issue, not a problem with your request.",
              requestId,
            },
            500,
          );
        }
        log.warn(
          {
            workspaceId: ctx.workspaceId,
            factId: input.factId,
            verb: input.verb,
            reason: verification.reason,
            requestId,
          },
          "Correction confirm rejected: invalid confirm token",
        );
        return c.json(TOKEN_INVALID_BODY, 400);
      }

      // Burn the nonce — single-use. Synchronous, with no `await` between the
      // verification above and here, so two concurrent replays of the same token
      // cannot both reach the verb (the first burns it; the second is rejected).
      // A looping agent re-posting its staged payload hits this too.
      if (!burnCorrectionConfirmNonce(verification.nonce, verification.expSeconds)) {
        log.warn(
          { workspaceId: ctx.workspaceId, factId: input.factId, verb: input.verb, requestId },
          "Correction confirm rejected: confirm token already used (replay)",
        );
        return c.json(
          {
            error: "confirm_token_invalid",
            message:
              "This confirmation was already used. Ask Atlas to stage the correction again if you need to repeat it.",
          },
          400,
        );
      }

      // ── The correction, gated exactly as the tool used to gate it ──────────
      let outcome: CorrectionOutcome;
      try {
        outcome = await correctFact({
          ctx,
          factId: input.factId,
          verb: input.verb,
          reason: input.reason,
          replacement: input.replacement
            ? {
                object: input.replacement.object,
                validFrom: input.replacement.validFrom
                  ? new Date(input.replacement.validFrom)
                  : null,
              }
            : undefined,
          // #5496 — a human clicked Confirm and the server verified a
          // single-use, workspace-bound token before this line ran. That is the
          // strongest intent evidence the system can produce, and the audit row
          // records it so a row written under this regime is distinguishable
          // from one written before it existed.
          intent: "confirmed",
          requestId,
          // The workspace's real vocabulary. Loaded HERE rather than carried in
          // the staged payload for the reason this whole endpoint exists: the
          // staged payload is not trusted, and a vocabulary is workspace STATE
          // that may have moved since staging. It is never degraded — the empty
          // vocabulary would key the replacement under a different identity
          // function than ingest used.
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
              factId: input.factId,
              verb: input.verb,
              position: err.position,
              norm: err.norm,
              requestId,
            },
            "Correction confirm refused: the workspace's alias vocabulary is half-rebuilt",
          );
          return c.json(
            {
              error: "vocabulary_incomplete",
              message:
                "This workspace's alias vocabulary is incomplete, so a correction cannot be keyed the way " +
                "ingest keys it — nothing was changed. Retrying will not help: an operator has to recompute " +
                "the vocabulary's closure first.",
              requestId,
            },
            503,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err: message, workspaceId: ctx.workspaceId, factId: input.factId, verb: input.verb, requestId },
          "Correction confirm failed",
        );
        return c.json(
          {
            error: "internal_error",
            message:
              "The correction failed before it could be applied — nothing was changed. Retry once; if it " +
              "persists, the brain store may be temporarily unavailable.",
            requestId,
          },
          500,
        );
      }

      if (outcome.kind === "not-found") {
        // The token was burned above and this correction did not land. That is
        // deliberate: the nonce is spent on the ATTEMPT, so a caller cannot
        // probe the graph by re-firing one confirmation against many states.
        // The user re-asks and the agent stages a fresh one.
        return c.json(correctionNotFoundBody(requestId), 404);
      }
      if (outcome.kind === "refused") {
        log.warn(
          {
            workspaceId: ctx.workspaceId,
            factId: input.factId,
            verb: input.verb,
            refusal: outcome.reason,
            requestId,
          },
          "Correction confirm refused by the machinery",
        );
        return c.json(
          { error: "correction_refused", message: outcome.message, requestId },
          refusalStatus(outcome.reason),
        );
      }

      const { verb, factId, correctionEpisodeId, invalidatedAt, supersededBy, validTo } =
        outcome.result;
      log.info(
        { workspaceId: ctx.workspaceId, factId, verb, correctionEpisodeId, requestId },
        "Confirmed brain correction applied",
      );
      // Projected field by field rather than spread — see ConfirmResponseSchema.
      return c.json(
        {
          status: "corrected" as const,
          verb,
          factId,
          correctionEpisodeId,
          invalidatedAt,
          supersededBy,
          validTo,
          flaggedForReReviewCount: outcome.result.flaggedForReReview.length,
        },
        200,
      );
    },
    (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
          422,
        );
      }
    },
  );

  return route;
}

/** The default route registered by `index.ts`. */
export const brainCorrections = createBrainCorrectionsRoute();
