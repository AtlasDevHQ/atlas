/**
 * Global test preload — strips ATLAS_*, BETTER_AUTH_*, DATABASE_URL, and
 * provider API keys (ANTHROPIC_API_KEY, etc.) before any test file loads,
 * preventing the developer's real .env from leaking into tests.
 *
 * Individual tests set the vars they need in beforeEach; this preload ensures a
 * clean baseline. Original values are restored in a top-level afterAll so the
 * process isn't permanently modified.
 *
 * It also sandboxes the semantic-layer root (#4655) — see below.
 */

import { afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const prefixes = ["ATLAS_", "BETTER_AUTH_"];
const exactVars = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  // Vercel deploy credentials: their presence alone makes the vercel-sandbox
  // backend eligible (vercelSandboxAccess), flipping sandbox backend-selection
  // tests to vercel-sandbox in any shell that carries them. The bare VERCEL
  // platform flag is deliberately NOT stripped — it's a platform marker, not a
  // secret, and suites that care scrub it themselves.
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
];

// Snapshot current values so we can restore them after the entire suite
const snapshot: Record<string, string> = {};

for (const key of Object.keys(process.env)) {
  if (prefixes.some((p) => key.startsWith(p)) || exactVars.includes(key)) {
    snapshot[key] = process.env[key]!;
    delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// Semantic-root sandbox (#4655)
// ---------------------------------------------------------------------------

/**
 * Point the semantic-layer root at a throwaway directory for the whole test
 * process.
 *
 * `getSemanticRoot()` defaults to `{cwd}/semantic`, and the dual-write sync
 * layer persists per-org YAML under `{root}/.orgs/<orgId>/`. Any suite that
 * exercises the real write path (the `-pg` amendment / connection-profile
 * family, the wizard, `importFromDisk`, …) therefore used to litter
 * `packages/api/semantic/` on the developer's actual checkout. That litter is
 * untracked (the `.gitignore` entry is anchored `/semantic/`, so it only
 * covers the repo root), makes `git status` noisy in shared worktrees, and —
 * worse — is *discovered* by first-boot suites like `semantic-sync.test.ts`
 * (`reconcileAllOrgs` walks `.orgs/`), so a second full run fails on orgs the
 * first run left behind.
 *
 * The sandbox is created with `mkdtempSync`, so it is unique per test process.
 * Cleanup only ever removes this process's own directory — concurrent runs
 * (sibling worktrees, the sharded CI lanes, `test-isolated.ts`'s per-file
 * processes) can never delete each other's fixtures.
 *
 * The leaf is literally named `semantic` so the sandbox is shaped like a real
 * semantic root, and suites that set their own `ATLAS_SEMANTIC_ROOT` keep
 * working unchanged — they just need to *restore* this value rather than
 * `delete` the var, or writes fall back to `{cwd}/semantic` again.
 */
const semanticSandboxParent = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-test-semantic-"));
const semanticSandbox = path.join(semanticSandboxParent, "semantic");
fs.mkdirSync(semanticSandbox, { recursive: true });
process.env.ATLAS_SEMANTIC_ROOT = semanticSandbox;

let sandboxRemoved = false;
function removeSemanticSandbox(): void {
  if (sandboxRemoved) return;
  sandboxRemoved = true;
  try {
    fs.rmSync(semanticSandboxParent, { recursive: true, force: true });
  } catch (err) {
    // Best effort: a leftover dir in os.tmpdir() is harmless, but never hide it.
    console.debug(
      `test-setup: failed to remove semantic sandbox ${semanticSandboxParent}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// Removal is deliberately bound to `exit` rather than `afterAll`: hook order
// across the preload and a test file's own `afterAll` is not guaranteed, and a
// file-level hook that still writes must not find the sandbox already gone.
// `exit` also covers what `afterAll` can't — a suite that throws during load,
// or a hard `process.exit`.
process.on("exit", removeSemanticSandbox);

afterAll(() => {
  // Restore snapshotted vars. The sandbox directory itself survives until the
  // `exit` hook fires; only the env var is rolled back here.
  delete process.env.ATLAS_SEMANTIC_ROOT;
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
});
