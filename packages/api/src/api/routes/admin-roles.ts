/**
 * Admin custom role management routes.
 *
 * Mounted under /api/v1/admin/roles. All routes require admin role AND
 * enterprise license (enforced within the roles service layer).
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  listRoleMembers,
  assignRole,
  RoleError,
  PERMISSIONS,
} from "@atlas/ee/auth/roles";
import { ErrorSchema, AuthErrorSchema, isValidId, createIdParamSchema, createParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

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
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const body = c.req.valid("json");

    if (!body.name || !body.permissions || !Array.isArray(body.permissions)) {
      return c.json({ error: "bad_request", message: "Missing required fields: name, permissions." }, 400);
    }

    const role = yield* createRole(orgId!, body);
    return c.json({ role }, 201);
  }), { label: "create role", domainErrors: [roleDomainError] });
});

// PUT /:id — update a custom role
adminRoles.openapi(updateRoleRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { id: roleId } = c.req.valid("param");

    if (!isValidId(roleId)) {
      return c.json({ error: "bad_request", message: "Invalid role ID." }, 400);
    }

    const body = c.req.valid("json");

    const role = yield* updateRole(orgId!, roleId, body);
    return c.json({ role }, 200);
  }), { label: "update role", domainErrors: [roleDomainError] });
});

// DELETE /:id — delete a custom role
adminRoles.openapi(deleteRoleRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { id: roleId } = c.req.valid("param");

    if (!isValidId(roleId)) {
      return c.json({ error: "bad_request", message: "Invalid role ID." }, 400);
    }

    const deleted = yield* deleteRole(orgId!, roleId);
    if (!deleted) {
      return c.json({ error: "not_found", message: "Role not found." }, 404);
    }
    return c.json({ message: "Role deleted." }, 200);
  }), { label: "delete role", domainErrors: [roleDomainError] });
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
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { userId } = c.req.valid("param");

    if (!isValidId(userId)) {
      return c.json({ error: "bad_request", message: "Invalid user ID." }, 400);
    }

    const { role: roleName } = c.req.valid("json");

    const result = yield* assignRole(orgId!, userId, roleName);
    return c.json(result, 200);
  }), { label: "assign role", domainErrors: [roleDomainError] });
});

export { adminRoles };
