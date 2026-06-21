#!/usr/bin/env bun
// Recurrence guard for the "version bumped on main but never published" drift.
//
// Why: every `@useatlas/*` (and the `create-atlas*`) package publishes
// independently via a tag-triggered step in .github/workflows/publish.yml. The
// flow is publish-AFTER-merge: a PR bumps `version` in package.json, and only
// after it lands does someone push the `<prefix>-v<version>` tag that triggers
// the publish. That manual post-merge step gets forgotten — e.g. @useatlas/plugin-sdk
// drifted to 0.0.13 on main while npm sat at 0.0.9 (#3638/#3667 bumps were never
// tagged), and @useatlas/bigquery@0.0.6 shipped to main untagged. Consumers on a
// `>=` range silently miss the change.
//
// This turns that into a CI failure — but WITHOUT blocking the legitimate
// post-merge window. A bump INTRODUCED by the current change is exempt (it's
// about to be published); the guard only fails when a version that is already on
// the base (a PRIOR merge) is still missing from npm. So the bumping PR is green,
// and if the publish is then forgotten, the NEXT PR/push goes red until the tag
// is pushed.
//
// npm is the oracle, not git tags: some packages were first-published before the
// tag convention (or had tags pruned), so they're live on npm with no matching
// tag — a tag-based check would false-positive on them. "Published" == "the
// version resolves on the registry".
//
// Network/registry hiccups are non-fatal (warn + skip that package) so a blip
// can't block merges; a definite "unpublished + not introduced here" is fatal.
//
// This script ALSO runs a network-free structural guard (checkWorkflowCoverage)
// that keeps publish.yml's triggers + steps, the PREFIX_TO_DIR map, and the
// publishable packages on disk in lockstep — catching a package that is wired in
// one place but not the others (the silent-no-publish class, #3815).
//
// Usage: bun scripts/check-unpublished-versions.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dir, "..");

// SSOT for publishable packages: tag prefix (the part before `-v`) -> package
// dir, mirroring .github/workflows/publish.yml. The workflow-coverage guard
// (checkWorkflowCoverage, below) keeps this map, publish.yml's `on.push.tags`
// triggers, publish.yml's per-package steps, and the actual publishable
// workspace packages all in lockstep — so a new package can't be half-wired and
// silently never publish, and a tag prefix can't linger without a step and
// silently no-op when pushed.
const PREFIX_TO_DIR: Record<string, string> = {
  types: "packages/types",
  "atlas-agent": "create-atlas",
  "atlas-plugin": "create-atlas-plugin",
  sdk: "packages/sdk",
  "plugin-sdk": "packages/plugin-sdk",
  "webhook-publisher": "packages/webhook-publisher",
  react: "packages/react",
  bigquery: "plugins/bigquery",
  clickhouse: "plugins/clickhouse",
  snowflake: "plugins/snowflake",
  duckdb: "plugins/duckdb",
  mysql: "plugins/mysql",
  salesforce: "plugins/salesforce",
  elasticsearch: "plugins/elasticsearch",
  e2b: "plugins/e2b",
  daytona: "plugins/daytona",
  nsjail: "plugins/nsjail",
  sidecar: "plugins/sidecar",
  "vercel-sandbox": "plugins/vercel-sandbox",
  "railway-sandbox": "plugins/railway-sandbox",
  chat: "plugins/chat",
  webhook: "plugins/webhook",
  teams: "plugins/teams",
  "email-digest": "plugins/email-digest",
  mcp: "plugins/mcp",
  email: "plugins/email",
  jira: "plugins/jira",
  twenty: "plugins/twenty",
  "webhook-action": "plugins/webhook-action",
  "yaml-context": "plugins/yaml-context",
  "obsidian-reader": "plugins/obsidian-reader",
  obsidian: "plugins/obsidian",
};

interface Pkg {
  name?: string;
  version?: string;
  private?: boolean;
}

function readPkg(text: string): Pkg {
  return JSON.parse(text) as Pkg;
}

/** Tag prefixes declared in publish.yml's `on.push.tags` (without the `-v*`). */
function declaredPrefixes(): string[] {
  const yml = readFileSync(join(repoRoot, ".github/workflows/publish.yml"), "utf8");
  const out = new Set<string>();
  for (const m of yml.matchAll(/^\s*-\s*'([a-z0-9-]+)-v\*'/gm)) out.add(m[1]);
  return [...out];
}

/** Tag prefixes a publish step is gated on (`if: ...refs/tags/<prefix>-v`). */
function stepPrefixes(): string[] {
  const yml = readFileSync(join(repoRoot, ".github/workflows/publish.yml"), "utf8");
  const out = new Set<string>();
  // Anchored to real `if:` step lines (leading indent then `if:`), like
  // declaredPrefixes — so a comment that mentions a removed `refs/tags/<x>-v`
  // can't inject a phantom step prefix and trip the trigger<->step check.
  for (const m of yml.matchAll(
    /^\s*if:\s*startsWith\(github\.ref,\s*['"]refs\/tags\/([a-z0-9-]+)-v/gm,
  )) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * Publishable workspace packages: every dir under the root `workspaces` globs
 * (plus `create-atlas`, which is published but not a workspace member) whose
 * package.json is not `private` and not in the internal `@atlas/*` scope.
 * Returns repo-relative dirs (e.g. "plugins/bigquery", "create-atlas"). These
 * MUST be covered by PREFIX_TO_DIR — a new one with no mapping would silently
 * never publish. Deriving from the workspace globs (not a fixed packages/+plugins/
 * scan) keeps root-level packages in scope.
 */
function publishablePackageDirs(): string[] {
  const rootPkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };

  const candidates = new Set<string>(["create-atlas"]);
  for (const entry of rootPkg.workspaces ?? []) {
    if (entry.endsWith("/*")) {
      const base = entry.slice(0, -2);
      let children: string[];
      try {
        children = readdirSync(join(repoRoot, base));
      } catch {
        continue;
      }
      for (const c of children) candidates.add(`${base}/${c}`);
    } else {
      candidates.add(entry);
    }
  }

  const out: string[] = [];
  for (const dir of candidates) {
    let pkg: Pkg;
    try {
      pkg = readPkg(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
    } catch {
      continue; // no package.json (a glob dir without one, or a stray entry)
    }
    if (pkg.private) continue;
    if (!pkg.name || pkg.name.startsWith("@atlas/")) continue;
    out.push(dir);
  }
  return out;
}

/**
 * Network-free structural guard. Keeps four lists in lockstep so a publishable
 * package can't be half-wired:
 *   1. publish.yml `on.push.tags` trigger prefixes
 *   2. publish.yml per-package step prefixes (`if: ...refs/tags/<prefix>-v`)
 *   3. PREFIX_TO_DIR (the SSOT map)
 *   4. the actual publishable workspace packages on disk
 * Returns a list of human-readable problems (empty = all in sync).
 */
function checkWorkflowCoverage(): string[] {
  const problems: string[] = [];
  const triggers = new Set(declaredPrefixes());
  const steps = new Set(stepPrefixes());
  const mapped = new Set(Object.keys(PREFIX_TO_DIR));

  // 1. Every trigger prefix must be in the SSOT map.
  for (const p of triggers) {
    if (!mapped.has(p)) {
      problems.push(
        `publish.yml declares tag prefix "${p}-v*" but PREFIX_TO_DIR has no entry. Add it pointing at the package dir.`,
      );
    }
  }
  // 2. Every map entry must be a real trigger (no stale/reserved prefixes).
  for (const p of mapped) {
    if (!triggers.has(p)) {
      problems.push(
        `PREFIX_TO_DIR has "${p}" but publish.yml's on.push.tags has no "${p}-v*" trigger. Remove the map entry or add the trigger.`,
      );
    }
  }
  // 3. Triggers and steps must match exactly — a trigger with no step silently
  //    no-ops on push; a step with no trigger never runs.
  for (const p of triggers) {
    if (!steps.has(p)) {
      problems.push(
        `publish.yml triggers on "${p}-v*" but has no publish step gated on refs/tags/${p}-v — pushing that tag fires the workflow but publishes nothing.`,
      );
    }
  }
  for (const p of steps) {
    if (!triggers.has(p)) {
      problems.push(
        `publish.yml has a publish step for "${p}-v*" but no matching on.push.tags trigger — that step can never run.`,
      );
    }
  }
  // 4. Every publishable package on disk must be covered by the map — a new
  //    package with no mapping (so no trigger/step) would silently never publish.
  const mappedDirs = new Set(Object.values(PREFIX_TO_DIR));
  for (const dir of publishablePackageDirs()) {
    if (!mappedDirs.has(dir)) {
      problems.push(
        `${dir} is a publishable workspace package (not private, not @atlas/*) but no PREFIX_TO_DIR entry points at it — it would never publish. Add a "<prefix>: ${dir}" entry plus the matching publish.yml trigger + step.`,
      );
    }
  }
  // 5. Every map entry must point at a real package.json — catches a
  //    renamed/removed package leaving a dangling map entry.
  for (const [prefix, dir] of Object.entries(PREFIX_TO_DIR)) {
    try {
      readPkg(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
    } catch {
      problems.push(
        `PREFIX_TO_DIR["${prefix}"] points at "${dir}" but there is no package.json there — fix the path or remove the entry (and its publish.yml trigger + step).`,
      );
    }
  }
  return problems;
}

function refExists(ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The ref to read each package's "already on the base" version from. PRs compare
 * to the base branch tip; a push (or local run) compares to the previous commit,
 * so a freshly-merged bump is treated as "introduced here" (exempt) exactly
 * once, then enforced on the next change. Returns null when no base can be
 * resolved (shallow clone with no history) — the caller then degrades to lenient.
 */
function resolveBaseRef(): string | null {
  const prBase = process.env.GITHUB_BASE_REF;
  if (prBase) {
    try {
      execFileSync(
        "git",
        ["fetch", "--quiet", "--depth=1", "origin", `+refs/heads/${prBase}:refs/remotes/origin/${prBase}`],
        { cwd: repoRoot, stdio: "ignore" },
      );
    } catch {
      // best-effort: the ref may already be present
    }
    if (refExists(`origin/${prBase}`)) return `origin/${prBase}`;
  }
  try {
    execFileSync("git", ["fetch", "--quiet", "--deepen=1"], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    // not a shallow clone (or offline) — HEAD~1 may already be reachable
  }
  if (refExists("HEAD~1")) return "HEAD~1";
  if (refExists("origin/main")) return "origin/main";
  return null;
}

/** Version of `<dir>/package.json` at `ref`, or null if absent there (new package). */
function versionAtRef(ref: string, dir: string): string | null {
  try {
    const text = execFileSync("git", ["show", `${ref}:${dir}/package.json`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return readPkg(text).version ?? null;
  } catch {
    return null;
  }
}

/** Published versions on npm, or null if the registry read failed (treated leniently). */
async function publishedVersions(name: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", name, "versions", "--json"], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as string[] | string;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A 404 (never-published package) is a definite empty set, not a blip.
    if (/E404|not found|is not in this registry/i.test(msg)) return [];
    return null;
  }
}

async function main(): Promise<void> {
  // ── workflow-coverage guard (structural, no network) ──────────────────
  const coverageProblems = checkWorkflowCoverage();
  if (coverageProblems.length > 0) {
    for (const p of coverageProblems) console.error(`::error::${p}`);
    console.error(
      "\npublish.yml / PREFIX_TO_DIR / workspace packages are out of lockstep " +
        "(see scripts/check-unpublished-versions.ts). Fix the mismatches above so no package silently fails to publish.",
    );
    process.exit(1);
  }

  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.warn(
      "⚠ could not resolve a base ref (shallow clone, no history) — skipping the unpublished-version guard.",
    );
    return;
  }

  const targets = Object.entries(PREFIX_TO_DIR);

  const results = await Promise.all(
    targets.map(async ([prefix, dir]) => {
      let pkg: Pkg;
      try {
        pkg = readPkg(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
      } catch {
        return { prefix, dir, kind: "skip" as const, msg: `no package.json at ${dir}` };
      }
      if (pkg.private) return { prefix, dir, kind: "skip" as const, msg: `${pkg.name} is private` };
      const name = pkg.name;
      const version = pkg.version;
      if (!name || !version) {
        return { prefix, dir, kind: "skip" as const, msg: `${dir} has no name/version` };
      }

      const published = await publishedVersions(name);
      if (published === null) {
        return { prefix, dir, kind: "warn" as const, msg: `${name}: registry read failed — skipped` };
      }
      if (published.includes(version)) {
        return { prefix, dir, kind: "ok" as const, msg: `${name}@${version} published` };
      }

      // Not on npm — exempt if THIS change introduced the bump (pending publish).
      const baseVersion = versionAtRef(baseRef, dir);
      if (baseVersion === null || baseVersion !== version) {
        return {
          prefix,
          dir,
          kind: "pending" as const,
          msg: `${name}@${version} not yet on npm (latest: ${published.at(-1) ?? "none"}) — bump introduced by this change; tag it after merge.`,
        };
      }

      return {
        prefix,
        dir,
        kind: "fail" as const,
        msg:
          `${name}@${version} is on the base branch but NOT published to npm (latest: ${published.at(-1) ?? "none"}), ` +
          `and this change didn't introduce the bump — a prior merged bump was never published. ` +
          `Publish it: git tag -a ${prefix}-v${version} <main-sha> -m "Release ${name} ${version}" && git push origin ${prefix}-v${version}`,
      };
    }),
  );

  let failed = false;
  for (const r of results.sort((a, b) => a.prefix.localeCompare(b.prefix))) {
    if (r.kind === "fail") {
      console.error(`::error::${r.msg}`);
      failed = true;
    } else if (r.kind === "warn") {
      console.warn(`⚠ ${r.msg}`);
    } else if (r.kind === "pending") {
      console.log(`⏳ ${r.msg}`);
    } else if (r.kind === "ok") {
      console.log(`✓ ${r.msg}`);
    }
  }

  if (failed) {
    console.error(
      "\nAt least one publishable package has a merged-but-unpublished version. Push the missing tag(s) above to publish.",
    );
    process.exit(1);
  }
  console.log("\nAll publishable packages are published or have a pending (this-change) bump.");
}

main().catch((err) => {
  console.error(`check-unpublished-versions: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
