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
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import {
  listConnections,
  deleteConnection,
  getSyncStatus,
  listGroupMappings,
  createGroupMapping,
  deleteGroupMapping,
  SCIMError,
} from "@atlas/ee/auth/scim";
import { ErrorSchema, AuthErrorSchema, isValidId, createIdParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const SCIM_ERROR_STATUS = { not_found: 404, conflict: 409, validation: 400 } as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SCIMConnectionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  organizationId: z.string().nullable(),
  createdAt: z.string(),
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

    const [scimConnections, syncStatus] = yield* Effect.promise(() => Promise.all([
      listConnections(orgId!),
      getSyncStatus(orgId!),
    ]));
    return c.json({ connections: scimConnections, syncStatus }, 200);
  }), { label: "get SCIM status", domainErrors: [[SCIMError, SCIM_ERROR_STATUS]] });
});

// DELETE /connections/:id — revoke a SCIM connection
adminScim.openapi(deleteConnectionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { id: connectionId } = c.req.valid("param");

    if (!isValidId(connectionId)) {
      return c.json({ error: "bad_request", message: "Invalid connection ID." }, 400);
    }

    const deleted = yield* Effect.promise(() => deleteConnection(orgId!, connectionId));
    if (!deleted) {
      return c.json({ error: "not_found", message: "SCIM connection not found." }, 404);
    }
    return c.json({ message: "SCIM connection deleted." }, 200);
  }), { label: "delete SCIM connection", domainErrors: [[SCIMError, SCIM_ERROR_STATUS]] });
});

// GET /group-mappings — list group→role mappings
adminScim.openapi(listGroupMappingsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const mappings = yield* Effect.promise(() => listGroupMappings(orgId!));
    return c.json({ mappings, total: mappings.length }, 200);
  }), { label: "list SCIM group mappings", domainErrors: [[SCIMError, SCIM_ERROR_STATUS]] });
});

// POST /group-mappings — create a group→role mapping
adminScim.openapi(createGroupMappingRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const { scimGroupName, roleName } = c.req.valid("json");
    if (!scimGroupName || !roleName) {
      return c.json({ error: "bad_request", message: "Missing required fields: scimGroupName, roleName." }, 400);
    }

    const mapping = yield* Effect.promise(() => createGroupMapping(orgId!, scimGroupName, roleName));
    return c.json({ mapping }, 201);
  }), { label: "create SCIM group mapping", domainErrors: [[SCIMError, SCIM_ERROR_STATUS]] });
});

// DELETE /group-mappings/:id — delete a group mapping
adminScim.openapi(deleteGroupMappingRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { id: mappingId } = c.req.valid("param");

    if (!isValidId(mappingId)) {
      return c.json({ error: "bad_request", message: "Invalid mapping ID." }, 400);
    }

    const deleted = yield* Effect.promise(() => deleteGroupMapping(orgId!, mappingId));
    if (!deleted) {
      return c.json({ error: "not_found", message: "SCIM group mapping not found." }, 404);
    }
    return c.json({ message: "SCIM group mapping deleted." }, 200);
  }), { label: "delete SCIM group mapping", domainErrors: [[SCIMError, SCIM_ERROR_STATUS]] });
});

export { adminScim };
