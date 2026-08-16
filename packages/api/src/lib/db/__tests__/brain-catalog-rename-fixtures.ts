/**
 * The pre-rename copy for the two Company Atlas ingest catalog rows — the
 * strings the three prod regions actually hold before migrations 0201 (#5082,
 * `name` + `description`) and 0203 (#5240, the `config_schema` helper text)
 * run.
 *
 * ⚠️ THIS FILE EXISTS SO THERE IS EXACTLY ONE DERIVATION IN THE TREE. Both
 * `seed-builtin-knowledge-catalog.test.ts` (the constant↔migration text pin)
 * and `brain-catalog-rename-pg.test.ts` (the behavioural suite) need the
 * pre-rename strings. Two copies would drift: neither checks the other, so
 * editing one desynchronises the pin from the fixture it is pinning.
 *
 * Deriving rather than transcribing is deliberate. Retyping the old strings a
 * third time makes the fixture and the migration agree by construction — the
 * #5000 lesson — because the same pair of hands writes both and a typo lands
 * in both. Inverting the rename ties the old strings to the CURRENT constants,
 * so editing a constant without editing the migration reds the pin.
 *
 * ⚠️ AND IT DOES NOT PARSE THE MIGRATION'S SYNTAX. An earlier draft read the
 * old strings out of 0201's `WHEN … THEN` arms. That removed the duplication
 * but coupled the fixture to the statement's SHAPE: deleting a `CASE` — the
 * precise defect the per-column guard exists to prevent — then made the
 * fixture fail to BUILD, which reads as a broken test rather than a caught
 * defect. Derive from the constants; VERIFY against the migration's text.
 *
 * These derivations are specific to ADR-0038 and migrations 0201/0203. A future
 * rename adds its own migration and re-points this file; the failure it causes
 * here meanwhile is the intended alarm.
 */

import {
  BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW,
  BUILTIN_OUTLOOK_MAIL_CATALOG_ROW,
} from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";

/**
 * ADR-0038's rename, inverted.
 *
 * Not exported — a second consumer would be a second derivation, which is the
 * one thing this module exists to prevent. Use `PRE_RENAME` / `RENAME_PAIRS`.
 */
const preRename = (s: string): string =>
  s.replace("Company Atlas (", "Company Brain (").replace("the Company Atlas", "the company brain");

/**
 * A value as it appears as a SQL string literal — single quotes doubled.
 *
 * Two of the fourteen built-in descriptions already contain an apostrophe
 * (`workspace's existing Salesforce`, `help center's`), so the day one of THESE
 * two rows gains one, a CORRECT migration writes `''` and a naive
 * `includes("'" + value + "'")` reports it as a typo — diagnosing a correct
 * migration as the exact defect it does not have.
 */
export const sqlLiteral = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/**
 * A migration with its `--` comments removed, so a text pin cannot be
 * satisfied by prose.
 *
 * 0201 carries a long prose header that discusses the strings it rewrites, and
 * both pins are `includes` over text. Stripping is shared here rather than
 * living in one test file, because it already drifted once: round 1 added it
 * to one pin and shipped a second pin without it.
 *
 * Handles trailing `--` as well as whole-line comments. It deliberately does
 * NOT try to be a SQL parser — a `--` inside a string literal would be
 * stripped too. That is safe in the conservative direction: it can only remove
 * text a pin might have matched, never invent text. If 0201 ever needs a `--`
 * inside a literal, this must become a real scan.
 */
export const stripSqlComments = (sql: string): string =>
  sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");

export const PRE_RENAME = {
  zoomName: preRename(BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.name),
  zoomDescription: preRename(BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.description),
  outlookName: preRename(BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.name),
  outlookDescription: preRename(BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.description),
} as const;

/**
 * Every string 0201 must mention, paired with the constant it came from.
 *
 * ⚠️ Round 2 found TWO instruments written for the Zoom row only — the
 * id-scoping decoy and the idempotency check — so a scoping defect appended to
 * the OUTLOOK statement passed the whole suite. (The copy lock's defect was a
 * different one: it interpolated both rows from the constants it was locking,
 * and a constants-to-constants comparison could never have seen a widened
 * `WHERE` in the migration anyway.)
 *
 * The two statements are copy-paste twins, so anything asserted about ONE
 * belongs in a loop over this array. The exceptions are cases whose subject IS
 * the asymmetry — absent-vs-present, partially-seeded — and they say so.
 */
export const RENAME_PAIRS = [
  {
    label: "Zoom transcripts",
    row: BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW,
    oldName: PRE_RENAME.zoomName,
    oldDescription: PRE_RENAME.zoomDescription,
    /** A foreign id carrying this row's stock copy — the id-scoping decoy. */
    decoyId: "catalog:operator-copy-zoom",
  },
  {
    label: "Outlook mail",
    row: BUILTIN_OUTLOOK_MAIL_CATALOG_ROW,
    oldName: PRE_RENAME.outlookName,
    oldDescription: PRE_RENAME.outlookDescription,
    decoyId: "catalog:operator-copy-outlook",
  },
] as const;

/**
 * #5240's string: the `config_schema` helper text on the field with key
 * `description`, on the same two rows.
 *
 * A THIRD customer-read string per row, stored inside the JSONB array under
 * the same insert-only seeder, renamed by migration
 * `0203_brain_catalog_config_help_company_atlas.sql`. Same discipline as the
 * name/description pair above: derive the pre-rename value from the current
 * constant, verify it against the migration's text.
 */
export const CONFIG_HELP_FIELD_KEY = "description";

/** ADR-0038's rename of the helper text, inverted. */
const preRenameConfigHelp = (s: string): string =>
  s.replace("this Company Atlas source", "this brain source");

/**
 * The helper text a row's `description` field carries.
 *
 * Throws rather than returning `undefined`: the field vanishing (renamed key,
 * dropped field) would make every pin below vacuous, and a fixture that cannot
 * fail is worse than a red one. A throw at import aborts the whole file, which
 * is the intended alarm.
 */
function configHelpOf(row: {
  readonly id: string;
  readonly configSchema: ReadonlyArray<{ readonly key: string; readonly description?: string }>;
}): string {
  const field = row.configSchema.find((f) => f.key === CONFIG_HELP_FIELD_KEY);
  if (!field?.description) {
    throw new Error(
      `${row.id}: no \`${CONFIG_HELP_FIELD_KEY}\` config_schema field with help text — ` +
        `#5240's pin has nothing to compare and would pass vacuously. Re-point brain-catalog-rename-fixtures.ts.`,
    );
  }
  return field.description;
}

/**
 * ⚠️ BUILT AS AN EXPLICIT TUPLE, not `RENAME_PAIRS.map(...)`. `RENAME_PAIRS` is
 * `as const` — a readonly 2-tuple — and `.map` collapses that to
 * `Array<...>`, which loses "there are exactly two, both present" at the type
 * level. Downstream that cost 13 non-null assertions in the `-pg` suite
 * (`ROWS[0]!`, `zoomPair!`, …), every one of them noise today and every one of
 * them load-bearing the day `noUncheckedIndexedAccess` goes on.
 */
const configHelpPair = (pair: (typeof RENAME_PAIRS)[number]) => {
  const help = configHelpOf(pair.row);
  return {
    label: pair.label,
    row: pair.row,
    help,
    oldHelp: preRenameConfigHelp(help),
    decoyId: pair.decoyId,
  } as const;
};

export const CONFIG_HELP_PAIRS = [
  configHelpPair(RENAME_PAIRS[0]),
  configHelpPair(RENAME_PAIRS[1]),
] as const;

/**
 * The 0203 counterpart of {@link assertPinnedToMigration}, and it fails in the
 * same two ways: the inversion degenerating into the identity (every fixture
 * would then seed the POST-rename string, the migration's guard would match
 * nothing, and the positive assertions would still read the constant back), or
 * producing a string 0203 does not match on.
 *
 * ⚠️ CALL IT FROM `beforeAll`, not from an `it` — `expect(...).not.toThrow()`
 * catches the throw and leaves every following case running against fixtures
 * that cannot fail.
 */
export function assertConfigHelpPinnedToMigration(migrationSql: string): void {
  const sql = stripSqlComments(migrationSql);
  for (const { label, help, oldHelp } of CONFIG_HELP_PAIRS) {
    if (oldHelp === help) {
      throw new Error(
        `${label}: the pre-rename config_schema help derivation is a no-op against the current constant, so ` +
          `every fixture would seed the post-rename string and pass without the migration writing anything. ` +
          `ADR-0038's rename shape changed — re-point brain-catalog-rename-fixtures.ts at the new one.`,
      );
    }
    for (const [what, value] of [
      ["new", help],
      ["pre-rename", oldHelp],
    ] as const) {
      if (!sql.includes(sqlLiteral(value))) {
        throw new Error(
          `${label}: migration 0203's STATEMENTS do not contain the ${what} config_schema help string. ` +
            `Either the seed constant moved without the migration, or the migration's literal has a typo — ` +
            `in production that is a guard matching nothing and a rename that silently never happens. ` +
            `(Comments are stripped before this check, so a header mentioning the string does not satisfy it.)`,
        );
      }
    }
  }
}

/**
 * The two ways this derivation can go quietly wrong.
 *
 * 1. The inversion becomes the IDENTITY — one more constant edit is enough (a
 *    name reading `Company Atlas —` rather than `Company Atlas (`). Every
 *    fixture would then seed the POST-rename string, the migration's `WHERE`
 *    would match nothing, and the positive assertions would still read the
 *    constant back. Green, against zero rows written — measured at round 2,
 *    when the `-pg` suite was 26 cases: with `preRename` degenerated, 21 of
 *    them passed.
 * 2. The inversion stays a real transform but no longer produces what 0201
 *    matches on, so the same vacuum arrives by a different route.
 *
 * ⚠️ CALL THIS FROM `beforeAll`, NOT ONLY FROM AN `it`. It throws, and a throw
 * inside `beforeAll` aborts the block — which is the point, since every case
 * after it would otherwise run against fixtures that cannot fail. An earlier
 * draft called it only as `expect(() => …).not.toThrow()`; `expect` catches
 * the throw, so the "refusal" degraded into one red test among twenty-one
 * false greens. The docstring claimed otherwise, which is why round 2 measured
 * it rather than believing it.
 */
export function assertPinnedToMigration(migrationSql: string): void {
  const sql = stripSqlComments(migrationSql);
  for (const { label, row, oldName, oldDescription } of RENAME_PAIRS) {
    if (oldName === row.name || oldDescription === row.description) {
      throw new Error(
        `${label}: the pre-rename derivation is a no-op against the current constant, so every fixture ` +
          `would seed the post-rename string and pass without the migration writing anything. ` +
          `ADR-0038's rename shape changed — re-point brain-catalog-rename-fixtures.ts at the new one.`,
      );
    }
    for (const [what, value] of [
      ["name", oldName],
      ["description", oldDescription],
    ] as const) {
      if (!sql.includes(sqlLiteral(value))) {
        throw new Error(
          `${label}: migration 0201's STATEMENTS do not match on the derived pre-rename ${what}. ` +
            `Either the seed constant moved without the migration, or the migration's literal has a typo — ` +
            `in production that is a WHERE clause matching nothing and a rename that silently never happens. ` +
            `(Comments are stripped before this check, so a header mentioning the string does not satisfy it.)`,
        );
      }
    }
  }
}
