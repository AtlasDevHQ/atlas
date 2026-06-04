/**
 * Admin-scoped access control for the Better Auth client.
 *
 * Mirrors packages/api/src/lib/auth/admin-permissions.ts — keep in sync.
 * Duplicated because @atlas/web cannot import from @atlas/api.
 */

import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";

const statement = {
  ...defaultStatements,
} as const;

export const adminAccessControl = createAccessControl(statement);

// #2890: `platform_admin` is the only admin-plugin user.role. Tenant admins
// flow through the org plugin's member.role (owner/admin/member).
export const platformAdminRole = adminAccessControl.newRole({
  ...adminAc.statements,
});
