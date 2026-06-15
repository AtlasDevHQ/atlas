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
// Usage: bun scripts/check-unpublished-versions.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dir, "..");

// SSOT for publishable packages: tag prefix (the part before `-v`) -> package
// dir, mirroring .github/workflows/publish.yml. `null` = a reserved tag prefix
// with no package yet. The publish.yml-sync guard below asserts this map covers
// every prefix publish.yml declares, so a newly publishable package can't be
// wired into publish.yml without being covered here.
const PREFIX_TO_DIR: Record<string, string | null> = {
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
  slack: null, // reserved prefix, no package dir yet
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
  // ── publish.yml-sync guard ────────────────────────────────────────────
  const declared = declaredPrefixes();
  const unmapped = declared.filter((p) => !(p in PREFIX_TO_DIR));
  if (unmapped.length > 0) {
    for (const p of unmapped) {
      console.error(
        `::error::publish.yml declares tag prefix "${p}-v*" but scripts/check-unpublished-versions.ts has no PREFIX_TO_DIR entry. Add it (point it at the package dir, or null if reserved).`,
      );
    }
    process.exit(1);
  }

  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.warn(
      "⚠ could not resolve a base ref (shallow clone, no history) — skipping the unpublished-version guard.",
    );
    return;
  }

  const targets = Object.entries(PREFIX_TO_DIR).filter(
    (e): e is [string, string] => e[1] !== null,
  );

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
