#!/usr/bin/env bun
/**
 * Runs the test suite for every workspace package EXCEPT @atlas/api, which the
 * root `test` script runs first and separately via `test:api`.
 *
 * Why this exists: `test:others` used to be a hand-appended chain of ~32
 * `bun run --filter '<pkg>' test` invocations joined with `&&`. Every new
 * workspace package with a `test` script had to be remembered and appended to
 * the chain; forgetting was SILENT both locally and in CI — the package's tests
 * simply never ran. That already bit real packages (railway-sandbox shipped
 * without its entry in #3369; chat + email-digest were discovered un-covered
 * when this script was written). See #3372.
 *
 * This script discovers packages from the `workspaces` globs in the root
 * package.json, so a new package with a `test` script is picked up
 * automatically — it can no longer silently skip the full suite.
 *
 * Semantics preserved from the old `&&` chain:
 *   - @atlas/api runs first/separately (via `test:api`, not here).
 *   - Each package runs in its own `bun run --filter` process (per-package
 *     isolation; the isolated-runner packages keep their own runners — see
 *     #2802). We never collapse them into one `bun test` invocation.
 *   - Serial, fail-fast: the first failing package stops the run with its exit
 *     code, exactly like `cmd1 && cmd2 && ...`.
 *
 * Coordinates with #2802 (bun test --parallel cutover): that work reshapes how
 * each package's own `test` script runs, not the enumeration this script owns,
 * so the two changes don't entangle.
 */
import { Glob } from "bun";
import { resolve } from "node:path";

/**
 * Packages intentionally NOT run here. @atlas/api is the heaviest suite and
 * runs first via `test:api` so a failure there fails the whole run fast,
 * before the long tail of smaller packages. This is the single special-case;
 * everything else is auto-discovered.
 */
const RUN_SEPARATELY = new Set<string>(["@atlas/api"]);

const repoRoot = resolve(import.meta.dir, "..");

interface WorkspacePackage {
  name: string;
  dir: string;
}

async function discoverTestablePackages(): Promise<WorkspacePackage[]> {
  const rootPkgPath = resolve(repoRoot, "package.json");
  const rootPkg = (await Bun.file(rootPkgPath).json()) as {
    workspaces?: string[];
  };
  const patterns = rootPkg.workspaces ?? [];

  const byName = new Map<string, WorkspacePackage>();

  for (const pattern of patterns) {
    const glob = new Glob(`${pattern}/package.json`);
    for await (const rel of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
      const pkgPath = resolve(repoRoot, rel);
      let pkg: { name?: string; scripts?: Record<string, string> };
      try {
        pkg = (await Bun.file(pkgPath).json()) as typeof pkg;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse ${rel}: ${message}`);
      }

      const hasTest = typeof pkg.scripts?.test === "string";
      if (!hasTest) continue;

      if (!pkg.name) {
        throw new Error(`${rel} declares a "test" script but has no "name"`);
      }
      if (RUN_SEPARATELY.has(pkg.name)) continue;

      // Workspace globs can overlap; dedupe by package name.
      byName.set(pkg.name, { name: pkg.name, dir: rel.replace("/package.json", "") });
    }
  }

  // Deterministic order for reproducible CI logs. The old chain's relative
  // order carried no meaning (tests are isolated per package); api-first is
  // preserved by RUN_SEPARATELY above.
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function runPackageTests(pkg: WorkspacePackage): Promise<number> {
  // One process per package (preserves per-package isolation). Inherit stdio so
  // each package's test output streams to the CI log, and inherit env so CI-set
  // vars (e.g. ATLAS_BACKUP_VERIFY_SCRATCH_URL_TEST) reach the child.
  const proc = Bun.spawn({
    cmd: ["bun", "run", "--filter", pkg.name, "test"],
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

async function main(): Promise<void> {
  const listOnly = process.argv.includes("--list");
  const packages = await discoverTestablePackages();

  if (packages.length === 0) {
    throw new Error(
      "No workspace packages with a 'test' script were discovered — the " +
        "workspaces globs or package layout likely changed. Refusing to exit " +
        "green on an empty test run.",
    );
  }

  console.log(
    `[test:others] ${listOnly ? "Discovered" : "Running tests for"} ` +
      `${packages.length} packages ` +
      `(@atlas/api runs separately via test:api):`,
  );
  for (const pkg of packages) console.log(`  - ${pkg.name}  [${pkg.dir}]`);
  console.log("");

  if (listOnly) return;

  for (const pkg of packages) {
    console.log(`[test:others] → ${pkg.name}`);
    const code = await runPackageTests(pkg);
    if (code !== 0) {
      console.error(`[test:others] ✗ ${pkg.name} failed (exit ${code})`);
      process.exit(code);
    }
  }

  console.log(`[test:others] ✓ All ${packages.length} packages passed`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[test:others] ${message}`);
  process.exit(1);
});
