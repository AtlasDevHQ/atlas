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

export const adminRole = adminAccessControl.newRole({
  ...adminAc.statements,
});

export const platformAdminRole = adminAccessControl.newRole({
  ...adminAc.statements,
});
