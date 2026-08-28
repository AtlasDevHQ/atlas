-- 0209 — carry legacy `scimProvider` rows into 1.7's managed-connection
-- catalog (#5493).
--
-- @better-auth/scim 1.7 replaced the single `scimProvider` table with a
-- catalog: `scimManagedConnection` (the connection), `scimManagedCredential`
-- (its bearer tokens, HMAC-digested), and `scimUser` (the provisioned-user
-- projection). Nothing backfills any of them, so on an upgrading deploy the
-- admin surface reads empty while the legacy rows still describe real
-- directory connections.
--
-- WHAT THIS MOVES, AND WHAT IT DELIBERATELY DOES NOT:
--
-- Connections move. Credentials do NOT.
--
-- 1.6 stored SCIM bearer tokens reversibly encrypted (`storeSCIMToken:
-- "encrypted"`); 1.7 stores an HMAC digest under a different secret. Carrying
-- them would mean decrypting live customer secrets in a migration and
-- rewriting them under a new scheme, where any mismatch in derivation,
-- encoding or hash version breaks provisioning SILENTLY — the exact failure
-- shape this upgrade produced repeatedly. The recorded decision is to rotate
-- instead: each connection is carried across so it keeps its identity and its
-- organization binding, and an admin issues a fresh token for it through
-- `POST /api/v1/admin/scim/connections/{id}/rotate`, which mints through the
-- authorized, audited path.
--
-- A carried connection therefore has NO active credential until rotated. Its
-- IdP gets 401 at `/scim/v2/*` in the meantime — the same outcome as not
-- migrating at all, except the admin can SEE the connection and rotate it
-- rather than having to reconstruct which org owned which provider id.
--
-- `scimConnectionBinding` and `scimUser` are likewise not synthesised. The
-- binding is written by the plugin's own lifecycle, and `scimUser` is a
-- projection of users the IdP has actually provisioned — inventing rows for
-- users we merely believe were provisioned would put fabricated identity data
-- in the table `isSCIMProvisioned` trusts. Until an IdP re-syncs, that
-- predicate reads the legacy table too (see `lib/auth/scim-provenance.ts`),
-- which is what keeps SCIM-managed users from becoming editable mid-upgrade.
--
-- OWNERSHIP: 1.7's `createdBy` is NOT NULL, where 1.6's `userId` was nullable
-- — that column plus migration 0184's sentinel is precisely what upstream
-- replaced. Rows carrying 0184's sentinel keep it; org-scoped rows that never
-- had an owner (they took the `organizationId` branch and were never affected
-- by GHSA-j8v8-g9cx-5qf4) get the same sentinel, so "no real owner" stays
-- representable and no live user id is invented.
--
-- Guarded on both tables because neither is owned by this runner:
-- `scimProvider` exists only where 1.6 EE SCIM ran, and
-- `scimManagedConnection` only once 1.7's schema-diff auto-migrate has run
-- (which happens on EVERY boot BEFORE this runner — see the note in
-- lib/auth/server.ts). Where SCIM was never enabled, both guards no-op.

DO $$
DECLARE
  carried  integer;
  skipped  integer;
  -- Reserved, non-existent owner. Same value migration 0184 stamps, kept
  -- identical so a row sealed there and a row carried here are one class.
  sentinel constant text := '00000000-0000-0000-0000-000000000000';
BEGIN
  IF to_regclass('"scimProvider"') IS NULL THEN
    RAISE NOTICE '0209: scimProvider absent (1.6 SCIM never enabled) — skipping';
    RETURN;
  END IF;

  IF to_regclass('"scimManagedConnection"') IS NULL THEN
    -- EE SCIM is off on this deploy, so 1.7's schema-diff has not created the
    -- catalog. Do NOT fail: a self-hosted deploy that once enabled SCIM and
    -- later turned it off would otherwise be unable to migrate at all.
    RAISE NOTICE '0209: scimManagedConnection absent (1.7 SCIM not enabled) — skipping';
    RETURN;
  END IF;

  -- Idempotent on `connectionId`, which is UNIQUE in the target: a re-run
  -- carries nothing twice, and a connection an admin already re-created by
  -- hand is left exactly as they made it.
  INSERT INTO "scimManagedConnection" (
    id,
    "creationRequestId",
    "connectionId",
    "provisioningDomainId",
    status,
    revision,
    "createdAt",
    "createdBy"
  )
  SELECT
    gen_random_uuid()::text,
    -- The catalog's idempotency key. Derived from the source row rather than
    -- random so a re-run collides with itself instead of inserting a twin.
    '0209-migrated-' || sp.id,
    sp."providerId",
    sp."organizationId",
    'active',
    1,
    now(),
    COALESCE(NULLIF(sp."userId", ''), sentinel)
  FROM "scimProvider" sp
  WHERE sp."organizationId" IS NOT NULL
    AND sp."providerId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "scimManagedConnection" mc
       WHERE mc."connectionId" = sp."providerId"
    );

  GET DIAGNOSTICS carried = ROW_COUNT;

  -- Personal (non-org) providers are NOT carried. `provisioningDomainId` is
  -- NOT NULL and means "the application-owned boundary receiving provisioned
  -- resources", which for Atlas is the organization; a provider with no org
  -- has no coherent destination. These are exactly the rows GHSA-j8v8-g9cx-5qf4
  -- was about, and 0184 sealed them precisely because they should not be
  -- reachable. Counted and reported rather than silently dropped.
  SELECT COUNT(*) INTO skipped
    FROM "scimProvider" sp
   WHERE sp."organizationId" IS NULL;

  IF carried > 0 THEN
    RAISE WARNING '0209: carried % SCIM connection(s) into the 1.7 managed catalog. Their bearer credentials were NOT migrated — 1.6 stored tokens encrypted, 1.7 stores HMAC digests. Each connection needs a fresh token issued from /admin/scim (or POST /api/v1/admin/scim/connections/{id}/rotate) and pasted into its IdP; until then that IdP receives 401 at /scim/v2/*.', carried;
  ELSE
    RAISE NOTICE '0209: no org-scoped scimProvider rows to carry';
  END IF;

  IF skipped > 0 THEN
    RAISE WARNING '0209: left % ownerless personal SCIM provider(s) behind — they carry no organization, so they have no provisioning domain in the 1.7 model. These are the rows migration 0184 sealed under GHSA-j8v8-g9cx-5qf4. Re-create them as org-scoped connections if any is still wanted.', skipped;
  END IF;
END $$;
