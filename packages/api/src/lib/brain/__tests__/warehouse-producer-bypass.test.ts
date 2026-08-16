/**
 * The SQL-gate name allowlist (#5042, re-pointed at #5230's spelling, widened to
 * whole-file name occurrence by #5249, given its completeness direction and five more
 * scanned roots by #5255).
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
 * or a literal with an excess property. `as const` on `valid` does not close it.
 * Measured against the repo's own checker, because the two obvious explanations for
 * this were both wrong. The identity mint that survives — one returning its own
 * argument — is waved through by the run loop's identity check: the gate never ran
 * and nothing downstream can tell.
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
 * whole suite green**, including the RUNNER arm — every file that names it is already
 * listed and also names another guarded type, so losing the arm changes no result,
 * and no unlisted file names it, which makes it the cheapest innocuous-looking
 * uncaught mint. Fixtures that agree by construction (#5000, #5068), one layer up.
 *
 * Four failures are closed by six mechanisms, none subsuming another — say which is
 * which before touching any of them:
 *
 * - **DELETION** — a name leaving the array. Closed at COMPILE time by the fixed-arity
 *   tuple (`bun run type`) and at RUNTIME by the length assertion (`bun test`, which
 *   strips types without checking them, so neither mechanism is redundant).
 * - **SUBSTITUTION** — one name replaced by a COPY of another. Arity is unchanged and
 *   both spellings are real exports, so neither mechanism above sees it, and the
 *   positive-control loop shrinks along with the matcher. Closed by the DISTINCTNESS
 *   assertion. This is listed separately because an earlier draft treated deletion as
 *   the whole class and measured green under substitution.
 * - **RENAME / TYPO** — a fragment that no longer spells a real export. Closed at
 *   RUNTIME by reading `warehouse-producer.ts`; the compiler cannot see inside a
 *   concatenation, so nothing else can close this. The reading machinery has its own
 *   fixture block, because a checker with no falsifier is how its blind spots ship.
 * - **A SIXTH branded type being exported and nobody adding it here** — closed by
 *   #5255, with two mechanisms rather than one. The `@sql-gate-guarded` TAG on each
 *   defining declaration makes membership reviewable at the definition site and is
 *   asserted set-equal to {@link GUARDED_NAMES} in both directions. But a tag is
 *   something a person has to remember, so the tag scan alone would have restated the
 *   hole rather than closed it: the CLOSURE — every top-level exported type in the
 *   module that transitively names the brand symbol — is computed from source and
 *   cannot be forgotten. A green run now DOES claim the five are the whole set, for
 *   every sixth type that names one of them.
 *
 * ## What this does NOT prove
 *
 * The brand is not the only bypass, and saying so here is the honest half. Measured
 * against the repo's own checker: an object literal, `as const`, `satisfies`, a
 * spread of the refusing arm, `unknown`, and the identity form of generic-inference
 * laundering are all REFUSED by the COMPILER.
 *
 * ⚠️ **What this scan holds is exactly: no unlisted TypeScript file under the scanned
 * roots SPELLS one of the five names.** What still escapes is everything that reaches the
 * type without naming it — `any`-typed wiring, a `Partial<T>`-shaped generic builder,
 * or an indexed-access lookup routed through a VALUE rather than the type
 * (`Parameters<typeof someRunner>[0]`). Those need no assertion and name nothing; the
 * negative controls below pin that limit rather than leave it to prose.
 *
 * ⚠️ **The scanned roots are EIGHT since #5255, and they are still not every directory
 * in the repo.** {@link ROOTS} says which, why each earns a place, and which siblings
 * remain unscanned and on what argument. Read a green run as *"no unlisted file under
 * those eight roots names one"*, nothing more.
 *
 * ⚠️ **`--affected` will not select this file for the event it exists to catch.** Run
 * against the runner's own `collectAffectedTests` rather than reasoned about, because
 * #5255 took the sentinel count from three to eight and the previous version of this
 * paragraph was an argument about two of them:
 *
 * - a brand-new mint at `lib/brain/<new-file>.ts` — NOT selected. Its token appears in
 *   no string here, which is the whole point: an unnamed new file is the event.
 * - a change to any of the EIGHT sentinels — NOT selected. The runner's token is the
 *   STEM and the quoted string has to end at it, so every sentinel spelling ends in
 *   `.ts` and matches nothing; six of the eight roots are outside this package anyway.
 * - a change to `warehouse-producer.ts` — SELECTED, through the `./warehouse-producer`
 *   specifier in the escape-spelling fixture. That one edge does reach it, and it is
 *   the edge that matters for the completeness assertions, which read that module.
 *
 * So the local pre-flight is blind to a NEW MINT and only full CI catches it. This is
 * the repo's known glob-scanning-guard-is-`--affected`-blind pattern; do not read a
 * green pre-flight as covering it.
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
 * ⚠️ **#5255 WIDENED this from three to eight, and the argument for the widening was
 * already written in the old version of this comment.** All five guarded names are
 * EXPORTED and nothing gates who imports `@atlas/api/*` — only the api→ee direction
 * is gated — so the same reasoning that put `ee/src` and `packages/cli/src` here
 * applied verbatim to five directories that were knowingly unscanned, one of which
 * (`packages/cli/bin/brain-paraphrase-eval.ts`, importing `@atlas/api/lib/brain/extract`)
 * was the comment's own example of brain-touching code outside its scan. A rationale
 * that names its own counterexample is a rationale for widening, not for a follow-up.
 *
 * What is now scanned, and why each one could hold a mint:
 *
 * - `packages/api/src` — the module's own package.
 * - `ee/src` — imports `@atlas/api/*` freely; the gate is only api→ee.
 * - `packages/cli/src` — the `atlas` CLI's command layer.
 * - `packages/cli/bin` — the entrypoints and the eval harnesses, including the
 *   brain-touching one named above.
 * - `packages/cli/lib` — the CLI's shared helpers, `tenant-db.ts` among them.
 * - `packages/api/scripts` — build/eval/ops scripts that import the api package
 *   directly and run with its credentials.
 * - `packages/mcp/src` — the MCP server, a second front door onto the same libs.
 * - `plugins` — walked WHOLE rather than as one root per `plugins/<name>/src`, because
 *   a glob of 25 roots would need 25 sentinels and 25 floors, most of them over
 *   directories of one or two files where a floor asserts nothing. One root over the
 *   whole tree is both simpler and STRICTLY more coverage: it also sees each plugin's
 *   root-level `.ts` files and test directories, which a per-plugin `src` glob misses.
 *
 * ⚠️ **What is still unscanned, stated rather than implied.** `apps/` (docs and www —
 * Next.js surfaces that speak HTTP and import no api lib), `packages/web`, and the
 * other published `@useatlas/*` packages. None imports `@atlas/api/*`; the frontend
 * convention is that it never does. That is an argument from a convention rather than
 * from a compiler, so it is weaker than the eight above — read a green run as *"no
 * unlisted file under those eight roots names one"*, nothing more.
 *
 * ⚠️ **The roots are NAMED in the failure message too, and that is now ASSERTED
 * rather than kept in sync by hand** (#5255) — see {@link SCAN_SCOPE_MESSAGE} and the
 * test that pins it. The message is hand-written on purpose: generating it from these
 * labels would make the assertion agree by construction, which is the failure #5249
 * measured one array over.
 *
 * ⚠️ **Root EXISTENCE is not root CORRECTNESS, and a VOLUME floor is only a proxy
 * for it — a proxy that was measured insufficient.** A first attempt set floors at
 * roughly half of each root's file count and verified one root. That is the wrong
 * calibration: the number that matters is the size of the largest CHILD directory,
 * because repointing a root at its own child is the edit in question. Measured —
 * `packages/api/src` -> `src/lib` is 1612 files against a floor of 1000, and
 * `packages/cli/src` -> `src/__tests__` is 35 against 30. Both stayed GREEN. Only the
 * `ee` root, the one that had been checked, RED-ed.
 *
 * So the floor is no longer the mechanism, it is the backstop. **`sentinel` is the
 * mechanism**: a file that must be REACHED by the walk, which answers "is this the
 * right directory" directly instead of inferring it from a count. Each sentinel is a
 * uniquely-pathed file under its root, so a repoint cannot accidentally satisfy it.
 *
 * ⚠️ **The sentinel catches a `walk` narrowing only when that narrowing drops the
 * sentinel's OWN path, and an earlier draft of this paragraph claimed more.**
 * Measured: skipping `brain` leaves 1,789 files — clears the 1,000 floor, but REDs
 * the sentinel. Skipping `src/api` leaves 1,651 — clears the floor AND still reaches
 * the sentinel, so both mechanisms miss it. Tightening the extension test to `.ts`
 * drops nothing at all, since no root holds a `.tsx`, `.mts` or `.cts` today. A scan
 * narrowed away from the sentinel's path is not covered here.
 *
 * The floors stay because they catch a different thing: a scan that still reaches the
 * sentinel while losing most of the tree.
 *
 * ⚠️ **The TUPLE type is the same fix as {@link GUARDED_NAMES}', and it is here
 * because the first attempt at that fix reproduced the defect one array over.**
 * Pinning a root's `dir` catches NARROWING it; nothing caught DELETING the entry,
 * because every assertion about a root is driven by this same list — so removing an
 * element removed the scan and its own checks together, and `ee/src` and
 * `packages/cli/src` contribute zero matches, so the allowlist test could not notice
 * either. Fixed arity makes a deletion a compile error.
 */
type ScanRoot = {
  readonly dir: string;
  readonly label: string;
  readonly minFiles: number;
  /** Root-relative path that MUST be reached — the direct answer to "right directory?". */
  readonly sentinel: string;
};
const ROOTS: readonly [
  ScanRoot,
  ScanRoot,
  ScanRoot,
  ScanRoot,
  ScanRoot,
  ScanRoot,
  ScanRoot,
  ScanRoot,
] = [
  {
    dir: SRC_ROOT,
    label: "",
    minFiles: 1000,
    sentinel: "lib/brain/warehouse-producer.ts",
  },
  {
    dir: fileURLToPath(new URL("../../../../../../ee/src/", import.meta.url)),
    label: "ee/src/",
    minFiles: 50,
    sentinel: "deploy-mode.ts",
  },
  {
    dir: fileURLToPath(new URL("../../../../../cli/src/", import.meta.url)),
    label: "packages/cli/src/",
    minFiles: 30,
    sentinel: "validate.ts",
  },
  {
    dir: fileURLToPath(new URL("../../../../../cli/bin/", import.meta.url)),
    label: "packages/cli/bin/",
    // 37 files, largest child `__tests__` at 23 — the floor clears the repoint.
    minFiles: 30,
    sentinel: "brain-paraphrase-eval.ts",
  },
  {
    dir: fileURLToPath(new URL("../../../../../cli/lib/", import.meta.url)),
    label: "packages/cli/lib/",
    // 23 files, largest child `learn/` at 5.
    minFiles: 15,
    sentinel: "tenant-db.ts",
  },
  {
    dir: fileURLToPath(new URL("../../../../scripts/", import.meta.url)),
    label: "packages/api/scripts/",
    // 27 files, largest child `mutations/` at 13.
    minFiles: 20,
    sentinel: "mutate.ts",
  },
  {
    dir: fileURLToPath(new URL("../../../../../mcp/src/", import.meta.url)),
    label: "packages/mcp/src/",
    // 75 files, largest child `__tests__` at 39.
    minFiles: 50,
    sentinel: "mcp-dispatch.ts",
  },
  {
    dir: fileURLToPath(new URL("../../../../../../plugins/", import.meta.url)),
    label: "plugins/",
    // 191 files across 25 plugins, largest child `chat/` at 52 — so a repoint at the
    // biggest plugin still REDs on the floor as well as on the sentinel.
    minFiles: 100,
    sentinel: "chat/src/index.ts",
  },
];

/** Resolve an allowlist entry to an absolute path via its root's label, never assuming the api root. */
function resolveEntry(file: string): string {
  const root = ROOTS.find((r) => r.label !== "" && file.startsWith(r.label));
  return root ? join(root.dir, file.slice(root.label.length)) : join(SRC_ROOT, file);
}

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
 * either, and an earlier draft's only use of it carried no positive anchor, so a
 * matcher that matched NOTHING satisfied every "should MISS" assertion.
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

/**
 * The failure a reviewer actually reads when a new file names a guarded type.
 *
 * ⚠️ **Hoisted so its scope enumeration can be ASSERTED rather than kept in sync by
 * hand** (#5255). The previous version was an inline string listing three roots under
 * a {@link ROOTS} docstring that said "if a root is added here, add it there" and
 * enforced nothing — the same prose-synchronisation defect PR #5234 corrected in this
 * very message once already. A message asserting a NARROWER scope than the test proves
 * tells a reader they are safe in directories nobody checked.
 *
 * ⚠️ **Written by hand, NOT generated from {@link ROOTS}.** Interpolating the labels
 * would make the assertion below true by construction and it would survive every root
 * being deleted — fixtures that agree by construction (#5000, #5068, and #5249 one
 * array over). Two independent spellings that must agree is the entire mechanism.
 */
const SCAN_SCOPE_MESSAGE =
  "the set of files that NAME one of the five guarded SQL-gate types has changed. The " +
  "scanned roots are packages/api/src/, ee/src/, packages/cli/src/, packages/cli/bin/, " +
  "packages/cli/lib/, packages/api/scripts/, packages/mcp/src/ and plugins/. Since #5249 " +
  "an entry means 'may name', not 'may cast' — so a file that merely ANNOTATES one of " +
  "these types lands here too, and that is expected: add it to NAME_ALLOWLIST with kind " +
  "'annotation'. A new PRODUCTION site that MINTS a passing verdict is kind 'bypass', and " +
  "it is a second door onto an unvalidated statement reaching a customer's datasource — " +
  "the thing to argue rather than merge.";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      // `.mts`/`.cts` are included though the roots contain none today: the cost is
      // two alternatives, and a module extension the scan cannot see is exactly the
      // silent narrowing this file is built to refuse.
      yield full;
    }
  }
}

/**
 * Strip block and line comments, so a guard cannot be satisfied by prose about itself.
 *
 * ⚠️ **Block comments are removed as REGIONS, not by looking at how each line
 * starts, and the difference was measured.** A line-shape filter (drop lines whose
 * trimmed start is `//`, `*` or `/*`) leaves the BODY of an ordinary block comment
 * intact, because continuation lines are only conventionally prefixed with `*` —
 * nothing enforces it, and "toggle block comment" over a declaration produces none.
 * So this stayed GREEN:
 *
 *     /* <a guarded declaration, commented out during a rename>
 *
 * which is the same vacuity the line filter was written to close, one comment syntax
 * over — a guard satisfied by prose describing the very rename it exists to catch.
 *
 * Honest bound: a STRING LITERAL whose content begins a line with `export type <a
 * guarded name>` still satisfies the caller's pattern. Not constructible against
 * today's module, and the fixtures below pin the shapes that are.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/**
 * Is `name` exported from `source`? Hoisted out of the test so it can be DRIVEN BY
 * FIXTURES rather than only by the real module.
 *
 * ⚠️ **Hoisting is the fix for a measured hole: the machinery that closes the
 * rename check had no falsifier of its own.** Replacing {@link withoutComments} with
 * the identity function, or dropping the `^`/`m` anchor, each left the whole suite
 * GREEN — so the previous round's fix was protected by nothing and its blind spot
 * (block comments) shipped undetected. The fixture block below is what makes both
 * deletions RED.
 */
function isExported(source: string, name: string): boolean {
  const stripped = withoutComments(source);
  const declared = new RegExp(`^export (?:declare )?(?:type|interface|class) ${name}\\b`, "m");
  // A barrel re-export is a legal refactor for a 2,378-line module and must not RED.
  // ⚠️ The negative lookahead matters: `export type { X as V2 }` means X is NO LONGER
  // exported under that spelling, which is precisely the rename this check exists to
  // catch — without it the widening swallowed its own subject.
  const reExported = new RegExp(`^export (?:type )?\\{[^}]*\\b${name}\\b(?!\\s+as\\b)`, "m");
  return declared.test(stripped) || reExported.test(stripped);
}

/**
 * The module-private brand symbol every guarded type ultimately reaches.
 *
 * Not a guarded name itself — it is never exported, so nothing can assert to it —
 * which is why it is spelled contiguously here while the five are not.
 */
const BRAND_SYMBOL = "validatedSnapshotSql";

/** The definition-site marker. See the convention block in the defining module. */
const GUARD_TAG = "@sql-gate-guarded";

/**
 * Every declaration carrying {@link GUARD_TAG} in the JSDoc block IMMEDIATELY above it.
 *
 * ⚠️ The gap between the tag and the `export` is bounded by "up to the end of THIS
 * comment block", never further. A tag mentioned in a standalone comment that is not
 * attached to a declaration therefore matches nothing rather than latching onto the
 * next unrelated export. Executed, not reasoned: the fixture block below runs it.
 *
 * ⚠️ **No deduplication, because a duplicate is not constructible — and the first draft
 * of this function added a `Set` for one that isn't.** The defining module explains the
 * convention INSIDE the docstring of a declaration that also carries the tag, so the
 * word appears twice above one `export`. That yields ONE name, not two: each match runs
 * from the tag to the end of the declaration line, so the earlier mention's match
 * swallows the later tag and `matchAll` resumes past it. Two matches capturing the same
 * name would need two non-overlapping spans ending at the same declaration, which
 * cannot happen. Measured, after the `Set` was added on the opposite belief and removing
 * it again changed no result — the file's own AC-4 rule (execute, don't reason) applied
 * to the code written to satisfy it.
 *
 * ⚠️ **Honest bound, in the fail-CLOSED direction:** the tag named in prose inside an
 * UNTAGGED declaration's own docstring reads as a tag on that declaration. It reds
 * rather than passes, and the fix is the repo's usual one — reword.
 */
function taggedNames(source: string): string[] {
  const re = new RegExp(
    `${GUARD_TAG}(?:(?!\\*/)[\\s\\S])*\\*/\\s*export (?:declare )?(?:type|interface|class) (\\w+)`,
    "g",
  );
  return [...source.matchAll(re)].map((m) => m[1] ?? "");
}

/** One top-level exported type-ish declaration, and the source it spans. */
type Decl = { readonly name: string; readonly body: string };

/**
 * Every top-level `export type|interface|class` in a module, with its own source.
 *
 * A declaration's body runs from its `export` keyword to the next COLUMN-ZERO
 * declaration keyword. Interface members, union arms and parameter lists are all
 * indented or start with a punctuator, so nothing inside a declaration ends it; the
 * next `export`/`declare`/`const`/`function` at column zero does.
 *
 * Callers pass source that has already been through {@link withoutComments}, so a
 * `{@link}` in a docstring cannot make a declaration look like it references anything.
 * That matters: {@link WarehouseSnapshotRequest}'s own docstring names a guarded type
 * and the request is NOT guarded.
 */
function topLevelExportedTypeDecls(stripped: string): Decl[] {
  const DECL = /^export (?:declare )?(?:type|interface|class) (\w+)/gm;
  const BOUNDARY = /^(?:export|declare|const|let|var|function|async|interface|type|class)\b/gm;
  const boundaries = [...stripped.matchAll(BOUNDARY)].map((m) => m.index);
  return [...stripped.matchAll(DECL)].map((m) => ({
    name: m[1] ?? "",
    body: stripped.slice(m.index, boundaries.find((b) => b > m.index) ?? stripped.length),
  }));
}

/**
 * The STRUCTURAL answer to "which exported types carry the brand?" — #5255's point.
 *
 * ⚠️ **This is the mechanism; {@link GUARD_TAG} is the documentation.** A tag is
 * something a person has to remember, so the sixth brand-carrying type added without
 * one would be invisible to a tag scan — which is precisely the hole #5255 exists to
 * close, and asserting tags against a hand-maintained array would have closed nothing
 * but restated it. This closure is computed from the module's own source and cannot be
 * forgotten.
 *
 * Transitive, because the brand travels by reference: the request names the symbol, the
 * runner and the verdict name the request, the validator names the verdict, and the
 * deps interface names the validator and the runner. Only the first hop is direct.
 *
 * ⚠️ A declaration's own name is NOT stripped from its body, and it does not need to
 * be: a declaration already in the closure is skipped, and one that is not cannot be
 * added by matching itself, since the only names searched for are the seed and names
 * already in the closure. A `slice` doing that strip was written here and MEASURED
 * dead — removing it changed no result — so it is gone rather than kept as a comment
 * about a case that cannot arise.
 */
function brandCarryingExports(strippedSource: string, seed: string): string[] {
  const decls = topLevelExportedTypeDecls(strippedSource);
  const carrying = new Set<string>();
  for (;;) {
    const before = carrying.size;
    for (const decl of decls) {
      if (carrying.has(decl.name)) continue;
      for (const ref of [seed, ...carrying]) {
        if (new RegExp(`\\b${ref}\\b`).test(decl.body)) {
          carrying.add(decl.name);
          break;
        }
      }
    }
    if (carrying.size === before) return [...carrying].toSorted();
  }
}

describe("the SQL-gate name allowlist (#5042, #5230, #5249, #5255)", () => {
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
    // ⚠️ Under `bun test` the tuple contributes NOTHING — the runner strips types
    // without checking them, so this assertion is the only live mechanism here and
    // the tuple is the only one in `bun run type`. Two gates, two mechanisms, neither
    // redundant.
    expect(GUARDED_NAMES.length, "a guarded name left the array; the scan silently narrowed").toBe(
      5,
    );
    // ⚠️ ARITY IS NOT IDENTITY, and the gap was measured. Substituting one name for a
    // COPY of another keeps the length at 5, keeps both spellings real exports, and
    // shrinks the positive-control loop along with the matcher — the whole suite
    // stayed GREEN while `NAME_RE` silently lost an alternative. The runner arm has no
    // assertion onto it anywhere and no unlisted file naming it, so it is the one a
    // copy-paste clobbers unnoticed.
    expect(
      new Set(GUARDED_NAMES).size,
      "two fragments assemble the same name — an arm left the matcher without shortening it",
    ).toBe(GUARDED_NAMES.length);

    const source = readFileSync(DEFINING_MODULE, "utf8");
    for (const name of GUARDED_NAMES) {
      expect(
        isExported(source, name),
        `${name} is no longer exported from lib/brain/warehouse-producer.ts. If it was ` +
          `renamed, update GUARDED_NAMES — the assembled fragments are invisible to the ` +
          `compiler, so a stale one silently matches nothing.`,
      ).toBe(true);
    }
  });

  test("the export check itself: prose must not satisfy it, a legal refactor must not RED it", () => {
    // ⚠️ This block exists because the machinery above had NO falsifier. Replacing
    // `withoutComments` with the identity function, or dropping its line anchor, each
    // left the suite green — so the rename check was protected by nothing, and that is
    // how the block-comment hole below shipped in the first place.
    const N = "SnapshotSql" + "Validator";
    // The real shape, which must pass.
    expect(isExported(`export type ${N} = (r: R) => V;`, N)).toBe(true);
    // A barrel re-export is legal and must pass, including multi-line.
    expect(isExported(`export type {\n  Other,\n  ${N},\n} from "./split";`, N)).toBe(true);
    // ⚠️ ...but a re-export that RENAMES it away is the rename, not an export of it.
    expect(isExported(`export type { ${N} as ${N}V2 } from "./split";`, N)).toBe(false);
    // Prose must not satisfy it — the line form the previous round closed...
    expect(isExported(`// export type ${N} = ... renamed in #9999`, N)).toBe(false);
    // ...the JSDoc form...
    expect(isExported(`/**\n * export type ${N} = (r: R) => V;\n */`, N)).toBe(false);
    // ...and the plain BLOCK form, whose body lines carry no `*` prefix. This is the
    // one a line-shape filter misses, and it is what "comment out the old declaration
    // during a rename" actually produces.
    expect(isExported(`/*\nexport type ${N} = (r: R) => V;\n*/`, N)).toBe(false);
    // A block comment opened mid-line, same reason.
    expect(isExported(`export type ${N}V2 = X; /* was:\nexport type ${N} = Y;\n*/`, N)).toBe(false);
    // The anchor: an indented match is not a top-level export.
    expect(isExported(`  export type ${N} = X;`, N)).toBe(false);
  });

  test("COMPLETENESS: a sixth brand-carrying export cannot arrive unnoticed (#5255)", () => {
    // ⚠️ The direction this file did NOT hold until #5255, and its header said so: the
    // list was hand-maintained, so a sixth brand-carrying export needed no file to
    // change for the guard to go stale. #5230 took the list from one name to five, and
    // the same edit today would have left a sixth uncovered from birth.
    //
    // TWO derivations, asserted against the assembled array and so against each other.
    // Neither subsumes the other and the difference is which failure each closes:
    //
    //   - TAGS answer "is the membership decision visible at the definition site?" They
    //     catch a tag added without a list entry, and a list entry whose tag was
    //     deleted. They CANNOT catch a sixth type nobody tagged.
    //   - The CLOSURE answers "which exported types actually reach the brand?" It is
    //     computed from the module's source, so it catches the sixth type nobody
    //     tagged. It cannot see a type that reaches the brand without naming anything
    //     — the `any`-wiring hole the negative controls below already pin.
    const source = readFileSync(DEFINING_MODULE, "utf8");
    const expected = [...GUARDED_NAMES].toSorted();

    const tagged = taggedNames(source).toSorted();
    expect(
      tagged,
      `the set of declarations tagged ${GUARD_TAG} in lib/brain/warehouse-producer.ts is not ` +
        `GUARDED_NAMES. A tagged name missing here means a guarded type nobody listed; a listed ` +
        `name missing there means a tag that was deleted or detached from its declaration.`,
    ).toEqual(expected);

    const stripped = withoutComments(source);
    const decls = topLevelExportedTypeDecls(stripped);
    // ⚠️ THE PARSER'S OWN FLOOR, and without it the assertion below is vacuous in the
    // most embarrassing way: a parser that finds NOTHING yields an empty closure, and a
    // parser that finds only the five yields the five. Measured at 19 top-level exported
    // type declarations in this module today; the floor is well under that so ordinary
    // refactoring does not trip it, and well over five so a broken parser does.
    expect(
      decls.length,
      "the declaration parser found almost nothing — the closure below would be vacuous",
    ).toBeGreaterThan(12);
    // ...and it must see the ones the closure REJECTS, or "rejected" means "never
    // looked at". The UNvalidated request is the sibling this whole guard must stay
    // clear of, and it is the name a broken parser would most plausibly still find.
    expect(
      decls.map((d) => d.name),
      "the parser no longer sees the module's UNguarded exports, so exclusion proves nothing",
    ).toContain("Warehouse" + "SnapshotRequest");
    // ⚠️ The guard EXERCISED on a real new export rather than only on the five it
    // was written around. #5277 added `EntityEdgeOutcome` to this module in the same
    // arc; it is a report shape naming `AliasProducerCounters` and nothing branded,
    // so the correct answer is "seen, and out of scope" — both halves asserted,
    // because "not in the closure" is what a parser that never saw it also says.
    expect(
      decls.map((d) => d.name),
      "the parser stopped seeing EntityEdgeOutcome, so its exclusion below proves nothing",
    ).toContain("EntityEdgeOutcome");
    expect(
      brandCarryingExports(stripped, BRAND_SYMBOL),
      "EntityEdgeOutcome now reaches the brand — tag it and list it, or remove the reference",
    ).not.toContain("EntityEdgeOutcome");

    expect(
      brandCarryingExports(stripped, BRAND_SYMBOL),
      `the set of exported types in lib/brain/warehouse-producer.ts that transitively reach the ` +
        `${BRAND_SYMBOL} brand is not GUARDED_NAMES. If a SIXTH one was just added, it is a ` +
        `sixth way to write a passing verdict by assertion: tag it ${GUARD_TAG}, add it to ` +
        `GUARDED_NAMES (widening the tuple), and add any file that names it to NAME_ALLOWLIST. ` +
        `If instead a type merely MENTIONS a guarded one incidentally, the mention is the thing ` +
        `to remove — a public type naming a branded one is a seam whether or not it meant to be.`,
    ).toEqual(expected);
  });

  test("the completeness machinery itself: fixtures, because a checker with no falsifier ships its blind spots", () => {
    // ⚠️ #5249's lesson applied to #5255's machinery on the way in rather than a round
    // later: the rename check shipped with no falsifier and its block-comment hole went
    // undetected until fixtures existed. These use INVENTED names and an invented seed,
    // so they are independent of the real module AND cannot put this file into its own
    // result set.
    const mod = [
      "/** The seed's own carrier.",
      " * @sql-gate-guarded",
      " */",
      "export type Carrier = Base & { readonly [brandSeed]: true };",
      "",
      "/** One hop out — reaches the seed only through Carrier.",
      " * @sql-gate-guarded",
      " */",
      "export interface Holder {",
      "  readonly run: (c: Carrier) => void;",
      "}",
      "",
      "/** Names Carrier in PROSE only — {@link Carrier} — and must NOT be guarded. */",
      "export type Bystander = { readonly n: number };",
      "",
      "/** Not exported, so no assertion can be written to it from outside. */",
      "type Private = Carrier;",
      "",
      "export type Unrelated = string;",
    ].join("\n");

    // The tag scan reads RAW source (the tag lives in a comment), the closure reads
    // stripped source. Two inputs, deliberately.
    expect(taggedNames(mod).toSorted()).toEqual(["Carrier", "Holder"]);
    expect(brandCarryingExports(withoutComments(mod), "brandSeed")).toEqual(["Carrier", "Holder"]);

    // ⚠️ The transitive hop is the arm that would silently vanish: a NON-transitive
    // closure returns just the direct carrier and the real assertion above would still
    // have to fail loudly rather than shrink quietly. Two elements, not one, so the
    // result cannot be confused with the direct-only answer (#5110's accidental
    // equality, where a fixture made two states the same value).
    expect(brandCarryingExports(withoutComments(mod), "brandSeed").length).toBe(2);

    // A sixth carrier added with NO tag: the closure catches it, the tag scan does not.
    // This is the whole reason both exist.
    const withUntagged = `${mod}\nexport type Sneaky = { readonly h: Holder };`;
    expect(taggedNames(withUntagged).toSorted()).toEqual(["Carrier", "Holder"]);
    expect(brandCarryingExports(withoutComments(withUntagged), "brandSeed")).toEqual([
      "Carrier",
      "Holder",
      "Sneaky",
    ]);

    // A tag DETACHED from its declaration — a stray mention in a comment of its own —
    // latches onto nothing. Without the "up to the end of THIS comment" bound it claims
    // the next export it can reach, which is a FALSE membership rather than a missing
    // one, and a false membership reds with a message about the wrong type entirely.
    //
    // ⚠️ The intervening comment is the whole fixture, and a first draft of this
    // assertion left it out and measured VACUOUS: with the stray tag placed directly
    // before a tagged declaration, a lazy unbounded gap reaches exactly the same name
    // the real tag reaches, so both matchers agree and the fixture discriminates
    // nothing. Replacing the bound with `[\s\S]*?` left the whole suite GREEN. What
    // separates them is a `*/` the gap must not cross to reach an UNTAGGED export.
    const strayTag = [
      "/** See @sql-gate-guarded for the convention. */",
      "/** An ordinary doc comment on an ordinary type. */",
      "export type Innocent = string;",
      "",
      mod,
    ].join("\n");
    expect(taggedNames(strayTag).toSorted()).toEqual(["Carrier", "Holder"]);

    // ...and the shape the real module actually has: the convention is EXPLAINED inside
    // the docstring of a declaration that also carries the tag, so the word appears
    // twice above one `export`. ONE name comes back, because the earlier mention's match
    // runs through the declaration and `matchAll` resumes past the second tag. Asserted
    // rather than assumed: a `Set` was added here for the duplicate this shape was
    // believed to produce, and removing the `Set` again changed no result.
    const explained = mod.replace(
      "/** The seed's own carrier.",
      "/** The seed's own carrier. Tagged @sql-gate-guarded, see the convention.",
    );
    expect(taggedNames(explained).toSorted()).toEqual(["Carrier", "Holder"]);

    // Prose alone must not enter the closure: `Bystander` names Carrier in a docstring.
    expect(brandCarryingExports(withoutComments(mod), "brandSeed")).not.toContain("Bystander");
    // A non-exported alias must not either — nothing outside can assert to it.
    expect(brandCarryingExports(withoutComments(mod), "brandSeed")).not.toContain("Private");
    // ...and a seed that appears nowhere yields nothing, so a mistyped seed reds the
    // real assertion instead of quietly agreeing with an emptied array.
    expect(brandCarryingExports(withoutComments(mod), "noSuchSymbol")).toEqual([]);
  });

  test("every scanned root exists, reaches its sentinel, and still yields its floor", () => {
    // ⚠️ Asserted rather than filtered. `existsSync`-and-skip would turn a renamed
    // directory into a silently smaller scan that still passes.
    expect(ROOTS.length, "a root left the list; the scan silently stopped covering it").toBe(8);
    for (const { dir, label, minFiles, sentinel } of ROOTS) {
      const name = label || "packages/api/src/";
      expect(existsSync(dir), `scan root missing: ${name} (${dir})`).toBe(true);
      const files = [...walk(dir)];
      // ⚠️ The sentinel, not the floor, is what answers "is this the right directory".
      // Two of the three floors were measured passable by repointing a root at its own
      // largest child; a reached-file check cannot be satisfied that way. It also
      // catches a `walk` narrowing that drops the sentinel's own directory — but only
      // that one; a narrowing elsewhere clears both this and the floor.
      expect(
        files,
        `scan root ${name} no longer reaches ${sentinel} — repointed, or did walk() narrow?`,
      ).toContain(join(dir, sentinel));
      expect(
        files.length,
        `scan root ${name} yielded fewer than ${minFiles} files. Either it was repointed at a ` +
          `subdirectory, or the package genuinely shrank — establish which before lowering ` +
          `this floor; the sentinel above distinguishes them.`,
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
    expect(found.toSorted(), SCAN_SCOPE_MESSAGE).toEqual(
      NAME_ALLOWLIST.map((b) => b.file).toSorted(),
    );
  });

  test("the failure message enumerates every scanned root — asserted, not hand-synchronised", () => {
    // ⚠️ #5255 AC-3. The {@link ROOTS} docstring used to say "if a root is added here,
    // add it there" and nothing enforced it, so a widened scan could ship under a
    // message asserting the OLD, narrower scope — telling a reader they were unchecked
    // in a directory that is now checked, or (worse, in the other direction) that a
    // directory is covered when it is not.
    for (const { label } of ROOTS) {
      const name = label || "packages/api/src/";
      expect(
        SCAN_SCOPE_MESSAGE,
        `the failure message does not name the scanned root ${name}. Add it — an enumeration ` +
          `is only as honest as its scope.`,
      ).toContain(name);
    }
    // ⚠️ The other direction, and it is not symmetric with the loop above: the loop
    // catches a root added to ROOTS and forgotten in the message; this catches a root
    // REMOVED from ROOTS and left in the message, which over-claims coverage. Counting
    // the root-shaped labels is the cheapest way to see the surplus one.
    expect(
      SCAN_SCOPE_MESSAGE.match(/\b(?:packages\/[a-z]+\/[a-z]+|ee\/src|plugins)\//g)?.length,
      "the message names a root the scan no longer covers — it now over-claims coverage",
    ).toBe(ROOTS.length);
    // ⚠️ And the guard against the guard: an empty-ish message would satisfy neither of
    // the above if ROOTS were also empty. The tuple type makes that a compile error, and
    // this pins the runtime half.
    expect(SCAN_SCOPE_MESSAGE.length).toBeGreaterThan(200);
  });

  test("the allowlist's kinds are counted, so adding a bypass is a visible edit", () => {
    // ⚠️ The NAME of this test used to promise that a bypass "cannot arrive dressed as
    // an annotation". Counting cannot give that: a mislabeller edits the entry and the
    // expected count in one hunk, and both are green. What counting DOES give is that
    // the edit is visible to a reviewer — which is worth having, and is all this
    // claims. The property the old name promised is held by the two checks below.
    const byKind: Record<AllowlistKind, number> = { bypass: 0, annotation: 0 };
    for (const entry of NAME_ALLOWLIST) byKind[entry.kind]++;
    expect(byKind).toEqual(EXPECTED_BY_KIND);
  });

  test("every kind is CHECKED against the tree, in both directions", () => {
    // ⚠️ The bypass arm restores a property #5249 removed: under the old line-keyed
    // matcher, deleting a cast while leaving its entry RED-ed the suite; a name scan
    // cannot see that, so an entry could over-claim forever.
    //
    // ⚠️ The annotation arm is the one the header's own threat model asks for — "a
    // real mint added as kind:'annotation' because that is the quieter word" — and it
    // was missing, so that exact edit passed everything. It is VACUOUS TODAY (zero
    // annotations) and load-bearing the moment the first one lands, which is the case
    // #5249's widening was written to invite. Do not delete it as dead.
    //
    // ⚠️ Both read through `withoutComments`. Reading raw source reproduced, in the
    // check added to fix it, the same prose vacuity the export check above was fixed
    // for: a comment narrating a cast satisfied the bypass arm after the cast itself
    // was gone.
    //
    // Honest limit: this uses the LEGACY matcher, so a bypass written in one of the
    // escape spellings reads as an annotation. It does not make `kind` sound; it makes
    // the common case falsifiable in both directions.
    const bypasses = NAME_ALLOWLIST.filter((e) => e.kind === "bypass");
    expect(bypasses.length, "no bypass entries — the arm below would be vacuous").toBeGreaterThan(
      0,
    );
    for (const entry of bypasses) {
      expect(
        LEGACY_AS_ADJACENT_RE.test(withoutComments(readFileSync(resolveEntry(entry.file), "utf8"))),
        `${entry.file} is listed kind "bypass" but contains no assertion form. If its cast ` +
          `was removed, demote it to "annotation" (and move the count); do not leave a stale ` +
          `over-claim in the list.`,
      ).toBe(true);
    }
    for (const entry of NAME_ALLOWLIST.filter((e) => e.kind === "annotation")) {
      expect(
        LEGACY_AS_ADJACENT_RE.test(withoutComments(readFileSync(resolveEntry(entry.file), "utf8"))),
        `${entry.file} is listed kind "annotation" but contains an assertion form — it is a ` +
          `bypass. Argue it as one rather than filing it under the quieter word.`,
      ).toBe(false);
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
    // also compiled against the repo's own checker while #5249 was written — each of
    // the four typechecks, which is what made them escapes rather than curiosities.
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
    // shrink together. An earlier draft claimed this loop did, and that was measured
    // false. Deletion is closed by the tuple and the length assert; SUBSTITUTION by
    // the distinctness assert — two different mechanisms, neither of them this loop.
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
