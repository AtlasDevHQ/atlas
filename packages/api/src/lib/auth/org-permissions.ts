/**
 * Organization-scoped access control for Better Auth's organization plugin.
 *
 * Defines resources, actions, and roles that govern what org members
 * can do within their organization. Exported for use in both the
 * server config (server.ts) and client config (auth/client.ts).
 *
 * Role hierarchy: owner > admin > member
 *
 * | Resource      | member        | admin              | owner              |
 * |---------------|---------------|--------------------|--------------------|
 * | organization  | —             | —                  | update, delete     |
 * | member        | —             | create,read,update,delete | create,read,update,delete |
 * | invitation    | —             | create, cancel     | create, cancel     |
 * | connection    | read          | create,read,update,delete | create,read,update,delete |
 * | conversation  | create,read   | create,read,delete | create,read,delete |
 * | semantic      | read          | read,update        | read,update        |
 * | settings      | read          | read,update        | read,update        |
 */

import { createAccessControl } from "better-auth/plugins/access";

const statement = {
  organization: ["update", "delete"],
  member: ["create", "read", "update", "delete"],
  // Better Auth's own invite routes ask for invitation create / cancel.
  // Because `server.ts` passes
  // this statement AND these roles to `organization()`, they REPLACE the stock
  // `defaultStatements`/`defaultRoles` rather than extending them — and
  // `role.authorize()` denies a resource it has never heard of. Omitting this
  // line therefore did not leave invitations unrestricted; it made them
  // impossible for every role, `owner` included.
  invitation: ["create", "cancel"],
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
  invitation: ["create", "cancel"],
  connection: ["create", "read", "update", "delete"],
  conversation: ["create", "read", "delete"],
  semantic: ["read", "update"],
  settings: ["read", "update"],
});

export const owner = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "read", "update", "delete"],
  invitation: ["create", "cancel"],
  connection: ["create", "read", "update", "delete"],
  conversation: ["create", "read", "delete"],
  semantic: ["read", "update"],
  settings: ["read", "update"],
});
