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
import {
  CORRECTION_VERBS,
  correctFact,
  type CorrectionOutcome,
} from "@atlas/api/lib/brain/correction";
import { CORRECTION_STAGED_VERB } from "@atlas/api/lib/brain/staged-correct";
import {
  BRAIN_CORRECTION_OBJECT_MAX_CHARS,
  BRAIN_CORRECTION_REASON_MAX_CHARS,
} from "@useatlas/schemas";
import { ErrorSchema } from "./shared-schemas";
import { correctionNotFoundBody, refusalStatus } from "./shared-correction";
import { runStagedConfirm } from "./shared-staged-confirm";
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
      const requestId = c.get("requestId");
      const input = c.req.valid("json");

      // Built ONCE and used for both the token binding and the correction below.
      // Rebuilt rather than passed through: Zod types the nested `validFrom` as
      // `string | undefined`, while `CorrectionConfirmPayload` declares it as an
      // exact optional (#5522).
      const payload = {
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

      // The shared gate: degradation preamble → actor re-resolution → verify →
      // burn → vocabulary → the verb. What stays here is what is genuinely a
      // CORRECTION's — the binding, the write, and a three-status outcome
      // projection no other verb shares.
      const staged = await runStagedConfirm<
        Parameters<typeof CORRECTION_STAGED_VERB.claims>[0],
        CorrectionOutcome
      >(c, {
        verb: CORRECTION_STAGED_VERB,
        log,
        logFields: { factId: input.factId, verb: input.verb },
        token: input.token,
        bind: (ctx) => ({
          workspaceId: ctx.workspaceId,
          factId: input.factId,
          verb: input.verb,
          payload,
        }),
        execute: (ctx, vocabulary) =>
          correctFact({
            ctx,
            factId: input.factId,
            verb: input.verb,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(input.replacement
              ? {
                  replacement: {
                    object: input.replacement.object,
                    validFrom: input.replacement.validFrom
                      ? new Date(input.replacement.validFrom)
                      : null,
                  },
                }
              : {}),
            // #5496 — a human clicked Confirm and the server verified a
            // single-use, workspace-bound token before this line ran. That is the
            // strongest intent evidence the system can produce, and the audit row
            // records it so a row written under this regime is distinguishable
            // from one written before it existed.
            intent: "confirmed",
            requestId,
            vocabulary,
          }),
      });
      if (!staged.ok) return c.json(staged.refusal.body, staged.refusal.status);

      const { ctx, outcome } = staged;

      if (outcome.kind === "not-found") {
        // The token was burned by the gate and this correction did not land.
        // That is deliberate: the nonce is spent on the ATTEMPT, so a caller
        // cannot probe the graph by re-firing one confirmation against many
        // states. The user re-asks and the agent stages a fresh one.
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
