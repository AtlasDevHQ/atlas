/**
 * #3164 — org-plugin hooks that BLOCK Better Auth's native member-mutation
 * endpoints in favor of Atlas's guarded admin routes.
 *
 * Better Auth's organization plugin exposes `POST /organization/update-member-role`
 * and `POST /organization/remove-member`, reachable through the managed-auth
 * catch-all and granted to tenant admin/owner by `org-permissions.ts`. They are
 * a SECOND, unguarded path to the same mutations Atlas funnels through its custom
 * admin routes (`changeUserRoleRoute` / `removeMembershipRoute`), which serialize
 * the last-admin decision under a per-workspace advisory lock (#3158). A native
 * mutation takes no such lock, so it can race a locked demotion and strip a
 * workspace of its last admin/owner (Codex P1 on PR #3162).
 *
 * DECISION: BLOCK, not coordinate. Coordinating is UNSOUND here: a `before*`
 * hook could acquire the advisory lock and re-check the admin count, but it
 * cannot HOLD that transaction-scoped lock across Better Auth's actual member
 * mutation — the mutation commits on the plugin's own connection, AFTER the hook
 * (and its transaction) has returned. The lock would release before the write
 * commits, reopening the exact TOCTOU #3158 closed. Holding the lock across the
 * write is only possible when the count AND the mutation run on the same locked
 * connection, which the custom routes do and the native endpoints cannot.
 *
 * Nothing in Atlas (client or server) calls these native endpoints; every member
 * mutation goes through the guarded admin API. `leaveOrganization` (a separate
 * endpoint with its own owner guard) and the admin-plugin `removeUser` cascade
 * (a different plugin, not these endpoints) do NOT fire these hooks, so neither
 * is affected — only the unguarded update-role / remove-member surface is closed.
 */

import { APIError } from "better-auth/api";

/** Machine-readable error code surfaced when a blocked native endpoint is hit. */
export const ATLAS_USE_ADMIN_API_CODE = "ATLAS_USE_ADMIN_API";

/**
 * `organizationHooks.beforeUpdateMemberRole` — refuses the native
 * `update-member-role` endpoint, pointing callers at the guarded Atlas route.
 */
export async function blockNativeMemberRoleUpdate(): Promise<never> {
  throw new APIError("FORBIDDEN", {
    code: ATLAS_USE_ADMIN_API_CODE,
    message:
      "Member roles must be changed through the Atlas admin API " +
      "(PATCH /api/v1/admin/users/{id}/role), which enforces the workspace " +
      "last-admin invariant atomically. The native organization role-update " +
      "endpoint is disabled.",
  });
}

/**
 * `organizationHooks.beforeRemoveMember` — refuses the native `remove-member`
 * endpoint, pointing callers at the guarded Atlas route.
 */
export async function blockNativeMemberRemoval(): Promise<never> {
  throw new APIError("FORBIDDEN", {
    code: ATLAS_USE_ADMIN_API_CODE,
    message:
      "Members must be removed through the Atlas admin API " +
      "(DELETE /api/v1/admin/users/{id}/membership), which enforces the " +
      "workspace last-admin invariant atomically. The native organization " +
      "remove-member endpoint is disabled.",
  });
}
