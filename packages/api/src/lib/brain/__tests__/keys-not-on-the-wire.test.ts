/**
 * A claim's identity keys are never projected to the wire (#5019, ADR-0037).
 *
 * ## Why this is a test and not a fact
 *
 * It is true today by ABSENCE: nothing selects `subject_key`, because the
 * columns are newer than every read surface and none has been touched since.
 * That is not a property — it is a coincidence with a short half-life, and
 * nothing about adding a column to a `SELECT` list makes an author stop and
 * think.
 *
 * `lib/brain/attribution.ts` is the precedent this follows. It could have left
 * "the caller selected the column" implicit and read a `null` as "never
 * widened"; instead it gives column-ABSENCE its own named, documented arm,
 * because the two states mean different things and one of them is a bug. Same
 * shape here: the keys' absence from every projection is the decision, so it
 * gets an arm rather than an assumption.
 *
 * ## Why it matters
 *
 * Retrieval and identity are decoupled on purpose — the FTS vector reads the
 * SURFACE so a vocabulary edit cannot silently re-rank `searchBrain`. Projecting
 * a key re-couples them through the consumer instead of through the index: an
 * agent, a UI, or a region bundle that can see `predicate_key` can branch on it,
 * and the moment anything downstream does, the vocabulary stops being an
 * internal join detail and becomes a compatibility surface — which is precisely
 * what makes an alias un-removable. The region bundle is the one deliberate
 * exception, and it is not this file's to grant: ADR-0037 §8 settles that keys
 * travel VERBATIM on a v3 bundle, and #5035 implements it. Until that lands, no
 * export projects a key, so the prohibition holds here too.
 *
 * ## What this can and cannot see
 *
 * It reads source text. A `SELECT` assembled at runtime from a variable is
 * invisible to it, exactly as `check-brain-fact-promotion.sh` says of its own
 * scan. `stripComments` also blinds the rest of a line after a `//` inside a
 * string literal (a URL), the same blind spot that guard documents. And unlike
 * that guard it does NOT scan `create-atlas/templates/*`, deliberately: those
 * files are generated from the sources scanned here and gated separately by
 * `scripts/check-template-drift.sh`, so a key could only reach them by first
 * reaching a file this scan already covers.
 *
 * What it does do is inline the module-level column-list constants
 * (`FACT_COLUMNS` and friends) before matching — which is where a new column
 * would actually be added, and the positive control below fails if that
 * inlining ever stops working.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..", "..");

/** SQL spellings. */
const KEY_COLUMNS = [
  "subject_key",
  "predicate_key",
  "object_key",
  "subject_cmp",
  "object_cmp",
] as const;

/** Drizzle spellings, for the ORM half. */
const ORM_KEY_COLUMNS = [
  "subjectKey",
  "predicateKey",
  "objectKey",
  "subjectCmp",
  "objectCmp",
] as const;

const KEY_RE = new RegExp(`\\b(${KEY_COLUMNS.join("|")})\\b`, "i");
const ORM_KEY_RE = new RegExp(`\\b(${ORM_KEY_COLUMNS.join("|")})\\b`);

/**
 * The one file that is allowed to name the columns: the Drizzle mirror, which
 * DECLARES them. Excluded by path rather than by shape — "a file that only
 * declares" is not something this scan can tell from "a file that projects",
 * and a shape-based exemption is one any read surface could adopt (the reason
 * `check-brain-fact-promotion.sh` names full paths too).
 */
const DECLARATION_SITES = new Set(["packages/api/src/lib/db/schema.ts"]);

/**
 * Every non-test source file that speaks about `brain_facts` in either
 * spelling — discovered, never enumerated, so a new read surface is covered the
 * day it is written rather than the day somebody remembers this file.
 */
function readSurfaceFiles(): string[] {
  // The same roots `check-brain-fact-promotion.sh` scans, and for the same
  // reason it does not use a bare `src/…` suffix. An earlier cut looked only at
  // `packages/api/src` and `ee`, which left the files that ARE the wire
  // contract outside the scan entirely — `packages/types/src/migration.ts`
  // (`ExportedBrainFact`, the region bundle), `packages/schemas/src/brain.ts`
  // (the REST response schemas), `packages/types/src/brain.ts`. Adding
  // `subjectKey` to any of those makes the decision this file says it is
  // holding, and the SQL-only scan could not see it.
  let out: string;
  try {
    out = execFileSync(
      "grep",
      [
        "-rlE",
        "brain_facts|\\bbrainFacts\\b",
        "packages",
        "apps",
        "ee",
        "examples",
        "plugins",
        "--include=*.ts",
        "--include=*.tsx",
        "--exclude=*.test.ts",
        "--exclude=*.test.tsx",
        "--exclude-dir=__tests__",
        "--exclude-dir=__mocks__",
        "--exclude-dir=__test-utils__",
        "--exclude-dir=node_modules",
        "--exclude-dir=dist",
      ],
      { cwd: REPO, encoding: "utf8" },
    );
  } catch {
    // grep exits 1 on no matches, which would throw at module scope and error
    // the file BEFORE the vacuity assertion below could produce its diagnostic.
    // Returning empty lets that assertion be the thing that fails, with the
    // message that explains why. (A genuine grep failure lands here too and is
    // reported the same way — as "the scan found nothing", which is exactly
    // what it means for this guard.)
    out = "";
  }
  return out.split("\n").filter(Boolean).filter((f) => !DECLARATION_SITES.has(f));
}

/** The same comment-stripping shape the promotion guard uses. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Inline module-level template constants into `${NAME}` references.
 *
 * Without this the scan has a hole exactly where a column would be added:
 * `search.ts` builds its projection as `SELECT ${FACT_COLUMNS}, … FROM`, so the
 * column names live in a constant that is not itself inside a `SELECT … FROM`
 * span. Bounded rather than recursive-to-fixpoint — three passes cover the one
 * level of nesting this repo has, and a runaway substitution would be a worse
 * failure than an incomplete one.
 */
function inlineTemplateConstants(source: string): string {
  const constants = new Map<string, string>();
  for (const [, name, body] of source.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*`([\s\S]*?)`/g,
  )) {
    constants.set(name!, body!);
  }
  let expanded = source;
  for (let pass = 0; pass < 3; pass++) {
    const next = expanded.replace(
      /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g,
      (whole, name: string) => constants.get(name) ?? whole,
    );
    if (next === expanded) break;
    expanded = next;
  }
  return expanded;
}

/**
 * Every `SELECT … FROM <table>` projection in one file, after inlining, paired
 * with the table it reads.
 *
 * The table is captured rather than assumed because the two arms below want
 * different scopes: a key column is forbidden in ANY projection (a join can
 * project `f.subject_key` while naming `brain_episodes` first), while a `*` is
 * only a problem when it stars `brain_facts`.
 */
function projections(source: string): { columns: string; from: string }[] {
  const prepared = inlineTemplateConstants(stripComments(source));
  return [
    // The FROM clause runs to the first clause keyword that ends it, so a JOIN
    // list is captured too. Taking only the FIRST table was a hole in the star
    // arm: `SELECT f.* FROM brain_episodes e JOIN brain_facts f ON …` projects
    // every key and would have been read as a star over `brain_episodes`.
    ...prepared.matchAll(
      /\bSELECT\b([\s\S]*?)\bFROM\b([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bUNION\b|\bRETURNING\b|\bSELECT\b|`|$)/gi,
    ),
  ].map((m) => ({ columns: m[1]!, from: m[2]! }));
}

/**
 * `*`, `f.*`, or `"f".*` in projection position.
 *
 * The trailing lookahead is what keeps `COUNT(*)` out — an aggregate's star is
 * immediately closed, a projection's is followed by a comma or `FROM`. Without
 * it this arm fires on the draft-count statement in the publish adapter, and a
 * guard that cries wolf on the existing tree gets deleted rather than fixed.
 */
const STAR_PROJECTION = /(^|[\s,(])(?:"?[\w$]+"?\.)?\*(?!\s*\))/;
const READS_BRAIN_FACTS = /(?:^|[\s,(])(?:"?[\w$]+"?\.)?"?brain_facts"?\b/i;

const FILES = readSurfaceFiles();

describe("the identity keys are never projected to the wire (#5019)", () => {
  it("finds the read surfaces at all", () => {
    // Everything below is vacuous if the discovery grep breaks — a moved
    // directory or a changed `--include` would otherwise turn this whole file
    // into a green no-op.
    expect(
      FILES.length,
      "no source file mentioning brain_facts was found — the discovery grep is broken, and every assertion below passes vacuously",
    ).toBeGreaterThan(5);
    for (const known of [
      "packages/api/src/lib/brain/search.ts",
      "packages/api/src/lib/brain/candidates.ts",
      "packages/api/src/lib/residency/export.ts",
      "packages/api/src/lib/content-mode/adapters/brain-facts.ts",
    ]) {
      expect(FILES, `${known} is no longer discovered by the scan`).toContain(known);
    }
  });

  it("still sees inside the column-list constants", () => {
    // THE positive control. `pre_widening_visible_to` reaches a projection in
    // `search.ts` only through `${FACT_COLUMNS}`, so this assertion fails the
    // moment the inlining stops working — which is the failure mode that would
    // otherwise leave the key assertions passing over spans that contain no
    // column names at all.
    const source = readFileSync(join(REPO, "packages/api/src/lib/brain/search.ts"), "utf8");
    const spans = projections(source);
    expect(spans.length, "no SELECT … FROM span found in search.ts").toBeGreaterThan(0);
    expect(
      spans.some((s) => s.columns.includes("pre_widening_visible_to")),
      "no projection in search.ts names `pre_widening_visible_to` — it is only reachable through the ${FACT_COLUMNS} inlining, so the scan below is looking at empty spans",
    ).toBe(true);
  });

  it("would catch a key column, or a star, if one were projected", () => {
    // And the matchers themselves, proven on synthetic spans before they are
    // trusted on real ones. The star arm needs this most: its first cut carried
    // a fixed-width window between `*` and `FROM`, and the real region-export
    // projection is wider than the window — so it read green over a planted
    // `SELECT f.*`.
    const planted = `const Q = \`SELECT f.id, f.subject, f.subject_key FROM brain_facts f\`;`;
    expect(projections(planted).some((s) => KEY_RE.test(s.columns))).toBe(true);

    const plantedViaConstant = [
      "const COLS = `f.id, f.predicate_key`;",
      "const Q = `SELECT ${COLS} FROM brain_facts f`;",
    ].join("\n");
    expect(projections(plantedViaConstant).some((s) => KEY_RE.test(s.columns))).toBe(true);

    // EVERY column in the list, not one representative. The `_cmp` arms in
    // particular cannot be exercised by the real tree — those columns ship in
    // #5032 — so without this loop `subject_cmp` and `object_cmp` could be
    // deleted from KEY_COLUMNS and every assertion in this file stays green.
    for (const column of KEY_COLUMNS) {
      const one = `const Q = \`SELECT f.id, f.${column} FROM brain_facts f\`;`;
      expect(
        projections(one).some((s) => KEY_RE.test(s.columns)),
        `the matcher does not detect a projected \`${column}\` — that arm is decoration`,
      ).toBe(true);
    }
    for (const column of ORM_KEY_COLUMNS) {
      expect(
        ORM_KEY_RE.test(`db.select({ k: brainFacts.${column} })`),
        `the ORM matcher does not detect \`${column}\``,
      ).toBe(true);
    }

    // A star behind a long column list — the shape that defeated the first cut.
    const plantedStar = `const Q = \`SELECT f.*, ${"f.col, ".repeat(60)}f.id FROM brain_facts f\`;`;
    expect(
      projections(plantedStar).some(
        (s) => READS_BRAIN_FACTS.test(s.from) && STAR_PROJECTION.test(s.columns),
      ),
    ).toBe(true);

    // …a star over brain_facts reached through a JOIN, where the FIRST table is
    // something else. This is the shape the first cut could not see.
    const plantedJoinStar =
      "const Q = `SELECT f.* FROM brain_episodes e JOIN brain_facts f ON f.source_episode_id = e.id WHERE e.id = $1`;";
    expect(
      projections(plantedJoinStar).some(
        (s) => READS_BRAIN_FACTS.test(s.from) && STAR_PROJECTION.test(s.columns),
      ),
    ).toBe(true);

    // …and a star over a DIFFERENT table is not this file's business.
    const plantedOtherStar = "const Q = `SELECT * FROM brain_episodes e`;";
    expect(
      projections(plantedOtherStar).some(
        (s) => READS_BRAIN_FACTS.test(s.from) && STAR_PROJECTION.test(s.columns),
      ),
    ).toBe(false);

    // …and an aggregate's star is not a projection. The publish adapter's
    // draft count is exactly this shape, and it tripped the first cut.
    const aggregate = "const Q = `SELECT COUNT(*)::int AS n FROM brain_facts`;";
    expect(
      projections(aggregate).some(
        (s) => READS_BRAIN_FACTS.test(s.from) && STAR_PROJECTION.test(s.columns),
      ),
    ).toBe(false);
  });

  it("projects no identity key from any read surface", () => {
    for (const file of FILES) {
      const source = readFileSync(join(REPO, file), "utf8");
      for (const span of projections(source)) {
        const hit = KEY_RE.exec(span.columns);
        expect(
          hit?.[1],
          `${file} projects \`${hit?.[1]}\`. Identity is a join detail: retrieval reads the SURFACE so a vocabulary edit cannot re-rank it, and a key on the wire re-couples the two through the consumer instead. Anything downstream that can branch on a key makes an alias un-removable. If this is a region bundle, whether keys travel is #5035's decision to make, not this projection's to assume.`,
        ).toBeUndefined();
      }
    }
  });

  it("projects no `SELECT *` over brain_facts", () => {
    // A star projects the keys without ever naming them, so the assertion above
    // cannot see it. No production read uses one today; this is what keeps that
    // true.
    for (const file of FILES) {
      for (const span of projections(readFileSync(join(REPO, file), "utf8"))) {
        if (!READS_BRAIN_FACTS.test(span.from)) continue;
        expect(
          STAR_PROJECTION.test(span.columns) ? span.columns.trim() : undefined,
          `${file} selects every column of brain_facts with a star, which projects the identity keys without ever naming them — so the assertion above cannot see it. Name the columns.`,
        ).toBeUndefined();
      }
    }
  });

  it("names no identity key in the Drizzle spelling either", () => {
    // The ORM half is a total prohibition rather than a projection scan: brain
    // reads are raw SQL, so there is no legitimate `brainFacts.subjectKey` in a
    // read surface today, and a `.select({…})` projection would not sit inside
    // a `SELECT … FROM` span for the arm above to find.
    //
    // It therefore ALSO fires on a fact-shaped TYPE that grows a key field —
    // `lib/brain/types.ts`'s `BrainFact`, `packages/types`' wire types, the
    // response schemas. That is deliberate and not a false positive: a key on a
    // consumer-facing row shape is the leak, whatever produced it. The only
    // file exempt is the Drizzle mirror, which declares the columns and is
    // named in DECLARATION_SITES.
    for (const file of FILES) {
      const source = stripComments(readFileSync(join(REPO, file), "utf8"));
      const hit = ORM_KEY_RE.exec(source);
      expect(
        hit?.[1],
        `${file} names \`${hit?.[1]}\`. Brain reads are raw SQL, so an ORM projection — or a fact-shaped TYPE that grows a key field — would slip past the SELECT-span scan above. A key belongs on the row in the database and nowhere a consumer can branch on it; the only exemption is the Drizzle mirror in DECLARATION_SITES.`,
      ).toBeUndefined();
    }
  });
});
