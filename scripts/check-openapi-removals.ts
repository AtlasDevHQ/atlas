#!/usr/bin/env bun
/**
 * check-openapi-removals.ts — REST endpoint removals must be ledgered
 * (2026-08-27 docs audit).
 *
 * The stability contract (apps/docs/content/shared/reference/stability.mdx)
 * promises that within v0.x every endpoint removal is recorded in its
 * "Removals within v0.x" ledger — "removals are record-or-bug". This gate is
 * the record-or-bug half made mechanical: it diffs the committed OpenAPI
 * artifact's path set against the previous release tag and FAILS when a path
 * disappeared without a matching ledger row. Without it the ledger is a
 * promise nobody re-checks — exactly how the ADR-0034/0035 removals shipped
 * unacknowledged for six weeks before the audit caught them.
 *
 * Baseline: the highest version-sorted `v<maj>.<min>.<patch>` release tag —
 * the spec customers were last shipped. Deliberately NOT `git describe`
 * (ancestry-based): CI checkouts are shallow, so no tag is an *ancestor* of
 * HEAD even after `git fetch --tags`, and describe would decline every PR run.
 * The tag pattern is anchored + filtered exactly like /release's own
 * next-version derivation — this repo runs ~20 tag trains, and an unanchored
 * `v*` glob once matched `vercel-sandbox-v0.0.5` (#5384). Override with
 * `--base <ref>` (any git ref that contains apps/docs/openapi.json) — also how
 * the fixture-style checks below stay runnable against historical windows:
 *
 *   bun scripts/check-openapi-removals.ts                  # HEAD vs last v-tag
 *   bun scripts/check-openapi-removals.ts --base v0.0.46   # spans the ADR-0035 removals
 *
 * A ledger row "matches" when the removed path template appears verbatim
 * anywhere in stability.mdx — the ledger is written from this same spec diff,
 * so parameter names line up by construction.
 *
 * Exit codes: 0 = pass (no removals, or every removal ledgered); 1 = a removal
 * is missing from the ledger; 2 = usage / parse error; 3 = DECLINED — no `v*`
 * tag is reachable (e.g. a shallow clone without tags), so the diff cannot be
 * computed. A declined gate is not a passed gate (`git fetch --tags origin`
 * and re-run).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const SPEC_REPO_PATH = "apps/docs/openapi.json";
const LEDGER_FILE = join(
  repoRoot,
  "apps/docs/content/shared/reference/stability.mdx",
);

function git(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repoRoot });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function parseArgs(): { base: string | null } {
  const idx = process.argv.indexOf("--base");
  if (idx === -1) return { base: null };
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("-")) {
    console.error("[openapi-removals] --base requires a git ref argument");
    process.exit(2);
  }
  return { base: value };
}

function specPaths(json: string, label: string): Set<string> {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (err) {
    console.error(
      `[openapi-removals] FAIL: could not parse ${label} as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  const paths = (doc as { paths?: Record<string, unknown> }).paths;
  if (!paths || typeof paths !== "object" || Object.keys(paths).length === 0) {
    console.error(
      `[openapi-removals] FAIL: ${label} has no "paths" object — not an OpenAPI document?`,
    );
    process.exit(2);
  }
  return new Set(Object.keys(paths));
}

const { base } = parseArgs();

let baseRef = base;
if (baseRef === null) {
  const tags = git(
    "tag",
    "-l",
    "v[0-9]*.[0-9]*.[0-9]*",
    "--sort=-version:refname",
  );
  const latest = tags.ok
    ? tags.stdout
        .split("\n")
        .map((t) => t.trim())
        .find((t) => /^v\d+\.\d+\.\d+$/.test(t))
    : undefined;
  if (!latest) {
    console.error(
      "[openapi-removals] DECLINED: no v<maj>.<min>.<patch> release tag found — cannot compute the removal diff.",
    );
    console.error("  Fetch tags and re-run: git fetch --tags origin");
    process.exit(3);
  }
  baseRef = latest;
}

const baseSpec = git("show", `${baseRef}:${SPEC_REPO_PATH}`);
if (!baseSpec.ok) {
  console.error(
    `[openapi-removals] FAIL: could not read ${SPEC_REPO_PATH} at ${baseRef}: ${baseSpec.stderr.trim()}`,
  );
  process.exit(2);
}

const basePaths = specPaths(baseSpec.stdout, `${baseRef}:${SPEC_REPO_PATH}`);
const headPaths = specPaths(
  readFileSync(join(repoRoot, SPEC_REPO_PATH), "utf8"),
  `working tree ${SPEC_REPO_PATH}`,
);

// stability.mdx's "Out-of-scope surfaces": these prefixes carry no frozen
// contract (the admin API evolves with the console it serves), so their
// removals are not ledgered. Keep in lockstep with that section.
const OUT_OF_SCOPE = ["/api/v1/internal/", "/api/v1/platform/", "/api/v1/admin/"];

const removed = [...basePaths]
  .filter((p) => !headPaths.has(p))
  .filter((p) => !OUT_OF_SCOPE.some((prefix) => p.startsWith(prefix)))
  .sort();

if (removed.length === 0) {
  console.log(
    `[openapi-removals] PASS: no endpoint removed since ${baseRef} (${basePaths.size} → ${headPaths.size} paths)`,
  );
  process.exit(0);
}

const ledger = readFileSync(LEDGER_FILE, "utf8");
const unledgered = removed.filter((p) => !ledger.includes(p));

if (unledgered.length > 0) {
  for (const p of unledgered) {
    console.error(
      `${SPEC_REPO_PATH}: path "${p}" existed at ${baseRef} but is gone, and has no row in the stability removals ledger`,
    );
  }
  console.error(
    `[openapi-removals] FAIL: ${unledgered.length} of ${removed.length} removed endpoint(s) missing from the ledger in ${LEDGER_FILE.slice(repoRoot.length + 1)}.`,
  );
  console.error(
    "  Either restore the endpoint, or record the removal (with its ADR and migration path)",
  );
  console.error(
    '  in the "Removals within v0.x" table — the removed path template must appear verbatim.',
  );
  process.exit(1);
}

console.log(
  `[openapi-removals] PASS: ${removed.length} endpoint(s) removed since ${baseRef}, all recorded in the stability removals ledger`,
);
