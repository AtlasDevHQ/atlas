-- 0201 — rename the two Company Atlas ingest catalog rows (#5082, ADR-0038).
--
-- ADR-0038 moved the product noun from "Company Brain" to "Company Atlas" in
-- every customer-visible string. These two `plugin_catalog` rows were left
-- behind on purpose, because editing the source constant would have renamed
-- NOTHING that already exists: `seedBuiltinKnowledgeCatalog` inserts with
-- `ON CONFLICT DO NOTHING` keyed on a stable id, so a boot against a region
-- whose rows were seeded months ago is a no-op. New installs would have shown
-- "Company Atlas (…)" while all three prod regions kept "Company Brain (…)"
-- forever, with nothing reporting the divergence — a silently forked label,
-- which is worse than not renaming at all because the source then lies about
-- what customers see.
--
-- So the rename lives here, and the seeder stays insert-only by design: the
-- constant is the shape a row is BORN with, a migration is the only thing that
-- changes a row that already exists. `seed-builtin-knowledge-catalog.ts`'s
-- header states that division; a test in
-- `__tests__/seed-builtin-knowledge-catalog.test.ts` pins the constants to the
-- literals below so the next rename cannot update one and miss the other.
--
-- Scale: `plugin_catalog` is global, not workspace-scoped — one row per id per
-- region, so this touches at most 2 rows in each of the 3 prod regions. No
-- batching, no lock concern.
--
-- CONSERVATIVE BY COLUMN, not by row. Each column is written only where it
-- still holds the exact string this migration expects, because a platform
-- admin CAN edit these fields through the catalog CRUD path
-- (`lib/integrations/catalog-crud.ts` → `UPDATE plugin_catalog SET ...`). The
-- per-column `CASE` matters: a row whose description an operator rewrote but
-- whose name is still stock gets the name renamed and the description left
-- alone, where a row-level guard would have abandoned both. Idempotent — the
-- second run's `WHERE` matches nothing, in either direction.
--
-- `updated_at` is bumped in the same statement because the application's own
-- update path does (`catalog-crud.ts`); a row whose name changed under a
-- stale `updated_at` would misreport when it last moved.
--
-- ⚠️ ORDERING, and the one interleaving that ends in the wrong string. On a
-- region where the rows are ABSENT when this runs (a fresh region, or one
-- whose earlier knowledge seed failed under the log-and-continue posture),
-- this migration correctly no-ops and is then recorded as applied — it will
-- never run again. If a PRE-#5082 image then boots against that database, its
-- seeder inserts the row born with "Company Brain (…)" and nothing will ever
-- rewrite it. That window is a rolling-deploy restart or an image rollback
-- during cutover. The notices below are how an operator sees it: a region
-- reporting "not rewritten" that later shows the old label in
-- `/admin/knowledge` is this case, and its repair is a follow-up migration.
--
-- The `RAISE NOTICE` per statement is the repo convention for a data-rewriting
-- migration (0032, 0034, 0055, 0072, 0184, 0194) and `migrate.ts` forwards
-- notices into the structured log. Without it all four outcomes below — wrote
-- two rows, rows absent, operator declined, and *the strings drifted so the
-- WHERE matched nothing it should have* — are byte-identical in the logs, and
-- only the last is a defect. It is also unrecoverable by retry, because the
-- applied-marker lands in the same successful transaction.

DO $$
DECLARE rewritten integer;
BEGIN
  UPDATE plugin_catalog
  SET
    name = CASE
      WHEN name = 'Company Brain (Zoom transcripts)' THEN 'Company Atlas (Zoom transcripts)'
      ELSE name
    END,
    description = CASE
      WHEN description = 'Read cloud-recording transcripts from Zoom into the company brain as immutable, deduped episodes. Each meeting is granted only to the people who attended it — a meeting whose participant list cannot be read is skipped rather than ingested. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.'
        THEN 'Read cloud-recording transcripts from Zoom into the Company Atlas as immutable, deduped episodes. Each meeting is granted only to the people who attended it — a meeting whose participant list cannot be read is skipped rather than ingested. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.'
      ELSE description
    END,
    updated_at = now()
  WHERE id = 'catalog:zoom-transcripts'
    AND (
      name = 'Company Brain (Zoom transcripts)'
      OR description = 'Read cloud-recording transcripts from Zoom into the company brain as immutable, deduped episodes. Each meeting is granted only to the people who attended it — a meeting whose participant list cannot be read is skipped rather than ingested. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.'
    );

  GET DIAGNOSTICS rewritten = ROW_COUNT;
  IF rewritten > 0 THEN
    RAISE NOTICE '[0201] catalog:zoom-transcripts rewritten to the Company Atlas copy (ADR-0038)';
  ELSE
    RAISE NOTICE '[0201] catalog:zoom-transcripts NOT rewritten. FOUR causes reach this and they are not equivalent. Three are expected: the row is absent (a fresh region — the boot seeder inserts the new copy directly); it already carries the new copy (a re-run); or an operator rewrote BOTH columns through the catalog CRUD path, in which case their text stands and this migration deliberately yields. The fourth is a defect: the stored strings differ from what this migration matches on, so the row still reads "Company Brain" while 0201 is already recorded as applied and will never retry. Check /admin/knowledge on this region; the repair is a follow-up migration, not a re-run.';
  END IF;
END $$;

DO $$
DECLARE rewritten integer;
BEGIN
  UPDATE plugin_catalog
  SET
    name = CASE
      WHEN name = 'Company Brain (Outlook mail)' THEN 'Company Atlas (Outlook mail)'
      ELSE name
    END,
    description = CASE
      WHEN description = 'Read selected Outlook mailboxes into the company brain as immutable, deduped episodes. Each message is granted only to the people named in its From, To and Cc headers — blind-copied and forwarded-to recipients are deliberately NOT granted, so access is a lower bound on who saw the mail rather than a guess. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.'
        THEN 'Read selected Outlook mailboxes into the Company Atlas as immutable, deduped episodes. Each message is granted only to the people named in its From, To and Cc headers — blind-copied and forwarded-to recipients are deliberately NOT granted, so access is a lower bound on who saw the mail rather than a guess. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.'
      ELSE description
    END,
    updated_at = now()
  WHERE id = 'catalog:outlook-mail'
    AND (
      name = 'Company Brain (Outlook mail)'
      OR description = 'Read selected Outlook mailboxes into the company brain as immutable, deduped episodes. Each message is granted only to the people named in its From, To and Cc headers — blind-copied and forwarded-to recipients are deliberately NOT granted, so access is a lower bound on who saw the mail rather than a guess. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.'
    );

  GET DIAGNOSTICS rewritten = ROW_COUNT;
  IF rewritten > 0 THEN
    RAISE NOTICE '[0201] catalog:outlook-mail rewritten to the Company Atlas copy (ADR-0038)';
  ELSE
    RAISE NOTICE '[0201] catalog:outlook-mail NOT rewritten. FOUR causes reach this and they are not equivalent. Three are expected: the row is absent (a fresh region — the boot seeder inserts the new copy directly); it already carries the new copy (a re-run); or an operator rewrote BOTH columns through the catalog CRUD path, in which case their text stands and this migration deliberately yields. The fourth is a defect: the stored strings differ from what this migration matches on, so the row still reads "Company Brain" while 0201 is already recorded as applied and will never retry. Check /admin/knowledge on this region; the repair is a follow-up migration, not a re-run.';
  END IF;
END $$;
