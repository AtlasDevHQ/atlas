/**
 * Admin OAuth-clients management (#2024 — Settings → OAuth Clients).
 *
 * Mounted under /api/v1/admin/oauth-clients via admin.route().
 *
 * The hosted MCP install path (#2024 PR C) onboards Claude Desktop / ChatGPT /
 * Cursor and any other MCP-spec-compliant agent through Dynamic Client
 * Registration on `@better-auth/oauth-provider`. Every successful DCR creates
 * a row in `oauthClient`; the `oauthProvider({ clientReference })` callback
 * in `lib/auth/server.ts` stamps the active workspace's id onto each row's
 * `referenceId` so org-scoping works without a separate join table.
 *
 * The admin surface here is inspection + revocation only — the install path
 * itself is standards-driven and never goes through this router. Token
 * issuance, consent flow, and refresh stay in the Better Auth oauth-provider
 * plugin.
 *
 * Atomicity, race detection, and the four ordered DELETEs live in the shared
 * helper at `lib/auth/oauth-clients.ts` so this admin surface and the
 * per-user `/api/v1/me/oauth-clients` surface (#2065) can't drift on
 * revocation semantics. This route owns audit emission + HTTP shaping; the
 * helper owns SQL + transaction lifecycle.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage, causeToError } from "@atlas/api/lib/audit/error-scrub";
import {
  findOAuthClient,
  listOAuthClients,
  revokeOAuthClient,
} from "@atlas/api/lib/auth/oauth-clients";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-oauth-clients");

/**
 * Upper bound for the `:id` route parameter — `client_id` values are
 * typically 32–64 chars (DCR-issued UUIDs or short well-known names like
 * `claude-desktop`). Capping prevents adversarial inputs from bloating
 * `admin_action_log.metadata` on the `found: false` audit branch.
 */
const ID_MAX_LEN = 255;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OAuthClientSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string().nullable(),
  redirectUris: z.array(z.string().url()),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  disabled: z.boolean(),
  type: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  tokenCount: z.number().int().nonnegative(),
  // tokenState (#2066) — same field surfaced on /me/oauth-clients.
  // Admin surface includes it so the wire shape stays in lockstep
  // with the per-user one and OpenAPI consumers see one schema.
  tokenState: z.enum(["active", "reconnect_required", "revoked"]),
});

const ListClientsResponseSchema = z.object({
  clients: z.array(OAuthClientSchema),
});

const RevokeResponseSchema = z.object({
  success: z.boolean(),
  tokensRevoked: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listClientsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — OAuth Clients"],
  summary: "List OAuth clients",
  description:
    "Returns OAuth 2.1 clients (including DCR-registered MCP agents) bound to the active workspace, with last-use timestamp and outstanding token count.",
  responses: {
    200: {
      description: "OAuth client list",
      content: { "application/json": { schema: ListClientsResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeClientRoute = createRoute({
  method: "post",
  path: "/{id}/revoke",
  tags: ["Admin — OAuth Clients"],
  summary: "Revoke OAuth client",
  description:
    "Atomically deletes the OAuth client and every outstanding access token, refresh token, and consent record for that client within the active workspace. Standards-compliant clients (Claude Desktop, ChatGPT, Cursor) will need to re-register via DCR after revocation.",
  request: {
    params: z.object({
      id: z.string().min(1).max(ID_MAX_LEN).openapi({
        param: { name: "id", in: "path" },
        example: "claude-desktop",
      }),
    }),
  },
  responses: {
    200: {
      description: "Client revoked",
      content: { "application/json": { schema: RevokeResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Client not found in this workspace", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminOauthClients = createAdminRouter();
adminOauthClients.use(requireOrgContext());

// GET / — list OAuth clients scoped to the active org
adminOauthClients.openapi(listClientsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const clients = yield* Effect.promise(() =>
      listOAuthClients({ kind: "org", orgId: orgId! }),
    );
    return c.json({ clients }, 200);
  }), { label: "list oauth clients" });
});

// POST /:id/revoke — atomic delete of client + outstanding tokens scoped to org
adminOauthClients.openapi(revokeClientRoute, async (c) => {
  const { id: clientId } = c.req.valid("param");
  const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
  // Closure-scoped flag so the rolled-back path can audit its phase-aware
  // metadata inline without `tapErrorCause` re-emitting a thinner row on the
  // same error. Pre-fetch failures (and any other unaudited termination)
  // still fall through to the tapErrorCause emission.
  let auditedInline = false;

  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    const { requestId } = c.get("orgContext");

    // Pre-fetch — captures `clientName` for the audit metadata before the
    // DELETE strips the row, and proves the client belongs to this org.
    // Probing a foreign workspace's clients is a forensic signal so the
    // not-found branch still emits an audit row.
    const prior = yield* Effect.promise(() =>
      findOAuthClient(clientId, { kind: "org", orgId: orgId! }),
    );

    if (!prior) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.oauth_client.revoke,
        targetType: "oauth_client",
        targetId: clientId,
        ipAddress,
        metadata: { clientId, found: false },
      });
      auditedInline = true;
      return c.json(
        { error: "not_found", message: "OAuth client not found in this workspace.", requestId },
        404,
      );
    }

    const clientName = prior.clientName;
    const outcome = yield* Effect.promise(() =>
      revokeOAuthClient(clientId, { kind: "org", orgId: orgId! }),
    );

    if (outcome.status === "race") {
      // Concurrent revoke won — partial child DELETEs were rolled back so
      // no stale tokens were left behind. The race row is forensically
      // distinct from a plain pre-fetch miss; mirrors admin-sessions.ts.
      logAdminAction({
        actionType: ADMIN_ACTIONS.oauth_client.revoke,
        targetType: "oauth_client",
        targetId: clientId,
        ipAddress,
        metadata: { clientId, clientName, found: false, race: true },
      });
      auditedInline = true;
      return c.json(
        { error: "not_found", message: "OAuth client not found in this workspace.", requestId },
        404,
      );
    }

    if (outcome.status === "rolled_back") {
      // Transaction rolled back. Audit with the phase that tripped + the
      // scrubbed error message (errorMessage strips pg userinfo and caps
      // length), then re-fail the Effect so runHandler classifies it to a
      // 500 with requestId. The `auditedInline` flag suppresses the
      // tapErrorCause duplicate. `rollbackError` is included only when
      // ROLLBACK itself threw — its presence in the audit row signals
      // "the partial child DELETEs may not have been cleanly reverted",
      // which the pino warn line alone wouldn't make queryable.
      logAdminAction({
        actionType: ADMIN_ACTIONS.oauth_client.revoke,
        targetType: "oauth_client",
        targetId: clientId,
        status: "failure",
        ipAddress,
        metadata: {
          clientId,
          clientName,
          phase: outcome.phase,
          error: errorMessage(outcome.error),
          ...(outcome.rollbackError
            ? { rollbackError: errorMessage(outcome.rollbackError) }
            : {}),
        },
      });
      auditedInline = true;
      return yield* Effect.fail(outcome.error);
    }

    // Exhaustiveness: a future `RevokeOutcome` variant must be handled
    // explicitly; this `satisfies` makes TS reject silent fall-through
    // into the success-branch reads below.
    outcome satisfies { status: "ok"; access: number; refresh: number; consent: number };

    log.info(
      {
        requestId,
        clientId,
        actorId: user?.id,
        accessTokensRevoked: outcome.access,
        refreshTokensRevoked: outcome.refresh,
      },
      "OAuth client revoked",
    );
    logAdminAction({
      actionType: ADMIN_ACTIONS.oauth_client.revoke,
      targetType: "oauth_client",
      targetId: clientId,
      ipAddress,
      metadata: {
        clientId,
        clientName,
        accessTokensRevoked: outcome.access,
        refreshTokensRevoked: outcome.refresh,
        consentRowsRevoked: outcome.consent,
      },
    });

    return c.json(
      { success: true, tokensRevoked: outcome.access + outcome.refresh },
      200,
    );
  }).pipe(
    // Pure-interrupt causes (client disconnect, shutdown) leave the outcome
    // indeterminate and are intentionally not audited — same precedent as
    // F-23 / `admin-sessions.ts`. All other un-audited failures (pre-fetch
    // throw, unexpected Effect bubble) emit a `status: "failure"` row so
    // forensic queries can pivot on outcome without joining on response
    // code. `auditedInline` suppresses duplicate emission for the
    // rolled-back path. `Effect.ignoreLogged` guards against a future
    // regression that makes `logAdminAction` throw — the original 500
    // still flows through to the caller instead of being masked.
    Effect.tapErrorCause((cause) => {
      if (auditedInline) return Effect.void;
      const err = causeToError(cause);
      if (err === undefined) return Effect.void;
      return Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.oauth_client.revoke,
          targetType: "oauth_client",
          targetId: clientId,
          status: "failure",
          ipAddress,
          metadata: { clientId, error: errorMessage(err) },
        }),
      ).pipe(Effect.ignoreLogged);
    }),
  ), { label: "revoke oauth client" });
});

export { adminOauthClients };
