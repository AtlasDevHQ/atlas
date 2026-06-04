-- 0118 — Drop the redundant `admin` value from the admin-plugin `user.role`.
--
-- #2890: Atlas ran two Better Auth role surfaces side by side — the admin
-- plugin's system-wide `user.role` (platform_admin / admin / user) and the
-- organization plugin's per-org `member.role` (owner / admin / member). The
-- `user.role = 'admin'` middle state ("system admin who isn't a platform
-- admin") was redundant: every tenant admin already flows through
-- `member.role`. The admin-plugin ACL no longer defines `admin` (see
-- lib/auth/admin-permissions.ts + server.ts), and `resolveEffectiveRole`
-- now sources tenant admin-ness exclusively from `member.role`. This file
-- retires the column value so no stale `user.role = 'admin'` outlives the
-- model change.
--
-- Touches the Better Auth-owned `user` + `member` tables, so it is listed in
-- MANAGED_AUTH_MIGRATIONS (db/internal.ts) and runs only in managed auth mode
-- (Better Auth migrations run first; same ordering as 0061 / 0027). The guard
-- below fails loudly if that ordering is ever violated.
--
-- Pre-migration audit (2026-06-03, all three prod regional internal DBs):
-- every `user.role = 'admin'` row was already `member.role = 'owner'`; ZERO
-- rows had an admin grant living only in `user.role`. The backfill below is
-- therefore a no-op on current prod data — it exists so that any admin-console
-- role change landing between the audit and this deploy (which under the old
-- code wrote `user.role`) is mirrored into `member.role` BEFORE the column is
-- cleared, guaranteeing no admin is silently demoted.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'user'
      AND table_schema = current_schema()
  ) THEN
    RAISE EXCEPTION 'Atlas migration 0118 requires the "user" table to exist in the current schema. In managed auth mode, Better Auth migrations must run before Atlas migrations.';
  END IF;
END $$;

-- Better Auth's admin plugin can store comma-separated multi-role strings
-- (e.g. `admin,user`); Atlas only ever writes single values, and the
-- pre-migration audit found none — but we match `admin` as a comma-list
-- SEGMENT so a multi-role row can't survive. `(',' || role || ',')` wraps the
-- value so a segment match is `LIKE '%,admin,%'`, which never matches
-- `platform_admin` (',platform_admin,' has no ',admin,' substring).

-- 1. Lossless backfill: for any user whose role-list carries an `admin`
--    segment, mirror it into `member.role = 'admin'` for every org they belong
--    to where they currently rank below admin. Org owners are skipped (already
--    >= admin). Under the retired model an `admin` user.role meant "effective
--    admin in every org" (max merge), so promoting these member rows to
--    `admin` preserves — not widens — their access.
UPDATE member m
SET role = 'admin'
FROM "user" u
WHERE m."userId" = u.id
  AND (',' || u.role || ',') LIKE '%,admin,%'
  AND m.role NOT IN ('admin', 'owner');

-- 2. Retire the `admin` segment from the user-level value: strip it from the
--    comma list, leaving any other segments intact, and NULL the column when
--    nothing remains. `platform_admin` and every non-admin value are left
--    untouched (the WHERE only matches rows carrying an `admin` segment).
UPDATE "user"
SET role = NULLIF(
  trim(BOTH ',' FROM replace(',' || role || ',', ',admin,', ',')),
  ''
)
WHERE (',' || role || ',') LIKE '%,admin,%';
