/**
 * Admin custom role management routes.
 *
 * Mounted under /api/v1/admin/roles. All routes require admin role AND
 * enterprise license (enforced within the roles service layer).
 *
 * Audit emission: every write path (`role.create|update|delete|assign`)
 * emits a `logAdminAction` row on success AND failure. The mutation-with-
 * prior-state handlers (update / delete / assign) pre-fetch the existing
 * row so the audit metadata captures what was replaced or removed — a
 * compromised admin can't stage permissions, exploit them, and purge the
 * trail. See F-25 in .claude/research/security-audit-1-2-3.md.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage, causeToError } from "@atlas/api/lib/audit/error-scrub";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  getRole,
  getRoleByName,
  listRoleMembers,
  assignRole,
  RoleError,
  PERMISSIONS,
} from "@atlas/ee/auth/roles";
import { ErrorSchema, AuthErrorSchema, isValidId, createIdParamSchema, createParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

function clientIP(c: Context): string | null {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

const roleDomainError = domainError(RoleError, { not_found: 404, conflict: 409, validation: 400, builtin_protected: 403 });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RoleSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  description: z.string(),
  permissions: z.array(z.string()),
  isBuiltin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RoleIdParamSchema = createIdParamSchema("role_abc123");

const UserIdParamSchema = createParamSchema("userId", "user_abc123");

const CreateRoleBodySchema = z.object({
  name: z.string().min(1).max(63),
  description: z.string().optional(),
  permissions: z.array(z.string()),
});

const UpdateRoleBodySchema = z.object({
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

const AssignRoleBodySchema = z.object({
  role: z.string().min(1).max(63),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRolesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Roles"],
  summary: "List roles",
  description:
    "Returns all roles (built-in + custom) for the admin's active organization.",
  responses: {
    200: {
      description: "List of roles",
      content: {
        "application/json": {
          schema: z.object({
            roles: z.array(RoleSchema),
            permissions: z.array(z.string()),
            total: z.number(),
          }),
        },
      },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRoleRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Roles"],
  summary: "Create custom role",
  description:
    "Creates a new custom role for the admin's active organization with the specified permissions.",
  request: { body: { required: true, content: { "application/json": { schema: CreateRoleBodySchema } } } },
  responses: {
    201: { description: "Role created", content: { "application/json": { schema: z.object({ role: RoleSchema }) } } },
    400: { description: "Invalid request body or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Role name conflict", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateRoleRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Admin — Roles"],
  summary: "Update custom role",
  description:
    "Updates an existing custom role's description and/or permissions. Built-in roles cannot be modified.",
  request: {
    params: RoleIdParamSchema,
    body: { required: true, content: { "application/json": { schema: UpdateRoleBodySchema } } },
  },
  responses: {
    200: { description: "Role updated", content: { "application/json": { schema: z.object({ role: RoleSchema }) } } },
    400: { description: "Invalid role ID, request body, or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role, enterprise license required, or built-in role", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Role not found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoleRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Roles"],
  summary: "Delete custom role",
  description:
    "Permanently removes a custom role. Built-in roles cannot be deleted.",
  request: { params: RoleIdParamSchema },
  responses: {
    200: { description: "Role deleted", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    400: { description: "Invalid role ID or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role, enterprise license required, or built-in role", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Role not found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listRoleMembersRoute = createRoute({
  method: "get",
  path: "/{id}/members",
  tags: ["Admin — Roles"],
  summary: "List role members",
  description:
    "Returns all users assigned to a specific role in the organization.",
  request: { params: RoleIdParamSchema },
  responses: {
    200: { description: "List of members with this role", content: { "application/json": { schema: z.object({ members: z.array(z.object({ userId: z.string(), role: z.string(), createdAt: z.string() })), total: z.number() }) } } },
    400: { description: "Invalid role ID or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Role not found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const assignRoleRoute = createRoute({
  method: "put",
  path: "/users/{userId}/role",
  tags: ["Admin — Roles"],
  summary: "Assign role to user",
  description:
    "Assigns a role to a user within the admin's active organization. The role must exist in the organization.",
  request: {
    params: UserIdParamSchema,
    body: { required: true, content: { "application/json": { schema: AssignRoleBodySchema } } },
  },
  responses: {
    200: { description: "Role assigned", content: { "application/json": { schema: z.object({ userId: z.string(), role: z.string() }) } } },
    400: { description: "Invalid user ID, request body, or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "User or role not found, or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminRoles = createAdminRouter();

adminRoles.use(requireOrgContext());
// F-53 — refine `adminAuth` (role ∈ {admin, owner, platform_admin}) with the
// per-flag custom-role check. Custom roles authored without `admin:roles`
// can no longer reach the role CRUD surface even though their assigned
// member.role still passes the coarse adminAuth gate.
adminRoles.use(requirePermission("admin:roles"));

// GET / — list all roles for the active org
adminRoles.openapi(listRolesRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const roles = yield* listRoles(orgId!);
    return c.json({ roles, permissions: [...PERMISSIONS], total: roles.length }, 200);
  }), { label: "list roles", domainErrors: [roleDomainError] });
});

// POST / — create a custom role
adminRoles.openapi(createRoleRoute, async (c) => {
  const ipAddress = clientIP(c);
  const body = c.req.valid("json");
  const roleName = body.name?.toLowerCase().trim() ?? "";

  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    if (!body.name || !body.permissions || !Array.isArray(body.permissions)) {
      return c.json({ error: "bad_request", message: "Missing required fields: name, permissions." }, 400);
    }

    const role = yield* createRole(orgId!, body);

    logAdminAction({
      actionType: ADMIN_ACTIONS.role.create,
      targetType: "role",
      targetId: role.id,
      ipAddress,
      metadata: {
        roleId: role.id,
        roleName: role.name,
        permissions: role.permissions,
      },
    });

    return c.json({ role }, 201);
  }).pipe(
    // `tapErrorCause` catches both typed failures (RoleError /
    // EnterpriseError from `yield*`) AND defects from `Effect.promise`
    // (rejected DB promises — pool exhaustion, network drops). `tapError`
    // alone would miss defects, dropping the audit row on the exact
    // failure mode a malicious admin would probe for.
    Effect.tapErrorCause((cause) => {
      const err = causeToError(cause);
      if (err === undefined) return Effect.void;
      return Effect.sync(() =>
        logAdminAction({
          actionType: ADMIN_ACTIONS.role.create,
          // No role id yet — key the row by the attempted name so forensic
          // queries can pivot across "admin tried to create X" even when
          // the row was never persisted. `roleId: null` in metadata keeps
          // the column shape aligned with update/delete/assign so
          // compliance queries can UNION across the four actions.
          targetType: "role",
          targetId: roleName || "unknown",
          status: "failure",
          ipAddress,
          metadata: {
            roleId: null,
            roleName,
            permissions: body.permissions,
            error: errorMessage(err),
          },
        }),
      );
    }),
  ), { label: "create role", domainErrors: [roleDomainError] });
});

// PUT /:id — update a custom role
adminRoles.openapi(updateRoleRoute, async (c) => {
  const ipAddress = clientIP(c);
  const { id: roleId } = c.req.valid("param");
  const body = c.req.valid("json");

  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    if (!isValidId(roleId)) {
      return c.json({ error: "bad_request", message: "Invalid role ID." }, 400);
    }

    // Pre-fetch so the audit row captures what the update replaced. Without
    // this a compromised admin could flip a role from `query` to
    // `query,admin:audit` and the audit trail would only show the new perms
    // — forensic reconstruction needs the delta.
    const prior = yield* getRole(orgId!, roleId);

    const role = yield* updateRole(orgId!, roleId, body);

    logAdminAction({
      actionType: ADMIN_ACTIONS.role.update,
      targetType: "role",
      targetId: role.id,
      ipAddress,
      metadata: {
        roleId: role.id,
        roleName: role.name,
        permissions: role.permissions,
        previousPermissions: prior?.permissions ?? null,
      },
    });

    return c.json({ role }, 200);
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.gen(function* () {
        const err = causeToError(cause);
        if (err === undefined) return;
        // Best-effort pre-fetch for the failure row too. Swallow errors
        // from this lookup so the audit emission isn't dropped when the
        // underlying DB is the failure itself.
        const { orgId } = yield* AuthContext;
        const prior = yield* getRole(orgId!, roleId).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        logAdminAction({
          actionType: ADMIN_ACTIONS.role.update,
          targetType: "role",
          targetId: roleId,
          status: "failure",
          ipAddress,
          metadata: {
            roleId,
            roleName: prior?.name ?? null,
            permissions: body.permissions ?? null,
            previousPermissions: prior?.permissions ?? null,
            error: errorMessage(err),
          },
        });
      }),
    ),
  ), { label: "update role", domainErrors: [roleDomainError] });
});

// DELETE /:id — delete a custom role
adminRoles.openapi(deleteRoleRoute, async (c) => {
  const ipAddress = clientIP(c);
  const { id: roleId } = c.req.valid("param");

  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    if (!isValidId(roleId)) {
      return c.json({ error: "bad_request", message: "Invalid role ID." }, 400);
    }

    // Pre-fetch the row BEFORE calling deleteRole. Without this the audit
    // metadata can't record which permissions were revoked — the row is
    // gone by the time we'd emit.
    const existing = yield* getRole(orgId!, roleId);

    if (!existing) {
      // Admin attempted to delete a role that doesn't exist — a probe
      // pattern an attacker exercises before pivoting. Emit as failure so
      // forensic queries filtering on `status = 'failure'` catch it.
      logAdminAction({
        actionType: ADMIN_ACTIONS.role.delete,
        targetType: "role",
        targetId: roleId,
        status: "failure",
        ipAddress,
        metadata: { roleId, found: false },
      });
      return c.json({ error: "not_found", message: "Role not found." }, 404);
    }

    const deleted = yield* deleteRole(orgId!, roleId);

    if (!deleted) {
      // Race between pre-fetch and delete — audit must not claim a
      // successful removal that didn't happen.
      logAdminAction({
        actionType: ADMIN_ACTIONS.role.delete,
        targetType: "role",
        targetId: roleId,
        status: "failure",
        ipAddress,
        metadata: {
          roleId,
          roleName: existing.name,
          permissions: existing.permissions,
          reason: "race_deleted_between_fetch_and_delete",
        },
      });
      return c.json({ error: "not_found", message: "Role not found." }, 404);
    }

    logAdminAction({
      actionType: ADMIN_ACTIONS.role.delete,
      targetType: "role",
      targetId: roleId,
      ipAddress,
      metadata: {
        roleId,
        roleName: existing.name,
        permissions: existing.permissions,
      },
    });
    return c.json({ message: "Role deleted." }, 200);
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.gen(function* () {
        const err = causeToError(cause);
        if (err === undefined) return;
        const { orgId } = yield* AuthContext;
        const prior = yield* getRole(orgId!, roleId).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        logAdminAction({
          actionType: ADMIN_ACTIONS.role.delete,
          targetType: "role",
          targetId: roleId,
          status: "failure",
          ipAddress,
          metadata: {
            roleId,
            roleName: prior?.name ?? null,
            permissions: prior?.permissions ?? null,
            error: errorMessage(err),
          },
        });
      }),
    ),
  ), { label: "delete role", domainErrors: [roleDomainError] });
});

// GET /:id/members — list members with a specific role
adminRoles.openapi(listRoleMembersRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { id: roleId } = c.req.valid("param");

    if (!isValidId(roleId)) {
      return c.json({ error: "bad_request", message: "Invalid role ID." }, 400);
    }

    const members = yield* listRoleMembers(orgId!, roleId);
    return c.json({ members, total: members.length }, 200);
  }), { label: "list role members", domainErrors: [roleDomainError] });
});

// PUT /users/:userId/role — assign a role to a user
adminRoles.openapi(assignRoleRoute, async (c) => {
  const ipAddress = clientIP(c);
  const { userId } = c.req.valid("param");
  const { role: roleName } = c.req.valid("json");

  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    if (!isValidId(userId)) {
      return c.json({ error: "bad_request", message: "Invalid user ID." }, 400);
    }

    // Pre-fetch role row (by name) to resolve a stable roleId for the audit,
    // and the user's existing member.role so the audit captures what was
    // replaced. Mirrors the `user.change_role` pattern in admin.ts —
    // compliance reconstruction needs the before-state, not just the after.
    const targetRole = yield* getRoleByName(orgId!, roleName);
    const priorRows = yield* Effect.tryPromise({
      try: () => internalQuery<{ role: string }>(
        `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
        [orgId, userId],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.catchAll(() => Effect.succeed([])));
    const previousRole = priorRows[0]?.role ?? null;

    const result = yield* assignRole(orgId!, userId, roleName);

    logAdminAction({
      actionType: ADMIN_ACTIONS.role.assign,
      targetType: "role",
      targetId: targetRole?.id ?? roleName,
      ipAddress,
      metadata: {
        roleId: targetRole?.id ?? null,
        roleName: result.role,
        userId,
        previousRole,
      },
    });

    return c.json(result, 200);
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.gen(function* () {
        const err = causeToError(cause);
        if (err === undefined) return;
        // Re-run the same best-effort lookups so the failure row carries
        // the same shape as the success row — compliance queries can then
        // union on metadata keys without special-casing the failure path.
        const { orgId } = yield* AuthContext;
        const targetRole = yield* getRoleByName(orgId!, roleName).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        const priorRows = yield* Effect.tryPromise({
          try: () => internalQuery<{ role: string }>(
            `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
            [orgId, userId],
          ),
          catch: (e) => e instanceof Error ? e : new Error(String(e)),
        }).pipe(Effect.catchAll(() => Effect.succeed([] as Array<{ role: string }>)));
        logAdminAction({
          actionType: ADMIN_ACTIONS.role.assign,
          targetType: "role",
          targetId: targetRole?.id ?? roleName,
          status: "failure",
          ipAddress,
          metadata: {
            roleId: targetRole?.id ?? null,
            roleName,
            userId,
            previousRole: priorRows[0]?.role ?? null,
            error: errorMessage(err),
          },
        });
      }),
    ),
  ), { label: "assign role", domainErrors: [roleDomainError] });
});

export { adminRoles };
