#!/usr/bin/env bun
/**
 * check-template-deps.ts — CI gate: every bare-specifier import in the source
 * `prepare-templates.sh` copies into a create-atlas template must be declared in
 * that template's `package.json`.
 *
 * ## Why this exists (#5421)
 *
 * `create-atlas/scripts/prepare-templates.sh` copies `packages/api/src` verbatim
 * into both templates, so an `import` added under `lib/**` ships to every
 * scaffolded project immediately. The templates' dependency lists, however, are
 * maintained BY HAND. Nothing joined the two facts:
 *
 *   - `check-template-drift.sh` compares template *source* against monorepo
 *     source. It reads no manifest.
 *   - syncpack reconciles version *ranges* for deps appearing in more than one
 *     manifest. A dep listed in NO template manifest is not a mismatch, so
 *     syncpack is structurally incapable of seeing this.
 *
 * The failure was therefore remote, delayed and misattributed: nothing failed in
 * the PR that introduced it, and it surfaced later as a Deploy Validation
 * scaffold breaking on `npm install`, in a run whose diff contained no clue.
 * Caught by hand on #5354/#5419; the fix there was two hand-edited manifests —
 * the same manual step that had just failed.
 *
 * ## What this checks, and what it deliberately does not
 *
 * PRESENCE ONLY. This gate answers "is the package declared at all?".
 *
 * VERSION RANGES ARE SYNCPACK'S HALF, and this gate defers to it on purpose.
 * Once a dep appears in a template manifest it is a multi-manifest dep, which is
 * exactly the case syncpack was already reconciling — `bun x syncpack lint` runs
 * as the first step of the same `drift` job, and `prepare-templates.sh` runs
 * `syncpack fix` at publish time. Re-asserting ranges here would be a second
 * copy of a rule that already has an owner, and the two copies would disagree.
 * So: this gate owns PRESENCE, syncpack owns RANGES. That split is the whole
 * answer to "which tool owns which half" — do not re-derive it.
 *
 * This is also deliberately NOT a hand-maintained allowlist of "deps the
 * templates need". That is the artifact that just failed; a second copy of it
 * fails the same way. Everything below is resolved from the tree.
 *
 * ## Usage
 *
 *   bun scripts/check-template-deps.ts               # prepare + check
 *   bun scripts/check-template-deps.ts --skip-prepare # templates already generated
 *   bun scripts/check-template-deps.ts --self-test    # adversarial fixtures
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = join(ROOT, "create-atlas", "templates");

/** Templates are discovered from disk, not listed — a new one is covered on arrival. */
function discoverTemplates(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((name) => existsSync(join(TEMPLATES_DIR, name, "package.json")))
    .sort();
}

/**
 * Directories that never contain template-shipped source. Everything else under
 * a template is walked, so this gate cannot fall out of step with the copy list
 * in prepare-templates.sh the way a hardcoded set of source roots would.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  ".git",
  "dist",
  "build",
  "data",
  "semantic",
  "public",
]);

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Test files, matching exactly what prepare-templates.sh strips from `src/`
 * (lines 63-67, 146-150). It does NOT strip them from the CLI `bin/` and `lib/`
 * copies, so a handful still reach scaffolded projects and import workspace-only
 * packages (`@atlas/mcp`) that no scaffold can resolve. That is a real defect —
 * and a different one from this gate's, which is about the deps of shipped app
 * source. Excluded here rather than silently absorbed; recorded on #5421.
 */
const TEST_DIRS = new Set(["__tests__", "__mocks__", "__test-utils__"]);
const TEST_FILE = /(^|\.)(test|spec)\.[cm]?[jt]sx?$|^test-setup\.ts$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // A template directory we cannot read is a real problem, not something to
    // skip silently — a gate that quietly checks nothing is the failure mode
    // this whole file exists to close.
    throw new Error(
      `Cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch (err) {
      // Broken symlink or a file that vanished mid-walk. Report and move on;
      // it cannot carry an import either way.
      console.warn(
        `  warn: skipping ${full}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry) || TEST_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (SOURCE_EXT.test(entry) && !TEST_FILE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip comments and template literals so a specifier mentioned in prose or in
 * an interpolated string cannot be read as an import.
 */
function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``");
}

/**
 * ## Which imports count, and why the narrow set is the correct one
 *
 * FLAGGED — static, build-time-resolved specifiers. These are what a bundler
 * must resolve for `next build` / `npm install` to succeed, and they are the
 * class the motivating defect belonged to (`email-reply-parser`, a plain
 * top-level `import` under `lib/**`, #5354/#5419):
 *
 *   import x from "y"      import "y"      export … from "y"
 *
 * NOT FLAGGED — `import("y")`, `require("y")` and `typeof import("y")`.
 * These are the repo's deliberate lazy optional-driver pattern: the ClickHouse,
 * Snowflake and DuckDB drivers, and the whole `@opentelemetry/sdk-node` graph,
 * are loaded inside a function precisely so a scaffolded project that does not
 * use that datasource never needs the package installed. `lib/telemetry.ts`
 * documents the intent in its own header. Flagging these would demand a
 * scaffolded project declare every driver it might never touch — inverting a
 * deliberate design — and would bury the static case this gate exists to catch
 * under ~30 findings nobody would act on.
 *
 * `import type` is likewise not flagged: it is erased before the bundler runs,
 * so it cannot break `npm install` or `next build`. It CAN affect a scaffolded
 * project's `bun run type`; that is a real but separate exposure, and one this
 * gate deliberately leaves out rather than conflate with the build-breaking
 * class. See the note in the PR for #5421.
 */
const IMPORT_PATTERNS: RegExp[] = [
  // import defaultOrNamed from "y"  /  import … , … from "y"
  // `from` is mandatory here: without it, `export const X = "some string"`
  // parses as an import and the gate reports a sentence as a package name.
  /(?:^|[\s;}])import\s+(?!type\s)[^;'"]*?\sfrom\s*(["'])([^"']+)\1/gm,
  // import "y" — bare side-effect import, no clause at all.
  // Anchored to a statement boundary, not merely to whitespace: the prose
  // `"  Run 'atlas import' later to retry.\n"` has `import` after a space and a
  // quote right behind it, and matched until the regex required both a real
  // statement start and a MATCHING closing quote (the backreference below).
  /(?:^|[;}])\s*import\s*(["'])([^"']+)\1/gm,
  // export … from "y"  (re-export; `export type … from` excluded)
  /(?:^|[\s;}])export\s+(?!type\s)[^;'"]*?\sfrom\s*(["'])([^"']+)\1/gm,
];

export function extractSpecifiers(src: string): string[] {
  const clean = stripNoise(src);
  const found = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      // Group 1 is the quote character (backreferenced to force a matching
      // close quote); group 2 is the specifier.
      const spec = m[2];
      if (spec) found.add(spec);
    }
  }
  return [...found];
}

/**
 * tsconfig `paths` prefixes that resolve INSIDE the copied tree. These are not
 * npm packages and must never be flagged. Read from the template's own
 * tsconfig.json rather than hardcoded, so a new alias is honoured automatically.
 */
function aliasPrefixes(templateDir: string): string[] {
  const tsconfigPath = join(templateDir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return [];
  let parsed: { compilerOptions?: { paths?: Record<string, unknown> } };
  try {
    // Template tsconfigs are plain JSON (no trailing commas / comments today),
    // but strip line comments defensively so a future JSONC edit does not turn
    // this gate into a false green.
    const raw = readFileSync(tsconfigPath, "utf8").replace(
      /(^|[^:"])\/\/[^\n]*/g,
      "$1",
    );
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Cannot parse ${tsconfigPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return Object.keys(parsed.compilerOptions?.paths ?? {});
}

function matchesAlias(spec: string, aliases: string[]): boolean {
  for (const alias of aliases) {
    if (alias.endsWith("/*")) {
      if (spec.startsWith(alias.slice(0, -1))) return true;
    } else if (spec === alias) {
      return true;
    }
  }
  return false;
}

const BUILTINS = new Set(builtinModules);

/** "@scope/name/sub" -> "@scope/name"; "pino/file" -> "pino". */
export function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

export function isBareSpecifier(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (spec.startsWith("node:") || spec.startsWith("bun:")) return false;
  if (BUILTINS.has(packageNameOf(spec))) return false;
  return true;
}

function declaredPackages(manifestPath: string): Set<string> {
  let pkg: Record<string, Record<string, string> | undefined>;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Cannot parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const name of Object.keys(pkg[field] ?? {})) names.add(name);
  }
  return names;
}

/**
 * Known exceptions — each a REAL defect with a ticket, not an "allowlist of deps
 * the templates need". The issue rules that allowlist out, and rightly: it is
 * the hand-maintained artifact that failed in the first place. This is the other
 * thing — a short, named list of specifiers whose correct fix is NOT "add it to
 * the manifest", so leaving the gate red on them would only train people to
 * ignore it.
 *
 * `@atlas/mcp` is `private: true` and is never published, so no manifest entry
 * could ever resolve it in a scaffolded project. It reaches templates through
 * the CLI `bin/` copy, in two internal eval harnesses
 * (`canonical-eval-mcp-llm.ts`, `canonical-eval-tool-selection.ts`) that a
 * customer scaffold has no reason to run. It cannot break `npm install` or
 * `next build`: `bin/` is outside the template tsconfig's `include` (which is
 * `src/**` only) and outside the Next build graph, and both harnesses are
 * reached only through `await import()` in `canonical-eval-run.ts`. The real fix
 * is to stop copying internal eval tooling into customer templates, which is a
 * product decision about the scaffold's CLI surface rather than a manifest edit.
 */
const KNOWN_EXCEPTIONS = new Map<string, string>([
  [
    "@atlas/mcp",
    "private:true workspace package; no manifest entry can resolve it. Ships via the " +
      "CLI bin/ copy in internal eval harnesses. Not build-breaking (bin/ is outside " +
      "the template tsconfig include and the Next build graph). See #5421.",
  ],
]);

interface Missing {
  pkg: string;
  sites: string[];
}

function checkTemplate(template: string): Missing[] {
  const templateDir = join(TEMPLATES_DIR, template);
  const declared = declaredPackages(join(templateDir, "package.json"));
  const aliases = aliasPrefixes(templateDir);
  const files = walk(templateDir);

  const missing = new Map<string, Set<string>>();
  const excepted = new Set<string>();
  let specifierCount = 0;

  for (const file of files) {
    const rel = file.slice(templateDir.length + 1);
    for (const spec of extractSpecifiers(readFileSync(file, "utf8"))) {
      if (!isBareSpecifier(spec)) continue;
      if (matchesAlias(spec, aliases)) continue;
      specifierCount++;
      const name = packageNameOf(spec);
      if (declared.has(name)) continue;
      if (KNOWN_EXCEPTIONS.has(name)) {
        excepted.add(name);
        continue;
      }
      if (!missing.has(name)) missing.set(name, new Set());
      missing.get(name)!.add(rel);
    }
  }

  console.log(
    `:: ${template}: ${files.length} source files, ${specifierCount} bare-specifier imports, ${declared.size} declared packages`,
  );
  // Print the exceptions every run. A suppressed finding that nobody ever sees
  // again is how the next reader concludes the tree is clean when it is not.
  for (const name of [...excepted].sort()) {
    console.log(`   known exception: ${name} — ${KNOWN_EXCEPTIONS.get(name)}`);
  }

  return [...missing.entries()]
    .map(([pkg, sites]) => ({ pkg, sites: [...sites].sort().slice(0, 5) }))
    .sort((a, b) => a.pkg.localeCompare(b.pkg));
}

// ── Adversarial fixtures ────────────────────────────────────────────
// The gate that cannot demonstrate it fires is not a verified gate (#5421 AC2).
// These assert the detector's boundaries directly, so they run in CI in seconds
// rather than depending on a historical checkout.
function selfTest(): number {
  const cases: Array<{ name: string; ok: boolean }> = [];
  const check = (name: string, ok: boolean) => cases.push({ name, ok });

  const bare = (src: string) =>
    extractSpecifiers(src).filter(isBareSpecifier).map(packageNameOf);

  check(
    "flags a plain default import",
    bare(`import EmailReplyParser from "email-reply-parser";`).includes(
      "email-reply-parser",
    ),
  );
  check(
    "flags a named import",
    bare(`import { z } from "zod";`).includes("zod"),
  );
  check(
    "does NOT flag a type-only import (erased before the bundler runs)",
    bare(`import type { Foo } from "some-types-pkg";`).length === 0,
  );
  check(
    "flags a re-export",
    bare(`export { a } from "reexported-pkg";`).includes("reexported-pkg"),
  );
  check(
    "flags a bare side-effect import",
    bare(`import "side-effect-pkg";`).includes("side-effect-pkg"),
  );
  check(
    "does NOT flag a dynamic import (the lazy optional-driver pattern)",
    bare(`const m = await import("dynamic-pkg");`).length === 0,
  );
  check(
    "does NOT flag require()",
    bare(`const x = require("cjs-pkg");`).length === 0,
  );
  check(
    "does NOT flag a typeof import() type query",
    bare(`type P = ReturnType<typeof import("snowflake-sdk").createPool>;`).length === 0,
  );
  // The regression that produced a 700-character sentence as a "package name":
  // with an optional `from`, `export const X = "…"` parsed as a re-export.
  check(
    "does NOT flag an exported string constant (#5421 regex regression)",
    bare(`export const REASON = "enumeration unavailable since <date>";`).length === 0,
  );
  // The second regex regression: `import` inside prose, with a quote right
  // behind it, matched across mismatched quote types.
  check(
    "does NOT flag the word import inside a string (#5421 regex regression)",
    bare(`const hint = "  Run 'atlas import' later to retry.\\n";`).length === 0,
  );
  check(
    "does NOT flag prose ending in the word import",
    bare(`const s = "once the API server is available to complete the import.";`)
      .length === 0,
  );
  check(
    "does NOT flag a plain string assignment",
    bare(`const msg = "not-a-package";`).length === 0,
  );
  check(
    "still flags a multi-line import clause",
    bare(`import {\n  a,\n  b,\n} from "multiline-pkg";`).includes("multiline-pkg"),
  );
  check(
    "still flags a default+named import",
    bare(`import def, { named } from "mixed-pkg";`).includes("mixed-pkg"),
  );
  check(
    "collapses a subpath to its package",
    bare(`import x from "pino/file";`).includes("pino"),
  );
  check(
    "collapses a scoped subpath to scope/name",
    bare(`import x from "@scope/pkg/deep/path";`).includes("@scope/pkg"),
  );
  check(
    "does NOT flag a relative import",
    bare(`import x from "./local";`).length === 0,
  );
  check(
    "does NOT flag a parent-relative import",
    bare(`import x from "../../lib/thing";`).length === 0,
  );
  check(
    "does NOT flag node: builtins",
    bare(`import { readFileSync } from "node:fs";`).length === 0,
  );
  check(
    "does NOT flag bare builtins",
    bare(`import path from "path";`).length === 0,
  );
  check(
    "does NOT flag a specifier inside a line comment",
    bare(`// import x from "commented-pkg";`).length === 0,
  );
  check(
    "does NOT flag a specifier inside a block comment",
    bare(`/* import x from "blocked-pkg"; */`).length === 0,
  );
  check(
    "does NOT read a URL's // as a comment",
    bare(`import x from "real-pkg"; const u = "https://example.com/x";`).includes(
      "real-pkg",
    ),
  );

  const aliases = ["@/*", "@atlas/api/*", "@atlas/okf-bundle", "@useatlas/schemas/*"];
  check(
    "does NOT flag the @/* alias",
    matchesAlias("@/lib/thing", aliases) === true,
  );
  check(
    "does NOT flag @atlas/api/*",
    matchesAlias("@atlas/api/lib/agent", aliases) === true,
  );
  check(
    "does NOT flag an exact (non-wildcard) alias",
    matchesAlias("@atlas/okf-bundle", aliases) === true,
  );
  check(
    "DOES flag a real @useatlas package that is not aliased",
    matchesAlias("@useatlas/react", aliases) === false,
  );

  let failed = 0;
  for (const c of cases) {
    if (!c.ok) {
      console.error(`  FAIL: ${c.name}`);
      failed++;
    }
  }
  console.log(
    `:: self-test: ${cases.length - failed}/${cases.length} fixtures passed`,
  );
  return failed;
}

// ── Main ────────────────────────────────────────────────────────────
const args = new Set(Bun.argv.slice(2));

if (args.has("--self-test")) {
  process.exit(selfTest() > 0 ? 1 : 0);
}

if (!args.has("--skip-prepare")) {
  console.log(":: Running prepare-templates.sh (SKIP_SYNCPACK=1)...");
  const proc = Bun.spawnSync(
    ["bash", "create-atlas/scripts/prepare-templates.sh"],
    { cwd: ROOT, env: { ...process.env, SKIP_SYNCPACK: "1" }, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    console.error(new TextDecoder().decode(proc.stderr));
    console.error("ERROR: prepare-templates.sh failed; cannot check template deps.");
    process.exit(1);
  }
}

let totalMissing = 0;
for (const template of discoverTemplates()) {
  const missing = checkTemplate(template);
  for (const { pkg, sites } of missing) {
    console.log(
      `::error file=create-atlas/templates/${template}/package.json::` +
        `"${pkg}" is imported by template source but not declared in ` +
        `create-atlas/templates/${template}/package.json (e.g. ${sites.join(", ")})`,
    );
    totalMissing++;
  }
}

if (totalMissing > 0) {
  console.log("");
  console.log(
    `ERROR: ${totalMissing} package(s) reach scaffolded projects' source but not their package.json.`,
  );
  console.log("");
  console.log("Fix: add each package to the named template manifest with the same");
  console.log("range packages/api/package.json declares, then run `bun run deps:fix`");
  console.log("(syncpack) so every declaring site moves together.");
  console.log("");
  console.log("Why this fails here and not in the PR that broke it: prepare-templates.sh");
  console.log("copies packages/api/src verbatim into both templates, so a new import under");
  console.log("lib/** ships to every scaffolded project immediately — while the template");
  console.log("manifests are maintained by hand. See #5421.");
  process.exit(1);
}

console.log("Template dependency check passed — every bare-specifier import is declared.");
