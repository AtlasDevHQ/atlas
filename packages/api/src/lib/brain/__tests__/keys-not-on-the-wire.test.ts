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
 * agent or a UI that can see `predicate_key` can branch on it, and the moment
 * anything downstream does, the vocabulary stops being an internal join detail
 * and becomes a compatibility surface — which is precisely what makes an alias
 * un-removable.
 *
 * The ROW-COPY paths are the deliberate exception, granted by ADR-0037 §8 —
 * *a row-copy path carries keys verbatim; a claim-supply path never supplies
 * them.* There are two: the region bundle, implemented on the v3 bundle by
 * #5035, and the correction path's target read (#5037), which inherits the
 * corrected fact's slot rather than re-deriving it. Their files are listed in
 * {@link ROW_COPY_SITES}, which records both why they are not the leak this
 * guard exists to stop and what exempting each one costs.
 *
 * ## What this can and cannot see
 *
 * It reads source text. A `SELECT` assembled at runtime from a variable is
 * invisible to it, exactly as `check-brain-fact-promotion.sh` says of its own
 * scan. `stripComments` also blinds the rest of a line after a `//` inside a
 * string literal (a URL), the same blind spot that guard documents. And unlike
 * that guard it does NOT scan `create-atlas/templates/*` or
 * `create-atlas-plugin`, deliberately: the template sources are GENERATED from
 * the files scanned here and gated separately by
 * `scripts/check-template-drift.sh`, so a key could only reach them by first
 * reaching a file this scan already covers, and the plugin scaffold holds no
 * brain read surface.
 *
 * One shape it genuinely cannot see, measured rather than assumed:
 * `row_to_json(f)` / `to_jsonb(f)` project the whole row without a star token
 * and are not lexically detectable. `RETURNING …, subject_key` IS covered —
 * the projection scan reads RETURNING lists too.
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
const DECLARATION_SITES = new Set([
  "packages/api/src/lib/db/schema.ts",
  // The cardinality store (#5027). Its table's PRIMARY KEY is `predicate_key`,
  // so the module cannot address a row without naming it — the same position
  // `schema.ts` is in, one table over. What the arm is actually guarding is a
  // fact-shaped TYPE growing a key field, and that is closed structurally
  // rather than by this exemption: neither `PredicateCardinalityRecord` nor
  // `CardinalityWriteResult` carries the key (the caller supplied it), and both
  // say so in their own docstrings. #5025's review UI must render the SURFACE.
  //
  // ⚠️ **What this exemption COSTS, stated because the first version of this
  // comment got it wrong.** It claimed "every remaining hit is a parameter name
  // or a WHERE-clause bind". It is not: `CORRECTION_REPEAT_COUNT_SQL` has
  // `COUNT(DISTINCT n.subject_key)` in PROJECTION position, so exempting the
  // file switches off the SELECT/RETURNING arm as well as the ORM one — for the
  // single module keyed on `predicate_key`. An aggregate over a key is not a
  // projection OF a key (the same distinction `STAR_PROJECTION`'s lookahead
  // draws for `COUNT(*)`), so nothing is wrong today; what is switched off is
  // the guard against a FUTURE `RETURNING predicate_key` there.
  //
  // The compensating pin is `cardinality.test.ts`'s "does not project the
  // predicate key", which reads the projection SPAN of the statement rather
  // than its first column. That is the file-local replacement for what this
  // line turns off, and it is why the exemption is affordable.
  "packages/api/src/lib/brain/cardinality.ts",
  // The alias-proposal query (#5034). It reads `predicate_key` off two
  // `brain_facts` rows and SELECTS the pair — genuinely a projection, not an
  // aggregate, so this exemption switches the SELECT arm off for the file
  // rather than only the ORM one.
  //
  // ⚠️ Why that is not the leak this guard exists to stop. What the prohibition
  // protects is a key BESIDE ITS CLAIM: `predicate_key` next to `predicate` on a
  // fact read surface lets a consumer branch on a claim's identity, and the
  // moment anything downstream does, the vocabulary stops being an internal join
  // detail and an alias becomes un-removable. This query returns no claim at all
  // — no fact id, no surface, no row. It returns two NORMS and a count, and a
  // norm is what the vocabulary is MADE of: `brain_vocabulary_edge` has stored
  // `from_norm`/`to_norm` since 0189 and `approveAliasEdge` takes norms, because
  // a reviewer approving a merge has to be shown which two spellings merge.
  // Norms on the vocabulary surface are settled design (ADR-0037 §6), not
  // something this slice introduces.
  //
  // What it also does not do is re-couple retrieval to identity: nothing here
  // reads or writes `fts`, and the query's output reaches exactly one
  // destination — `brain_vocabulary_proposal`, through `proposeAliasEdges`.
  //
  // The compensating pin is `alias-proposal.test.ts`'s "projects no key but the
  // two predicate norms", which reads the OUTER projection span of
  // `ALIAS_PROPOSAL_SQL` and the shape of `AliasCandidate`. That is the
  // file-local replacement for what this line turns off — `subject_key` and
  // `object_cmp` DO appear inside the statement (a join arm and a
  // `COUNT(DISTINCT …)` input), and the pin is what keeps them from graduating
  // into the result.
  "packages/api/src/lib/brain/alias-proposal.ts",
  // A MUTATION SPEC — a test fixture that happens to live outside `__tests__`,
  // so the scan's non-test filter does not reach it. Its `predicate_key`
  // occurrences are the before/after strings of the "`INSERT_FACT_SQL` feeds
  // `predicate_cardinality` again" mutation, i.e. quoted copies of production
  // SQL that `scripts/mutate.ts` applies and then reverts. It is not a read
  // surface, it ships in no bundle, and it is reached by this scan only because
  // the file it mutates says `brain_facts`.
  "packages/api/scripts/mutations/cardinality.mutations.ts",
  // The same shape, one spec over (#5034). Its `subject_key` occurrences are the
  // before/after strings of two rows — *the repeat gate counts EVIDENCE ROWS*
  // and *a subject key graduates into the projection* — and the second of those
  // is a deliberate quoted copy of a KEY PROJECTION, because measuring what this
  // slice's exemption is worth requires writing the violation down. `mutate.ts`
  // applies it and reverts it; it is not a read surface and it ships in no
  // bundle.
  "packages/api/scripts/mutations/alias-proposal.mutations.ts",
  // The same shape a third time (#5035). Its occurrences are the before/after
  // strings of the bundle-identity mutations — including two DELIBERATE quoted
  // copies of a key projection (`SELECT a.object_key FROM brain_fact_alias a`,
  // and a joined `e.audience_cmp` inside the granted statement), because
  // measuring what §8's whole-file exemption is worth requires writing the
  // violation down. `mutate.ts` applies each one and reverts it; the file is not
  // a read surface and ships in no bundle.
  "packages/api/scripts/mutations/bundle-identity.mutations.ts",
]);

/**
 * The ROW-COPY paths — the deliberate exceptions, the first of which this file's
 * header said was *"not this file's to grant"* until #5035 implemented it.
 *
 * ADR-0037 §8: **a row-copy path carries keys verbatim; a claim-supply path
 * never supplies them.** TWO paths qualify, and they are listed separately from
 * {@link DECLARATION_SITES} because the rationale is different in kind: those
 * files are exempt for naming a column they cannot avoid naming; these are exempt
 * for genuinely moving keys around, on purpose.
 *
 *   - **The region bundle** (#5035) — three files: the exporter's projection, the
 *     wire type, and the importer's INSERT.
 *   - **The correction path** (#5037) — one file: the target read, whose keys
 *     never leave the transaction they were read in.
 *
 * ⚠️ They are not the same risk, and the difference is worth keeping in view. The
 * bundle genuinely puts keys ON A WIRE, so its exemption is justified by who the
 * single consumer is. The correction path puts them on no wire at all — the
 * exemption is needed only because the guard cannot tell a key that is read and
 * written back one statement later from one that escapes. Each entry states its
 * own cost below rather than inheriting this paragraph's.
 *
 * ⚠️ **Why this is not the leak the prohibition exists to stop.** What re-couples
 * retrieval to identity is a key reaching a CONSUMER that can branch on it: an
 * agent, a UI, or a REST response that sees `predicate_key` beside `predicate`
 * makes the vocabulary a compatibility surface, and an alias stops being
 * removable. A region bundle has exactly one consumer — `importBundle`, which
 * writes the value straight back into the column it came from — and it is not a
 * read surface: no reader can request one, and nothing renders it. The
 * alternative is strictly worse and was measured rather than assumed
 * (`admin-migrate.ts`'s pre-#5035 comment records it): an imported fact landing
 * UNKEYED corroborates nothing, earns no tension edge, and can neither supersede
 * nor be superseded, while the publish-time disclosure reports "nothing to
 * supersede" without being able to say the check could not run.
 *
 * ⚠️ **What the BUNDLE exemption COSTS, stated rather than implied.** It switches
 * off BOTH arms for its three files, so a future `SELECT … f.object_key` added to
 * `export.ts` for an unrelated read, or a key field added to a NON-brain wire
 * type in `migration.ts`, is no longer caught here. The compensating pin is
 * `bundle-identity-v3.test.ts`, which reads the projection span of the fact
 * query and the bind list of the fact INSERT and asserts they carry exactly
 * these five columns — file-local, and narrower than what this line turns off,
 * which is the same trade `cardinality.ts` records above.
 *
 * Every file is named individually rather than by directory. A path-prefix
 * exemption would cover every future file under `lib/residency` or `lib/brain`,
 * and the next one will not be a row-copy path.
 */
const ROW_COPY_SITES = new Set([
  // The projection. Five columns, in the one SELECT that reads `brain_facts`
  // for a bundle.
  "packages/api/src/lib/residency/export.ts",
  // The wire type — `ExportedBrainFact`. Caught by the ORM arm rather than the
  // SELECT arm, which is the arm that exists precisely because a fact-shaped
  // TYPE growing a key field IS the leak.
  "packages/types/src/migration.ts",
  // The correction path's target read (#5037) — the SECOND row-copy path, and
  // the one ADR-0037 §8 names in the same breath as the region bundle: *a
  // row-copy path carries keys verbatim; a claim-supply path never supplies
  // them.* `correctionTargetSql` projects all three keys off the fact being
  // corrected, so the replacement can INHERIT the target's slot instead of
  // re-deriving it from the target's surfaces.
  //
  // ⚠️ Why this is not the leak the prohibition exists to stop. The keys have one
  // destination — back into the slot columns of the replacement row, through
  // `InheritedSlot` — and no route to a consumer that could branch on them.
  // `BrainFactCorrectionResponse` carries no claim text at all, let alone a key;
  // the module's `supersededPredicate` comment already refuses to widen it for
  // exactly that reason, and that refusal is now pinned rather than trusted.
  //
  // ⚠️ What the exemption COSTS. Both arms, whole-file — so a future `SELECT …
  // f.object_key` added to `REPLACEMENT_ROW_SQL` for an unrelated read is no
  // longer caught here. That is a live risk in this file specifically: it holds
  // four statements over `brain_facts` where the bundle's exporter holds one.
  //
  // The compensating pin is `correction.test.ts`'s "#5037" block, which is
  // per-STATEMENT where this exemption is per-file: it scans every statement the
  // module executes for a key in a projection, in a `SET` clause or `INSERT`
  // column list, and in a `*`, over all five gated columns; it proves each
  // matcher on planted SQL first; and it refuses a module-private statement the
  // scan could not see. The target read is bounded from ABOVE rather than
  // skipped — it may carry the three keys it inherits and no other identity
  // column — so "all five" holds for every statement including that one. That is a narrower guarantee than the global arms, which
  // is the same trade `cardinality.ts` records above.
  //
  // ⚠️ ONE HALF IS NOT REPLACED, stated rather than implied: the ORM/type arm,
  // which exists precisely because *a fact-shaped TYPE growing a key field* is
  // the leak. `TargetRow` grows exactly such a field here (`objectKey`), and the
  // pin reads SQL strings only, so nothing in this repo would object if a second
  // one appeared. It is benign today — `TargetRow` is module-private, never
  // serialized, and `BrainFactCorrectionResponse` carries no claim text — and
  // the wire itself is still covered, because `packages/types/src/brain.ts` and
  // `packages/schemas/src/brain.ts` hold the response types and neither is
  // exempt. The residual risk is a key reaching a NEW correction wire type
  // declared in this file, and that is what a reviewer here is holding.
  //
  // The re-derivation this replaces was not caught by anything, which is the
  // asymmetry worth stating: the guard can see a key being READ, and could never
  // have seen the `slotKey(target.subject, …)` that stood in for reading one.
  "packages/api/src/lib/brain/correction.ts",
  // The INSERT, and the null-at-import rule. This file is already allowlisted
  // in `check-brain-fact-promotion.sh` for writing `status` verbatim, on the
  // same row-copy rationale — so this extends an existing carve-out rather than
  // inventing a second one.
  "packages/api/src/api/routes/admin-migrate.ts",
]);

/**
 * Every non-test source file that speaks about `brain_facts` in either
 * spelling — discovered, never enumerated, so a new read surface is covered the
 * day it is written rather than the day somebody remembers this file.
 */
function readSurfaceFiles(): string[] {
  // The roots `check-brain-fact-promotion.sh` scans, minus `create-atlas` and
  // `create-atlas-plugin` (the header says why), and for the same reason it
  // does not use a bare `src/…` suffix. An earlier cut looked only at
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
        // `BrainFact` as well as the table name: the fact-shaped WIRE types
        // never say `brain_facts` at all. `packages/schemas/src/brain.ts`
        // (`BrainFactCandidateSchema`, the REST response schema) matched
        // nothing under the table-name-only pattern, and it is the file where
        // adding a field is literally the act that puts a key on the wire —
        // `z.object` STRIPS unknown keys, so the schema edit is the leak.
        // `packages/types/src/brain.ts` matched only through comment prose, so
        // rewording a comment would have dropped it out of the scan silently.
        "brain_facts|\\bbrainFacts\\b|\\bBrainFact",
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
  } catch (err: unknown) {
    // grep exits 1 for "no matches", which would throw at module scope and
    // error this file BEFORE the vacuity assertion below could produce its
    // diagnostic — so that ONE status is absorbed and the assertion gets to
    // fail with the message that explains it.
    //
    // Every other status is re-thrown with context. Collapsing them would map
    // exit 2 (unreadable path, partial stdout discarded), ENOENT (no grep in
    // the image), and a maxBuffer overflow onto the same "found nothing"
    // outcome — four different broken scans wearing one benign face, which is
    // the fail-open shape the guard script itself refuses.
    const status = (err as { status?: unknown }).status;
    if (status !== 1) {
      throw new Error(
        `the brain_facts discovery grep failed (status=${String(status)}, cwd=${REPO}): ` +
          (err instanceof Error ? err.message : String(err)) +
          " — every assertion in this file would otherwise pass vacuously.",
        { cause: err },
      );
    }
    out = "";
  }
  return out.split("\n").filter(Boolean);
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

  // A `RETURNING` list is a projection with a different keyword, and it is the
  // one #5020 will touch: `INSERT_FACT_SQL` already ends `RETURNING id`, and
  // `RETURNING id, subject_key` is the natural next line. Attributed to the
  // statement's own table so the brain_facts-only arms still scope correctly.
  const returning = [
    ...prepared.matchAll(
      /\b(?:INSERT\s+INTO|UPDATE)\s+((?:"?[\w$]+"?\.)?"?[\w$]+"?)[\s\S]*?\bRETURNING\b([^`;]*)/gi,
    ),
  ].map((m) => ({ columns: m[2]!, from: m[1]! }));

  // The FROM clause runs to the first clause keyword that ends it, so a JOIN
  // list is captured too. Taking only the FIRST table was a hole in the star
  // arm: `SELECT f.* FROM brain_episodes e JOIN brain_facts f ON …` projects
  // every key and would have been read as a star over `brain_episodes`.
  const selects = [
    ...prepared.matchAll(
      /\bSELECT\b([\s\S]*?)\bFROM\b([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bUNION\b|\bRETURNING\b|\bSELECT\b|`|$)/gi,
    ),
  ].map((m) => ({ columns: m[1]!, from: m[2]! }));

  return [...returning, ...selects];
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

/** Does this source project an identity key anywhere? */
const projectsKey = (source: string): boolean =>
  projections(source).some((p) => KEY_RE.test(p.columns));

/** Does this source star-project `brain_facts`? */
const starsBrainFacts = (source: string): boolean =>
  projections(source).some(
    (p) => READS_BRAIN_FACTS.test(p.from) && STAR_PROJECTION.test(p.columns),
  );

/** Everything the discovery grep found, exemptions included. */
const DISCOVERED = readSurfaceFiles();

/** The files the two arms below actually scan. */
const FILES = DISCOVERED.filter((f) => !DECLARATION_SITES.has(f) && !ROW_COPY_SITES.has(f));

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
      "packages/api/src/lib/content-mode/adapters/brain-facts.ts",
      // The WIRE contracts specifically. An earlier cut pinned only
      // `packages/api` files, so the scan could stop reaching the types a key
      // would actually leak through and nothing would fail.
      "packages/types/src/brain.ts",
      "packages/schemas/src/brain.ts",
    ]) {
      expect(FILES, `${known} is no longer discovered by the scan`).toContain(known);
    }
  });

  it("still reaches every exempted file, so an exemption cannot go stale", () => {
    // An exemption is a path STRING, and a path string survives the file being
    // renamed or moved. It would then exempt nothing — harmless — but it would
    // also mean the compensating pin named in its rationale is guarding a file
    // the scan has stopped covering, and nothing would say so. Asserted against
    // the UNFILTERED discovery so the sets are checked against the tree rather
    // than against each other.
    for (const exempt of [...DECLARATION_SITES, ...ROW_COPY_SITES]) {
      expect(
        DISCOVERED,
        `${exempt} is exempted here but the discovery grep no longer finds it — either it moved (update the entry) or it stopped mentioning brain_facts (delete the entry). A stale exemption reads as a decision nobody is holding.`,
      ).toContain(exempt);
    }
    // …and the two sets are disjoint. A file in both would be exempt for two
    // different recorded reasons, and deleting either would look safe.
    for (const site of ROW_COPY_SITES) {
      expect(
        DECLARATION_SITES.has(site),
        `${site} is in BOTH exemption sets — one rationale, one entry.`,
      ).toBe(false);
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
    // The matchers, proven on synthetic sources before they are trusted on real
    // ones. The star arm needs this most: its first cut carried a fixed-width
    // window between `*` and `FROM`, and the real region-export projection is
    // wider than the window — so it read green over a planted `SELECT f.*`.

    // EVERY column, not one representative. `subject_cmp` in particular cannot
    // be exercised by the real tree — that column ships in #5032 — so without
    // this loop it could be deleted from KEY_COLUMNS and every assertion in
    // this file would stay green. (`object_cmp` landed in #5030 and IS on the
    // real tree now; it stays in the loop because the argument is about the
    // matcher, not about which columns happen to exist this week.)
    for (const column of KEY_COLUMNS) {
      expect(
        projectsKey(`const Q = \`SELECT f.id, f.${column} FROM brain_facts f\`;`),
        `the matcher does not detect a projected \`${column}\` — that arm is decoration`,
      ).toBe(true);
    }
    for (const column of ORM_KEY_COLUMNS) {
      expect(
        ORM_KEY_RE.test(`db.select({ k: brainFacts.${column} })`),
        `the ORM matcher does not detect \`${column}\``,
      ).toBe(true);
    }

    // …through a column-list constant, which is where a column would really be
    // added (`search.ts` builds its projection that way).
    expect(
      projectsKey(
        ["const COLS = `f.id, f.predicate_key`;", "const Q = `SELECT ${COLS} FROM brain_facts f`;"].join(
          "\n",
        ),
      ),
    ).toBe(true);

    // …and through RETURNING rather than SELECT — the clause #5020 will touch,
    // since `INSERT_FACT_SQL` already ends `RETURNING id`.
    expect(
      projectsKey(
        "const Q = `INSERT INTO brain_facts (workspace_id, subject) VALUES ($1,$2) RETURNING id, subject_key`;",
      ),
      "a key projected through RETURNING is invisible",
    ).toBe(true);

    // A star behind a long column list — the shape that defeated the first cut.
    expect(
      starsBrainFacts(`const Q = \`SELECT f.*, ${"f.col, ".repeat(60)}f.id FROM brain_facts f\`;`),
    ).toBe(true);

    // …a star over brain_facts reached through a JOIN, where the FIRST table is
    // something else. This is the shape the FROM-clause capture exists for.
    expect(
      starsBrainFacts(
        "const Q = `SELECT f.* FROM brain_episodes e JOIN brain_facts f ON f.source_episode_id = e.id WHERE e.id = $1`;",
      ),
    ).toBe(true);

    // …a star over a DIFFERENT table is not this file's business.
    expect(starsBrainFacts("const Q = `SELECT * FROM brain_episodes e`;")).toBe(false);

    // …and an aggregate's star is not a projection. The publish adapter's draft
    // count is exactly this shape, and it tripped the first cut.
    expect(starsBrainFacts("const Q = `SELECT COUNT(*)::int AS n FROM brain_facts`;")).toBe(false);
  });

  it("projects no identity key from any read surface", () => {
    for (const file of FILES) {
      const source = readFileSync(join(REPO, file), "utf8");
      for (const span of projections(source)) {
        const hit = KEY_RE.exec(span.columns);
        expect(
          hit?.[1],
          `${file} projects \`${hit?.[1]}\`. Identity is a join detail: retrieval reads the SURFACE so a vocabulary edit cannot re-rank it, and a key on the wire re-couples the two through the consumer instead. Anything downstream that can branch on a key makes an alias un-removable. ADR-0037 §8's row-copy exception covers the region bundle and nothing else — its three files are in ROW_COPY_SITES above, and adding a fourth needs the same recorded rationale and a file-local pin to replace what the exemption switches off.`,
        ).toBeUndefined();
      }
    }
  });

  it("gates exactly the columns the promotion guard declares", () => {
    // KEY_COLUMNS is a hand-written list, and the same family is spelled out
    // independently in `check-brain-fact-promotion.sh`, `schema.ts`, and
    // `docs/development/content-mode.md`. The carve-out register already pins
    // doc ⊇ declared and declared ⊆ enforced; nothing linked THIS list to any
    // of them, so a rename in #5032 would leave it gating a column that no
    // longer exists — silently, because the positive control above plants the
    // same literal it scans for and would stay green.
    const guard = readFileSync(join(REPO, "scripts", "check-brain-fact-promotion.sh"), "utf8");
    const decl = /^UPDATE_GATED_COLUMNS='\(([^']+)\)'/m.exec(guard);
    expect(
      decl,
      "check-brain-fact-promotion.sh no longer declares UPDATE_GATED_COLUMNS='(…)' — re-point this parse",
    ).not.toBeNull();
    const declared = new Set(decl![1]!.split("|"));
    for (const column of KEY_COLUMNS) {
      expect(
        declared.has(column),
        `\`${column}\` is gated here but not declared in check-brain-fact-promotion.sh's UPDATE_GATED_COLUMNS. Either it was renamed and this list is now dead, or the guard lost an arm — the two lists describe one column family and must not drift.`,
      ).toBe(true);
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
        `${file} names \`${hit?.[1]}\`. Brain reads are raw SQL, so an ORM projection — or a fact-shaped TYPE that grows a key field — would slip past the SELECT-span scan above. A key belongs on the row in the database and nowhere a consumer can branch on it. If this is an UNRELATED field that happens to share a name (\`objectKey\` is also blob-storage vocabulary), rename it or add the file to DECLARATION_SITES with a rationale — the arm is deliberately over-broad because a missed key is the unrecoverable direction.`,
      ).toBeUndefined();
    }
  });
});
