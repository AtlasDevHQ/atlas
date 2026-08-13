-- backfill-only: reconciles seeded built-in custom_roles rows with the
-- BUILTIN_ROLES definitions as of #5189. No schema change, no lock beyond the
-- touched rows, and it is a no-op on any deploy that never seeded (those orgs
-- have no custom_roles row and resolve through LEGACY_ROLE_PERMISSIONS, which
-- carries the new flags in code).
--
-- 0196 — grant dashboards:read / dashboards:write to seeded built-in roles (#5189)
--
-- ## Why a migration and not just the seeder
--
-- `seedBuiltinRoles` was insert-if-absent, so a built-in role's permission set
-- was frozen in the DB at first seed. `resolvePermissions` RETURNS that stored
-- set rather than unioning it with the legacy mapping, and `updateRole` refuses
-- `is_builtin` rows — so the frozen value was the live authorization answer and
-- was unreachable from every supported surface.
--
-- #5189 makes the seeder reconcile (`ON CONFLICT … DO UPDATE WHERE is_builtin`),
-- but that only fires when `seedBuiltinRoles` runs, and its ONLY call site is
-- `listRoles` — i.e. someone opening /admin/roles. The failure this repairs
-- happens strictly BEFORE that: an org admin opens /dashboards, resolves to the
-- frozen 8-flag set, and is 403'd. Nothing sends them to the roles page, and the
-- 403 gives them no reason to go. Lazy reconciliation cannot reach them.
--
-- ## Why the arrays are spelled out here
--
-- A migration is a point-in-time snapshot on purpose. Reading BUILTIN_ROLES at
-- migration time would make this file mean something different depending on when
-- it ran, which is the property migrations exist NOT to have. When a later flag
-- is added, it gets its own backfill — and the reconciling seeder means most
-- orgs will already be current by then.
--
-- ## Scope
--
-- `WHERE is_builtin = true` only. A customer's own role that happens to be named
-- `analyst` is `is_builtin = false` and is left exactly as authored — we do not
-- own it and must not rewrite it.
--
-- `admin` is set to the full 10-flag list rather than having two appended,
-- because "admin holds every flag" is the definition; appending would preserve
-- any drift already in the row.

UPDATE custom_roles
   SET permissions = '["query","query:raw_data","dashboards:read","dashboards:write","admin:users","admin:connections","admin:settings","admin:audit","admin:roles","admin:semantic"]',
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
