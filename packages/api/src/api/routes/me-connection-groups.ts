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
 * `reason` distinguishes "empty because the workspace genuinely has no
 * groups" (null — picker stays hidden, chat falls back to the legacy
 * single-connection path) from "empty because the request can't reach a
 * usable state" (`no_internal_db` / `no_active_org` — picker renders
 * explanatory copy instead of silently disappearing). See #2422.
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
  // The group's designated default execution target. `null` when the
  // operator hasn't set one (or it's been archived). The chat env
  // picker uses this as the default member rather than
  // alphabetical-first — without it, a group like
  // `{apac-prod, eu-prod, us-prod}` would route to `apac-prod` even
  // when the operator picked `us-prod` as the primary.
  primaryConnectionId: z.string().nullable(),
  members: z.array(ConnectionGroupMemberSchema),
});

/**
 * Why an empty `groups` list. `null` ⇒ the workspace genuinely has no
 * groups configured (picker stays hidden, legacy single-connection
 * routing kicks in). Anything else is a degraded state the user should
 * see explained instead of a silent empty picker.
 *
 * Extending: keep this as a discriminated string union (not a free-form
 * `string`) so the frontend's exhaustive switch stays a compile-time
 * check. New reasons require a matching branch in `env-picker.tsx`.
 */
export type MeConnectionGroupsEmptyReason = "no_active_org" | "no_internal_db";

const ResponseSchema = z.object({
  groups: z.array(ConnectionGroupSchema),
  reason: z.enum(["no_active_org", "no_internal_db"]).nullable(),
});

export type MeConnectionGroupsResponse = z.infer<typeof ResponseSchema>;

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
          schema: ResponseSchema,
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
  // Pick the most operator-actionable diagnostic when both signals are
  // degraded. `no_internal_db` points at the deploy-side fix (set
  // DATABASE_URL); `no_active_org` is the per-user case the topbar
  // surfaces anyway. See `me-connection-groups.test.ts` →
  // "prefers 'no_internal_db' over 'no_active_org' when both apply"
  // for the load-bearing test on this precedence.
  if (!hasInternalDB()) {
    return c.json(
      { groups: [], reason: "no_internal_db" as const },
      200,
    );
  }
  if (!orgId) {
    // Leave a breadcrumb so support can correlate "empty picker" user
    // reports to a real auth-state issue without having to repro the
    // mid-org-switch race. Debug-level: this is expected during normal
    // org switches and would flood at info.
    log.debug(
      { requestId, userId: auth?.user?.id, reason: "no_active_org" },
      "me/connection-groups: no active organization for user",
    );
    return c.json(
      { groups: [], reason: "no_active_org" as const },
      200,
    );
  }
  try {
    // One round-trip via a left-join so groups with zero non-archived
    // members still appear in the list (the picker should show them so
    // the user can spot the "empty group" misconfiguration).
    const rows = await internalQuery<{
      group_id: string;
      group_name: string;
      primary_connection_id: string | null;
      connection_id: string | null;
      db_type: string | null;
      description: string | null;
    }>(
      `SELECT g.id                    AS group_id,
              g.name                  AS group_name,
              g.primary_connection_id AS primary_connection_id,
              c.id                    AS connection_id,
              c.type                  AS db_type,
              c.description           AS description
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
        group = {
          id: row.group_id,
          name: row.group_name,
          primaryConnectionId: row.primary_connection_id,
          members: [],
        };
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
    // Null out a primary that's been archived or doesn't exist — the
    // picker should fall through to alphabetical-first rather than try
    // to pin to a member that isn't in the list.
    for (const group of byGroup.values()) {
      if (
        group.primaryConnectionId &&
        !group.members.some((m) => m.connectionId === group.primaryConnectionId)
      ) {
        group.primaryConnectionId = null;
      }
    }
    // `reason: null` covers both "workspace has groups" and the
    // ordinary "workspace has no groups configured yet" — the picker
    // treats null as "no banner; just hide if the array is empty". A
    // populated `reason` is reserved for genuinely degraded states the
    // caller couldn't reach a usable query for.
    return c.json({ groups: Array.from(byGroup.values()), reason: null }, 200);
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
