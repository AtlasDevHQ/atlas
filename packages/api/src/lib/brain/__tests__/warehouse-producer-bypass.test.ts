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
 * The consequence is that a module which only ANNOTATES — an annotation, a
 * re-export, an import — has to be listed too, even though it asserts nothing and is
 * safe. The allowlist therefore grows for reasons that are not bypasses, and a flat
 * list would quietly stop distinguishing the two. So it does not stay flat: every
 * entry carries a {@link AllowlistKind}, the count of each is asserted, and every
 * entry claiming `"bypass"` is CHECKED against the tree rather than believed.
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
 * ⚠️ **Assembly collapses the matcher and its fixtures onto ONE array, and that is a
 * vacuity risk the first draft of #5249 shipped.** Before, the regex literal spelled
 * the five contiguously while each control assembled its own — two independent
 * spellings that had to agree. Deriving both from `GUARDED_NAMES` removed that
 * independence, and it was measured: **deleting three of the five names left the
 * whole suite green**, including the RUNNER arm that has no instances in the tree and
 * is the cheapest innocuous-looking uncaught mint. Fixtures that agree by
 * construction (#5000, #5068), one layer up.
 *
 * Three different mechanisms hold three different failures, and none subsumes
 * another — say which is which before touching any of them:
 *
 * - **DELETION** — a name leaving the array. Closed at COMPILE time: the array is a
 *   fixed-arity tuple, so dropping an element is a type error, and the runtime length
 *   assertion below is the same claim where a reader will look for it.
 * - **RENAME / TYPO** — a fragment that no longer spells a real export. Closed at
 *   RUNTIME by reading `warehouse-producer.ts`; the compiler cannot see inside a
 *   concatenation, so nothing else can close this.
 * - **A SIXTH branded type being exported and nobody adding it here** — OPEN, and
 *   deliberately: deriving the set from the module needs a tagging convention in
 *   production source. Tracked as a follow-up rather than improvised in a review
 *   round. A green run does not claim the five are still the whole set.
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
 * negative controls below pin that limit rather than leave it to prose.
 *
 * ⚠️ **The scanned roots are three, and they are NOT every root a mint could live
 * in.** {@link ROOTS} says which, and says plainly which sibling directories are
 * knowingly unscanned. Read a green run as *"no new file under those three roots
 * names one"*, nothing more.
 *
 * ⚠️ **`--affected` will not select this file for the event it exists to catch.** The
 * affected-test runner keys on quoted module specifiers, and a brand-new mint at
 * `lib/brain/<new-file>.ts` is named in no string here — nor is anything under
 * `ee/src` or `packages/cli/src`, which are outside this package entirely. So the
 * local pre-flight is blind to a new mint and only full CI catches it. This is the
 * repo's known glob-scanning-guard-is-`--affected`-blind pattern; do not read a green
 * pre-flight as covering it.
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
import { fileURLToPath } from "url";

// `src/`, from `src/lib/brain/__tests__/`. Resolved off `import.meta.url` rather
// than `process.cwd()`: the isolated runner and a bare `bun test` disagree about
// the working directory, and a cwd-relative root would silently scan nothing under
// one of them. `fileURLToPath`, not `.pathname` — the latter stays percent-encoded,
// so a checkout path containing a space resolves to a directory that does not exist.
const SRC_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The roots this guard scans, with a floor on how much each must yield.
 *
 * ⚠️ **These are the three roots with brain-adjacent imports today. They are NOT
 * "every root a mint could live in", and an earlier draft of this comment claimed
 * they were.** All five guarded names are EXPORTED and nothing gates who imports
 * `@atlas/api/*` — only the api→ee direction is gated — so the same argument that
 * put `ee/src` and `packages/cli/src` here applies verbatim to directories that are
 * knowingly unscanned: every `plugins/<name>/src` (a dozen of which import
 * `@atlas/api` today), `packages/cli/bin`, `packages/cli/lib`,
 * `packages/api/scripts`, and `packages/mcp/src`. None names a guarded type today —
 * verified by repo-wide grep —
 * so the gap is latent, not live. Widening the scan to cover them needs glob
 * expansion and is tracked as a follow-up.
 *
 * ⚠️ **The roots are NAMED in the failure message too.** An enumeration is only as
 * honest as its scope. If a root is added here, add it there.
 *
 * ⚠️ **`minFiles` exists because root EXISTENCE is not root CORRECTNESS.** Repointing
 * a root at a subdirectory that also exists — `ee/src/lib` for `ee/src` — passed
 * every other assertion in this file, because `ee/` and `cli/` contribute zero
 * matches and a narrower scan of them is invisible. The floors are set near half of
 * today's counts (1966 / 108 / 75), so ordinary churn does not red them and gross
 * narrowing does.
 */
const ROOTS: readonly {
  readonly dir: string;
  readonly label: string;
  readonly minFiles: number;
}[] = [
  { dir: SRC_ROOT, label: "", minFiles: 1000 },
  {
    dir: fileURLToPath(new URL("../../../../../../ee/src/", import.meta.url)),
    label: "ee/src/",
    minFiles: 50,
  },
  {
    dir: fileURLToPath(new URL("../../../../../cli/src/", import.meta.url)),
    label: "packages/cli/src/",
    minFiles: 30,
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
 * ⚠️ **The TUPLE type is the fix for a measured silent failure, not decoration.**
 * As `readonly string[]` this array could lose an element with the entire suite
 * green — matcher and fixtures both derive from it, so they shrank together. A
 * fixed-arity tuple makes a deletion a COMPILE error, which is the only place it can
 * be caught cheaply: no runtime assertion can see a name that was never there.
 */
const GUARDED_NAMES: readonly [string, string, string, string, string] = [
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
 *
 * ⚠️ The fragments are interpolated UNESCAPED, and that coupling is load-bearing
 * rather than sloppy: a name containing a regex metacharacter would fail to match
 * here AND fail to match in the export check below, so the export check reds instead
 * of this one going quietly vacuous.
 */
const NAME_RE = new RegExp(`\\b(?:${GUARDED_NAMES.join("|")})\\b`);

/**
 * The matcher #5249 replaced. It does NOT scan the tree — but it is not dead code
 * either, and an earlier draft that treated it as dead shipped a vacuous test.
 *
 * Two live uses: the behaviour delta below asserts it MISSES each escape spelling
 * (with a positive anchor, so a matcher that missed *everything* could not satisfy
 * it), and the `kind: "bypass"` check asserts every file claiming to bypass actually
 * contains an assertion form. That second use restores a property #5249 otherwise
 * removed — under the old matcher, deleting a cast without deleting its entry RED-ed
 * the suite; under a name scan it would not.
 *
 * Built from the same assembled fragments, for the same self-match reason as
 * {@link NAME_RE}.
 */
const LEGACY_AS_ADJACENT_RE = new RegExp(
  `\\bas\\b[^;=\\n]*\\b(?:${GUARDED_NAMES.join("|")})\\b`,
);

/** What an allowlist entry certifies. See the header — the distinction is the cost of #5249. */
type AllowlistKind =
  /** The file mints or asserts a passing verdict. This is the one to argue, and it is CHECKED. */
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
    why: "the -pg harness, same whitelist reason; its subject is the storage layer, not the gate",
  },
  {
    file: "lib/brain/__tests__/warehouse-producer-logging.test.ts",
    kind: "bypass",
    why: "the logging harness, same whitelist reason; its subject is the emitted log line",
  },
];

/** Kinds are counted, not merely declared — see the test that pins this. */
const EXPECTED_BY_KIND: Record<AllowlistKind, number> = { bypass: 4, annotation: 0 };

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      // `.mts`/`.cts` are included though the roots contain none today: the cost is
      // one alternative, and a module extension the scan cannot see is exactly the
      // silent narrowing this file is built to refuse.
      yield full;
    }
  }
}

/** Strip line and block comments, so a guard cannot be satisfied by prose about it. */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("the SQL-gate name allowlist (#5042, #5230, #5249)", () => {
  test("every assembled name is really exported — a rename must RED, not go vacuous", () => {
    // ⚠️ The one test that assembly makes mandatory. Fragments are invisible to the
    // compiler, so nothing but this read connects them to the real exports. It closes
    // RENAME and TYPO; it cannot close DELETION (the tuple type does that) and does
    // not claim to.
    expect(
      existsSync(DEFINING_MODULE),
      `the defining module moved: ${DEFINING_MODULE}. Update DEFINING_MODULE — a bare ` +
        `ENOENT below would be this assertion's job done badly.`,
    ).toBe(true);
    // Belt and braces on the tuple: the same claim, where a reader looks for it.
    expect(GUARDED_NAMES.length, "a guarded name left the array; the scan silently narrowed").toBe(
      5,
    );

    // ⚠️ Comments are stripped and the pattern is line-ANCHORED. Unanchored, a
    // `// export type <name> was renamed in #9999` note satisfied this check — the
    // exact vacuity the test exists to refuse, satisfied by prose describing the
    // rename. Measured.
    const source = withoutComments(readFileSync(DEFINING_MODULE, "utf8"));
    for (const name of GUARDED_NAMES) {
      const declared = new RegExp(`^export (?:declare )?(?:type|interface|class) ${name}\\b`, "m");
      // A barrel re-export is a legal refactor for a 2,300-line module and must not RED.
      const reExported = new RegExp(`^export (?:type )?\\{[^}]*\\b${name}\\b`, "m");
      expect(
        declared.test(source) || reExported.test(source),
        `${name} is no longer exported from lib/brain/warehouse-producer.ts. If it was ` +
          `renamed, update GUARDED_NAMES — the assembled fragments are invisible to the ` +
          `compiler, so a stale one silently matches nothing.`,
      ).toBe(true);
    }
  });

  test("every scanned root exists AND still yields its floor — narrowing must RED", () => {
    // ⚠️ Asserted rather than filtered. `existsSync`-and-skip would turn a renamed
    // directory into a silently smaller scan that still passes. The floor is the same
    // discipline one level down: a root repointed at a real subdirectory exists, and
    // without a volume check its narrowing is invisible.
    for (const { dir, label, minFiles } of ROOTS) {
      const name = label || "packages/api/src/";
      expect(existsSync(dir), `scan root missing: ${name} (${dir})`).toBe(true);
      expect(
        [...walk(dir)].length,
        `scan root ${name} yielded fewer than ${minFiles} files — repointed at a subdirectory?`,
      ).toBeGreaterThan(minFiles);
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
    // to a line a reviewer is looking at.
    const byKind: Record<AllowlistKind, number> = { bypass: 0, annotation: 0 };
    for (const entry of NAME_ALLOWLIST) byKind[entry.kind]++;
    expect(byKind).toEqual(EXPECTED_BY_KIND);
  });

  test("every kind:'bypass' entry really contains an assertion — the claim is checked, not believed", () => {
    // ⚠️ This restores a property #5249 removed. Under the old line-keyed matcher,
    // deleting a cast while leaving its entry RED-ed the suite; a name scan cannot see
    // that, so an entry could over-claim forever. Non-vacuous today: all four match.
    //
    // Honest limit, stated because the arm is one-directional: this uses the LEGACY
    // matcher, so a bypass written in one of the escape forms would read as an
    // annotation here. It does not make `kind` sound; it makes the common case
    // falsifiable and restores the deleted-cast-REDs property.
    const bypasses = NAME_ALLOWLIST.filter((e) => e.kind === "bypass");
    expect(bypasses.length, "no bypass entries — this test would be vacuous").toBeGreaterThan(0);
    for (const entry of bypasses) {
      expect(
        LEGACY_AS_ADJACENT_RE.test(readFileSync(join(SRC_ROOT, entry.file), "utf8")),
        `${entry.file} is listed kind "bypass" but contains no assertion form. If its cast ` +
          `was removed, demote it to "annotation" (and move the count); do not leave a stale ` +
          `over-claim in the list.`,
      ).toBe(true);
    }
  });

  test("every entry states a distinct reason", () => {
    // Split from the count assertion above: a failing count used to mean this loop
    // never ran. Two entries sharing a reason verbatim is the copy-paste this list
    // trends toward, and the reason is the only thing a reviewer actually reads.
    for (const entry of NAME_ALLOWLIST) expect(entry.why.length).toBeGreaterThan(20);
    expect(
      new Set(NAME_ALLOWLIST.map((e) => e.why)).size,
      "two entries share a reason verbatim — say what is different about them",
    ).toBe(NAME_ALLOWLIST.length);
  });

  test("the escapes #5249 closed: old matcher MISSES each, new matcher CATCHES each", () => {
    // ⚠️ The behaviour delta, executed rather than described. Each spelling below was
    // also compiled against the repo's own checker while #5249 was written — all three
    // typecheck, which is what made them escapes rather than curiosities.
    //
    // ASSEMBLED, never written whole — a contiguous name here would put this file into
    // its own result set, which is the trap the header describes.
    const V = "Snapshot" + "SqlVerdict";
    // ⚠️ The POSITIVE anchor, and it is what makes the misses below mean anything.
    // Without it, replacing the legacy matcher with one that matches NOTHING satisfied
    // every `should MISS` assertion and the suite stayed green — a delta test proving
    // only that the new matcher works. Measured.
    expect(
      LEGACY_AS_ADJACENT_RE.test(`const v = x as ${V};`),
      "the legacy matcher must still catch the one-line form, or the misses below are vacuous",
    ).toBe(true);
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
    // ⚠️ Read this for what it is: it proves the word boundaries hold in BOTH the
    // assertion and the annotation context, for each name. It CANNOT detect a name
    // leaving GUARDED_NAMES — matcher and loop derive from the same array, so they
    // shrink together. The tuple type closes that; an earlier draft claimed this loop
    // did, and that claim was measured false.
    for (const name of GUARDED_NAMES) {
      expect(NAME_RE.test(`const v = x as ${name};`), `boundary failed for ${name}`).toBe(true);
      // ⚠️ And the whole point of #5249: the same name with no assertion at all.
      expect(NAME_RE.test(`let v: ${name};`), `annotation form missed for ${name}`).toBe(true);
    }
  });

  test("the negative controls: what a name scan still cannot see", () => {
    // ⚠️ These three are the residual holes, pinned as assertions so the header's
    // "what this does NOT prove" section cannot drift away from the truth. Each
    // reaches the branded type — or claims to — without spelling it.
    //
    // ⚠️ They do NOT discriminate the matcher: containing none of the five, they are
    // false for ANY matcher, including one that lost every alternative. The two
    // boundary controls below are the ones that kill mutants.
    expect(NAME_RE.test(`const d: any = { validateSnapshotSql: mint };`)).toBe(false);
    expect(NAME_RE.test(`type V = Parameters<typeof runProducerSnapshot>[0];`)).toBe(false);
    expect(NAME_RE.test(`const v = buildPartial({ valid: true, request: r });`)).toBe(false);
    // ⚠️ DISCRIMINATING negatives, one per boundary. A near-miss identifier must not
    // match — otherwise a `\b` has been dropped and the matcher is a substring test,
    // which would drag in every sibling type and make the allowlist unmaintainable.
    // Both directions, because they fail independently: dropping the TRAILING `\b`
    // and dropping the LEADING one are different mutations and each needs its own arm.
    expect(NAME_RE.test(`let v: Snapshot${"SqlVerdict"}ish;`)).toBe(false);
    expect(NAME_RE.test(`type Pre${"Validated"}SnapshotRequest = never;`)).toBe(false);
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
