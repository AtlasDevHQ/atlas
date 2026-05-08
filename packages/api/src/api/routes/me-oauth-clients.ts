/**
 * Per-user OAuth-clients management (#2065 — Settings → AI Agents).
 *
 * Mounted at /api/v1/me/oauth-clients. Workspace users (non-admin) can list,
 * self-revoke, and (for #2073) toggle multi-workspace mode + revoke per-
 * workspace grants for OAuth clients THEY personally registered through
 * the hosted MCP install path. The admin variant
 * (`/api/v1/admin/oauth-clients`) sees every client in the workspace and is
 * documented in `admin-oauth-clients.ts`. SQL + transaction lifecycle live
 * in the shared helpers at `lib/auth/oauth-clients.ts` and
 * `lib/auth/oauth-workspace-grants.ts` so the two surfaces cannot drift on
 * revocation / scope-toggle semantics.
 *
 * Routes:
 *   GET    /                                 — list calling user's clients
 *   POST   /:id/revoke                       — atomic revoke (#2065)
 *   POST   /:id/workspace-scope              — single↔multi toggle (#2073)
 *   DELETE /:id/workspaces/:workspaceId      — per-workspace grant revoke (#2073)
 *
 * Cross-user isolation: every SELECT and DELETE filters by both
 * `referenceId = activeOrgId` (tenant) and `userId = caller` (user). User A
 * never sees User B's clients; revoke against another user's client returns
 * 404. The combined filter is the load-bearing IDOR check — neither alone
 * is sufficient (DCR clients are workspace-scoped at registration, but a
 * misconfigured row could match on org alone).
 *
 * Audit: all four routes emit the `oauth_client.revoke` action with a
 * `metadata.phase` discriminator so a single retention policy and a single
 * downstream alert cover the whole family:
 *   - phase=undefined → `/revoke` (full client + tokens)
 *   - phase="workspace_scope" → `/workspace-scope` toggle
 *   - phase="workspace_grant" → `/workspaces/:workspaceId` per-grant revoke
 * Forensic queries that need to distinguish admin-revoke from self-revoke
 * must join `actor_id` against `member` or read the metadata `clientName`.
 * Differentiating purely by action type would have required forking the
 * retention policies + dashboards.
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
import {
  listUserWorkspaceIds,
  revokeWorkspaceGrant,
  setWorkspaceScopeAndGrants,
} from "@atlas/api/lib/auth/oauth-workspace-grants";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { validationHook } from "./validation-hook";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("me-oauth-clients");

/**
 * Upper bound for path-param values — `client_id` and `workspaceId`
 * are typically 32–64 chars (DCR-issued UUIDs or short well-known
 * names like `claude-desktop`). The cap defends two adjacent surfaces:
 * the `found: false` audit branch on `/:id/revoke` (where the param
 * lands in `admin_action_log.metadata`) and the per-workspace revoke
 * route's `workspaceId` (a sanity bound — the route doesn't audit a
 * `found: false` branch but oversized params still cost log line bytes
 * downstream and shouldn't be unbounded).
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
  // tokenState (#2066) — derived in SQL from disabled flag + outstanding
  // non-expired access/refresh tokens. The /settings/ai-agents table
  // renders three badges (Active / Reconnect required / Revoked); the
  // legacy `tokenCount` field stays informational for "tokens issued".
  tokenState: z.enum(["active", "reconnect_required", "revoked"]),
  // workspaceScope (#2073) — `'single'` (legacy default, no row in
  // `oauth_client_workspace_scope`) or `'multi'` (cross-workspace path).
  // The page renders a "Connected to all your workspaces" badge for
  // `multi` and exposes per-workspace revoke for the granted set.
  workspaceScope: z.enum(["single", "multi"]),
  // Granted workspace ids for `multi`-scope clients; empty for `single`.
  // The order is `granted_at ASC` so the UI's first row matches the
  // origin workspace (where DCR happened) for the typical install path.
  grantedWorkspaceIds: z.array(z.string()),
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

// #2073 — workspace-scope upgrade payload + response.
const SetWorkspaceScopeRequestSchema = z.object({
  // `mode = 'multi'` upgrades the client to cross-workspace operation
  // and grants access to every workspace the caller is currently a
  // member of. `mode = 'single'` reverts to the legacy single-scope
  // path: the scope row stamps `'single'` and every grant for this
  // client is removed (the implicit grant for `referenceId` resumes).
  mode: z.enum(["single", "multi"]),
});

const SetWorkspaceScopeResponseSchema = z.object({
  success: z.boolean(),
  workspaceScope: z.enum(["single", "multi"]),
  grantedWorkspaceIds: z.array(z.string()),
});

const RevokeWorkspaceGrantResponseSchema = z.object({
  success: z.boolean(),
  removed: z.number().int().nonnegative(),
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

const setWorkspaceScopeRoute = createRoute({
  method: "post",
  path: "/{id}/workspace-scope",
  tags: ["Me — OAuth Clients"],
  summary: "Toggle this agent's cross-workspace mode (#2073)",
  description:
    "Upgrade an OAuth client from `single`-scope (legacy, bound to its " +
    "registration workspace) to `multi`-scope (workspace-aware: the user " +
    "picks per-request via `X-Atlas-Workspace`, the audit + rate-limit + " +
    "approval surfaces all read the resolved workspace). `mode='multi'` " +
    "creates grants for every workspace the caller is currently a member " +
    "of; `mode='single'` clears the grant set.",
  request: {
    params: z.object({
      id: z.string().min(1).max(ID_MAX_LEN).openapi({
        param: { name: "id", in: "path" },
        example: "claude-desktop",
      }),
    }),
    body: {
      content: {
        "application/json": { schema: SetWorkspaceScopeRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Scope updated",
      content: { "application/json": { schema: SetWorkspaceScopeResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Client not found for this user", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeWorkspaceGrantRoute = createRoute({
  method: "delete",
  path: "/{id}/workspaces/{workspaceId}",
  tags: ["Me — OAuth Clients"],
  summary: "Revoke this agent's access to one workspace (#2073)",
  description:
    "For a `multi`-scope client, removes a single (clientId, workspaceId) " +
    "grant. The OAuth client itself stays intact for the other granted " +
    "workspaces; tokens that have already been minted stay valid for those. " +
    "Cross-user isolation: the caller must own the OAuth client (registered " +
    "by them) AND be a current member of the workspace whose grant they're " +
    "removing.",
  request: {
    params: z.object({
      id: z.string().min(1).max(ID_MAX_LEN).openapi({
        param: { name: "id", in: "path" },
        example: "claude-desktop",
      }),
      workspaceId: z.string().min(1).max(ID_MAX_LEN).openapi({
        param: { name: "workspaceId", in: "path" },
      }),
    }),
  },
  responses: {
    200: {
      description: "Grant removed",
      content: { "application/json": { schema: RevokeWorkspaceGrantResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Client or grant not found", content: { "application/json": { schema: ErrorSchema } } },
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

// POST /:id/workspace-scope — toggle multi-workspace mode (#2073).
meOauthClients.openapi(setWorkspaceScopeRoute, async (c) => {
  const { id: clientId } = c.req.valid("param");
  const { mode } = c.req.valid("json");
  const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;

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
    // Pre-fetch — proves the caller owns this client at this workspace
    // before we touch the scope/grant tables. Cross-user / cross-workspace
    // probes 404 here, not 403, so they look indistinguishable from an
    // unknown client (avoids leaking the existence of clients in other
    // workspaces).
    const prior = yield* Effect.promise(() => findOAuthClient(clientId, scope));
    if (!prior) {
      return c.json(
        { error: "not_found", message: "OAuth client not found.", requestId },
        404,
      );
    }

    // For `multi`, expand to every workspace the user is currently a
    // member of. The grant set tracks WORKSPACE membership (admin
    // policy), not the user's session-active workspace — picking
    // mode=multi means "let this agent into any workspace I belong to."
    let workspaceIds: string[] = [];
    if (mode === "multi") {
      workspaceIds = yield* Effect.promise(() => listUserWorkspaceIds(user.id));
      if (workspaceIds.length === 0) {
        // Defensive: a user with an active org but zero `member` rows
        // is a state we shouldn't be able to reach (the active org
        // assignment requires a member row), but bail gracefully so we
        // don't write a multi-scope marker with no grants.
        log.warn(
          { requestId, userId: user.id, orgId, clientId },
          "set workspace-scope multi requested but user has no member rows",
        );
        return c.json(
          {
            error: "not_found",
            message: "No workspaces available to grant.",
            requestId,
          },
          404,
        );
      }
    }

    yield* Effect.promise(() =>
      setWorkspaceScopeAndGrants({
        clientId,
        referenceId: orgId,
        mode,
        workspaceIds,
        grantedByUserId: user.id,
      }),
    );

    log.info(
      { requestId, clientId, mode, workspaceCount: workspaceIds.length, actorId: user.id },
      "Updated OAuth client workspace scope",
    );
    logAdminAction({
      actionType: ADMIN_ACTIONS.oauth_client.revoke,
      // Reuse the revoke action type with phase metadata so a single
      // retention policy + downstream alert covers both scope toggles
      // and revokes (per the existing /api/v1/me/oauth-clients audit
      // discipline). Distinguish via metadata.phase so forensic queries
      // can pivot.
      targetType: "oauth_client",
      targetId: clientId,
      ipAddress,
      metadata: {
        clientId,
        clientName: prior.clientName,
        phase: "workspace_scope",
        mode,
        grantedWorkspaceIds: workspaceIds,
      },
    });

    return c.json(
      {
        success: true,
        workspaceScope: mode,
        grantedWorkspaceIds: workspaceIds,
      },
      200,
    );
  }), { label: "set my oauth client workspace scope" });
});

// DELETE /:id/workspaces/:workspaceId — per-workspace revoke (#2073).
meOauthClients.openapi(revokeWorkspaceGrantRoute, async (c) => {
  const { id: clientId, workspaceId } = c.req.valid("param");
  const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;

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
    // The caller must own the OAuth client at the active workspace AND
    // be a member of the workspace whose grant they're trying to remove.
    // The first check is the IDOR guard; the second prevents a member
    // of workspace A from revoking a grant on workspace B (where the
    // user isn't a member, so they shouldn't see the grant exists).
    const prior = yield* Effect.promise(() => findOAuthClient(clientId, scope));
    if (!prior) {
      return c.json(
        { error: "not_found", message: "OAuth client not found.", requestId },
        404,
      );
    }
    const userWorkspaces = yield* Effect.promise(() => listUserWorkspaceIds(user.id));
    if (!userWorkspaces.includes(workspaceId)) {
      return c.json(
        { error: "not_found", message: "Workspace grant not found.", requestId },
        404,
      );
    }

    const removed = yield* Effect.promise(() =>
      revokeWorkspaceGrant({ clientId, workspaceId }),
    );

    log.info(
      { requestId, clientId, workspaceId, removed, actorId: user.id },
      "Revoked workspace grant for OAuth client",
    );
    logAdminAction({
      actionType: ADMIN_ACTIONS.oauth_client.revoke,
      targetType: "oauth_client",
      targetId: clientId,
      ipAddress,
      metadata: {
        clientId,
        clientName: prior.clientName,
        phase: "workspace_grant",
        workspaceId,
        removed,
      },
    });

    return c.json({ success: true, removed }, 200);
  }), { label: "revoke my oauth client workspace grant" });
});

export { meOauthClients };
