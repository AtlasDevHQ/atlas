/**
 * The v3 bundle's identity surface — the compensating pin for the exemption
 * `keys-not-on-the-wire.test.ts` grants (#5035, ADR-0037 §8).
 *
 * ## Why this file exists
 *
 * `keys-not-on-the-wire.test.ts` forbids any read surface projecting a key, and
 * ADR-0037 §8 grants the region bundle the one exception: *a row-copy path
 * carries keys verbatim.* The exemption is spelled as three whole FILES —
 * `export.ts`, `migration.ts`, `admin-migrate.ts` — because the scan has no way
 * to tell "this projection is the row-copy path" from "this projection is a new
 * read surface in the same file". So both of its arms switch off for all three,
 * and what they were guarding has to be re-established narrowly. That is this
 * file. It is the same trade the `cardinality.ts` and `alias-proposal.ts`
 * exemptions record, one door over and with a wider blast radius.
 *
 * ## What it pins, and what it deliberately does not
 *
 * It reads source text, exactly as the guard it stands in for does, and it pins
 * the SHAPE of the exception rather than the behaviour: five identity columns in
 * the exporter's fact projection and no sixth, the same five bound by the
 * importer's INSERT, and `predicate_cardinality` gone from both. Behaviour — the
 * verbatim carry, the entity-tag null-out, the legacy keying — is pinned against
 * real Postgres in `migrate-roundtrip-pg.test.ts`, which is where a claim about
 * VALUES belongs. A lexical test that tried to assert behaviour would be
 * asserting its own reading of the SQL.
 *
 * The blind spots are the scan's, inherited: a statement assembled at runtime
 * from a variable is invisible, and `stripComments` blinds the rest of a line
 * after a `//` inside a string literal. Both are documented in
 * `check-brain-fact-promotion.sh` and neither is new here.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_BUNDLE_VERSION } from "@useatlas/types";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..", "..");

const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

/**
 * The five columns §8 puts on the wire, in SQL spelling.
 *
 * Hand-written and matched against BOTH sides below, which is the point: the
 * exporter's projection and the importer's INSERT are two independent lists in
 * two files, and the failure this file exists to catch is one of them growing or
 * shrinking alone. Deriving the list from either would make that failure
 * invisible by construction.
 */
const IDENTITY_COLUMNS = [
  "subject_key",
  "predicate_key",
  "object_key",
  "subject_cmp",
  "object_cmp",
] as const;

/** Strip comments so a column named only in prose is not read as code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("the v3 bundle carries exactly the identity ADR-0037 §8 grants (#5035)", () => {
  it("is version 3", () => {
    // The version is what the importer discriminates its two key arms on, so a
    // bump that did not reach the constant would silently route v3 bundles
    // through the legacy RE-DERIVE arm — the over-match direction §8 refuses.
    expect(EXPORT_BUNDLE_VERSION).toBe(3);
  });

  it("projects the five identity columns from the exporter's fact query, and no sixth", () => {
    const source = stripComments(read("packages/api/src/lib/residency/export.ts"));

    // The one statement that reads `brain_facts`. Located by its FROM clause
    // rather than by line number, and asserted to be unique — a second query
    // over the same table would be a second projection this file is not
    // looking at, which is precisely the hole the file-wide exemption opens.
    const factQueries = [
      ...source.matchAll(/SELECT\b([\s\S]*?)\bFROM brain_facts\b/gi),
    ].map((m) => m[1]!);
    expect(
      factQueries.length,
      "export.ts no longer contains exactly one `SELECT … FROM brain_facts` — the exemption in keys-not-on-the-wire.test.ts covers this whole file, so a second projection is unguarded. Point this pin at it or give it its own.",
    ).toBe(1);

    const projection = factQueries[0]!;
    for (const column of IDENTITY_COLUMNS) {
      expect(
        projection.includes(column),
        `the exporter's fact projection no longer selects \`${column}\`. A v3 bundle whose facts are missing a key imports with that key NULL, which joins nothing — the claim corroborates nothing, earns no tension edge, and can neither supersede nor be superseded.`,
      ).toBe(true);
    }

    // ⚠️ The negative arm, and it is the half the exemption actually costs.
    // `keys-not-on-the-wire.test.ts` would have caught a SIXTH key column added
    // to this projection; it no longer looks at this file at all.
    const named = [...projection.matchAll(/\bf\.([a-z_]+)\b/g)].map((m) => m[1]!);
    const unexpected = named.filter(
      (c) => /_key$|_cmp$/.test(c) && !(IDENTITY_COLUMNS as readonly string[]).includes(c),
    );
    expect(
      unexpected,
      "the exporter's fact projection names a key- or cmp-shaped column ADR-0037 §8 does not grant. §8's exception is the three slot keys and the two comparable values; anything else is an ordinary key-on-the-wire leak wearing the exemption's coat.",
    ).toEqual([]);

    // Gone from v3 — #5027 moved cardinality onto the canonical predicate and
    // the per-row values are LLM guesses. Pinned rather than left to the
    // round-trip, because "the exporter still selects it and the importer
    // ignores it" passes every behavioural assertion while leaving the field on
    // the wire for #5028 to trip over.
    expect(projection).not.toContain("predicate_cardinality");
  });

  it("binds the same five in the importer's INSERT, and drops predicate_cardinality", () => {
    const source = stripComments(read("packages/api/src/api/routes/admin-migrate.ts"));

    const inserts = [
      ...source.matchAll(/INSERT INTO brain_facts\s*\(([^)]*)\)/gi),
    ].map((m) => m[1]!);
    expect(
      inserts.length,
      "admin-migrate.ts no longer contains exactly one `INSERT INTO brain_facts` — a second fact writer in the region importer would be a second place the identity rule is decided.",
    ).toBe(1);

    const columns = inserts[0]!.split(",").map((c) => c.trim());
    for (const column of IDENTITY_COLUMNS) {
      expect(
        columns,
        `the importer's fact INSERT no longer writes \`${column}\`. An imported fact then lands unkeyed, and the publish-time disclosure reports "nothing to supersede" without being able to say the check could not run — fail-closed, and invisible.`,
      ).toContain(column);
    }
    expect(
      columns,
      "the importer still writes `predicate_cardinality`. v3 does not carry it, so the only value available is a legacy bundle's LLM guess, restored as though it were a curated decision.",
    ).not.toContain("predicate_cardinality");

    // The two lists agree. Written as a set comparison over the identity
    // columns specifically rather than over the whole column list, which
    // legitimately differs — the INSERT writes `workspace_id`, the projection
    // reads `source_episode_id`.
    const projected = new Set(
      IDENTITY_COLUMNS.filter((c) =>
        stripComments(read("packages/api/src/lib/residency/export.ts")).includes(`f.${c}`),
      ),
    );
    const written = new Set(IDENTITY_COLUMNS.filter((c) => columns.includes(c)));
    expect(
      [...written],
      "the exporter and the importer disagree about which identity columns travel. Whichever side is short silently drops that column to NULL on every migrated fact.",
    ).toEqual([...projected]);
  });

  it("the wire type declares all five, and marks the cardinality field deprecated", () => {
    const source = read("packages/types/src/migration.ts");
    const factType = /export interface ExportedBrainFact \{([\s\S]*?)\n\}/.exec(source);
    expect(factType, "ExportedBrainFact is no longer declared in migration.ts").not.toBeNull();

    const body = factType![1]!;
    for (const field of ["subjectKey", "predicateKey", "objectKey", "subjectCmp", "objectCmp"]) {
      expect(
        new RegExp(`^\\s*${field}\\?:`, "m").test(body),
        `ExportedBrainFact.${field} is missing, or is no longer optional. It must be OPTIONAL on the type and REQUIRED by validation from v3: a v1/v2 bundle carries none of these, and a required field would make every legacy bundle unrepresentable.`,
      ).toBe(true);
    }
    // Still declared so a consumer built against an older `@useatlas/types`
    // keeps compiling, and marked so nobody reads its presence as support.
    //
    // The doc comment is located as the LAST `/** … */` before the field rather
    // than by a distance window: a window is a length nobody maintains, and the
    // first cut of this assertion failed only because the rationale grew past
    // it — a green/red verdict decided by prose length is not a verdict.
    const declaration = /predicateCardinality\?:/.exec(body);
    expect(
      declaration,
      "predicateCardinality is gone from ExportedBrainFact, or is no longer optional. Removing it breaks a published type for consumers that still set it; making it required makes every v3 bundle unrepresentable.",
    ).not.toBeNull();
    const preceding = body.slice(0, declaration!.index);
    const lastDoc = preceding.lastIndexOf("/**");
    expect(
      lastDoc !== -1 && preceding.slice(lastDoc).includes("@deprecated"),
      "predicateCardinality is no longer marked @deprecated, so it reads as a supported field — while the exporter does not emit it and the importer ignores it.",
    ).toBe(true);
  });
});
