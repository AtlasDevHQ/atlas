-- 0184 — seal ownerless non-org SCIM providers (GHSA-j8v8-g9cx-5qf4).
--
-- The advisory: @better-auth/scim does not bind non-organization ("personal")
-- SCIM providers to their creator in the default configuration. The plugin's
-- management access check is
--
--   } else if (provider.userId && provider.userId !== userId) throw FORBIDDEN
--
-- so a NULL `userId` short-circuits the `&&` and ANY authenticated user can
-- read, list, delete, or REGENERATE THE TOKEN of another user's personal
-- provider. Regenerating rotates it: the legitimate token stops working and
-- the caller holds a valid one.
--
-- The 1.6.x stable line is NOT patched (the only upstream fix is the breaking
-- 1.7.0-beta.4+). The supported mitigation is `providerOwnership: { enabled:
-- true }`, wired in `lib/auth/server.ts` alongside this migration. But that
-- flag only stamps `userId` on providers created AFTER it is enabled — the
-- column is nullable and nothing backfills it, so every pre-existing personal
-- provider stays ownerless and exploitable indefinitely. This migration closes
-- that residual set.
--
-- WHY A SENTINEL AND NOT `DELETE`:
--
-- The advisory suggests deleting ownerless rows, but that is destructive and
-- unrecoverable — it discards a live IdP's provisioning connection. Stamping a
-- reserved, non-existent owner id instead makes the row fail CLOSED against
-- every real user (no `user.id` can equal it) while preserving the row and its
-- token. That mirrors exactly what upstream 1.7.0 does ("connections created
-- before the upgrade carry no owner and become unreachable through the
-- management endpoints, so reclaim them at the database level") and it is
-- reversible: an operator reclaims a connection by setting `userId` to the
-- intended owner, then regenerating the token.
--
-- ACTIVE PROVISIONING IS UNAFFECTED. The /scim/v2/* protocol routes
-- authenticate through `authMiddlewareFactory`, which resolves the Bearer
-- token via `verifySCIMToken` and never consults `provider.userId`. Only the
-- MANAGEMENT endpoints (generate-token, get-provider-connection, the
-- connection list, delete) go through the ownership check. A sealed row keeps
-- syncing users; it just cannot be administered until reclaimed.
--
-- Org-scoped providers are deliberately untouched: they take the
-- `provider.organizationId` branch, which already enforces org membership and
-- role, and were never affected by this advisory.
--
-- Guarded on both the table and the column because `scimProvider` is owned by
-- Better Auth, not by this runner: the table only exists once the EE SCIM
-- plugin has booted, and the `userId` column only once `providerOwnership` is
-- enabled. Better Auth's schema-diff auto-migrate runs on EVERY boot BEFORE
-- this runner (see the note in lib/auth/server.ts), so on an EE deploy the
-- column is present by the time this executes. On a deploy where SCIM was
-- never enabled, both guards no-op instead of erroring.

DO $$
DECLARE
  sealed integer;
BEGIN
  -- Unqualified so the lookup resolves against the caller's search_path, and
  -- `current_schema()` for the same reason — mirrors 0090 / 0085 / 0153. A
  -- hardcoded 'public' would make this migration silently no-op wherever the
  -- runner operates in another schema (every -pg test harness does), which on a
  -- SECURITY migration is the worst possible failure: a clean green run that
  -- sealed nothing.
  IF to_regclass('"scimProvider"') IS NULL THEN
    RAISE NOTICE '0184: scimProvider table absent (SCIM never enabled) — skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'scimProvider'
      AND column_name = 'userId'
  ) THEN
    RAISE NOTICE '0184: scimProvider."userId" absent (providerOwnership not yet applied) — skipping';
    RETURN;
  END IF;

  UPDATE "scimProvider"
     SET "userId" = '00000000-0000-0000-0000-000000000000'
   WHERE "userId" IS NULL
     AND "organizationId" IS NULL;

  GET DIAGNOSTICS sealed = ROW_COUNT;

  IF sealed > 0 THEN
    RAISE WARNING '0184: sealed % ownerless personal SCIM provider(s) (GHSA-j8v8-g9cx-5qf4). They keep provisioning but are unreachable from the management endpoints until an operator sets "userId" to the intended owner and regenerates the token.', sealed;
  END IF;
END $$;
