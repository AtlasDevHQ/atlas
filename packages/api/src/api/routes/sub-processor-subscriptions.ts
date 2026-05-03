/**
 * Procurement-team self-serve webhook subscriptions for the sub-processor
 * change feed (#1924, phase 3). One POST endpoint — no list / delete via
 * API today (procurement teams email legal@useatlas.dev to revoke; that
 * matches the existing "Subscribe via email" fallback channel and avoids
 * UI-for-managing-subscriptions until there's demand).
 *
 * Auth: standardAuth (any logged-in Atlas user). The /dpa modal explains
 * "sign in first" if the POST returns 401 — we don't want anonymous URL
 * dumping into the table.
 *
 * SSRF guard: stored URLs are POSTed to from inside the API process every
 * 6 hours, so we reject loopback / RFC1918 / link-local / non-https
 * targets at registration time via the shared `isSafeExternalUrl` helper.
 */

import crypto from "crypto";

import { Effect } from "effect";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { isSafeExternalUrl } from "@atlas/api/lib/sandbox/validate";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { createSubscription } from "@atlas/api/lib/sub-processor-publisher";

import {
  AuthErrorSchema,
  ErrorSchema,
} from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("sub-processor-subscriptions");

const PG_UNIQUE_VIOLATION = "23505";

const CreateSubscriptionBodySchema = z.object({
  url: z
    .string()
    .url("URL must be a fully-qualified https:// URL")
    .max(2048)
    .refine(isSafeExternalUrl, {
      message:
        "URL must be https:// and resolve to a public host — loopback, RFC1918, link-local, and metadata-service targets are rejected",
    }),
  token: z
    .string()
    .min(16, "Token must be at least 16 characters — used as the HMAC signing key"),
});

const CreateSubscriptionResponseSchema = z.object({
  id: z.string(),
});

const createSubscriptionRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Sub-processor Subscriptions"],
  summary: "Register a webhook for sub-processor change notifications",
  description:
    "Registers an HTTPS endpoint that Atlas POSTs to whenever the published " +
    "sub-processor list changes (add / change / remove). The token is stored " +
    "encrypted at rest and used as the HMAC-SHA256 signing key for every " +
    "delivery; verify the `X-Webhook-Signature` header (formatted as " +
    "`sha256=<hex_digest>`, Stripe/GitHub-style) against `${X-Webhook-" +
    "Timestamp}:${body}`. The full payload schema and a runnable verify " +
    "snippet live at https://docs.useatlas.dev/integrations/sub-processor-feed. " +
    "Tokens cannot be retrieved after registration — save your copy locally.",
  request: {
    body: {
      content: { "application/json": { schema: CreateSubscriptionBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Subscription registered",
      content: { "application/json": { schema: CreateSubscriptionResponseSchema } },
    },
    400: {
      description: "Invalid input",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    409: {
      description: "URL is already registered",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const router = new OpenAPIHono<AuthEnv>();

router.use("/*", standardAuth);
router.use("/*", requestContext);

type CreateOutcome =
  | { kind: "ok"; id: string }
  | { kind: "duplicate" }
  | { kind: "no_db" };

router.openapi(createSubscriptionRoute, async (c) => {
  const program = Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return { outcome: { kind: "no_db" as const }, requestId };
    }

    const { url, token } = c.req.valid("json");
    const id = `subp_${crypto.randomBytes(12).toString("hex")}`;

    const outcome = yield* Effect.tryPromise<CreateOutcome, Error>({
      try: async (): Promise<CreateOutcome> => {
        try {
          await createSubscription({
            id,
            url,
            token,
            createdByUserId: user?.id ?? null,
            // AtlasUser.label is the closest user-facing identifier we
            // have (email in managed mode, AAD upn / Slack handle
            // elsewhere). Stored verbatim for the audit trail.
            createdByLabel: user?.label ?? null,
          });
          return { kind: "ok", id };
        } catch (err) {
          // Match by SQLSTATE, not error message — the message is locale-
          // and pg-version dependent. Same precedent as
          // packages/api/src/lib/starter-prompts/favorite-store.ts and
          // packages/api/src/lib/suggestions/approval-store.ts.
          const code = (err as { code?: string } | undefined)?.code;
          if (code === PG_UNIQUE_VIOLATION) {
            return { kind: "duplicate" };
          }
          throw err instanceof Error ? err : new Error(String(err));
        }
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          log.error(
            { err: errorMessage(err), userId: user?.id, requestId },
            "Failed to create sub-processor subscription",
          ),
        ),
      ),
    );

    return { outcome, requestId };
  });

  const { outcome, requestId } = await runEffect(c, program, {
    label: "register sub-processor subscription",
  });

  if (outcome.kind === "no_db") {
    return c.json(
      {
        error: "internal_db_unavailable",
        message:
          "Sub-processor subscriptions require the internal database. Configure DATABASE_URL or contact your operator.",
        requestId,
      },
      503,
    );
  }
  if (outcome.kind === "duplicate") {
    return c.json(
      {
        error: "subscription_already_exists",
        message:
          "This URL is already registered. Use a different URL or contact legal@useatlas.dev to update the existing subscription.",
        requestId,
      },
      409,
    );
  }
  return c.json({ id: outcome.id }, 200);
});

export { router as subProcessorSubscriptions };
