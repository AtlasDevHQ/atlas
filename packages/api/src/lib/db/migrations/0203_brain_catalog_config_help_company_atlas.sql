-- 0203 — rename the Company Atlas ingest rows' config_schema helper text
-- (#5240, ADR-0038). The residue 0201 deliberately did not carry.
--
-- 0201 renamed these two `plugin_catalog` rows' `name` and `description`. Each
-- row's `config_schema` still carries a THIRD customer-read string, inside the
-- JSONB array, on the field with key `description`:
--
--     "Optional. A human description of this brain source."
--
-- It renders as helper text on the install form at /admin/knowledge, so
-- ADR-0038 governs it, and it is frozen by exactly the same insert-only seeder
-- (`seedBuiltinKnowledgeCatalog`, `ON CONFLICT (id) DO NOTHING`): editing the
-- source constant renames nothing that any region already holds.
--
-- ⚠️ WHY THIS IS ITS OWN MIGRATION rather than two more lines in 0201. 0201
-- rewrites whole COLUMNS, where equality against a known string is the whole
-- guard. Here the target is one string inside an ARRAY OF OBJECTS, and the
-- obvious spelling — a `config_schema::text` round-trip through `replace()` —
-- is not safely anchored: JSONB normalises key order and whitespace on
-- storage, so the text a match would be written against is not the text the
-- author sees, and a substring rewrite would also hit any OTHER field whose
-- help happened to contain the phrase. Bundling that statement shape into a
-- well-tested rename migration is what #5240 declined to do.
--
-- THE SHAPE INSTEAD: rebuild the array element-wise with `jsonb_agg`, ORDERED
-- by the original ordinality, replacing the one matched field's `description`
-- via `jsonb_set`. Every other element is passed through as the same JSONB
-- value, so the rest of the schema — fields, order, keys, secret flags — is
-- byte-identical afterwards. `brain-config-help-rename-pg.test.ts` asserts that
-- against a real Postgres rather than reasoning about it.
--
-- GUARDED, like 0201, and for the same reason: a platform admin can rewrite a
-- catalog row through the CRUD path (`lib/integrations/catalog-crud.ts`). The
-- match is on the field with key `description` AND the exact known-old string,
-- so an operator's own helper text is never clobbered, and a row whose
-- `config_schema` is not an array (or is NULL) is skipped rather than erroring
-- the boot migration. Idempotent — the second run's `EXISTS` matches nothing.
--
-- `updated_at` is bumped in the same statement because the application's own
-- update path does (`catalog-crud.ts`).
--
-- Scale: `plugin_catalog` is global, not workspace-scoped — one row per id per
-- region, so this touches at most 2 rows in each of the 3 prod regions. No
-- batching, no lock concern.
--
-- ⚠️ SAME ROLLBACK WINDOW AS 0201, and nothing in this file can detect it: on a
-- region where the rows are ABSENT when this runs, the migration correctly does
-- nothing and is recorded as applied forever. A pre-#5240 image booting against
-- that database afterwards seeds the row born with the OLD helper text, and
-- nothing rewrites it. `present=0` in the notice below says the region is
-- EXPOSED to that window, not that it occurred; detecting the outcome is a
-- deploy-verification step, not a migration's job.
--
-- ⚠️ THE BREADCRUMB REPORTS present AND eligible SEPARATELY, because they are
-- different situations: `present=0` is the exposed-to-the-window case above,
-- while `present=1, rewritten=0` means the row is here and already carries the
-- new text (or an operator's own). A single count would collapse the two.
-- `RAISE WARNING` for the residue arm follows 0201/0184; note `migrate.ts` logs
-- every notice at `info` and drops severity, so today the arms are told apart
-- by their TEXT. `SET LOCAL client_min_messages` is set explicitly so a region
-- whose role raises it above `notice` cannot silence the NOTICE arm.

DO $$
DECLARE
  present   integer;
  eligible  integer;
  residue   integer;
BEGIN
  SET LOCAL client_min_messages = notice;

  SELECT count(*) INTO present
    FROM plugin_catalog
   WHERE id = 'catalog:zoom-transcripts';

  SELECT count(*) INTO eligible
    FROM plugin_catalog
   WHERE id = 'catalog:zoom-transcripts'
     AND jsonb_typeof(config_schema) = 'array'
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(plugin_catalog.config_schema) AS f(field)
            WHERE f.field->>'key' = 'description'
              AND f.field->>'description' = 'Optional. A human description of this brain source.'
         );

  UPDATE plugin_catalog
     SET config_schema = (
           SELECT jsonb_agg(
                    CASE
                      WHEN f.field->>'key' = 'description'
                       AND f.field->>'description' = 'Optional. A human description of this brain source.'
                      THEN jsonb_set(
                             f.field,
                             '{description}',
                             to_jsonb('Optional. A human description of this Company Atlas source.'::text)
                           )
                      ELSE f.field
                    END
                    ORDER BY f.ord
                  )
             FROM jsonb_array_elements(plugin_catalog.config_schema) WITH ORDINALITY AS f(field, ord)
         ),
         updated_at = now()
   WHERE id = 'catalog:zoom-transcripts'
     AND jsonb_typeof(config_schema) = 'array'
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(plugin_catalog.config_schema) AS f(field)
            WHERE f.field->>'key' = 'description'
              AND f.field->>'description' = 'Optional. A human description of this brain source.'
         );

  RAISE NOTICE '[0203] catalog:zoom-transcripts: present=%, config_schema helper text rewritten=%. present=0 means the row does not exist here yet, so this region is exposed to the rollback window described in this file''s header — the boot seeder will create it, and which helper text it gets depends on which image creates it. With present=1, a 0 means the field was already renamed or carries an operator''s own wording; the warning below fires if any config_schema help still reads the old product noun.', present, eligible;

  SELECT count(*) INTO residue
    FROM plugin_catalog
   WHERE id = 'catalog:zoom-transcripts'
     AND jsonb_typeof(config_schema) = 'array'
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(plugin_catalog.config_schema) AS f(field)
            WHERE f.field->>'description' ILIKE '%brain source%'
         );

  IF residue > 0 THEN
    RAISE WARNING '[0203] catalog:zoom-transcripts config_schema STILL carries help text reading "brain source" after this migration ran. TWO causes, and only one is benign: an operator wrote that wording themselves through the catalog CRUD path (benign — their text stands), or the stored string drifted from what this migration matches on, which is a defect. 0203 is recorded as applied in the same transaction and will never retry, so the defect case needs a follow-up migration rather than a re-run. Check the install form at /admin/knowledge on this region to tell them apart.';
  END IF;
END $$;

DO $$
DECLARE
  present   integer;
  eligible  integer;
  residue   integer;
BEGIN
  SET LOCAL client_min_messages = notice;

  SELECT count(*) INTO present
    FROM plugin_catalog
   WHERE id = 'catalog:outlook-mail';

  SELECT count(*) INTO eligible
    FROM plugin_catalog
   WHERE id = 'catalog:outlook-mail'
     AND jsonb_typeof(config_schema) = 'array'
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(plugin_catalog.config_schema) AS f(field)
            WHERE f.field->>'key' = 'description'
              AND f.field->>'description' = 'Optional. A human description of this brain source.'
         );

  UPDATE plugin_catalog
     SET config_schema = (
           SELECT jsonb_agg(
                    CASE
                      WHEN f.field->>'key' = 'description'
                       AND f.field->>'description' = 'Optional. A human description of this brain source.'
                      THEN jsonb_set(
                             f.field,
                             '{description}',
                             to_jsonb('Optional. A human description of this Company Atlas source.'::text)
                           )
                      ELSE f.field
                    END
                    ORDER BY f.ord
                  )
             FROM jsonb_array_elements(plugin_catalog.config_schema) WITH ORDINALITY AS f(field, ord)
         ),
         updated_at = now()
   WHERE id = 'catalog:outlook-mail'
     AND jsonb_typeof(config_schema) = 'array'
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(plugin_catalog.config_schema) AS f(field)
            WHERE f.field->>'key' = 'description'
              AND f.field->>'description' = 'Optional. A human description of this brain source.'
         );

  RAISE NOTICE '[0203] catalog:outlook-mail: present=%, config_schema helper text rewritten=%. present=0 means the row does not exist here yet, so this region is exposed to the rollback window described in this file''s header — the boot seeder will create it, and which helper text it gets depends on which image creates it. With present=1, a 0 means the field was already renamed or carries an operator''s own wording; the warning below fires if any config_schema help still reads the old product noun.', present, eligible;

  SELECT count(*) INTO residue
    FROM plugin_catalog
   WHERE id = 'catalog:outlook-mail'
     AND jsonb_typeof(config_schema) = 'array'
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(plugin_catalog.config_schema) AS f(field)
            WHERE f.field->>'description' ILIKE '%brain source%'
         );

  IF residue > 0 THEN
    RAISE WARNING '[0203] catalog:outlook-mail config_schema STILL carries help text reading "brain source" after this migration ran. TWO causes, and only one is benign: an operator wrote that wording themselves through the catalog CRUD path (benign — their text stands), or the stored string drifted from what this migration matches on, which is a defect. 0203 is recorded as applied in the same transaction and will never retry, so the defect case needs a follow-up migration rather than a re-run. Check the install form at /admin/knowledge on this region to tell them apart.';
  END IF;
END $$;
