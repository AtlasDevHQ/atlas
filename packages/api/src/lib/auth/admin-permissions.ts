/**
 * Admin-scoped access control for Better Auth's admin plugin.
 *
 * Defines the single user-level admin role, `platform_admin`, that governs
 * who can perform cross-tenant administrative operations (ban users, set
 * roles, impersonate, manage sessions, etc.).
 *
 * As of #2890 the redundant system-wide `admin` user.role was dropped — it
 * meant "system admin who isn't a platform_admin", which nothing in Atlas
 * actually needs. Tenant admins flow exclusively through the organization
 * plugin's `member.role` (owner/admin/member); see org-permissions.ts. This
 * file now handles only the top-level cross-tenant role.
 *
 * Exported for use in the server config (server.ts). A client-side
 * mirror exists at packages/web/src/lib/auth/admin-permissions.ts —
 * keep both files in sync.
 */

import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";

const statement = {
  ...defaultStatements,
} as const;

export const adminAccessControl = createAccessControl(statement);

/**
 * Platform admin — full admin-plugin permissions over users and sessions.
 * The only role in the admin-plugin ACL: platform-operator routes check
 * `user.role === "platform_admin"` to gate cross-tenant operations.
 */
export const platformAdminRole = adminAccessControl.newRole({
  ...adminAc.statements,
});
