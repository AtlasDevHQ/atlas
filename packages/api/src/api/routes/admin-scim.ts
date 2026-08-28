/**
 * Admin SCIM directory sync management routes.
 *
 * Mounted under /api/v1/admin/scim. All routes require admin role AND
 * enterprise license (enforced within the SCIM service layer).
 *
 * The actual SCIM 2.0 protocol endpoints (/scim/v2/Users, etc.) are handled
 * by the @better-auth/scim plugin via the Better Auth catch-all at /api/auth/*.
 * These admin routes manage SCIM connections, tokens, and group→role mappings.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import { AuthContext, SCIMProvenance } from "@atlas/api/lib/effect/services";
import { requireFeatureEntitlement } from "@atlas/api/lib/billing/feature-entitlement-guard";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage, causeToError } from "@atlas/api/lib/audit/error-scrub";
import { SCIMError } from "@atlas/api/lib/auth/auth-errors";
import { canGenerateSCIMToken } from "@atlas/api/lib/auth/scim-authz";
import { ErrorSchema, AuthErrorSchema, createIdParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

function clientIP(c: Context): string | null {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

const scimDomainError = domainError(SCIMError, { not_found: 404, conflict: 409, validation: 400 });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SCIMConnectionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  organizationId: z.string().nullable(),
});

const SCIMSyncStatusSchema = z.object({
  connections: z.number().int().nonnegative(),
  provisionedUsers: z.number().int().nonnegative(),
  lastSyncAt: z.string().nullable(),
});

const SCIMGroupMappingSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  scimGroupName: z.string(),
  roleName: z.string(),
  createdAt: z.string(),
});

const SCIMIssuedCredentialSchema = z.object({
  connectionId: z.string(),
  credentialId: z.string(),
  // Returned ONCE. @better-auth/scim stores only an HMAC digest, so this
  // plaintext is unrecoverable after the response is sent.
  token: z.string(),
  expiresAt: z.string(),
});

const ConnectionIdParamSchema = createIdParamSchema("conn_abc123");

const MappingIdParamSchema = createIdParamSchema("map_abc123");

const CreateGroupMappingBodySchema = z.object({
  scimGroupName: z.string().min(1).max(255).regex(
    /^[a-zA-Z0-9]/,
    "Must start with an alphanumeric character",
  ),
  roleName: z.string().min(1).max(63),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getStatusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — SCIM"],
  summary: "Get SCIM status and connections",
  description:
    "Returns SCIM provider connections and sync status for the admin's active organization.",
  responses: {
    200: {
      description: "SCIM connections and sync status",
      content: {
        "application/json": {
          schema: z.object({
            connections: z.array(SCIMConnectionSchema),
            syncStatus: SCIMSyncStatusSchema,
          }),
        },
      },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteConnectionRoute = createRoute({
  method: "delete",
  path: "/connections/{id}",
  tags: ["Admin — SCIM"],
  summary: "Delete SCIM connection",
  description:
    "Revokes a SCIM provider connection, invalidating its bearer token.",
  request: { params: ConnectionIdParamSchema },
  responses: {
    200: { description: "SCIM connection deleted", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    400: { description: "Invalid connection ID or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Connection not found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createConnectionRoute = createRoute({
  method: "post",
  path: "/connections",
  tags: ["Admin — SCIM"],
  summary: "Create SCIM connection and issue its bearer token",
  description:
    "Creates a SCIM provisioning connection for the admin's active organization and returns "
    + "its bearer token. The token is shown ONCE — only an HMAC digest is stored.",
  responses: {
    201: { description: "Connection created and credential issued", content: { "application/json": { schema: SCIMIssuedCredentialSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin, owner or platform-admin required, plus enterprise license", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rotateCredentialRoute = createRoute({
  method: "post",
  path: "/connections/{id}/rotate",
  tags: ["Admin — SCIM"],
  summary: "Rotate a SCIM connection's bearer token",
  description:
    "Issues a fresh bearer token for an existing connection and retires the previous one. "
    + "The new token is shown ONCE.",
  request: { params: ConnectionIdParamSchema },
  responses: {
    200: { description: "Credential rotated", content: { "application/json": { schema: SCIMIssuedCredentialSchema } } },
    400: { description: "Invalid connection ID or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin, owner or platform-admin required, plus enterprise license", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Connection not found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listGroupMappingsRoute = createRoute({
  method: "get",
  path: "/group-mappings",
  tags: ["Admin — SCIM"],
  summary: "List SCIM group mappings",
  description:
    "Returns all SCIM group → custom role mappings for the admin's active organization.",
  responses: {
    200: {
      description: "List of group mappings",
      content: {
        "application/json": {
          schema: z.object({
            mappings: z.array(SCIMGroupMappingSchema),
            total: z.number(),
          }),
        },
      },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createGroupMappingRoute = createRoute({
  method: "post",
  path: "/group-mappings",
  tags: ["Admin — SCIM"],
  summary: "Create SCIM group mapping",
  description:
    "Maps a SCIM group display name to an Atlas custom role. When users are provisioned via SCIM " +
    "and belong to the mapped group, they are assigned the corresponding role.",
  request: { body: { required: true, content: { "application/json": { schema: CreateGroupMappingBodySchema } } } },
  responses: {
    201: { description: "Group mapping created", content: { "application/json": { schema: z.object({ mapping: SCIMGroupMappingSchema }) } } },
    400: { description: "Invalid request body or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Role not found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Duplicate mapping for this SCIM group", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteGroupMappingRoute = createRoute({
  method: "delete",
  path: "/group-mappings/{id}",
  tags: ["Admin — SCIM"],
  summary: "Delete SCIM group mapping",
  description:
    "Removes a SCIM group → role mapping. Users already assigned via this mapping keep their role.",
  request: { params: MappingIdParamSchema },
  responses: {
    200: { description: "Group mapping deleted", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    400: { description: "Invalid mapping ID or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Mapping not found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminScim = createAdminRouter();

adminScim.use(requireOrgContext());

// GET / — SCIM connections and sync status
adminScim.openapi(getStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "scim");
    const scim = yield* SCIMProvenance;

    const [scimConnections, syncStatus] = yield* Effect.all([
      scim.listConnections(orgId!),
      scim.getSyncStatus(orgId!),
    ], { concurrency: "unbounded" });
    return c.json({ connections: scimConnections, syncStatus }, 200);
  }), { label: "get SCIM status", domainErrors: [scimDomainError] });
});

// DELETE /connections/:id — revoke a SCIM connection
adminScim.openapi(deleteConnectionRoute, async (c) => {
  const ipAddress = clientIP(c);
  // `createIdParamSchema` (z.string().min(1).max(128)) validates at the
  // OpenAPI boundary; a malformed id returns 422 before this runs.
  const { id: connectionId } = c.req.valid("param");

  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "scim");

    const deleted = yield* (yield* SCIMProvenance).deleteConnection(orgId!, connectionId);
    if (!deleted) {
      return c.json({ error: "not_found", message: "SCIM connection not found." }, 404);
    }

    logAdminAction({
      actionType: ADMIN_ACTIONS.scim.connectionDelete,
      targetType: "scim",
      targetId: connectionId,
      ipAddress,
      metadata: { connectionId },
    });

    return c.json({ message: "SCIM connection deleted." }, 200);
  }).pipe(
    Effect.tapErrorCause((cause) => {
      // `tapErrorCause` sees both typed failures and defects — the EE
      // service uses `Effect.promise` for DB calls, so pool exhaustion /
      // connection drops surface here as defects.
      const err = causeToError(cause);
      if (err === undefined) return Effect.void;
      return Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.scim.connectionDelete,
          targetType: "scim",
          targetId: connectionId,
          status: "failure",
          ipAddress,
          metadata: {
            connectionId,
            error: errorMessage(err),
          },
        }),
      );
    }),
  ), { label: "delete SCIM connection", domainErrors: [scimDomainError] });
});

// ---------------------------------------------------------------------------
// Credential minting — the GHSA-j8v8-g9cx-5qf4 operation
// ---------------------------------------------------------------------------
//
// In @better-auth/scim 1.6 this was `POST /api/auth/scim/generate-token`, a
// PUBLIC plugin route, and the advisory was that its ownership check fell
// open on a NULL `userId`. We held it shut with the `providerOwnership` flag
// plus a `beforeSCIMTokenGenerated` hook that called `canGenerateSCIMToken`.
//
// 1.7 withdraws that route entirely and exposes the operation as a
// SERVER_ONLY endpoint, so the plugin no longer has a hook to run our check
// in — the authorization moved OUT to here. The predicate is unchanged; what
// changed is that it now guards an Atlas route sitting in front of an
// endpoint that is unreachable over the wire, rather than a public one.
//
// `createAdminRouter()` already rejects non-admins, so this is defence in
// depth AND a narrowing: `canGenerateSCIMToken` resolves the EFFECTIVE grant
// (#2890 — platform_admin via user.role, org admin/owner via member.role)
// and fails CLOSED on a member-lookup error, which minting an IdP
// provisioning token warrants.

/**
 * Shared guard for both minting routes.
 *
 * Returns a boolean rather than failing, so the caller can answer 403 —
 * `scimDomainError` maps SCIMError codes to 400/404/409 only, and an
 * authorization denial is structurally a 403 (the caller authenticated
 * fine; they simply lack the grant).
 */
const canMintHere = (
  role: unknown,
  userId: string | undefined,
) => Effect.tryPromise({
  try: () => canGenerateSCIMToken(role, userId),
  // `canGenerateSCIMToken` already fails closed internally on a DB error;
  // this catch covers an unexpected throw. Either way the failure
  // propagates as a 500 rather than being read as "allowed" — never let a
  // lookup failure mint a provisioning token.
  catch: (err) => (err instanceof Error ? err : new Error(String(err))),
});

/** 403 body shared by both minting routes. */
const MINT_FORBIDDEN = {
  error: "forbidden",
  message: "Only admin, owner, or platform-admin users can issue SCIM tokens.",
} as const;

/**
 * Record a REFUSED attempt to issue a SCIM credential.
 *
 * A 403 returns as a successful Effect, so the `tapErrorCause` handlers on
 * these routes never see it. Without this an attempt to mint an IdP
 * provisioning credential that the authorization check turned away would
 * leave no trace at all, while a transient DB fault would be audited — the
 * refusal is the more interesting event of the two.
 */
function auditMintRefused(args: {
  actionType: (typeof ADMIN_ACTIONS)["scim"][keyof (typeof ADMIN_ACTIONS)["scim"]];
  targetId: string;
  ipAddress: string | null;
  userId: string | undefined;
  metadata?: Record<string, unknown>;
}): void {
  logAdminAction({
    actionType: args.actionType,
    targetType: "scim",
    targetId: args.targetId,
    status: "failure",
    ipAddress: args.ipAddress,
    metadata: {
      ...args.metadata,
      reason: "not_authorized_to_mint",
      attemptedBy: args.userId ?? "unknown",
    },
  });
}

// POST /connections — create a connection and issue its first token
adminScim.openapi(createConnectionRoute, async (c) => {
  const ipAddress = clientIP(c);

  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "scim");
    if (!(yield* canMintHere(user?.role, user?.id))) {
      auditMintRefused({
        actionType: ADMIN_ACTIONS.scim.connectionCreate,
        targetId: "unissued",
        ipAddress,
        userId: user?.id,
      });
      return c.json(MINT_FORBIDDEN, 403);
    }

    const issued = yield* (yield* SCIMProvenance).createConnection(orgId!, user!.id);

    logAdminAction({
      actionType: ADMIN_ACTIONS.scim.connectionCreate,
      targetType: "scim",
      targetId: issued.connectionId,
      ipAddress,
      // NEVER put `issued.token` in metadata — audit rows are readable by
      // every workspace admin, which would hand them a live IdP credential.
      metadata: {
        connectionId: issued.connectionId,
        credentialId: issued.credentialId,
        expiresAt: issued.expiresAt,
      },
    });

    return c.json(issued, 201);
  }).pipe(
    Effect.tapErrorCause((cause) => {
      const err = causeToError(cause);
      if (err === undefined) return Effect.void;
      return Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.scim.connectionCreate,
          targetType: "scim",
          targetId: "unknown",
          status: "failure",
          ipAddress,
          metadata: { error: errorMessage(err) },
        }),
      );
    }),
  ), { label: "create SCIM connection", domainErrors: [scimDomainError] });
});

// POST /connections/:id/rotate — issue a fresh token, retire the old one
adminScim.openapi(rotateCredentialRoute, async (c) => {
  const ipAddress = clientIP(c);
  const { id: connectionId } = c.req.valid("param");

  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "scim");
    if (!(yield* canMintHere(user?.role, user?.id))) {
      auditMintRefused({
        actionType: ADMIN_ACTIONS.scim.credentialRotate,
        targetId: connectionId,
        ipAddress,
        userId: user?.id,
        metadata: { connectionId },
      });
      return c.json(MINT_FORBIDDEN, 403);
    }

    const issued = yield* (yield* SCIMProvenance).rotateCredential(orgId!, connectionId, user!.id);

    logAdminAction({
      actionType: ADMIN_ACTIONS.scim.credentialRotate,
      targetType: "scim",
      targetId: issued.connectionId,
      ipAddress,
      metadata: {
        connectionId: issued.connectionId,
        credentialId: issued.credentialId,
        expiresAt: issued.expiresAt,
      },
    });

    return c.json(issued, 200);
  }).pipe(
    Effect.tapErrorCause((cause) => {
      const err = causeToError(cause);
      if (err === undefined) return Effect.void;
      return Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.scim.credentialRotate,
          targetType: "scim",
          targetId: connectionId,
          status: "failure",
          ipAddress,
          metadata: { connectionId, error: errorMessage(err) },
        }),
      );
    }),
  ), { label: "rotate SCIM credential", domainErrors: [scimDomainError] });
});

// GET /group-mappings — list group→role mappings
adminScim.openapi(listGroupMappingsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "scim");

    const mappings = yield* (yield* SCIMProvenance).listGroupMappings(orgId!);
    return c.json({ mappings, total: mappings.length }, 200);
  }), { label: "list SCIM group mappings", domainErrors: [scimDomainError] });
});

// POST /group-mappings — create a group→role mapping
adminScim.openapi(createGroupMappingRoute, async (c) => {
  const ipAddress = clientIP(c);
  // Zod body schema (min(1) / regex) has already validated these.
  const { scimGroupName, roleName } = c.req.valid("json");

  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "scim");

    const mapping = yield* (yield* SCIMProvenance).createGroupMapping(orgId!, scimGroupName, roleName);

    logAdminAction({
      actionType: ADMIN_ACTIONS.scim.groupMappingCreate,
      targetType: "scim",
      targetId: mapping.id,
      ipAddress,
      metadata: {
        mappingId: mapping.id,
        scimGroupName,
        roleName,
        orgId: orgId!,
      },
    });

    return c.json({ mapping }, 201);
  }).pipe(
    Effect.tapErrorCause((cause) => {
      const err = causeToError(cause);
      if (err === undefined) return Effect.void;
      return Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.scim.groupMappingCreate,
          // No mapping id on failure — key the row by the group name the
          // admin attempted to map so operators can pivot in the audit log.
          targetType: "scim",
          targetId: scimGroupName,
          status: "failure",
          ipAddress,
          metadata: {
            scimGroupName,
            roleName,
            error: errorMessage(err),
          },
        }),
      );
    }),
  ), { label: "create SCIM group mapping", domainErrors: [scimDomainError] });
});

// DELETE /group-mappings/:id — delete a group mapping
adminScim.openapi(deleteGroupMappingRoute, async (c) => {
  const ipAddress = clientIP(c);
  const { id: mappingId } = c.req.valid("param");

  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "scim");

    // Fetch the mapping before delete so the audit row captures the
    // group→role grant that was revoked — without this, a deletion leaves
    // no forensic trace of which grant was removed.
    const mappings = yield* (yield* SCIMProvenance).listGroupMappings(orgId!);
    const existing = mappings.find((m) => m.id === mappingId);

    if (!existing) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.scim.groupMappingDelete,
        targetType: "scim",
        targetId: mappingId,
        ipAddress,
        metadata: { mappingId, found: false },
      });
      return c.json({ error: "not_found", message: "SCIM group mapping not found." }, 404);
    }

    const deleted = yield* (yield* SCIMProvenance).deleteGroupMapping(orgId!, mappingId);

    if (!deleted) {
      // Race: another admin / SCIM sync deleted the row between the
      // listGroupMappings pre-fetch and this call. Record as failure so
      // the audit trail doesn't claim a successful revoke that didn't
      // actually happen (the previous "success then 404" ordering could
      // mislead forensic reconstruction).
      logAdminAction({
        actionType: ADMIN_ACTIONS.scim.groupMappingDelete,
        targetType: "scim",
        targetId: mappingId,
        status: "failure",
        ipAddress,
        metadata: {
          mappingId,
          scimGroupName: existing.scimGroupName,
          roleName: existing.roleName,
          reason: "race_deleted_between_fetch_and_delete",
        },
      });
      return c.json({ error: "not_found", message: "SCIM group mapping not found." }, 404);
    }

    logAdminAction({
      actionType: ADMIN_ACTIONS.scim.groupMappingDelete,
      targetType: "scim",
      targetId: mappingId,
      ipAddress,
      metadata: {
        mappingId,
        scimGroupName: existing.scimGroupName,
        roleName: existing.roleName,
      },
    });

    return c.json({ message: "SCIM group mapping deleted." }, 200);
  }).pipe(
    Effect.tapErrorCause((cause) => {
      const err = causeToError(cause);
      if (err === undefined) return Effect.void;
      return Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.scim.groupMappingDelete,
          targetType: "scim",
          targetId: mappingId,
          status: "failure",
          ipAddress,
          metadata: {
            mappingId,
            error: errorMessage(err),
          },
        }),
      );
    }),
  ), { label: "delete SCIM group mapping", domainErrors: [scimDomainError] });
});

export { adminScim };
