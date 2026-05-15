/**
 * Admin connection-group management routes.
 *
 * Mounted under /api/v1/admin/connection-groups via admin.route().
 * Org-scoped: every group lives under the active organization. The composite
 * FK on `connections.group_id` → `connection_groups (id, org_id)` is the
 * DB-layer guarantee that membership never crosses org boundaries.
 *
 * Vocabulary: schema + code use "connection group"; UI copy uses
 * "environment". Content tables (semantic entities, dashboard cards,
 * scheduled tasks, approvals, PII classifications) are not part of this
 * surface — they migrate to group-scoping in separate slices.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-connection-groups");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validation regex matching the existing connection-id rule. Reused so a
 * group renamed to a value that would later collide with a connection id
 * stays predictable; group rename also normalizes through this so the
 * `name` column cannot accumulate trailing whitespace that would shadow a
 * legitimate value.
 */
const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

type GroupRow = {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  member_count: string;
  /** 0066: admin-pinned primary. NULL means resolver uses first member by (created_at, id). */
  primary_connection_id: string | null;
  /** First (oldest) non-archived member id — convenience for callers
   * surfacing the "executes against" hint without a second round-trip. */
  fallback_connection_id: string | null;
} & Record<string, unknown>;

function rowToWire(row: GroupRow) {
  return {
    id: row.id,
    name: row.name,
    memberCount: safeMemberCount(row.member_count),
    primaryConnectionId: row.primary_connection_id ?? null,
    /** Resolved "executes against" target: primary if set, else first
     * member by (created_at, id). Null when the group has no members. */
    resolvedConnectionId: row.primary_connection_id ?? row.fallback_connection_id ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Parse a Postgres COUNT(*)::text into a non-negative integer. Returns null
 * on malformed input so callers can distinguish "zero members" from "the
 * driver returned something we couldn't parse" — collapsing both to 0 lets
 * a NaN-driven `delete` slip past the empty-group guard and cascade
 * ON DELETE SET NULL across every member.
 */
function parseMemberCount(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Wire-format projection: malformed counts surface as 0 in lists rather than
 * crashing the page. The DELETE handler uses {@link parseMemberCount} directly
 * so it can distinguish null from 0 and fail closed. */
function safeMemberCount(value: string | null | undefined): number {
  return parseMemberCount(value) ?? 0;
}

/**
 * Narrow a thrown Postgres error to its `code` + `constraint` fields without
 * leaking `any`. `pg` populates both on driver-thrown errors; non-driver
 * throws (TypeErrors, network blips) come through with neither set, and the
 * caller falls through to the generic 500 path.
 */
function pgErrorMeta(err: unknown): { code?: string; constraint?: string } {
  if (!(err instanceof Error)) return {};
  const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
  const constraint =
    "constraint" in err && typeof err.constraint === "string" ? err.constraint : undefined;
  return { code, constraint };
}

/** Constraint name from migration 0062. Centralised so a future rename
 * surfaces in this one spot rather than in three string-equality checks. */
const UNIQUE_NAME_CONSTRAINT = "uq_connection_groups_org_name";
const CONNECTIONS_GROUP_FK = "fk_connections_group";

function generateGroupId(): string {
  // Random hex tag avoids collisions with the `g_<connection_id>` shape the
  // backfill uses for 1:1 legacy groups. The (id, org_id) PK is the final
  // collision check — at ~64 bits of entropy a retry-on-23505 path isn't
  // load-bearing but is wired correctly below so the user never sees a
  // misleading "name conflict" for what was actually a PK collision.
  return `g_${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const ConnectionGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberCount: z.number().int().nonnegative(),
  /** 0066 — admin-pinned primary member. NULL means "fall back to
   * first member by (created_at, id)" — see lib/dashboards-group-resolve.ts. */
  primaryConnectionId: z.string().nullable(),
  /** 0066 — convenience field for callers surfacing the "executes
   * against" hint. Equals `primaryConnectionId` when set, else the
   * group's first non-archived member by `(created_at, id)`, else null. */
  resolvedConnectionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ConnectionGroupMemberSchema = z.object({
  connectionId: z.string(),
  dbType: z.string(),
  description: z.string().nullable(),
});

const listGroupsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Connection Groups"],
  summary: "List connection groups",
  description: "Returns connection groups for the active organization, with member counts.",
  responses: {
    200: {
      description: "Connection group list",
      content: {
        "application/json": {
          schema: z.object({ groups: z.array(ConnectionGroupSchema) }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getGroupRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Connection Groups"],
  summary: "Get connection group detail",
  description: "Returns one group with its current members. Scoped to active organization.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "g_prod" }),
    }),
  },
  responses: {
    200: {
      description: "Group detail",
      content: {
        "application/json": {
          schema: ConnectionGroupSchema.extend({
            members: z.array(ConnectionGroupMemberSchema),
          }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Group not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createGroupRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Connection Groups"],
  summary: "Create connection group",
  description: "Creates a new connection group in the active organization.",
  responses: {
    201: {
      description: "Group created",
      content: { "application/json": { schema: ConnectionGroupSchema } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    409: { description: "Group name already in use", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const renameGroupRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Connection Groups"],
  summary: "Rename connection group",
  description: "Renames an existing group (display-label only — id is the foreign key).",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "g_prod" }),
    }),
  },
  responses: {
    200: {
      description: "Group renamed",
      content: { "application/json": { schema: ConnectionGroupSchema } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Group not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Group name already in use", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteGroupRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Connection Groups"],
  summary: "Delete connection group",
  description: "Deletes an empty connection group. Rejects 409 if the group still has members.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "g_prod" }),
    }),
  },
  responses: {
    200: {
      description: "Group deleted",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Group not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Group has members", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const assignMemberRoute = createRoute({
  method: "post",
  path: "/{id}/members",
  tags: ["Admin — Connection Groups"],
  summary: "Move connection into group",
  description: "Assigns a connection to this group, or moves it back to its deterministic single-connection group when unassign=true.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "g_prod" }),
    }),
  },
  responses: {
    200: {
      description: "Member moved",
      content: {
        "application/json": {
          schema: z.object({
            connectionId: z.string(),
            groupId: z.string(),
          }),
        },
      },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Group or connection not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminConnectionGroups = createAdminRouter();
adminConnectionGroups.use(requireOrgContext());
// Re-use the existing connection permission — groups are a facet of the
// connection-management surface. A finer-grained `admin:connection_groups`
// permission can land later if the role-management UX needs to split them.
adminConnectionGroups.use(requirePermission("admin:connections"));

// GET / — list groups for the active org
adminConnectionGroups.openapi(listGroupsRoute, async (c) =>
  runHandler(c, "list connection groups", async () => {
    const { orgId, requestId } = c.get("orgContext");
    try {
      const rows = await internalQuery<GroupRow>(
        `SELECT g.id,
                g.name,
                g.created_at,
                g.updated_at,
                g.primary_connection_id,
                (
                  SELECT COUNT(*)::text
                  FROM connections c
                  WHERE c.group_id = g.id
                    AND c.org_id = g.org_id
                    AND c.status != 'archived'
                ) AS member_count,
                (
                  SELECT c.id
                  FROM connections c
                  WHERE c.group_id = g.id
                    AND c.org_id = g.org_id
                    AND c.status != 'archived'
                  ORDER BY c.created_at ASC, c.id ASC
                  LIMIT 1
                ) AS fallback_connection_id
         FROM connection_groups g
         WHERE g.org_id = $1
         ORDER BY g.name ASC`,
        [orgId],
      );
      return c.json({ groups: rows.map(rowToWire) }, 200);
    } catch (err) {
      log.error({ err: errorMessage(err), requestId, orgId }, "Failed to list connection groups");
      return c.json({ error: "internal_error", message: "Failed to list connection groups.", requestId }, 500);
    }
  }),
);

// GET /:id — group detail with member list
adminConnectionGroups.openapi(getGroupRoute, async (c) =>
  runHandler(c, "get connection group", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { id } = c.req.valid("param");
    try {
      const rows = await internalQuery<GroupRow>(
        `SELECT g.id,
                g.name,
                g.created_at,
                g.updated_at,
                g.primary_connection_id,
                (
                  SELECT COUNT(*)::text
                  FROM connections c
                  WHERE c.group_id = g.id
                    AND c.org_id = g.org_id
                    AND c.status != 'archived'
                ) AS member_count,
                (
                  SELECT c.id
                  FROM connections c
                  WHERE c.group_id = g.id
                    AND c.org_id = g.org_id
                    AND c.status != 'archived'
                  ORDER BY c.created_at ASC, c.id ASC
                  LIMIT 1
                ) AS fallback_connection_id
         FROM connection_groups g
         WHERE g.id = $1 AND g.org_id = $2`,
        [id, orgId],
      );
      if (rows.length === 0) {
        return c.json({ error: "not_found", message: `Group "${id}" not found.`, requestId }, 404);
      }
      const members = await internalQuery<{ id: string; type: string; description: string | null }>(
        `SELECT id, type, description
         FROM connections
         WHERE group_id = $1
           AND org_id = $2
           AND status != 'archived'
         ORDER BY id ASC`,
        [id, orgId],
      );
      return c.json(
        {
          ...rowToWire(rows[0]),
          members: members.map((m) => ({
            connectionId: m.id,
            dbType: m.type,
            description: m.description,
          })),
        },
        200,
      );
    } catch (err) {
      log.error({ err: errorMessage(err), requestId, orgId, groupId: id }, "Failed to fetch connection group");
      return c.json({ error: "internal_error", message: "Failed to fetch connection group.", requestId }, 500);
    }
  }),
);

// POST / — create group
adminConnectionGroups.openapi(createGroupRoute, async (c) =>
  runHandler(c, "create connection group", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const authResult = c.get("authResult");

    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: errorMessage(err), requestId }, "Failed to parse JSON body in create group request");
      return null;
    });
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required.", requestId }, 400);
    }
    const { name } = body as Record<string, unknown>;
    if (typeof name !== "string" || !GROUP_NAME_PATTERN.test(name.trim())) {
      return c.json(
        {
          error: "invalid_request",
          message: "Group name must start with a letter or digit and may contain letters, digits, spaces, hyphens, or underscores (max 64 chars).",
          requestId,
        },
        400,
      );
    }
    const trimmedName = name.trim();

    const id = generateGroupId();
    try {
      await internalQuery(
        `INSERT INTO connection_groups (id, org_id, name) VALUES ($1, $2, $3)`,
        [id, orgId, trimmedName],
      );
    } catch (err) {
      const meta = pgErrorMeta(err);
      // Disambiguate: 23505 fires on both the unique-name index AND the
      // composite (id, org_id) PK. Only the former should surface as a
      // name conflict — a generated-id PK collision is vanishingly rare
      // but if it ever happens we want the user to retry, not be told
      // their (correct) name is taken.
      if (meta.code === "23505" && meta.constraint === UNIQUE_NAME_CONSTRAINT) {
        return c.json(
          { error: "conflict", message: `A group named "${trimmedName}" already exists.`, requestId },
          409,
        );
      }
      log.error({ err: errorMessage(err), requestId, orgId, name: trimmedName }, "Failed to create connection group");
      return c.json({ error: "internal_error", message: "Failed to create connection group.", requestId }, 500);
    }

    log.info({ requestId, orgId, groupId: id, name: trimmedName, actorId: authResult.user?.id }, "Connection group created");
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection_group.create,
      targetType: "connection_group",
      targetId: id,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { name: trimmedName },
    });

    const created = await internalQuery<GroupRow>(
      `SELECT id, name, created_at, updated_at, '0' AS member_count
       FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    return c.json(rowToWire(created[0]), 201);
  }),
);

// PATCH /:id — rename
adminConnectionGroups.openapi(renameGroupRoute, async (c) =>
  runHandler(c, "rename connection group", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const authResult = c.get("authResult");
    const { id } = c.req.valid("param");

    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: errorMessage(err), requestId }, "Failed to parse JSON body in rename group request");
      return null;
    });
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required.", requestId }, 400);
    }
    const { name } = body as Record<string, unknown>;
    if (typeof name !== "string" || !GROUP_NAME_PATTERN.test(name.trim())) {
      return c.json(
        {
          error: "invalid_request",
          message: "Group name must start with a letter or digit and may contain letters, digits, spaces, hyphens, or underscores (max 64 chars).",
          requestId,
        },
        400,
      );
    }
    const trimmedName = name.trim();

    let updated: GroupRow[];
    try {
      updated = await internalQuery<GroupRow>(
        `UPDATE connection_groups
         SET name = $3, updated_at = NOW()
         WHERE id = $1 AND org_id = $2
         RETURNING id, name, created_at, updated_at,
                   (SELECT COUNT(*)::text FROM connections c
                    WHERE c.group_id = connection_groups.id
                      AND c.org_id = connection_groups.org_id
                      AND c.status != 'archived') AS member_count`,
        [id, orgId, trimmedName],
      );
    } catch (err) {
      const meta = pgErrorMeta(err);
      if (meta.code === "23505" && meta.constraint === UNIQUE_NAME_CONSTRAINT) {
        return c.json(
          { error: "conflict", message: `A group named "${trimmedName}" already exists.`, requestId },
          409,
        );
      }
      log.error({ err: errorMessage(err), requestId, orgId, groupId: id }, "Failed to rename connection group");
      return c.json({ error: "internal_error", message: "Failed to rename connection group.", requestId }, 500);
    }
    if (updated.length === 0) {
      return c.json({ error: "not_found", message: `Group "${id}" not found.`, requestId }, 404);
    }

    log.info({ requestId, orgId, groupId: id, name: trimmedName, actorId: authResult.user?.id }, "Connection group renamed");
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection_group.rename,
      targetType: "connection_group",
      targetId: id,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { name: trimmedName },
    });
    return c.json(rowToWire(updated[0]), 200);
  }),
);

// DELETE /:id — delete (must be empty)
adminConnectionGroups.openapi(deleteGroupRoute, async (c) =>
  runHandler(c, "delete connection group", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const authResult = c.get("authResult");
    const { id } = c.req.valid("param");

    const existing = await internalQuery<{ id: string }>(
      `SELECT id FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (existing.length === 0) {
      return c.json({ error: "not_found", message: `Group "${id}" not found.`, requestId }, 404);
    }

    // Reject delete-with-active-members so the admin sees a meaningful 409
    // with a member count rather than a raw 23503 from the underlying
    // ON DELETE RESTRICT. The "split a group" workflow goes through
    // POST /:id/members with `unassign: true` per connection.
    const members = await internalQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM connections
       WHERE group_id = $1 AND org_id = $2 AND status != 'archived'`,
      [id, orgId],
    );
    const memberCount = parseMemberCount(members[0]?.count);
    // Fail closed on a malformed COUNT: dropping a delete because we
    // can't trust the guard is preferable to dropping a non-empty group
    // because `NaN > 0` is false.
    if (memberCount === null) {
      log.error(
        { rawCount: members[0]?.count, requestId, orgId, groupId: id },
        "Could not parse member count before delete — refusing to drop group",
      );
      return c.json(
        {
          error: "internal_error",
          message: "Could not verify group is empty. Try again.",
          requestId,
        },
        500,
      );
    }
    if (memberCount > 0) {
      return c.json(
        {
          error: "conflict",
          message: `Group "${id}" still has ${memberCount} connection(s). Move them out before deleting.`,
          requestId,
        },
        409,
      );
    }

    try {
      await internalQuery(
        `DELETE FROM connection_groups WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
    } catch (err) {
      const meta = pgErrorMeta(err);
      if (meta.code === "23503") {
        const message = meta.constraint === CONNECTIONS_GROUP_FK
          ? `Group "${id}" is still referenced by connection rows. Restore or permanently remove those connections before deleting it.`
          : `Group "${id}" is still referenced by workspace content. Remove or update those references before deleting it.`;
        return c.json(
          {
            error: "conflict",
            message,
            requestId,
          },
          409,
        );
      }
      log.error({ err: errorMessage(err), requestId, orgId, groupId: id }, "Failed to delete connection group");
      return c.json({ error: "internal_error", message: "Failed to delete connection group.", requestId }, 500);
    }

    log.info({ requestId, orgId, groupId: id, actorId: authResult.user?.id }, "Connection group deleted");
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection_group.delete,
      targetType: "connection_group",
      targetId: id,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: {},
    });
    return c.json({ success: true }, 200);
  }),
);

// POST /:id/members — move a connection into this group, or back to its single-connection group
adminConnectionGroups.openapi(assignMemberRoute, async (c) =>
  runHandler(c, "assign connection group member", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const authResult = c.get("authResult");
    const { id: groupId } = c.req.valid("param");

    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: errorMessage(err), requestId }, "Failed to parse JSON body in assign member request");
      return null;
    });
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required.", requestId }, 400);
    }
    const { connectionId, unassign } = body as Record<string, unknown>;
    if (typeof connectionId !== "string" || !connectionId) {
      return c.json({ error: "invalid_request", message: "connectionId is required.", requestId }, 400);
    }
    // Strict `=== true` so JSON-coerced truthy values (`"true"`, `1`, `{}`)
    // can't accidentally trigger an unassign. JSON booleans only.
    const isUnassign = unassign === true;

    // Verify the group exists in this org so the caller gets a typed 404
    // rather than a foreign_key_violation 500 from the UPDATE below.
    const groupRows = await internalQuery<{ id: string }>(
      `SELECT id FROM connection_groups WHERE id = $1 AND org_id = $2`,
      [groupId, orgId],
    );
    if (groupRows.length === 0) {
      return c.json({ error: "not_found", message: `Group "${groupId}" not found.`, requestId }, 404);
    }

    // Verify the connection belongs to this org and (for unassign) is
    // currently a member of the group named in the URL. Without the
    // group_id match on unassign, a caller could move a connection out
    // of a different group — the URL implies "this group" but the
    // effect would be "any group".
    const conn = await internalQuery<{ id: string; group_id: string | null }>(
      `SELECT id, group_id FROM connections
       WHERE id = $1 AND org_id = $2 AND status != 'archived'`,
      [connectionId, orgId],
    );
    if (conn.length === 0) {
      return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.`, requestId }, 404);
    }
    if (isUnassign && conn[0].group_id !== groupId) {
      return c.json(
        {
          error: "not_found",
          message: `Connection "${connectionId}" is not a member of group "${groupId}".`,
          requestId,
        },
        404,
      );
    }

    const targetGroupId = isUnassign ? `g_${connectionId}` : groupId;
    try {
      if (isUnassign) {
        await internalQuery(
          `WITH group_row AS (
             INSERT INTO connection_groups (id, org_id, name)
             VALUES ($1, $3, $2)
             ON CONFLICT (id, org_id) DO UPDATE SET updated_at = connection_groups.updated_at
             RETURNING id
           )
           UPDATE connections SET group_id = (SELECT id FROM group_row), updated_at = NOW()
            WHERE id = $2 AND org_id = $3`,
          [targetGroupId, connectionId, orgId],
        );
      } else {
        await internalQuery(
          `UPDATE connections SET group_id = $1, updated_at = NOW()
           WHERE id = $2 AND org_id = $3`,
          [targetGroupId, connectionId, orgId],
        );
      }
    } catch (err) {
      log.error(
        { err: errorMessage(err), requestId, orgId, groupId, connectionId },
        "Failed to assign connection to group",
      );
      return c.json({ error: "internal_error", message: "Failed to assign connection to group.", requestId }, 500);
    }

    log.info(
      { requestId, orgId, groupId: targetGroupId, connectionId, actorId: authResult.user?.id },
      "Connection group membership updated",
    );
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection_group.assignMember,
      targetType: "connection_group",
      targetId: groupId,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { connectionId, groupId: targetGroupId },
    });
    return c.json({ connectionId, groupId: targetGroupId }, 200);
  }),
);

export { adminConnectionGroups };
