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
 * Token-revocation order matters: tokens reference the client via FK, so a
 * naïve `DELETE FROM oauthClient` first either CASCADEs (depending on the
 * adapter's FK config) or fails on the constraint. We delete tokens →
 * consent → client to keep the order deterministic regardless of FK
 * mode and to give the audit metadata accurate per-table counts.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { queryEffect } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage, causeToError } from "@atlas/api/lib/audit/error-scrub";
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
  clientId: z.string(),
  clientName: z.string().nullable(),
  redirectUris: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  disabled: z.boolean(),
  type: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  tokenCount: z.number(),
});

const ListClientsResponseSchema = z.object({
  clients: z.array(OAuthClientSchema),
});

const RevokeResponseSchema = z.object({
  success: z.boolean(),
  tokensRevoked: z.number(),
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
    "Deletes the OAuth client and every outstanding access token, refresh token, and consent record for that client within the active workspace. Standards-compliant clients (Claude Desktop, ChatGPT, Cursor) will need to re-register via DCR after revocation.",
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

    // The `oauthAccessToken` LEFT JOIN aggregates outstanding tokens + the
    // most recent issuance per client in one round trip. Filtering by
    // `referenceId` on BOTH tables means a token whose client moved
    // workspaces (rare, but possible if `referenceId` is ever rewritten)
    // doesn't leak across the join.
    //
    // Better Auth's oauth-provider stores camelCase column names, so every
    // identifier needs double-quoting in PG. The `"oauthClient"` table name
    // matches `modelName: "oauthClient"` from the plugin schema.
    const rows = yield* queryEffect<{
      clientId: string;
      clientName: string | null;
      redirectUris: string[] | null;
      createdAt: string;
      updatedAt: string | null;
      disabled: boolean | null;
      type: string | null;
      lastUsedAt: string | null;
      tokenCount: string;
    }>(
      `SELECT c."clientId" AS "clientId",
              c."name" AS "clientName",
              c."redirectUris" AS "redirectUris",
              c."createdAt" AS "createdAt",
              c."updatedAt" AS "updatedAt",
              c."disabled" AS "disabled",
              c."type" AS "type",
              MAX(t."createdAt") AS "lastUsedAt",
              COUNT(t."id") AS "tokenCount"
         FROM "oauthClient" c
         LEFT JOIN "oauthAccessToken" t
           ON t."clientId" = c."clientId"
          AND t."referenceId" = c."referenceId"
         WHERE c."referenceId" = $1
         GROUP BY c."clientId", c."name", c."redirectUris", c."createdAt",
                  c."updatedAt", c."disabled", c."type"
         ORDER BY c."createdAt" DESC`,
      [orgId!],
    );

    return c.json({
      clients: rows.map((r) => ({
        clientId: r.clientId,
        clientName: r.clientName,
        redirectUris: r.redirectUris ?? [],
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        disabled: Boolean(r.disabled),
        type: r.type,
        lastUsedAt: r.lastUsedAt,
        tokenCount: parseInt(r.tokenCount, 10),
      })),
    }, 200);
  }), { label: "list oauth clients" });
});

// POST /:id/revoke — delete client + outstanding tokens scoped to org
adminOauthClients.openapi(revokeClientRoute, async (c) => {
  const { id: clientId } = c.req.valid("param");
  const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;

  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    const { requestId } = c.get("orgContext");

    // Pre-fetch — captures `clientName` for the audit metadata before the
    // DELETE strips the row, and proves the client belongs to this org.
    // Probing a foreign workspace's clients is a forensic signal so the
    // not-found branch still emits an audit row.
    const prior = yield* queryEffect<{ clientId: string; clientName: string | null }>(
      `SELECT "clientId", "name" AS "clientName"
         FROM "oauthClient"
         WHERE "clientId" = $1 AND "referenceId" = $2`,
      [clientId, orgId!],
    );

    if (prior.length === 0) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.oauth_client.revoke,
        targetType: "oauth_client",
        targetId: clientId,
        ipAddress,
        metadata: { clientId, found: false },
      });
      return c.json(
        { error: "not_found", message: "OAuth client not found in this workspace.", requestId },
        404,
      );
    }

    const clientName = prior[0]!.clientName;

    // Order: tokens → consent → client. Tokens FK-reference the client; the
    // refresh token chain is independent of the access token chain, but
    // both must be gone before the client row drops to keep deletion safe
    // regardless of the underlying FK ON DELETE policy.
    const accessTokens = yield* queryEffect<{ id: string }>(
      `DELETE FROM "oauthAccessToken"
        WHERE "clientId" = $1 AND "referenceId" = $2
        RETURNING "id"`,
      [clientId, orgId!],
    );
    const refreshTokens = yield* queryEffect<{ id: string }>(
      `DELETE FROM "oauthRefreshToken"
        WHERE "clientId" = $1 AND "referenceId" = $2
        RETURNING "id"`,
      [clientId, orgId!],
    );
    const consents = yield* queryEffect<{ id: string }>(
      `DELETE FROM "oauthConsent"
        WHERE "clientId" = $1 AND "referenceId" = $2
        RETURNING "id"`,
      [clientId, orgId!],
    );
    yield* queryEffect<{ clientId: string }>(
      `DELETE FROM "oauthClient"
        WHERE "clientId" = $1 AND "referenceId" = $2
        RETURNING "clientId"`,
      [clientId, orgId!],
    );

    log.info(
      {
        requestId,
        clientId,
        actorId: user?.id,
        accessTokensRevoked: accessTokens.length,
        refreshTokensRevoked: refreshTokens.length,
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
        accessTokensRevoked: accessTokens.length,
        refreshTokensRevoked: refreshTokens.length,
        consentRowsRevoked: consents.length,
      },
    });

    return c.json(
      { success: true, tokensRevoked: accessTokens.length + refreshTokens.length },
      200,
    );
  }).pipe(
    // Pure-interrupt causes (client disconnect, shutdown) leave the outcome
    // indeterminate and are intentionally not audited — same precedent as
    // `admin-sessions.ts`. All other failures emit a `status: "failure"` row
    // so forensic queries can pivot on outcome without joining on response
    // code. `Effect.ignoreLogged` guards against a future regression that
    // makes `logAdminAction` throw — the original 500 still flows through
    // to the caller instead of being masked.
    Effect.tapErrorCause((cause) => {
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
