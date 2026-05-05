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
 * Revocation is atomic. The four DELETEs (access tokens → refresh tokens →
 * consent → client) run inside a single transaction so a transient failure
 * mid-sequence (pool exhaustion, statement timeout, TCP reset) cannot leave
 * the workspace in a partially-revoked state with stale refresh tokens still
 * able to mint new access tokens. The pattern mirrors `admin-archive.ts`.
 * Order is child→parent: oauthAccessToken / oauthRefreshToken / oauthConsent
 * all FK-reference oauthClient.clientId, so deleting children first prevents
 * an FK violation on the final parent DELETE regardless of the adapter's
 * ON DELETE policy.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { getInternalDB, queryEffect } from "@atlas/api/lib/db/internal";
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

/**
 * Discriminator on the transactional revoke result. Captures the SQL phase
 * the rollback was triggered from so the failure-audit metadata can answer
 * "did anything actually delete?" without forcing the reviewer to grep logs.
 */
type RevokePhase = "access_tokens" | "refresh_tokens" | "consent" | "client" | "commit";

type RevokeOutcome =
  | { status: "ok"; access: number; refresh: number; consent: number }
  | { status: "race" }
  | { status: "rolled_back"; phase: RevokePhase; error: Error };

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
// Transactional revoke helper
// ---------------------------------------------------------------------------

/**
 * Atomically revoke `clientId` for `orgId`. All four DELETEs run inside one
 * transaction; partial-state failures roll back so the workspace never ends
 * up with stale refresh tokens after a 500.
 *
 * Returns a discriminated outcome so the caller can branch on success / race
 * / rolled-back without exception handling. Race detection: pre-fetch is
 * outside this transaction, so a concurrent revoke can win between pre-fetch
 * and BEGIN — the parent DELETE seeing zero rows is the signal.
 *
 * Mirrors `admin-archive.ts:267-315` for the BEGIN/COMMIT/ROLLBACK +
 * `release(rollbackErr)` destroy-on-poison pattern.
 */
async function revokeAtomically(clientId: string, orgId: string): Promise<RevokeOutcome> {
  const pool = getInternalDB();
  const client = await pool.connect();
  let phase: RevokePhase = "access_tokens";
  let rollbackErr: Error | null = null;

  try {
    await client.query("BEGIN");

    const access = await client.query(
      `DELETE FROM "oauthAccessToken"
        WHERE "clientId" = $1 AND "referenceId" = $2
        RETURNING "id"`,
      [clientId, orgId],
    );
    phase = "refresh_tokens";

    const refresh = await client.query(
      `DELETE FROM "oauthRefreshToken"
        WHERE "clientId" = $1 AND "referenceId" = $2
        RETURNING "id"`,
      [clientId, orgId],
    );
    phase = "consent";

    const consent = await client.query(
      `DELETE FROM "oauthConsent"
        WHERE "clientId" = $1 AND "referenceId" = $2
        RETURNING "id"`,
      [clientId, orgId],
    );
    phase = "client";

    const deleted = await client.query(
      `DELETE FROM "oauthClient"
        WHERE "clientId" = $1 AND "referenceId" = $2
        RETURNING "clientId"`,
      [clientId, orgId],
    );

    // Race: pre-fetch saw the row but the transactional DELETE missed it. A
    // concurrent admin (or duplicate request) revoked the same client
    // between the pre-fetch and BEGIN. Roll back so the partial child
    // DELETEs revert — without rollback, the children would be gone but
    // the parent client (now owned by the racing tx) would survive.
    if (deleted.rows.length === 0) {
      await client.query("ROLLBACK");
      return { status: "race" };
    }

    phase = "commit";
    await client.query("COMMIT");

    return {
      status: "ok",
      access: access.rows.length,
      refresh: refresh.rows.length,
      consent: consent.rows.length,
    };
  } catch (err) {
    // ROLLBACK can itself fail (TCP reset between BEGIN and ROLLBACK). pg
    // destroys the socket when `release(err)` is called with a truthy arg,
    // so a poisoned client doesn't return to the pool to corrupt the next
    // borrower's transaction.
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { err: rollbackErr.message, clientId, orgId, phase },
        "ROLLBACK failed after revoke error — client will be destroyed",
      );
    });
    return {
      status: "rolled_back",
      phase,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}

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
      auditedInline = true;
      return c.json(
        { error: "not_found", message: "OAuth client not found in this workspace.", requestId },
        404,
      );
    }

    const clientName = prior[0]!.clientName;
    const outcome = yield* Effect.promise(() => revokeAtomically(clientId, orgId!));

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
      // tapErrorCause duplicate.
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
        },
      });
      auditedInline = true;
      return yield* Effect.fail(outcome.error);
    }

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
