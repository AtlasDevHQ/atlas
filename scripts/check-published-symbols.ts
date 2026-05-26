#!/usr/bin/env bun
// Diff symbols imported from each `@useatlas/*` workspace package against
// the symbols exported by the version of that package currently pinned in
// `create-atlas/templates/*/package.json`.
//
// Why: scaffold smoke tests run `bun install` from the registry, so any
// source that ends up in the scaffold (via prepare-templates.sh) is
// compiled against the *published* version of `@useatlas/*` packages, not
// the workspace version. If a monorepo file imports a symbol that exists
// locally but not in the published version, the scaffold's `bun install`
// + build step fails late in CI with a confusing "Cannot find name X"
// error.
//
// This gate catches that drift locally, before push. See the
// version-bump-ordering memory for the publish-then-bump rule.

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  type Dirent,
} from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const TEMPLATE_PKG_JSONS = [
  "create-atlas/templates/nextjs-standalone/package.json",
  "create-atlas/templates/docker/package.json",
];

// Directories whose .ts/.tsx source is copied into scaffold templates by
// create-atlas/scripts/prepare-templates.sh. If you add a new copy target
// there, mirror it here. Tests / mocks / test-utils are filtered out —
// prepare-templates.sh strips them too.
const SCAFFOLD_BOUND_DIRS = [
  "packages/api/src",
  "packages/cli/src",
  "packages/cli/bin",
  "packages/cli/lib",
  "packages/web/src",
  "packages/schemas/src",
  "ee/src",
  "examples/nextjs-standalone/src",
  "create-atlas/overrides",
];

const SCAFFOLD_STRIPPED = [
  /\/__tests__\//,
  /\/__mocks__\//,
  /\/__test-utils__\//,
  /\.test\.tsx?$/,
  /\/test-setup\.ts$/,
];

interface PinnedPackage {
  name: string;
  /** The actual version resolved from the template's range (what scaffolds install). */
  resolvedVersion: string;
  /** The original range string (for error messages). */
  range: string;
  /** Subpath ("." or "./foo") → resolved source file path in extracted tarball. */
  subpaths: Map<string, string>;
  /** Memoized: subpath → set of exported names (recursive). */
  exportsBySubpath: Map<string, Set<string>>;
}

interface UsedSymbol {
  pkg: string;
  /** "." for root or "./lead-normalizer" for subpath imports. */
  subpath: string;
  symbol: string;
  file: string;
  line: number;
}

function compareVersions(a: string, b: string): number {
  // Strip pre-release suffix for ordering — we don't expect prereleases in
  // template pins, but a stray one shouldn't crash the comparator.
  const stripPre = (v: string) => v.split("-")[0];
  const pa = stripPre(a).split(".").map((p) => parseInt(p, 10));
  const pb = stripPre(b).split(".").map((p) => parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Map of `@useatlas/<pkg>` → set of dep ranges pinning it across templates. */
function collectPinnedRanges(): Map<string, Set<string>> {
  const pinned = new Map<string, Set<string>>();
  for (const tplRel of TEMPLATE_PKG_JSONS) {
    const tplPath = join(REPO_ROOT, tplRel);
    if (!existsSync(tplPath)) continue;
    const pkg = JSON.parse(readFileSync(tplPath, "utf8"));
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith("@useatlas/")) continue;
      if (typeof range !== "string") continue;
      if (
        range.startsWith("workspace:") ||
        range.startsWith("file:") ||
        range.startsWith("link:")
      ) {
        continue;
      }
      let set = pinned.get(name);
      if (!set) {
        set = new Set();
        pinned.set(name, set);
      }
      set.add(range);
    }
  }
  return pinned;
}

const PKG_NAME_RE = /^@useatlas\/[a-z0-9][a-z0-9._-]*$/i;
const RANGE_RE = /^[0-9A-Za-z.+\-^~=<>|\s*xX]+$/;

/**
 * Resolve a dep range to the highest published version matching it — i.e.
 * what `bun install` from a scaffold actually picks. `^0.0.X` is semver-
 * exact so this returns the pin verbatim for plugins on 0.0.x. `^0.1.X+`
 * returns the latest published patch/minor.
 */
function resolveRange(name: string, range: string): string {
  if (!PKG_NAME_RE.test(name)) {
    throw new Error(`Refusing to query suspicious package name: ${JSON.stringify(name)}`);
  }
  if (!RANGE_RE.test(range)) {
    throw new Error(`Refusing to pass suspicious version range to npm view: ${JSON.stringify(range)}`);
  }
  const out = execFileSync(
    "npm",
    ["view", `${name}@${range}`, "version", "--json"],
    { encoding: "utf8" },
  ).trim();
  if (!out) {
    throw new Error(`npm view returned nothing for ${name}@${range} — no published version matches the range`);
  }
  const parsed = JSON.parse(out);
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed) && parsed.length > 0) {
    return [...parsed].sort(compareVersions).at(-1) as string;
  }
  throw new Error(`Unexpected npm view output for ${name}@${range}: ${out}`);
}

function resolveExportTarget(def: unknown): string | null {
  if (typeof def === "string") return def;
  if (def && typeof def === "object") {
    const obj = def as Record<string, unknown>;
    for (const k of ["types", "import", "default", "require"]) {
      const v = obj[k];
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        const inner = resolveExportTarget(v);
        if (inner) return inner;
      }
    }
  }
  return null;
}

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function fetchPackage(
  name: string,
  resolvedVersion: string,
  range: string,
  cacheRoot: string,
): PinnedPackage {
  if (!PKG_NAME_RE.test(name)) {
    throw new Error(`Refusing to fetch suspicious package name: ${JSON.stringify(name)}`);
  }
  if (!VERSION_RE.test(resolvedVersion)) {
    throw new Error(
      `Refusing to fetch suspicious resolved version: ${JSON.stringify(resolvedVersion)}`,
    );
  }

  const safeName = name.replace("@", "").replace("/", "-");
  const extractDir = join(cacheRoot, `${safeName}-${resolvedVersion}`);
  const pkgRoot = join(extractDir, "package");

  if (!existsSync(pkgRoot)) {
    mkdirSync(extractDir, { recursive: true });
    const tarballUrl = execFileSync(
      "npm",
      ["view", `${name}@${resolvedVersion}`, "dist.tarball"],
      { encoding: "utf8" },
    ).trim();
    if (!tarballUrl) {
      throw new Error(`npm view returned no tarball URL for ${name}@${resolvedVersion}`);
    }
    // Loose sanity check on the URL — inputs were already validated; this
    // catches the case where a registry returns something we can't safely
    // hand to execFileSync (which doesn't spawn a shell, but we still don't
    // want to download an exotic redirect).
    if (!/^https:\/\/\S+\.tgz$/.test(tarballUrl) || /[\s"'`$;|&<>()]/.test(tarballUrl)) {
      throw new Error(`Unexpected tarball URL from npm view: ${tarballUrl}`);
    }
    const tarPath = join(extractDir, "pkg.tgz");
    execFileSync("curl", ["-fsSL", tarballUrl, "-o", tarPath]);
    execFileSync("tar", ["-xzf", tarPath, "-C", extractDir]);
  }

  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const subpaths = new Map<string, string>();
  const exportsField = pkgJson.exports;
  if (exportsField && typeof exportsField === "object") {
    for (const [subpath, def] of Object.entries(exportsField)) {
      const file = resolveExportTarget(def);
      if (file) subpaths.set(subpath, join(pkgRoot, file));
    }
  }
  if (!subpaths.has(".")) {
    const main = pkgJson.types ?? pkgJson.main;
    if (main) subpaths.set(".", join(pkgRoot, main));
  }

  return {
    name,
    resolvedVersion,
    range,
    subpaths,
    exportsBySubpath: new Map(),
  };
}

function tryResolveFile(p: string): string | null {
  const candidates = [
    p,
    p + ".ts",
    p + ".tsx",
    p + ".d.ts",
    p + ".js",
    p + ".mjs",
    join(p, "index.ts"),
    join(p, "index.tsx"),
    join(p, "index.d.ts"),
    join(p, "index.js"),
    join(p, "index.mjs"),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // not found, keep looking
    }
  }
  return null;
}

function loadExports(filePath: string, visited = new Set<string>()): Set<string> {
  const result = new Set<string>();
  const real = tryResolveFile(filePath);
  if (!real || visited.has(real)) return result;
  visited.add(real);

  let src: string;
  try {
    src = readFileSync(real, "utf8");
  } catch {
    return result;
  }

  // Strip comments so commented-out exports don't get counted.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");

  // Pattern A: `export { a, b as c, type Foo } [from "..."]`
  const blockRe = /export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?/g;
  for (const m of stripped.matchAll(blockRe)) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const raw of names) {
      const cleaned = raw.replace(/^type\s+/, "");
      const parts = cleaned.split(/\s+as\s+/).map((s) => s.trim());
      const exportedName = parts[1] ?? parts[0];
      if (exportedName) result.add(exportedName);
    }
  }

  // Pattern B: `export <decl> name`
  const declRe =
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+(\w+)/g;
  for (const m of stripped.matchAll(declRe)) {
    result.add(m[1]);
  }

  // Pattern C: `export * from "..."` — recurse for relative paths.
  const starRe = /export\s+\*\s+from\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(starRe)) {
    if (!m[1].startsWith(".")) continue;
    const target = resolve(dirname(real), m[1]);
    for (const n of loadExports(target, visited)) result.add(n);
  }

  // Pattern D: `export * as ns from "..."` — adds `ns` only.
  const starAsRe = /export\s+\*\s+as\s+(\w+)\s+from\s*["'][^"']+["']/g;
  for (const m of stripped.matchAll(starAsRe)) {
    result.add(m[1]);
  }

  return result;
}

function scanImports(pinnedNames: Set<string>): UsedSymbol[] {
  const usages: UsedSymbol[] = [];
  for (const dir of SCAFFOLD_BOUND_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    walkDir(abs, (file) => {
      if (!/\.(t|j)sx?$/.test(file)) return;
      if (SCAFFOLD_STRIPPED.some((re) => re.test(file))) return;
      const src = readFileSync(file, "utf8");
      if (!src.includes("@useatlas/")) return;

      // Value imports only. Type-only imports (`import type { ... }` or
      // inline `import { type X }`) erase at compile time, so missing
      // type-only symbols don't break the scaffold's `next build` (which
      // runs with `typescript: { ignoreBuildErrors: true }` anyway).
      // Gating type-only imports would over-fire on drift that doesn't
      // actually fail CI. Default/namespace imports don't bind specific
      // exported names so they also can't trigger the drift we're guarding.
      const re =
        /import\s+(type\s+)?\{([^}]+)\}\s+from\s*["'](@useatlas\/[^"']+)["']/g;
      for (const m of src.matchAll(re)) {
        const isTypeOnlyImport = Boolean(m[1]);
        if (isTypeOnlyImport) continue;
        const namesStr = m[2];
        const spec = m[3];
        const afterScope = spec.indexOf("/", "@useatlas/".length);
        const pkgName = afterScope === -1 ? spec : spec.slice(0, afterScope);
        const subpath = afterScope === -1 ? "." : "." + spec.slice(afterScope);
        if (!pinnedNames.has(pkgName)) continue;
        const lineNumber = src.slice(0, m.index ?? 0).split("\n").length;
        const names = namesStr
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const raw of names) {
          // Inline `type` prefix marks this specifier as type-only — skip.
          if (/^type\s+/.test(raw)) continue;
          const orig = raw.split(/\s+as\s+/)[0].trim();
          if (!orig) continue;
          usages.push({ pkg: pkgName, subpath, symbol: orig, file, line: lineNumber });
        }
      }
    });
  }
  return usages;
}

function walkDir(dir: string, fn: (file: string) => void) {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (
        ent.name === "node_modules" ||
        ent.name === "dist" ||
        ent.name === ".next" ||
        ent.name === ".turbo"
      ) {
        continue;
      }
      walkDir(full, fn);
    } else if (ent.isFile()) {
      fn(full);
    }
  }
}

function main() {
  const ranges = collectPinnedRanges();
  if (ranges.size === 0) {
    console.log(
      "No registry-pinned @useatlas/* packages found in create-atlas/templates/*/package.json — nothing to check.",
    );
    return;
  }

  console.log(
    `Checking ${ranges.size} pinned @useatlas/* package(s) against scaffold-bound source...`,
  );

  // Cache tarballs across runs, versioned by name+resolvedVersion. /tmp is
  // fine; user can wipe any time. Repeat runs land in ~100ms after first fetch.
  const cacheRoot = join(tmpdir(), "atlas-published-symbols-cache");
  mkdirSync(cacheRoot, { recursive: true });

  const pkgs = new Map<string, PinnedPackage>();
  for (const [name, rangeSet] of ranges.entries()) {
    // Resolve each pinning range; gate against the LOWEST resolved version —
    // the worst case any scaffold might install. In practice both templates
    // pin the same range so the set has one element.
    let chosenVersion: string | null = null;
    let chosenRange: string | null = null;
    for (const range of rangeSet) {
      let resolved: string;
      try {
        resolved = resolveRange(name, range);
      } catch (err) {
        console.log(`  ${name}@${range}... FAILED`);
        console.error(
          `::error::Could not resolve ${name}@${range}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        console.error(
          "  If this is a network or registry issue, retry. If no published version matches the range, publish first, then bump the ref in create-atlas/templates/*/package.json.",
        );
        process.exit(2);
      }
      if (!chosenVersion || compareVersions(resolved, chosenVersion) < 0) {
        chosenVersion = resolved;
        chosenRange = range;
      }
    }
    if (!chosenVersion || !chosenRange) continue;
    process.stdout.write(`  ${name}@${chosenRange} → ${chosenVersion}... `);
    try {
      pkgs.set(name, fetchPackage(name, chosenVersion, chosenRange, cacheRoot));
      console.log("ok");
    } catch (err) {
      console.log("FAILED");
      console.error(
        `::error::Could not fetch ${name}@${chosenVersion}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exit(2);
    }
  }

  const usages = scanImports(new Set(pkgs.keys()));
  const failures: UsedSymbol[] = [];

  for (const u of usages) {
    const pkg = pkgs.get(u.pkg);
    if (!pkg) continue;
    let exportsSet = pkg.exportsBySubpath.get(u.subpath);
    if (!exportsSet) {
      const sourceFile = pkg.subpaths.get(u.subpath);
      if (!sourceFile) {
        failures.push(u);
        continue;
      }
      exportsSet = loadExports(sourceFile);
      pkg.exportsBySubpath.set(u.subpath, exportsSet);
    }
    if (!exportsSet.has(u.symbol)) failures.push(u);
  }

  if (failures.length === 0) {
    console.log("Published symbol check passed.");
    return;
  }

  console.error(
    "\n::error::Symbols imported from @useatlas/* are not exported by the pinned-published versions:\n",
  );
  const byPkg = new Map<string, UsedSymbol[]>();
  for (const f of failures) {
    let arr = byPkg.get(f.pkg);
    if (!arr) {
      arr = [];
      byPkg.set(f.pkg, arr);
    }
    arr.push(f);
  }
  for (const [pkgName, items] of byPkg.entries()) {
    const pkg = pkgs.get(pkgName);
    if (!pkg) continue;
    console.error(
      `  ${pkgName}@${pkg.resolvedVersion} (range "${pkg.range}" in create-atlas/templates/*/package.json):`,
    );
    for (const u of items) {
      const importSpec =
        u.subpath === "." ? u.pkg : `${u.pkg}${u.subpath.slice(1)}`;
      console.error(`    ${relative(REPO_ROOT, u.file)}:${u.line}`);
      console.error(`      import { ${u.symbol} } from "${importSpec}"`);
    }
    console.error("");
  }
  console.error("Scaffold smoke tests will fail (`Scaffold (docker)` / `Scaffold (vercel)`)");
  console.error("because the scaffolded project runs `bun install` from the registry and");
  console.error("type-checks scaffold-bound source against the *published* tarball.\n");
  console.error("Fix (publish-then-bump — see version-bump-ordering memory):");
  console.error("  1) Bump `version` in plugins/<pkg>/package.json, merge.");
  console.error(
    "  2) Tag + push the release (e.g. `git tag twenty-v0.0.4 && git push origin twenty-v0.0.4`).",
  );
  console.error(
    "  3) Wait for the publish workflow to finish; verify the new version is on npm.",
  );
  console.error(
    "  4) In a follow-up PR, bump `@useatlas/<pkg>` in create-atlas/templates/*/package.json.",
  );
  console.error("");
  process.exit(1);
}

main();
