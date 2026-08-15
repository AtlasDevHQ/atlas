/**
 * The SQL-gate bypass set (#5042, re-pointed at #5230's spelling).
 *
 * ## WHY THIS FILE EXISTS
 *
 * `warehouse-producer.ts` brands the SQL gate's PASSING verdict so that no object
 * literal can assert *"the product's SELECT-only / single-statement /
 * whitelist-scoped check said yes"*. That closes the hole a plain
 * `{ valid: boolean }` left — but the brand's own docstring then makes a claim the
 * TYPE cannot keep: that grepping for the cast is the whole list of places the gate
 * is bypassed. A cast is greppable; nothing fails when a fifth one appears.
 *
 * ## FIVE names, because #5230 moved the brand onto the REQUEST
 *
 * The passing verdict now carries the request it validated, and that request is
 * what is branded — which is how replay (a cached token for some other statement)
 * and ordering (a runner reachable with an unvalidated request) got closed. A bypass
 * can therefore be spelled five ways, and {@link BYPASS_RE} matches all of them: an
 * assertion naming the branded REQUEST type (what a mint ordinarily writes), the
 * VERDICT union, the VALIDATOR seam type, the DEPS interface that holds it, or the
 * RUNNER type whose parameter is the branded request.
 *
 * ⚠️ **The last four are here because the docstrings claimed they were refused, and
 * that was measured false — twice, with two different wrong explanations.** The
 * mechanism, measured against the repo's own checker: the brand only ADDS a
 * property, so the branded request is assignable to the bare one, and `as` succeeds
 * whenever EITHER direction is comparable — the reverse direction carries all of
 * them. What IS refused is the shape where the reverse direction also fails: a
 * NULLARY mint (a 1-parameter function type is not assignable to a 0-parameter one)
 * or a literal with an excess property. Pinning `valid` with `as const` does not
 * close it; that was the second wrong explanation, and it was the one this file
 * shipped in round 1. Such a validator returns its own argument, so the run loop's
 * identity check waves it through: the gate never ran and nothing downstream can
 * tell. Matching only the first two would have left this guard green over the one
 * bypass the brand does not close.
 *
 * ⚠️ **The pattern is not written out in this file's prose, and that is the point
 * rather than fastidiousness.** A lexical guard cannot tell a quotation from an
 * assertion, so a docstring spelling the forbidden cast puts the guard's own file
 * in its own result set — which it did, on the first run. The repo's answer is
 * reword, never exempt: an exemption is a hole shaped exactly like the thing being
 * guarded, and the next real instance gets written inside it. The exact spelling
 * lives in {@link BYPASS_RE} below, where a reader can still see it and the scan
 * cannot trip over it.
 *
 * This is the repo's standing ratchet applied on a shorter cycle than usual: the
 * same principle was swept for twice inside one PR — once when the gate moved out
 * of `defaultRunSnapshot`, and again when the seam that replaced it turned out to
 * be as skippable as the thing it replaced — and prose does not scale to new
 * surface, which is exactly where it kept failing. So the enumeration is asserted
 * as what it is.
 *
 * ## What a new entry means
 *
 * Not automatically a bug. A suite that must bypass the real gate has a legitimate
 * reason — the gate's table check is workspace-whitelist-scoped, and a test schema
 * has no whitelist — which is why three of the four sites are test harnesses. What
 * it must not be is INVISIBLE: a production module minting a passing verdict is a
 * second door onto an unvalidated statement reaching a customer's datasource, and
 * that is the event that has to be argued rather than merged.
 *
 * ## What this does NOT prove
 *
 * The brand is not the only bypass, and saying so here is the honest half. Measured
 * against the repo's own checker: an object literal, `as const`, `satisfies`, a
 * spread of the refusing arm, `unknown`, and the identity form of generic-inference
 * laundering are all REFUSED by the COMPILER.
 *
 * ⚠️ **What this scan holds is a different question, and conflating the two is how
 * this header has now been wrong twice.** What it holds is exactly: *an assertion
 * that puts the keyword and one of the five names on ONE PHYSICAL LINE.* So it DOES
 * catch a double assertion through `unknown` written on one line — an earlier draft
 * listed that as escaping, which was measurably false and is corrected here. What
 * genuinely escapes: an angle-bracket assertion; a local type alias; an import that
 * renames one of these types OUT to another local name; an indexed lookup of the
 * runner's parameter; a line break between keyword and name (the character class
 * below bars a newline); and `any`-typed wiring or a `Partial<T>`-shaped generic
 * builder, which need no assertion at all. Chasing those is a regex arms race the
 * honest sentence wins; the sentence is here so nobody reads a green run as more
 * than it is.
 *
 * It also does not pin the ANTI-REPLAY half. A mint listed below hands back a token
 * for the request it was given; a mint that hands back a token for some OTHER
 * request is a source-identical line this scan cannot tell apart, and it is the run
 * loop's identity check that refuses it. `warehouse-producer.test.ts` drives that
 * refusal.
 *
 * A source-text test, and it says so: it proves what the tree CONTAINS, never what
 * runs.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

// `src/`, from `src/lib/brain/__tests__/`. Resolved off `import.meta.url` rather
// than `process.cwd()`: the isolated runner and a bare `bun test` disagree about
// the working directory, and a cwd-relative root would silently scan nothing under
// one of them.
const SRC_ROOT = new URL("../../../", import.meta.url).pathname;

/**
 * Every root that can hold a mint — three of them, not decoration.
 *
 * ⚠️ All five matched names are EXPORTED, and both `ee/` and `packages/cli/` import
 * `@atlas/api/*` freely: only the api→ee direction is gated. A scan of this package
 * alone proved a claim strictly narrower than the one the failure message made, so a
 * mint added under either would sit outside the enumeration while the guard stayed
 * green — the same silent-empty shape {@link BYPASS_RE}'s own note is written to
 * prevent, one axis over. `packages/cli/` is the concrete case: it already imports
 * `@atlas/api/lib/db/*` and `@atlas/api/lib/semantic/*`, so an `atlas brain produce`
 * command is a plausible sixth site.
 *
 * ⚠️ **The roots are NAMED in the failure message too.** An enumeration is only as
 * honest as its scope, and the previous message asserted a tree-wide claim over one
 * directory. If a root is added here, add it there.
 */
const ROOTS: readonly { readonly dir: string; readonly label: string }[] = [
  { dir: SRC_ROOT, label: "" },
  { dir: new URL("../../../../../../ee/src/", import.meta.url).pathname, label: "ee/src/" },
  {
    dir: new URL("../../../../../cli/src/", import.meta.url).pathname,
    label: "packages/cli/src/",
  },
];

/**
 * Every site that MAY ASSERT one of the guarded names, with why.
 *
 * ⚠️ "May assert", not "does bypass" — and the difference is real now that five
 * names are matched. A deps assertion carrying no `validateSnapshotSql`, or a
 * validator assertion returning only the refusing arm, bypasses nothing and still
 * belongs here. An entry is a place to LOOK, not a finding.
 *
 * ⚠️ ONE production entry, deliberately. It is the single point where the product's
 * gate answering yes becomes a value the run will act on. Note the module also names
 * these types in prose, so it would keep matching even if its cast were removed —
 * this test cannot tell you the cast is still there, only that no NEW file names one.
 */
const KNOWN_BYPASSES: readonly { file: string; why: string }[] = [
  {
    file: "lib/brain/warehouse-producer.ts",
    why: "the production mint — `defaultValidateSnapshotSql`, wrapping the real `validateSQL`",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer.test.ts",
    why: "the unit harness: no whitelist exists in a test workspace, so the real gate refuses every table",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer-pg.test.ts",
    why: "the -pg harness, for the same reason; its subject is the storage layer, not the gate",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer-logging.test.ts",
    why: "the logging harness, for the same reason",
  },
];

/**
 * The cast that asserts a pass, however it is spelled.
 *
 * ⚠️ **`[^;=\n]*` between the keyword and the name, not `\s+`, and the difference
 * was measured rather than reasoned.** The first version required them adjacent, so
 * a QUALIFIED reference — the `as` keyword followed by an inline `import(…)` type
 * and only then the name, which is what a file that has not imported the type
 * writes — walked straight past it. A guard that reports an empty set is
 * indistinguishable from one with nothing to find, which is the way this kind of
 * test fails silently. (The spelling is not written out here for the header's
 * reason; the second positive control below constructs it.)
 *
 * The class excludes `;`, `=` and a newline so the match stays inside one type
 * position rather than spanning statements. The regex is also the canonical
 * spelling of the pattern: writing it out in prose would put this file into its own
 * result set, which is why the header describes it instead.
 *
 * ⚠️ **FIVE alternatives (#5230), and the header says why each is load-bearing.**
 * Only the first has instances in the tree today; the other four are pinned by the
 * planted controls below, which is deliberate — a matcher whose arms are exercised
 * only by real instances loses the arm the moment the tree stops containing one, and
 * these four exist precisely for the mint nobody has written yet.
 *
 * ⚠️ A single-line import that renames some OTHER binding INTO one of these names
 * matches — a false positive rather than a hole, since it fails loudly and the fix
 * is to rename the local. An import that renames one of these types OUT to a
 * different local name does NOT match, and that direction is a real escape, listed
 * with the others in the header. A round-1 draft asserted the opposite direction and
 * called it a false positive; both halves were wrong, and the correction is measured
 * rather than reasoned. Neither spelling is written out here — writing one put THIS
 * FILE into its own result set on the first run, which is the quotation trap
 * arriving exactly where the header says it does.
 */
const BYPASS_RE =
  /\bas\b[^;=\n]*\b(?:ValidatedSnapshotRequest|SnapshotSqlVerdict|SnapshotSqlValidator|WarehouseProducerDeps|WarehouseSnapshotRunner)\b/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      yield full;
    }
  }
}

describe("the SQL-gate bypass set (#5042, #5230)", () => {
  test("every scanned root exists — a moved path must RED, not shrink the scan", () => {
    // ⚠️ Asserted rather than filtered. `existsSync`-and-skip would turn a renamed
    // directory into a silently smaller scan that still passes, which is the exact
    // failure the two-root change was made to close.
    for (const { dir, label } of ROOTS) {
      expect(existsSync(dir), `scan root missing: ${label || "packages/api/src/"} (${dir})`).toBe(
        true,
      );
    }
  });

  test("exactly the known sites assert a passing SQL verdict", () => {
    const found: string[] = [];
    for (const { dir, label } of ROOTS) {
      for (const file of walk(dir)) {
        if (BYPASS_RE.test(readFileSync(file, "utf8"))) {
          found.push(label + file.slice(dir.length));
        }
      }
    }
    expect(
      found.toSorted(),
      "the set of places under packages/api/src, ee/src and packages/cli/src that can assert the SQL " +
        "gate passed has changed. A new TEST harness is ordinarily fine — the real gate is " +
        "whitelist-scoped and a test workspace has none — but a new PRODUCTION site is a second door " +
        "onto an unvalidated statement reaching a customer's datasource, and it is the thing to argue " +
        "rather than merge. Add it to KNOWN_BYPASSES with a reason, or remove the cast.",
    ).toEqual(KNOWN_BYPASSES.map((b) => b.file).toSorted());
  });

  test("the positive control: the matcher finds a cast it is shown", () => {
    // Without this, an over-narrow regex reports an empty set forever and the test
    // above passes by finding nothing — the shape a guard test fails in silently.
    // ASSEMBLED, never written whole — see the header. A literal here would put this
    // file back in its own result set.
    const planted = `const v = ({ valid: true, request: r }) as Snapshot${"SqlVerdict"};`;
    expect(BYPASS_RE.test(planted)).toBe(true);
    // The QUALIFIED spelling, which the first version of this matcher missed — a
    // file that has not imported the type writes it this way.
    const qualified = `const v = x as import("./warehouse-producer").Snapshot${"SqlVerdict"};`;
    expect(BYPASS_RE.test(qualified)).toBe(true);
    // #5230's spelling — the one the four sites below actually use. Without this
    // arm the matcher could lose the request alternative entirely and every
    // assertion here would still pass on the verdict one.
    const branded = `const v = { valid: true, request: r as Validated${"SnapshotRequest"} };`;
    expect(BYPASS_RE.test(branded)).toBe(true);
    const brandedQualified = `const v = r as import("./warehouse-producer").Validated${"SnapshotRequest"};`;
    expect(BYPASS_RE.test(brandedQualified)).toBe(true);
    // The SEAM spellings, and these two are the reason the header's claim changed.
    // A mint asserted onto the validator type — with a PARAMETER, which is the only
    // useful shape — compiles, so the matcher has to see it. The tree contains no
    // instance, so these controls are the arms' only coverage.
    const seam = `const v = (async (r) => ({ valid: true, request: r })) as SnapshotSql${"Validator"};`;
    expect(BYPASS_RE.test(seam)).toBe(true);
    const deps = `const d = { validateSnapshotSql: mint } as WarehouseProducer${"Deps"};`;
    expect(BYPASS_RE.test(deps)).toBe(true);
    // The RUNNER type, the fifth name. Free today — the tree has zero assertions
    // onto it — and it is the cheapest innocuous-looking uncaught mint, because its
    // parameter IS the branded request.
    const runner = `const run = ((r) => read(r)) as WarehouseSnapshot${"Runner"};`;
    expect(BYPASS_RE.test(runner)).toBe(true);
    // A DOUBLE assertion through `unknown`, on one line. A round-1 draft of the
    // header listed this as escaping; it does not, and the control is here so the
    // sentence cannot drift back.
    const doubled = `const r = payload as unknown as Validated${"SnapshotRequest"};`;
    expect(BYPASS_RE.test(doubled)).toBe(true);
    // And negative controls, so the matcher is not simply true of everything:
    // naming a TYPE is not asserting a pass.
    expect(BYPASS_RE.test(`let v: Snapshot${"SqlVerdict"};`)).toBe(false);
    expect(BYPASS_RE.test(`let r: Validated${"SnapshotRequest"};`)).toBe(false);
    expect(BYPASS_RE.test(`const f: SnapshotSql${"Validator"} = realGate;`)).toBe(false);
    expect(BYPASS_RE.test(`function run(d: WarehouseProducer${"Deps"}) {}`)).toBe(false);
    // ⚠️ The two negatives above contain no `as` at all, so they are false for ANY
    // matcher that requires the keyword — including one that has lost every name.
    // They do not discriminate the arms they sit beside. This one does: a matched
    // name with no `as` anywhere on the line, in a position no assertion can take.
    expect(BYPASS_RE.test(`export type { SnapshotSql${"Validator"} };`)).toBe(false);
    // ⚠️ And the honest cost, asserted rather than described: PROSE containing the
    // word and a matched name on one line MATCHES. This is the quotation trap as a
    // measurement — the guard cannot tell a sentence from an assertion, which is
    // exactly why the header describes spellings instead of writing them out.
    expect(
      BYPASS_RE.test(`// as good a place as any to name SnapshotSql${"Validator"} in prose`),
    ).toBe(true);
    // ⚠️ A NEGATIVE control of legitimate PROSE, not only of legitimate code. Every
    // positive above is hand-planted by the same author as the matcher, so they pass
    // by construction; this is the arm that catches an over-broad one. The sentence
    // below is the shape a docstring in this module actually writes.
    expect(
      BYPASS_RE.test(`// the runner is reachable only as a consequence of the gate passing`),
    ).toBe(false);
  });
});
