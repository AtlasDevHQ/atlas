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
import { REST_DATASOURCE_CATALOG_IDS } from "@atlas/api/lib/openapi/data-candidates";
import { normalizeGroupId } from "@atlas/api/lib/openapi/datasource";
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
  // Operator-designated default member; null when unset or archived.
  primaryConnectionId: z.string().nullable(),
  members: z.array(ConnectionGroupMemberSchema),
});

/**
 * A REST/OpenAPI datasource's cross-environment scope (#3044, ADR-0010), surfaced
 * so the chat env picker can frame what a pinned conversation can actually reach.
 * REST datasources are NOT SQL `members` (they're not execution targets for the
 * Pin/All routing), so they ride a parallel array rather than polluting `groups`.
 *
 * `groupId === null` ⇒ **workspace-global** (available in every conversation,
 * NOT constrained by the env pin). A string ⇒ **scoped** to that connection
 * group (in-scope only when that group is active).
 */
const RestDatasourceScopeSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  groupId: z.string().nullable(),
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
  // #3044 — REST datasources + their env scope, for the picker's scope summary.
  // Always present (possibly empty) so the frontend never branches on absence.
  restDatasources: z.array(RestDatasourceScopeSchema),
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
      { groups: [], restDatasources: [], reason: "no_internal_db" as const },
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
      { groups: [], restDatasources: [], reason: "no_active_org" as const },
      200,
    );
  }
  try {
    // One round-trip via a left-join so groups with zero non-archived
    // members still appear in the list (the picker should show them so
    // the user can spot the "empty group" misconfiguration).
    // Post-0096 cutover (#2744 / ADR-0007 pure-collapse): groups are
    // free-form JSONB strings in `workspace_plugins.config.group_id`
    // with no separate `connection_groups` row. "Group name" and "group
    // id" collapse to the same value (the JSONB string). There's no
    // `primary_connection_id` — the picker falls back to the deterministic
    // first-by-install_id ordering when no explicit pin exists.
    // #3044 — SQL connection groups + REST datasource scope resolve in one
    // round-trip. SQL members EXCLUDE REST `catalog_id`s (REST datasources share
    // `pillar = 'datasource'` but are not SQL execution targets — listing them as
    // pickable members would route the agent to a connection that can't run SQL,
    // ADR-0010); REST datasources ride their own array with their `group_id`.
    const restCatalogIds = [...REST_DATASOURCE_CATALOG_IDS];
    const [rows, restRows] = await Promise.all([
      internalQuery<{
        group_id: string;
        connection_id: string;
        db_type: string | null;
        description: string | null;
      }>(
        `SELECT config->>'group_id' AS group_id,
                install_id           AS connection_id,
                config->>'db_type'   AS db_type,
                config->>'description' AS description
           FROM workspace_plugins
          WHERE workspace_id = $1
            AND pillar = 'datasource'
            AND catalog_id <> ALL($2)
            AND status != 'archived'
            AND config->>'group_id' IS NOT NULL
          ORDER BY config->>'group_id' ASC, install_id ASC`,
        [orgId, restCatalogIds],
      ),
      // REST datasources — group_id may be NULL (workspace-global) or set
      // (scoped). The picker frames the cross-env reach from this.
      internalQuery<{
        install_id: string;
        display_name: string | null;
        snapshot_title: string | null;
        group_id: string | null;
      }>(
        `SELECT install_id,
                config->>'display_name'                  AS display_name,
                config->'openapi_snapshot'->>'title'     AS snapshot_title,
                config->>'group_id'                      AS group_id
           FROM workspace_plugins
          WHERE workspace_id = $1
            AND catalog_id = ANY($2)
            AND pillar = 'datasource'
            AND status != 'archived'
          ORDER BY install_id ASC`,
        [orgId, restCatalogIds],
      ),
    ]);

    // Pivot the flat rows into one entry per group with a `members` array.
    const byGroup = new Map<string, z.infer<typeof ConnectionGroupSchema>>();
    for (const row of rows) {
      let group = byGroup.get(row.group_id);
      if (!group) {
        group = {
          id: row.group_id,
          name: row.group_id,
          primaryConnectionId: null,
          members: [],
        };
        byGroup.set(row.group_id, group);
      }
      group.members.push({
        connectionId: row.connection_id,
        dbType: row.db_type ?? "unknown",
        description: row.description,
      });
    }
    // Project REST datasources into the scope shape. A blank display name falls
    // back to the spec title, then the install id — mirrors the admin summary.
    const restDatasources = restRows.map((r) => ({
      id: r.install_id,
      displayName:
        (r.display_name && r.display_name.length > 0 ? r.display_name : null) ??
        (r.snapshot_title && r.snapshot_title.length > 0 ? r.snapshot_title : null) ??
        r.install_id,
      groupId: normalizeGroupId(r.group_id),
    }));

    // `reason: null` covers both "workspace has groups" and the
    // ordinary "workspace has no groups configured yet" — the picker
    // treats null as "no banner; just hide if the array is empty". A
    // populated `reason` is reserved for genuinely degraded states the
    // caller couldn't reach a usable query for.
    return c.json(
      { groups: Array.from(byGroup.values()), restDatasources, reason: null },
      200,
    );
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
