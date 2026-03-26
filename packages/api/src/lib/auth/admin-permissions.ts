/**
 * Admin-scoped access control for Better Auth's admin plugin.
 *
 * Defines user-level roles (`admin`, `platform_admin`) that govern
 * who can perform administrative operations (ban users, set roles,
 * impersonate, manage sessions, etc.).
 *
 * Separate from org-permissions.ts which handles organization-scoped
 * RBAC (owner/admin/member within an org). This file handles the
 * top-level user role that determines system-wide admin privileges.
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

/** Standard admin — full admin permissions over users and sessions. */
export const adminRole = adminAccessControl.newRole({
  ...adminAc.statements,
});

/**
 * Platform admin — same permissions as admin.
 * Distinguished by name for platform-operator routes that check
 * `user.role === "platform_admin"` to gate cross-tenant operations.
 */
export const platformAdminRole = adminAccessControl.newRole({
  ...adminAc.statements,
});
