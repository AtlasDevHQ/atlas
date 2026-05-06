/**
 * Per-user OAuth-clients management (#2065 — Settings → AI Agents).
 *
 * Mounted at /api/v1/me/oauth-clients. Workspace users (non-admin) can list
 * and self-revoke OAuth clients THEY personally registered through the
 * hosted MCP install path. The admin variant
 * (`/api/v1/admin/oauth-clients`) sees every client in the workspace and is
 * documented in `admin-oauth-clients.ts`. SQL + transaction lifecycle live
 * in the shared helper at `lib/auth/oauth-clients.ts` so the two surfaces
 * cannot drift on revocation semantics.
 *
 * Cross-user isolation: every SELECT and DELETE filters by both
 * `referenceId = activeOrgId` (tenant) and `userId = caller` (user). User A
 * never sees User B's clients; revoke against another user's client returns
 * 404. The combined filter is the load-bearing IDOR check — neither alone
 * is sufficient (DCR clients are workspace-scoped at registration, but a
 * misconfigured row could match on org alone).
 *
 * Audit: emitted via the existing `oauth_client.revoke` action. The audit
 * row records `actor_id` / `actor_email` only — the role (member vs
 * admin) is implicit. Forensic queries that need to distinguish
 * self-revoke from admin-revoke must join `actor_id` against `member` or
 * read the metadata `clientName` against the workspace's user list.
 * Reusing one action type lets a single retention policy and a single
 * downstream alert apply to both surfaces; differentiating purely by
 * action type would have required forking those.
 *
 * The `GET` response includes the resolved `deployMode`. The
 * `/settings/ai-agents` page uses it to gate the "Connect new agent" CTA
 * (SaaS only — self-hosted operators continue using the admin surface).
 * Inlining `deployMode` here saves a second roundtrip; the admin
 * `/api/v1/admin/settings` endpoint that exposes the same value is
 * admin-gated and would 403 for the page's primary audience.
 */

import { Effect } from "effect";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage, causeToError } from "@atlas/api/lib/audit/error-scrub";
import { getConfig } from "@atlas/api/lib/config";
import {
  findOAuthClient,
  listOAuthClients,
  revokeOAuthClient,
} from "@atlas/api/lib/auth/oauth-clients";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("me-oauth-clients");

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
});

const ListMyClientsResponseSchema = z.object({
  clients: z.array(OAuthClientSchema),
  // Inlined into the list response so non-admin pages don't need a second
  // admin-gated roundtrip just to gate the "Connect new agent" CTA.
  deployMode: z.enum(["self-hosted", "saas"]),
});

const RevokeResponseSchema = z.object({
  success: z.boolean(),
  tokensRevoked: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listMyClientsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Me — OAuth Clients"],
  summary: "List your connected AI agents",
  description:
    "Returns OAuth 2.1 clients (e.g. Claude Desktop, ChatGPT, Cursor) that " +
    "the calling user personally registered against the active workspace, " +
    "with last-use timestamp and outstanding token count. The admin " +
    "variant (`/api/v1/admin/oauth-clients`) surfaces the workspace-wide " +
    "set. Includes the resolved `deployMode` so the UI can gate the " +
    "connect-new-agent flow to SaaS.",
  responses: {
    200: {
      description: "OAuth client list + deploy mode",
      content: { "application/json": { schema: ListMyClientsResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeMyClientRoute = createRoute({
  method: "post",
  path: "/{id}/revoke",
  tags: ["Me — OAuth Clients"],
  summary: "Revoke one of your connected AI agents",
  description:
    "Atomically deletes the OAuth client and every outstanding access " +
    "token, refresh token, and consent record for that (client, user) " +
    "pair. Cross-user isolation: a foreign client returns 404 — the " +
    "caller cannot revoke another user's client.",
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
    404: { description: "Client not found for this user", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const meOauthClients = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

meOauthClients.use(standardAuth);
meOauthClients.use(requestContext);

function resolveDeployMode(): "self-hosted" | "saas" {
  // Two-state collapse: anything other than `"saas"` (including a null /
  // missing config) maps to `"self-hosted"`. Same safe-default the web
  // `useDeployMode()` hook applies on its 403 fallback path.
  return getConfig()?.deployMode === "saas" ? "saas" : "self-hosted";
}

// GET / — list the calling user's OAuth clients.
meOauthClients.openapi(listMyClientsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;
    const orgId = user?.activeOrganizationId;

    if (!hasInternalDB()) {
      return c.json(
        { error: "not_available", message: "OAuth client management requires an internal database.", requestId },
        404,
      );
    }
    if (!user || !orgId) {
      // Belt-and-braces: standardAuth already rejects unauthenticated, but a
      // user without an active org has nothing to list — surface a stable
      // empty payload instead of a confusing partial.
      return c.json({ clients: [], deployMode: resolveDeployMode() }, 200);
    }

    const clients = yield* Effect.promise(() =>
      listOAuthClients({ kind: "user", userId: user.id, orgId }),
    );

    return c.json({ clients, deployMode: resolveDeployMode() }, 200);
  }), { label: "list my oauth clients" });
});

// POST /:id/revoke — atomic delete scoped to (clientId, userId).
meOauthClients.openapi(revokeMyClientRoute, async (c) => {
  const { id: clientId } = c.req.valid("param");
  const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
  // Closure-scoped flag mirrors the admin variant — the rolled-back path
  // emits an inline failure audit, so `tapErrorCause` must not duplicate it.
  let auditedInline = false;

  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;
    const orgId = user?.activeOrganizationId;

    if (!hasInternalDB()) {
      return c.json(
        { error: "not_available", message: "OAuth client management requires an internal database.", requestId },
        404,
      );
    }
    if (!user || !orgId) {
      return c.json(
        { error: "not_found", message: "OAuth client not found.", requestId },
        404,
      );
    }

    const scope = { kind: "user" as const, userId: user.id, orgId };

    // Pre-fetch — captures `clientName` for the audit metadata before the
    // DELETE strips the row, and proves the client belongs to this user.
    // Probing another user's client surfaces a `found: false` audit row so
    // forensic queries can pivot on cross-user probe attempts.
    const prior = yield* Effect.promise(() => findOAuthClient(clientId, scope));

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
        { error: "not_found", message: "OAuth client not found.", requestId },
        404,
      );
    }

    const clientName = prior.clientName;
    const outcome = yield* Effect.promise(() => revokeOAuthClient(clientId, scope));

    if (outcome.status === "race") {
      // Concurrent revoke (or a duplicate request) won between pre-fetch
      // and BEGIN — partial child DELETEs were rolled back. Forensically
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
        { error: "not_found", message: "OAuth client not found.", requestId },
        404,
      );
    }

    if (outcome.status === "rolled_back") {
      // `rollbackError` is surfaced only when ROLLBACK itself threw — its
      // presence pivots the audit row from "cleanly reverted" to "child
      // DELETEs may have leaked", which the pino warn line alone
      // wouldn't make queryable from `admin_action_log`.
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
        actorId: user.id,
        accessTokensRevoked: outcome.access,
        refreshTokensRevoked: outcome.refresh,
      },
      "User revoked own OAuth client",
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
  ), { label: "revoke my oauth client" });
});

export { meOauthClients };
