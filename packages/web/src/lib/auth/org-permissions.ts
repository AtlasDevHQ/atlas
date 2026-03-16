/**
 * Organization-scoped access control for the Better Auth client.
 *
 * Mirrors packages/api/src/lib/auth/org-permissions.ts — keep in sync.
 * Duplicated because @atlas/web cannot import from @atlas/api.
 */

import { createAccessControl } from "better-auth/plugins/access";

const statement = {
  organization: ["update", "delete"],
  member: ["create", "read", "update", "delete"],
  connection: ["create", "read", "update", "delete"],
  conversation: ["create", "read", "delete"],
  semantic: ["read", "update"],
  settings: ["read", "update"],
} as const;

export const ac = createAccessControl(statement);

export const member = ac.newRole({
  connection: ["read"],
  conversation: ["create", "read"],
  semantic: ["read"],
  settings: ["read"],
});

export const admin = ac.newRole({
  member: ["create", "read", "update", "delete"],
  connection: ["create", "read", "update", "delete"],
  conversation: ["create", "read", "delete"],
  semantic: ["read", "update"],
  settings: ["read", "update"],
});

export const owner = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "read", "update", "delete"],
  connection: ["create", "read", "update", "delete"],
  conversation: ["create", "read", "delete"],
  semantic: ["read", "update"],
  settings: ["read", "update"],
});
