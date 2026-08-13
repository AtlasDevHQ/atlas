-- backfill-only: reconciles seeded built-in custom_roles rows with the
-- BUILTIN_ROLES definitions as of #5192. No schema change, no lock beyond the
-- touched rows, and it is a no-op on any deploy that never seeded (those orgs
-- have no custom_roles row and resolve through LEGACY_ROLE_PERMISSIONS, which
-- carries the current flags in code).
--
-- 0197 — grant dashboards:share to the seeded built-in `admin` role (#5192)
--
-- ## Why a migration at all
--
-- The full argument is in 0196's header and has not changed: `resolvePermissions`
-- RETURNS the stored `custom_roles` set rather than unioning it with the legacy
-- mapping, `updateRole` refuses `is_builtin` rows, and the reconciling seeder
-- only fires from `listRoles` — i.e. when somebody opens /admin/roles. So a new
-- flag added in code is silently ABSENT for every already-seeded workspace until
-- someone happens to visit that page.
--
-- 0196 repaired a case where that absence 403'd an admin off a surface they used
-- yesterday. This one is the mirror image and is not user-visible as a break: an
-- admin who never opens /admin/roles would simply find the new share gate
-- denying them a capability they have always had. Same mechanism, so the same
-- remedy — and the `roles.test.ts` drift guard requires the newest backfill to
-- match `BUILTIN_ROLES` exactly, which is what keeps this from being forgotten.
--
-- ## Why the arrays are spelled out here
--
-- A migration is a point-in-time snapshot on purpose. Reading BUILTIN_ROLES at
-- migration time would make this file mean something different depending on when
-- it ran, which is the property migrations exist NOT to have.
--
-- ## Scope
--
-- `WHERE is_builtin = true` only. A customer's own role that happens to be named
-- `analyst` is `is_builtin = false` and is left exactly as authored — we do not
-- own it and must not rewrite it.
--
-- `analyst` and `viewer` are restated UNCHANGED from 0196. They are here because
-- the drift guard reads the newest backfill as the whole current definition, and
-- because restating a value that did not change is how this file stays readable
-- as the snapshot it claims to be. ⚠️ They must NOT gain `dashboards:share` —
-- withholding it from every non-admin built-in is the entire point of #5192, and
-- `admin` is the only role that picks a new flag up automatically (its entry in
-- `BUILTIN_ROLES` is the `[...PERMISSIONS]` spread).

UPDATE custom_roles
   SET permissions = '["query","query:raw_data","dashboards:read","dashboards:write","dashboards:share","admin:users","admin:connections","admin:settings","admin:audit","admin:roles","admin:semantic"]',
       description = 'Full access to all features and administration',
       updated_at  = now()
 WHERE is_builtin = true
   AND name = 'admin';

UPDATE custom_roles
   SET permissions = '["query","query:raw_data","dashboards:read","dashboards:write","admin:audit"]',
       description = 'Can query data (including raw data), build dashboards, and view audit logs',
       updated_at  = now()
 WHERE is_builtin = true
   AND name = 'analyst';

UPDATE custom_roles
   SET permissions = '["query","dashboards:read"]',
       description = 'Can query data with aggregate results only, and view dashboards',
       updated_at  = now()
 WHERE is_builtin = true
   AND name = 'viewer';
