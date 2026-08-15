-- 0201 — rename the two Company Atlas ingest catalog rows (#5082, ADR-0038).
--
-- ADR-0038 moved the product noun from "Company Brain" to "Company Atlas" in
-- every customer-visible string. These two `plugin_catalog` rows were left
-- behind on purpose, because editing the source constant would have renamed
-- NOTHING that already exists: `seedBuiltinKnowledgeCatalog` inserts with
-- `ON CONFLICT DO NOTHING` keyed on a stable id, so a boot against a region
-- whose rows were seeded months ago is a no-op. New installs would have shown
-- "Company Atlas (…)" while all three prod regions kept the old label forever:
-- the label would fork silently, and the source would then misstate what
-- customers see.
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
-- GUARDED PER COLUMN. Each column is written only where it still holds the
-- exact string this migration expects, because a platform admin CAN edit these
-- fields through the catalog CRUD path
-- (`lib/integrations/catalog-crud.ts`). The per-column `CASE` matters: a row
-- whose description an operator rewrote but whose name is still stock gets the
-- name renamed and the description left alone, where a row-level guard would
-- have abandoned both. Idempotent — the second run's `WHERE` matches nothing,
-- in either direction.
--
-- `updated_at` is bumped in the same statement because the application's own
-- update path does (`catalog-crud.ts`); a row whose name changed under a stale
-- `updated_at` would misreport when it last moved.
--
-- ⚠️ ORDERING, and the one interleaving that ends in the wrong string. On a
-- region where the rows are ABSENT when this runs, this migration correctly
-- does nothing and is then recorded as applied — it will never run again. If a
-- PRE-#5082 image then boots against that database, its seeder inserts the row
-- born with the OLD label and nothing will ever rewrite it. That window is a
-- rolling-deploy restart or an image rollback during cutover.
--
-- ⚠️ NOTHING IN THIS FILE DETECTS THAT WINDOW, and an earlier draft of this
-- header claimed the residue warning did. It cannot: the residue check runs
-- inside 0201's own transaction, strictly before any later image could boot
-- and re-seed, so it reads 0 and stays silent by construction. The only
-- in-file signal is `present=0` in the notice below — which says the row was
-- absent AT MIGRATION TIME, i.e. that this region is exposed to the window,
-- not that the window occurred. Detecting the outcome needs a check after the
-- rollout settles, which is a deploy-verification step and not a migration's
-- job. Reporting `present` at all is the point: absent and already-renamed
-- are different situations and only one of them is exposed.
--
-- ⚠️ THE BREADCRUMB REPORTS PER COLUMN, because the guard is per column.
-- `ROW_COUNT` counts ROWS, so a row whose name was rewritten and whose
-- description was not is one row either way, so a row-level count would report
-- plain success on a half-renamed row. The two counts below are taken BEFORE
-- the update and say exactly which columns
-- were eligible; the residue check afterwards answers the question an operator
-- actually has — *does this row still say the old name* — about the state THIS
-- TRANSACTION sees. See the window note above for what it cannot answer.
-- `RAISE WARNING` for that arm follows 0184's precedent for the "somebody must
-- look at this" case, though note `migrate.ts` currently logs every notice at
-- `info` and drops severity, so today the two arms are distinguished by their
-- TEXT rather than by level.
--
-- ⚠️ Notices are emitted at EXECUTION time, not at commit. `migrate.ts` wraps
-- each file in `BEGIN`/`COMMIT`, so a failure after these blocks — the
-- `__atlas_migrations` insert, or the commit itself — leaves these lines in
-- the log for writes that were discarded. `migrate.ts` also logs "Migration
-- failed" in that case, so both are visible together; read them together.
-- `SET LOCAL client_min_messages` is set explicitly because a region whose
-- role or connection string raises it above `notice` would otherwise silence
-- the NOTICE arm — the residue WARNING survives one level higher — leaving
-- only the failure case audible and restoring most of the ambiguity this
-- breadcrumb exists to remove.

DO $$
DECLARE
  present              integer;
  eligible_name        integer;
  eligible_description integer;
  residue              integer;
BEGIN
  SET LOCAL client_min_messages = notice;

  SELECT
    count(*),
    count(*) FILTER (WHERE name = 'Company Brain (Zoom transcripts)'),
    count(*) FILTER (WHERE description = 'Read cloud-recording transcripts from Zoom into the company brain as immutable, deduped episodes. Each meeting is granted only to the people who attended it — a meeting whose participant list cannot be read is skipped rather than ingested. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.')
    INTO present, eligible_name, eligible_description
    FROM plugin_catalog
   WHERE id = 'catalog:zoom-transcripts';

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

  RAISE NOTICE '[0201] catalog:zoom-transcripts: present=%, name rewritten=%, description rewritten=%. present=0 means the row does not exist here yet, so this region is exposed to the rollback window described in this file''s header — the boot seeder will create it, and which label it gets depends on which image creates it. With present=1, a 0 for either column means that column was already renamed or carries an operator''s own wording; the warning below fires if any of it still reads the old name.', present, eligible_name, eligible_description;

  SELECT count(*) INTO residue
    FROM plugin_catalog
   WHERE id = 'catalog:zoom-transcripts'
     AND (name ILIKE '%company brain%' OR description ILIKE '%company brain%');

  IF residue > 0 THEN
    RAISE WARNING '[0201] catalog:zoom-transcripts STILL reads the old product name after this migration ran. TWO causes, and only one is benign: an operator wrote that wording themselves through the catalog CRUD path (benign — their text stands), or the stored string drifted from what this migration matches on, which is a defect. 0201 is recorded as applied in the same transaction and will never retry, so the defect case needs a follow-up migration rather than a re-run. Check /admin/knowledge on this region to tell them apart.';
  END IF;
END $$;

DO $$
DECLARE
  present              integer;
  eligible_name        integer;
  eligible_description integer;
  residue              integer;
BEGIN
  SET LOCAL client_min_messages = notice;

  SELECT
    count(*),
    count(*) FILTER (WHERE name = 'Company Brain (Outlook mail)'),
    count(*) FILTER (WHERE description = 'Read selected Outlook mailboxes into the company brain as immutable, deduped episodes. Each message is granted only to the people named in its From, To and Cc headers — blind-copied and forwarded-to recipients are deliberately NOT granted, so access is a lower bound on who saw the mail rather than a guess. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.')
    INTO present, eligible_name, eligible_description
    FROM plugin_catalog
   WHERE id = 'catalog:outlook-mail';

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

  RAISE NOTICE '[0201] catalog:outlook-mail: present=%, name rewritten=%, description rewritten=%. present=0 means the row does not exist here yet, so this region is exposed to the rollback window described in this file''s header — the boot seeder will create it, and which label it gets depends on which image creates it. With present=1, a 0 for either column means that column was already renamed or carries an operator''s own wording; the warning below fires if any of it still reads the old name.', present, eligible_name, eligible_description;

  SELECT count(*) INTO residue
    FROM plugin_catalog
   WHERE id = 'catalog:outlook-mail'
     AND (name ILIKE '%company brain%' OR description ILIKE '%company brain%');

  IF residue > 0 THEN
    RAISE WARNING '[0201] catalog:outlook-mail STILL reads the old product name after this migration ran. TWO causes, and only one is benign: an operator wrote that wording themselves through the catalog CRUD path (benign — their text stands), or the stored string drifted from what this migration matches on, which is a defect. 0201 is recorded as applied in the same transaction and will never retry, so the defect case needs a follow-up migration rather than a re-run. Check /admin/knowledge on this region to tell them apart.';
  END IF;
END $$;
