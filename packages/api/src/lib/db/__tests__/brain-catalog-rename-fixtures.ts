/**
 * The pre-rename copy for #5082's two Company Atlas ingest catalog rows — the
 * strings the three prod regions actually hold before migration 0201 runs.
 *
 * ⚠️ THIS FILE EXISTS SO THERE IS EXACTLY ONE DERIVATION IN THE TREE. Both
 * `seed-builtin-knowledge-catalog.test.ts` (the constant↔migration text pin)
 * and `brain-catalog-rename-pg.test.ts` (the behavioural suite) need the
 * pre-rename strings. Two independent copies of the inversion sounds like
 * belt-and-braces and is the opposite: neither copy checks the other, so an
 * edit to one silently desynchronises the pin from the fixture it is supposed
 * to be pinning.
 *
 * Deriving rather than transcribing is deliberate. Retyping the old strings a
 * third time makes the fixture and the migration agree by construction — the
 * #5000 lesson — because the same pair of hands writes both and a typo lands
 * in both. Inverting the rename ties the old strings to the CURRENT constants,
 * so editing a constant without editing the migration reds `assertPinnedToMigration`.
 *
 * ⚠️ AND IT DOES NOT PARSE THE MIGRATION'S SYNTAX. An earlier draft read the
 * old strings out of 0201's `WHEN … THEN` arms. That removed the duplication
 * but coupled the fixture to the statement's SHAPE: deleting a `CASE` — the
 * precise defect the per-column guard exists to prevent — then made the
 * fixture unbuildable instead of making an assertion fail. A defect that
 * destroys the instrument measuring it reads as a broken test, not a caught
 * bug. Derive from the constants; VERIFY against the migration's text.
 *
 * This derivation is specific to ADR-0038 and migration 0201. A future rename
 * adds its own migration and re-points this file; the failure it causes here
 * meanwhile is the intended alarm.
 */

import {
  BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW,
  BUILTIN_OUTLOOK_MAIL_CATALOG_ROW,
} from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";

/** ADR-0038's rename, inverted. */
export const preRename = (s: string): string =>
  s.replace("Company Atlas (", "Company Brain (").replace("the Company Atlas", "the company brain");

export const PRE_RENAME = {
  zoomName: preRename(BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.name),
  zoomDescription: preRename(BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.description),
  outlookName: preRename(BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.name),
  outlookDescription: preRename(BUILTIN_OUTLOOK_MAIL_CATALOG_ROW.description),
} as const;

/**
 * Every string 0201 must mention, paired with the constant it was derived
 * from. Both test files walk this, so neither can drift from the other.
 */
export const RENAME_PAIRS = [
  {
    label: "Zoom transcripts",
    row: BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW,
    oldName: PRE_RENAME.zoomName,
    oldDescription: PRE_RENAME.zoomDescription,
  },
  {
    label: "Outlook mail",
    row: BUILTIN_OUTLOOK_MAIL_CATALOG_ROW,
    oldName: PRE_RENAME.outlookName,
    oldDescription: PRE_RENAME.outlookDescription,
  },
] as const;

/**
 * The two ways this derivation can go quietly wrong, as a throwing check the
 * `-pg` suite runs before it seeds anything.
 *
 * 1. The inversion becomes the IDENTITY — one more constant edit is enough (a
 *    name reading `Company Atlas —` rather than `Company Atlas (`). Every
 *    fixture would then seed the POST-rename string, the migration's `WHERE`
 *    would match nothing, and the positive assertions would still read the
 *    constant back. Green, against zero rows written.
 * 2. The inversion stays a real transform but no longer produces what 0201
 *    matches on, so the same vacuum arrives by a different route.
 *
 * Throwing rather than returning a boolean is the point: a seeded fixture that
 * cannot fail is worse than no fixture, so this refuses to let the suite start.
 */
export function assertPinnedToMigration(migrationSql: string): void {
  for (const { label, row, oldName, oldDescription } of RENAME_PAIRS) {
    if (oldName === row.name || oldDescription === row.description) {
      throw new Error(
        `${label}: preRename is a no-op against the current constant, so every fixture below would ` +
          `seed the post-rename string and pass without the migration writing anything. ` +
          `ADR-0038's rename shape changed — re-point brain-catalog-rename-fixtures.ts at the new one.`,
      );
    }
    for (const [what, value] of [
      ["name", oldName],
      ["description", oldDescription],
    ] as const) {
      if (!migrationSql.includes(`'${value}'`)) {
        throw new Error(
          `${label}: migration 0201 does not match on the derived pre-rename ${what}. ` +
            `Either the seed constant moved without the migration, or the migration's literal has a typo — ` +
            `in production that is a WHERE clause that matches nothing and a rename that silently never happens.`,
        );
      }
    }
  }
}
