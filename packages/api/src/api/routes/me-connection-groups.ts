/**
 * `GET /api/v1/me/connection-groups` — non-admin listing of the user's
 * accessible connection groups and their members. Powers the chat
 * env/member picker (#2345).
 *
 * Authorization: any authenticated user with an active organization.
 * The response is scoped to `orgId` so callers only see groups in
 * their own workspace.
 *
 * Distinct from `/api/v1/admin/connection-groups` (admin-only):
 *   - That endpoint exposes mutation routes (POST / PATCH / DELETE).
 *   - This endpoint is read-only and serves end-user surfaces (chat
 *     header picker, conversation create dialog). It cannot grow new
 *     verbs — non-admin users must not be able to mutate group state.
 *
 * Empty workspaces (no groups configured yet) return `{ groups: [] }`;
 * the picker then renders nothing and the chat falls back to the
 * legacy single-connection path.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { standardAuth, type AuthEnv } from "./middleware";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

const log = createLogger("me-connection-groups");

const ConnectionGroupMemberSchema = z.object({
  connectionId: z.string(),
  dbType: z.string(),
  description: z.string().nullable(),
});

const ConnectionGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(ConnectionGroupMemberSchema),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Me — Connection Groups"],
  summary: "List connection groups visible to the user",
  description:
    "Returns connection groups for the active organization with their members. Scoped to the caller's workspace. Read-only — group mutations live under the admin router.",
  responses: {
    200: {
      description: "Connection group list",
      content: {
        "application/json": {
          schema: z.object({ groups: z.array(ConnectionGroupSchema) }),
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const meConnectionGroups = new OpenAPIHono<AuthEnv>();

meConnectionGroups.use(standardAuth);

meConnectionGroups.openapi(listRoute, async (c) => {
  const auth = c.get("authResult");
  const orgId = auth?.user?.activeOrganizationId;
  const requestId = c.get("requestId");
  if (!hasInternalDB() || !orgId) {
    // No internal DB or no org context — return empty rather than 500.
    // The picker UI treats `[]` as "no groups configured" and falls back
    // to the legacy single-connection routing. Surfacing a 500 here
    // would block chat for self-hosted users on the legacy single-
    // connection path.
    return c.json({ groups: [] as Array<z.infer<typeof ConnectionGroupSchema>> }, 200);
  }
  try {
    // One round-trip via a left-join so groups with zero non-archived
    // members still appear in the list (the picker should show them so
    // the user can spot the "empty group" misconfiguration).
    const rows = await internalQuery<{
      group_id: string;
      group_name: string;
      connection_id: string | null;
      db_type: string | null;
      description: string | null;
    }>(
      `SELECT g.id   AS group_id,
              g.name AS group_name,
              c.id   AS connection_id,
              c.type AS db_type,
              c.description AS description
         FROM connection_groups g
         LEFT JOIN connections c
           ON c.group_id = g.id
          AND c.org_id   = g.org_id
          AND c.status  != 'archived'
        WHERE g.org_id = $1
        ORDER BY g.name ASC, c.id ASC`,
      [orgId],
    );

    // Pivot the flat rows into one entry per group with a `members` array.
    const byGroup = new Map<string, z.infer<typeof ConnectionGroupSchema>>();
    for (const row of rows) {
      let group = byGroup.get(row.group_id);
      if (!group) {
        group = { id: row.group_id, name: row.group_name, members: [] };
        byGroup.set(row.group_id, group);
      }
      if (row.connection_id) {
        group.members.push({
          connectionId: row.connection_id,
          dbType: row.db_type ?? "unknown",
          description: row.description,
        });
      }
    }
    return c.json({ groups: Array.from(byGroup.values()) }, 200);
  } catch (err) {
    log.error(
      { err: errorMessage(err), requestId, orgId },
      "Failed to list connection groups for /me",
    );
    return c.json(
      {
        error: "internal_error",
        message: "Failed to list connection groups.",
        requestId,
      },
      500,
    );
  }
});

export { meConnectionGroups };
