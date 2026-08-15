/**
 * The SQL-gate name allowlist (#5042, re-pointed at #5230's spelling, widened to
 * whole-file name occurrence by #5249).
 *
 * ## WHY THIS FILE EXISTS
 *
 * `warehouse-producer.ts` brands the REQUEST the SQL gate passed, and the passing
 * verdict carries it — so no object literal can assert *"the product's SELECT-only /
 * single-statement / whitelist-scoped check said yes"*. That closes the hole a plain
 * `{ valid: boolean }` left, but it leaves a claim the TYPE cannot keep: that
 * grepping for the assertion is the whole list of places the gate is bypassed. An
 * assertion is greppable; nothing fails when a fifth one appears.
 *
 * ## WHAT AN ENTRY MEANS — read this before adding one
 *
 * **An entry names a file that may MENTION a guarded name. It does not certify that
 * the file bypasses anything, and it no longer certifies that the file asserts.**
 * That is #5249's change and it is a real widening: before, an entry meant *"this
 * line may cast"*; now it means *"this file may say the word"*.
 *
 * The consequence is that a module which only ANNOTATES — `let v: <a guarded name>`,
 * a re-export, an import — has to be listed too, even though an annotation asserts
 * nothing and is safe. The allowlist therefore grows for reasons that are not
 * bypasses, and a flat list would quietly stop distinguishing the two. So it does not
 * stay flat: every entry carries a {@link AllowlistKind}, and the count of each is
 * asserted below. A reviewer reading the list can still see *"four bypasses, zero
 * annotations"* rather than *"five files, unknown mix"*.
 *
 * **When you add an entry, pick the kind honestly.** `"bypass"` is the one that has
 * to be argued: a production module minting a passing verdict is a second door onto
 * an unvalidated statement reaching a customer's datasource. `"annotation"` is
 * ordinarily fine and still has to be visible.
 *
 * ## WHY WHOLE-FILE, and what it bought
 *
 * The previous matcher keyed on the cast's own line — the keyword and a guarded name
 * on one physical line. Three spellings walked past it, **all three measured against
 * the repo's own checker (they compile) and against both matchers (the old one misses
 * each, this one catches each)**. The measurement is not described here, it is
 * executed: see the delta table in the "escapes closed by #5249" test below, which
 * runs {@link LEGACY_AS_ADJACENT_RE} beside {@link NAME_RE} on each spelling.
 *
 * - a local type ALIAS, then the assertion through the alias
 * - the ANGLE-BRACKET assertion form
 * - a LINE BREAK between the keyword and the name
 *
 * A fourth, listed as a live escape by the previous header, is closed by the same
 * move: an import that renames a guarded type OUT to another local name still spells
 * the guarded name at the import site.
 *
 * ## FIVE names, because #5230 moved the brand onto the REQUEST
 *
 * The passing verdict carries the request it validated, and that request is what is
 * branded — which is how replay (a cached token for some other statement) and
 * ordering (a runner reachable with an unvalidated request) got closed. A bypass can
 * be spelled five ways: the branded REQUEST type, the VERDICT union, the VALIDATOR
 * seam type, the DEPS interface that holds it, or the RUNNER type whose parameter is
 * the branded request.
 *
 * ⚠️ **All five have to be listed, and the reason is one property of the brand.** It
 * only ADDS a field, so a branded request is assignable to a bare one, and the
 * assertion succeeds whenever EITHER direction is comparable — the reverse direction
 * carries every seam name. Refused only where the reverse direction also fails: a
 * NULLARY mint (a 1-parameter function type is not assignable to a 0-parameter one),
 * or a literal with an excess property. Such a validator returns its own argument, so
 * the run loop's identity check waves it through: the gate never ran and nothing
 * downstream can tell.
 *
 * ## The names are ASSEMBLED, and that is load-bearing twice
 *
 * A lexical guard cannot tell a quotation from an assertion. Under the old
 * line-keyed matcher this file stayed out of its own result set by describing
 * spellings in prose instead of writing them; under a whole-file name scan that is no
 * longer enough, because **the matcher's own definition would spell all five names
 * and put this file into its own results.** Measured: it does.
 *
 * The repo's answer is reword, never exempt — an exemption is a hole shaped exactly
 * like the thing being guarded. So {@link GUARDED_NAMES} assembles each name from
 * fragments and {@link NAME_RE} is built at runtime. No contiguous guarded name
 * appears in this file's source, so it needs no entry, and **a real assertion written
 * into this file would still spell a name contiguously and would still RED.**
 *
 * ⚠️ **Assembly introduces its own silent-failure mode, and it is the dangerous
 * kind: a rename makes the guard VACUOUS rather than red.** If someone renames the
 * VERDICT union, the fragments stop matching anything, the scan finds nothing, and
 * the allowlist assertion fails loudly only because the four real files stop matching
 * too — but a rename of a name with no instances (the runner, today) would go green
 * forever. That is why the first test below reads `warehouse-producer.ts` and asserts
 * every assembled name is really exported there.
 *
 * ⚠️ This paragraph names the types by ROLE rather than spelling them, and that is
 * the rule for every comment added to this file from now on. The first draft of
 * #5249's header spelled one — the suite RED-ed on its own file, immediately, which
 * is the guard working.
 *
 * ## What this does NOT prove
 *
 * The brand is not the only bypass, and saying so here is the honest half. Measured
 * against the repo's own checker: an object literal, `as const`, `satisfies`, a
 * spread of the refusing arm, `unknown`, and the identity form of generic-inference
 * laundering are all REFUSED by the COMPILER.
 *
 * ⚠️ **What this scan holds is exactly: no unlisted file under the scanned roots
 * SPELLS one of the five names.** What still escapes is everything that reaches the
 * type without naming it — `any`-typed wiring, a `Partial<T>`-shaped generic builder,
 * or an indexed-access lookup routed through a VALUE rather than the type
 * (`Parameters<typeof someRunner>[0]`). Those need no assertion and name nothing; the
 * negative controls below pin that limit rather than leave it to prose. The list is
 * not exhaustive and cannot be — read a green run as *"no new file names one"*,
 * nothing more.
 *
 * It also does not pin the ANTI-REPLAY half. A mint listed below hands back a token
 * for the request it was given; a mint that hands back a token for some OTHER request
 * is a source-identical line this scan cannot tell apart, and it is the run loop's
 * identity check that refuses it. `warehouse-producer.test.ts` drives that refusal.
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
 * ⚠️ All five guarded names are EXPORTED, and both `ee/` and `packages/cli/` import
 * `@atlas/api/*` freely: only the api→ee direction is gated. A scan of this package
 * alone proved a claim strictly narrower than the one the failure message made, so a
 * mint added under either would sit outside the enumeration while the guard stayed
 * green. `packages/cli/` is the concrete case: it already imports
 * `@atlas/api/lib/db/*` and `@atlas/api/lib/semantic/*`, so an `atlas brain produce`
 * command is a plausible sixth site.
 *
 * ⚠️ **The roots are NAMED in the failure message too.** An enumeration is only as
 * honest as its scope, and a previous message asserted a tree-wide claim over one
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
 * The module that defines all five names — read, not imported, so the assembled
 * fragments can be checked against the real exports.
 */
const DEFINING_MODULE = join(SRC_ROOT, "lib/brain/warehouse-producer.ts");

/**
 * The five guarded names, ASSEMBLED so no contiguous spelling appears in this file.
 * See the header: writing them whole would put this file into its own result set.
 *
 * The split points are arbitrary and only have to prevent a contiguous literal.
 */
const GUARDED_NAMES: readonly string[] = [
  "Validated" + "SnapshotRequest",
  "Snapshot" + "SqlVerdict",
  "SnapshotSql" + "Validator",
  "WarehouseProducer" + "Deps",
  "WarehouseSnapshot" + "Runner",
];

/**
 * #5249's matcher: does the file MENTION a guarded name at all?
 *
 * No keyword, no line discipline, no character class — the widening is the whole
 * change, and it is what closes the alias, angle-bracket and line-break spellings in
 * one move rather than three.
 */
const NAME_RE = new RegExp(`\\b(?:${GUARDED_NAMES.join("|")})\\b`);

/**
 * The matcher #5249 REPLACED, kept only so the behaviour delta is executable.
 *
 * ⚠️ This is not live — nothing scans the tree with it. It exists so the test below
 * can assert, on each escape spelling, that the old matcher MISSED it and the new one
 * CATCHES it. A delta described in prose drifts; a delta that runs cannot. Built from
 * the same assembled fragments, for the same self-match reason as {@link NAME_RE}.
 */
const LEGACY_AS_ADJACENT_RE = new RegExp(
  `\\bas\\b[^;=\\n]*\\b(?:${GUARDED_NAMES.join("|")})\\b`,
);

/** What an allowlist entry certifies. See the header — the distinction is the cost of #5249. */
type AllowlistKind =
  /** The file mints or asserts a passing verdict. This is the one to argue. */
  | "bypass"
  /** The file only names the type — annotation, import, re-export. Safe, still visible. */
  | "annotation";

/**
 * Every file that MAY NAME one of the guarded types, with which kind and why.
 *
 * ⚠️ "May name", not "does bypass" — see the header. An entry is a place to LOOK,
 * not a finding.
 *
 * ⚠️ ONE production entry, deliberately. It is the single point where the product's
 * gate answering yes becomes a value the run will act on.
 *
 * ⚠️ This file is deliberately ABSENT, and that is not an exemption. It names none
 * of the five contiguously — {@link GUARDED_NAMES} assembles them — so the scan does
 * not find it. A real assertion written here would spell a name and would RED.
 */
const NAME_ALLOWLIST: readonly {
  readonly file: string;
  readonly kind: AllowlistKind;
  readonly why: string;
}[] = [
  {
    file: "lib/brain/warehouse-producer.ts",
    kind: "bypass",
    why: "the production mint — `defaultValidateSnapshotSql`, wrapping the real `validateSQL`; also where all five names are DEFINED",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer.test.ts",
    kind: "bypass",
    why: "the unit harness: no whitelist exists in a test workspace, so the real gate refuses every table",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer-pg.test.ts",
    kind: "bypass",
    why: "the -pg harness, for the same reason; its subject is the storage layer, not the gate",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer-logging.test.ts",
    kind: "bypass",
    why: "the logging harness, for the same reason",
  },
];

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

describe("the SQL-gate name allowlist (#5042, #5230, #5249)", () => {
  test("every assembled name is really exported — a rename must RED, not go vacuous", () => {
    // ⚠️ The one test that assembly makes mandatory. Fragments cannot be checked by
    // the compiler, so nothing but this read connects them to the real exports.
    // Without it, renaming a guarded type with no instances in the tree leaves a
    // matcher that can never match and a suite that is green forever.
    const source = readFileSync(DEFINING_MODULE, "utf8");
    for (const name of GUARDED_NAMES) {
      expect(
        new RegExp(`export (?:type|interface) ${name}\\b`).test(source),
        `${name} is no longer exported from lib/brain/warehouse-producer.ts. If it was ` +
          `renamed, update GUARDED_NAMES — the assembled fragments are invisible to the ` +
          `compiler, so a stale one silently matches nothing.`,
      ).toBe(true);
    }
  });

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

  test("exactly the allowlisted files name a guarded type", () => {
    const found: string[] = [];
    for (const { dir, label } of ROOTS) {
      for (const file of walk(dir)) {
        if (NAME_RE.test(readFileSync(file, "utf8"))) {
          found.push(label + file.slice(dir.length));
        }
      }
    }
    expect(
      found.toSorted(),
      "the set of files under packages/api/src, ee/src and packages/cli/src that NAME one of " +
        "the five guarded SQL-gate types has changed. Since #5249 an entry means 'may name', " +
        "not 'may cast' — so a file that merely ANNOTATES one of these types lands here too, " +
        "and that is expected: add it to NAME_ALLOWLIST with kind 'annotation'. A new " +
        "PRODUCTION site that MINTS a passing verdict is kind 'bypass', and it is a second " +
        "door onto an unvalidated statement reaching a customer's datasource — the thing to " +
        "argue rather than merge.",
    ).toEqual(NAME_ALLOWLIST.map((b) => b.file).toSorted());
  });

  test("the allowlist's kinds are counted, so a bypass cannot arrive dressed as an annotation", () => {
    // ⚠️ The number, not just the field. #5249 widened what an entry means, and the
    // failure mode it introduces is a real mint added as `kind: "annotation"` because
    // that is the quieter word. Pinning the count makes adding a bypass a visible edit
    // to this line, with the reviewer's attention on it.
    const byKind = { bypass: 0, annotation: 0 };
    for (const entry of NAME_ALLOWLIST) byKind[entry.kind]++;
    expect(byKind).toEqual({ bypass: 4, annotation: 0 });
    // Every entry says why, and the reason is not the empty string.
    for (const entry of NAME_ALLOWLIST) expect(entry.why.length).toBeGreaterThan(20);
  });

  test("the escapes #5249 closed: old matcher MISSES each, new matcher CATCHES each", () => {
    // ⚠️ The behaviour delta, executed rather than described. Each spelling below was
    // also compiled against the repo's own checker while #5249 was written — all three
    // typecheck, which is what made them escapes rather than curiosities.
    //
    // ASSEMBLED, never written whole — a contiguous name here would put this file into
    // its own result set, which is the trap the header describes.
    const V = "Snapshot" + "SqlVerdict";
    const escapes: readonly { readonly label: string; readonly src: string }[] = [
      {
        label: "a local type alias, then the assertion through the alias",
        src: `type V = ${V};\nconst v = ({ valid: true, request: r }) as V;`,
      },
      {
        label: "the angle-bracket assertion form",
        src: `const v = <${V}>({ valid: true, request: r });`,
      },
      {
        label: "a line break between the keyword and the name",
        src: `const v = ({ valid: true, request: r }) as\n  ${V};`,
      },
      {
        label: "an import renaming a guarded type OUT to another local name",
        src: `import type { ${V} as Ok } from "./warehouse-producer";`,
      },
    ];
    for (const { label, src } of escapes) {
      expect(LEGACY_AS_ADJACENT_RE.test(src), `legacy matcher should MISS: ${label}`).toBe(false);
      expect(NAME_RE.test(src), `#5249 matcher should CATCH: ${label}`).toBe(true);
    }
  });

  test("the positive control: the matcher finds every name it is shown", () => {
    // Without this, an over-narrow matcher reports an empty set forever and the
    // allowlist test above passes by finding nothing — the shape a guard test fails
    // in silently. One arm per name, so losing a single alternative REDS.
    for (const name of GUARDED_NAMES) {
      expect(NAME_RE.test(`const v = x as ${name};`), `lost the arm for ${name}`).toBe(true);
      // ⚠️ And the whole point of #5249: the same name with no assertion at all.
      expect(NAME_RE.test(`let v: ${name};`), `annotation form missed for ${name}`).toBe(true);
    }
  });

  test("the negative controls: what a name scan still cannot see", () => {
    // ⚠️ These are the residual holes, pinned as assertions so the header's "what this
    // does NOT prove" section cannot drift away from the truth. Each names none of the
    // five, so each reaches the branded type — or claims to — without spelling it.
    expect(NAME_RE.test(`const d: any = { validateSnapshotSql: mint };`)).toBe(false);
    expect(NAME_RE.test(`type V = Parameters<typeof runProducerSnapshot>[0];`)).toBe(false);
    expect(NAME_RE.test(`const v = buildPartial({ valid: true, request: r });`)).toBe(false);
    // ⚠️ A DISCRIMINATING negative, not merely an absent one. A near-miss identifier
    // that CONTAINS a guarded name as a prefix must not match — otherwise `\b` has
    // been dropped and the matcher is a substring test, which would drag in every
    // sibling type and make the allowlist unmaintainable.
    expect(NAME_RE.test(`let v: Snapshot${"SqlVerdict"}ish;`)).toBe(false);
    // The real sibling type this scan must stay clear of: the UNvalidated request is
    // named all over the producer and is not one of the five.
    expect(NAME_RE.test(`function run(r: WarehouseSnapshot${"Request"}) {}`)).toBe(false);
    // ⚠️ And the honest cost of the widening, asserted rather than described: PROSE
    // naming a guarded type now matches, where the old matcher needed the keyword too.
    // This is the quotation trap as a measurement — it is why the names above are
    // assembled, and why "reword, never exempt" is the only way to add a comment here
    // that mentions one.
    expect(NAME_RE.test(`// see Snapshot${"SqlVerdict"} for the passing arm`)).toBe(true);
  });
});
