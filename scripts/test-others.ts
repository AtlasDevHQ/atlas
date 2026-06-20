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
 *   - Each package runs in its own `bun run --filter` process (per-package
 *     isolation; the isolated-runner packages keep their own runners — see
 *     #2802). We never collapse them into one `bun test` invocation.
 *   - Serial, fail-fast: the first failing package stops the run with its exit
 *     code, exactly like `cmd1 && cmd2 && ...`.
 *
 * @atlas/api is not run here. The root `test` script runs `test:api` before
 * `test:others`, so locally an api failure short-circuits the whole run before
 * this long tail. (In CI, `api-tests` and `test-others` are independent
 * parallel jobs — the ordering is a local `bun run test` property, not a
 * property of this script.)
 *
 * Coordinates with #2802 (bun test --parallel cutover): that work reshapes how
 * each package's own `test` script runs, not the enumeration this script owns,
 * so the two changes don't entangle.
 */
import { Glob } from "bun";
import { resolve } from "node:path";

/**
 * Packages intentionally NOT run here — the escape hatch for anything that
 * shouldn't ride this serial, fail-fast lane. @atlas/api is the only entry: the
 * root `test` script runs it first via `test:api`. Everything else is
 * auto-discovered. Discovery asserts each name here is actually present in the
 * workspace (see below), so a rename can't silently turn this into a no-op.
 */
const RUN_SEPARATELY = new Set<string>(["@atlas/api"]);

const repoRoot = resolve(import.meta.dir, "..");

interface WorkspacePackage {
  name: string;
  /** Workspace-relative dir, for log output only — execution keys off `name`. */
  dir: string;
}

async function discoverTestablePackages(): Promise<WorkspacePackage[]> {
  const rootPkgPath = resolve(repoRoot, "package.json");
  const rootPkg = (await Bun.file(rootPkgPath).json()) as {
    workspaces?: string[];
  };
  const patterns = rootPkg.workspaces ?? [];

  const byName = new Map<string, WorkspacePackage>();
  const excludedSeen = new Set<string>();

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
      if (RUN_SEPARATELY.has(pkg.name)) {
        excludedSeen.add(pkg.name);
        continue;
      }

      // Workspace globs can overlap; dedupe by package name.
      byName.set(pkg.name, { name: pkg.name, dir: rel.replace(/\/package\.json$/, "") });
    }
  }

  // Guard against RUN_SEPARATELY rot: if a name we mean to run elsewhere is no
  // longer a discoverable testable package (e.g. @atlas/api was renamed or lost
  // its `test` script), fail loudly. Otherwise the rename would silently either
  // drop the package from both lanes or double-run it here — exactly the kind of
  // silent gap this script exists to eliminate.
  for (const name of RUN_SEPARATELY) {
    if (!excludedSeen.has(name)) {
      throw new Error(
        `RUN_SEPARATELY lists "${name}", but no workspace package with that ` +
          `name and a "test" script was found. It was likely renamed — update ` +
          `RUN_SEPARATELY (and the matching test:api script) to match.`,
      );
    }
  }

  // Deterministic order for reproducible CI logs. The old chain's relative
  // order carried no meaning (tests are isolated per package).
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function runPackageTests(pkg: WorkspacePackage): Promise<number> {
  // One process per package (preserves per-package isolation). stdio "inherit"
  // streams each package's output to the CI log. We pass no `env`, so the child
  // inherits process.env — CI-set vars (e.g. ATLAS_BACKUP_VERIFY_SCRATCH_URL_TEST)
  // reach it. Don't add an `env` override here without spreading process.env.
  try {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "--filter", pkg.name, "test"],
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await proc.exited;
  } catch (err) {
    // Bun.spawn can throw synchronously (e.g. bun missing from PATH, fork
    // exhaustion). Keep the failing package's name in the message instead of
    // letting a bare spawn error bubble to the top-level catch unattributed.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to launch tests for ${pkg.name}: ${message}`);
  }
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
