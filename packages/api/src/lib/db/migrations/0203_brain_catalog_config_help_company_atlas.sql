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
-- value, so the rest of the schema — fields, keys, secret flags, order — is
-- identical afterwards. `brain-config-help-rename-pg.test.ts` asserts that
-- against a real Postgres by comparing the whole value to the seed constant.
--
-- ⚠️ ONE THIRD OF THAT CLAIM IS PINNED BY TEXT, NOT BY BEHAVIOUR. Deleting
-- `ORDER BY f.ord` was MEASURED against Postgres 17 and returned the fields in
-- byte-identical order anyway, because `jsonb_array_elements … WITH ORDINALITY`
-- already emits them in order and `jsonb_agg` follows its input. So the `-pg`
-- suite cannot falsify the ORDER half — the fields and flags halves it proves
-- properly — and the only guard on it is a text assertion in
-- `seed-builtin-knowledge-catalog.test.ts`. The `ORDER BY` stays because
-- aggregate input order is not contractual, but do not read the behavioural
-- suite as evidence for it.
--
-- GUARDED, like 0201, and for the same reason: a platform admin can rewrite a
-- catalog row through the CRUD path (`lib/integrations/catalog-crud.ts`). The
-- match is on the field with key `description` AND the exact known-old string,
-- so an operator's own helper text is never clobbered, and a row whose
-- `config_schema` is not an array (or is NULL) is skipped rather than erroring
-- the boot migration. Idempotent — the second run's `EXISTS` matches nothing.
-- An array of SCALARS is safe for the same reason without needing its own arm:
-- `'"a"'::jsonb ->> 'key'` is NULL rather than an error, so the predicate is
-- simply false (measured, not assumed).
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
-- ⚠️ THE BREADCRUMB REPORTS present, rewritten AND unexamined SEPARATELY,
-- because they are three situations. `present=0` is row-absent.
-- `present=1, rewritten=0, unexamined=0` means the row is here and already
-- carries the new text, or an operator's own wording. `unexamined=1` means
-- `config_schema` is not a JSON array, so the UPDATE's `jsonb_typeof` gate
-- skipped it and no field was read at all — without that third count,
-- `rewritten=0` claims "already renamed" about a row nothing looked at.
-- `rewritten` is `GET DIAGNOSTICS … ROW_COUNT` taken AFTER the UPDATE, not a
-- pre-count of eligible rows as 0201 does: a pre-count is a prediction, and a
-- trigger or policy filtering the write would make it report success over a
-- no-op. These two rows carry one `description` field each, so ROW_COUNT is
-- also the field count here — it counts ROWS, so a row with two matching
-- fields would rewrite both and still report 1.
--
-- ⚠️ AND `present=0` HAS TWO CAUSES THAT WANT OPPOSITE ACTIONS, which is why
-- there is a squatter arm below. The rollback window is one. The other is
-- #5239: another catalog row holds the slug under a different id, so the boot
-- seeder CANNOT create this row — it raises 23505 every boot. Saying "the boot
-- seeder will create it" in that state, as an earlier draft of the notice did,
-- points the operator at the wrong story in the one case where the breadcrumb
-- is load-bearing. The `squatted` count tells them apart.
--
-- `RAISE WARNING` for the residue arm follows 0201/0184; note `migrate.ts` logs
-- every notice at `info` and drops severity, so today the arms are told apart
-- by their TEXT. `SET LOCAL client_min_messages` is set explicitly so a region
-- whose role raises it above `notice` cannot silence the NOTICE arm.

DO $$
DECLARE
  present   integer;
  squatted   integer;
  unexamined integer;
  rewritten integer;
  residue   integer;
BEGIN
  SET LOCAL client_min_messages = notice;

  SELECT count(*) INTO present
    FROM plugin_catalog
   WHERE id = 'catalog:zoom-transcripts';

  SELECT count(*) INTO squatted
    FROM plugin_catalog
   WHERE slug = 'zoom-transcripts'
     AND id <> 'catalog:zoom-transcripts';

  -- ⚠️ THE STATE THE UPDATE NEVER LOOKS AT. The rewrite is gated on
  -- `jsonb_typeof(config_schema) = 'array'` because `jsonb_array_elements`
  -- ERRORS on anything else and that would abort the boot migration. So a row
  -- whose schema is an object, a scalar, or NULL is skipped silently — and
  -- `rewritten=0` then means "not eligible" and "never examined" at once.
  -- Counting it is what stops the notice below asserting the field was already
  -- renamed about a row nothing read. `IS DISTINCT FROM` so a NULL counts as
  -- unexamined rather than evaluating to NULL.
  SELECT count(*) INTO unexamined
    FROM plugin_catalog
   WHERE id = 'catalog:zoom-transcripts'
     AND jsonb_typeof(config_schema) IS DISTINCT FROM 'array';

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

  GET DIAGNOSTICS rewritten = ROW_COUNT;

  RAISE NOTICE '[0203] catalog:zoom-transcripts: present=%, config_schema helper text rewritten=%, unexamined=%. present=0 means the row does not exist under this id — see the squatter warning below, or, absent that, this region is exposed to the rollback window described in this file''s header. With present=1, a 0 means the field was already renamed or carries an operator''s own wording — UNLESS unexamined=1, which means config_schema is not a JSON array (an object, a scalar, or NULL) and this migration read no field at all; the residue warning below fires if any config_schema string contains "brain source".', present, rewritten, unexamined;

  IF present = 0 AND squatted > 0 THEN
    RAISE WARNING '[0203] catalog:zoom-transcripts is ABSENT because another catalog row already holds the slug "zoom-transcripts" under a different id (#5239). This is NOT the rollback window: the boot seeder cannot create this row at all — it raises 23505, reports the slug as blocked, and will do so on every boot. Rename or remove the conflicting row (SELECT id, name FROM plugin_catalog WHERE slug = ''zoom-transcripts''), then re-seed. WHICH helper text the new row is born with depends on the image that seeds it, and only one of the two cases needs anything further: a build at or after #5240 writes the new wording and you are done, whereas an older image writes the old wording — and since 0203 is recorded as applied in this transaction and never retries, THAT case needs a follow-up migration.';
  END IF;

  -- ⚠️ DETECTION IS A WHOLE-VALUE TEXT SCAN, and deliberately NOT the array
  -- walk the rewrite uses. Two reasons, both learned from the arms above:
  -- `jsonb_typeof(...) = 'array'` is required on the UPDATE (jsonb_array_elements
  -- errors on a non-array, which would abort the boot migration) but on a
  -- DETECTOR it is a blind spot: a `config_schema` an operator left as an
  -- object reports `present=1, rewritten=0, unexamined=1` and nothing more —
  -- the counter says the row went unread, but only a scan can say the old noun
  -- is still in there. And scanning the whole value catches it on a `label` or
  -- an option label, not only on a `description`. A text scan is safe here in a
  -- way it is not for the rewrite: it writes nothing, so JSONB's normalisation
  -- of key order and whitespace cannot corrupt anything — it can only over-warn.
  SELECT count(*) INTO residue
    FROM plugin_catalog
   WHERE id = 'catalog:zoom-transcripts'
     AND config_schema::text ILIKE '%brain source%';

  IF residue > 0 THEN
    RAISE WARNING '[0203] catalog:zoom-transcripts config_schema STILL carries a string reading "brain source" after this migration ran. THREE cases, and only the last is a defect: (a) the string sits on a field this migration does not target — a label, an option, another key — which is expected and left alone by design; (b) an operator wrote that wording themselves through the catalog CRUD path, and their text stands; (c) the `description` field''s stored value drifted from what this migration matches on (an edited string, or a config_schema that is not a JSON array), which is a defect. 0203 is recorded as applied in the same transaction and will never retry, so the defect case needs a follow-up migration rather than a re-run. Check the install form at /admin/knowledge on this region to tell them apart.';
  END IF;
END $$;

DO $$
DECLARE
  present   integer;
  squatted   integer;
  unexamined integer;
  rewritten integer;
  residue   integer;
BEGIN
  SET LOCAL client_min_messages = notice;

  SELECT count(*) INTO present
    FROM plugin_catalog
   WHERE id = 'catalog:outlook-mail';

  SELECT count(*) INTO squatted
    FROM plugin_catalog
   WHERE slug = 'outlook-mail'
     AND id <> 'catalog:outlook-mail';

  -- ⚠️ THE STATE THE UPDATE NEVER LOOKS AT. The rewrite is gated on
  -- `jsonb_typeof(config_schema) = 'array'` because `jsonb_array_elements`
  -- ERRORS on anything else and that would abort the boot migration. So a row
  -- whose schema is an object, a scalar, or NULL is skipped silently — and
  -- `rewritten=0` then means "not eligible" and "never examined" at once.
  -- Counting it is what stops the notice below asserting the field was already
  -- renamed about a row nothing read. `IS DISTINCT FROM` so a NULL counts as
  -- unexamined rather than evaluating to NULL.
  SELECT count(*) INTO unexamined
    FROM plugin_catalog
   WHERE id = 'catalog:outlook-mail'
     AND jsonb_typeof(config_schema) IS DISTINCT FROM 'array';

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

  GET DIAGNOSTICS rewritten = ROW_COUNT;

  RAISE NOTICE '[0203] catalog:outlook-mail: present=%, config_schema helper text rewritten=%, unexamined=%. present=0 means the row does not exist under this id — see the squatter warning below, or, absent that, this region is exposed to the rollback window described in this file''s header. With present=1, a 0 means the field was already renamed or carries an operator''s own wording — UNLESS unexamined=1, which means config_schema is not a JSON array (an object, a scalar, or NULL) and this migration read no field at all; the residue warning below fires if any config_schema string contains "brain source".', present, rewritten, unexamined;

  IF present = 0 AND squatted > 0 THEN
    RAISE WARNING '[0203] catalog:outlook-mail is ABSENT because another catalog row already holds the slug "outlook-mail" under a different id (#5239). This is NOT the rollback window: the boot seeder cannot create this row at all — it raises 23505, reports the slug as blocked, and will do so on every boot. Rename or remove the conflicting row (SELECT id, name FROM plugin_catalog WHERE slug = ''outlook-mail''), then re-seed. WHICH helper text the new row is born with depends on the image that seeds it, and only one of the two cases needs anything further: a build at or after #5240 writes the new wording and you are done, whereas an older image writes the old wording — and since 0203 is recorded as applied in this transaction and never retries, THAT case needs a follow-up migration.';
  END IF;

  -- Whole-value text scan, for the reasons given on the Zoom block above.
  SELECT count(*) INTO residue
    FROM plugin_catalog
   WHERE id = 'catalog:outlook-mail'
     AND config_schema::text ILIKE '%brain source%';

  IF residue > 0 THEN
    RAISE WARNING '[0203] catalog:outlook-mail config_schema STILL carries a string reading "brain source" after this migration ran. THREE cases, and only the last is a defect: (a) the string sits on a field this migration does not target — a label, an option, another key — which is expected and left alone by design; (b) an operator wrote that wording themselves through the catalog CRUD path, and their text stands; (c) the `description` field''s stored value drifted from what this migration matches on (an edited string, or a config_schema that is not a JSON array), which is a defect. 0203 is recorded as applied in the same transaction and will never retry, so the defect case needs a follow-up migration rather than a re-run. Check the install form at /admin/knowledge on this region to tell them apart.';
  END IF;
END $$;
