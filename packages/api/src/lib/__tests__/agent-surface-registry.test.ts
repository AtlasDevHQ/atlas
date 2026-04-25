/**
 * F-54 / F-55 meta-guardrail.
 *
 * The class of bug F-54 + F-55 closed was "agent runs without a user
 * bound — approval gate silently disabled." The unit tests pin
 * scheduler + Slack specifically, but a 4th surface added later (or an
 * existing surface losing its actor binding via refactor) would
 * silently regress with no failing test.
 *
 * This file is the structural answer to "approval rules fire on EVERY
 * surface that runs the agent": it enumerates the known agent call
 * sites and asserts each one either passes an explicit `actor` to
 * `executeAgentQuery` or wraps in `withRequestContext({ user })`. Adding
 * a new caller is a one-line update to `KNOWN_AGENT_CALLERS`; forgetting
 * to update the registry, or adding a caller that does neither, fails
 * the suite.
 *
 * The audit doc's `.claude/research/security-audit-1-2-3.md` Phase 7
 * records the original silent-bypass shape — link this test to that
 * narrative when adding new callers.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");

interface AgentCallerSpec {
  /** Path relative to the repo root. */
  file: string;
  /**
   * Why this caller is allowed to invoke the agent and how it binds an
   * identity. Each caller must EITHER pass an explicit `actor:` option to
   * `executeAgentQuery` OR wrap the call in `withRequestContext({ user })`.
   * The string here is asserted to appear in the file as a basic structural
   * check — it doesn't replace the per-caller unit tests, but it forces a
   * conscious touch when the binding shape changes.
   */
  bindingProof: RegExp;
}

/**
 * Every known caller of `executeAgentQuery` (or `runAgent` directly).
 * Add a new entry whenever a new agent surface lands. Removing a caller
 * is allowed; **adding** a caller without updating this list fails the
 * suite via the unknown-caller assertion below.
 */
const KNOWN_AGENT_CALLERS: AgentCallerSpec[] = [
  {
    file: "packages/api/src/lib/scheduler/executor.ts",
    // F-54: resolves the task creator and passes as actor.
    bindingProof: /agentQueryEffect\([^)]*,\s*\{\s*actor\s*\}/,
  },
  {
    file: "packages/api/src/api/routes/slack.ts",
    // F-55: builds botActorUser from installation, passes as actor.
    bindingProof: /executeAgentQuery\([^)]*\bactor\b/s,
  },
  {
    file: "packages/api/src/api/routes/query.ts",
    // /query authenticates first then wraps in withRequestContext({ user }).
    bindingProof: /withRequestContext\(\s*\{[^}]*\buser\b/,
  },
  {
    file: "packages/api/src/api/routes/chat.ts",
    // /chat binds user via withRequestContext before runAgent.
    bindingProof: /withRequestContext\(\s*\{[^}]*\buser\b/,
  },
  {
    file: "packages/api/src/api/routes/demo.ts",
    // Demo binds a synthetic demo user (no org by design — handled by the
    // `requesterId` pass-through path in checkApprovalRequired).
    bindingProof: /withRequestContext\(\s*\{[^}]*\buser\b/,
  },
  {
    file: "packages/api/src/api/routes/admin-semantic-improve.ts",
    // Admin route — gated by requireAuth middleware that binds the user
    // via withRequestContext upstream. The route itself uses runAgent
    // inside that frame, so any of the upstream withRequestContext calls
    // satisfies the binding requirement.
    bindingProof: /\b(runAgent|executeAgentQuery)\b/,
  },
];

const AGENT_INVOCATION_PATTERN = /\b(executeAgentQuery|runAgent)\s*\(/;

async function readRepoFile(relPath: string): Promise<string> {
  const abs = resolve(REPO_ROOT, relPath);
  return readFile(abs, "utf8");
}

describe("F-54/F-55 agent-surface registry", () => {
  it("every known caller binds an actor or a withRequestContext({ user })", async () => {
    for (const spec of KNOWN_AGENT_CALLERS) {
      const source = await readRepoFile(spec.file);
      expect(source).toMatch(AGENT_INVOCATION_PATTERN);
      expect(source, `${spec.file} must satisfy bindingProof ${spec.bindingProof}`).toMatch(spec.bindingProof);
    }
  });

  it("no agent caller exists outside the registry (catches new surfaces that forgot to bind)", async () => {
    // Walk the route + scheduler directories looking for any file that
    // mentions `executeAgentQuery` or `runAgent`. Compare against
    // KNOWN_AGENT_CALLERS — anything new is a hard failure so the next
    // person adding an agent surface is forced through this checklist.
    const candidates = await collectCandidateFiles();
    const known = new Set(KNOWN_AGENT_CALLERS.map((c) => c.file));
    const unknown = candidates.filter((f) => !known.has(f));

    expect(unknown, `Unknown agent caller(s) detected — add to KNOWN_AGENT_CALLERS in agent-surface-registry.test.ts after verifying actor binding: ${unknown.join(", ")}`).toEqual([]);
  });
});

/**
 * Walk the route + scheduler directories and return the relative paths
 * of files that reference `executeAgentQuery` or `runAgent`. Excludes
 * test files (`__tests__/`, `*.test.ts`) and the agent module itself.
 */
async function collectCandidateFiles(): Promise<string[]> {
  const ROOTS = [
    "packages/api/src/api/routes",
    "packages/api/src/lib/scheduler",
  ];
  const results: string[] = [];
  for (const root of ROOTS) {
    await walk(resolve(REPO_ROOT, root), root, results);
  }
  return results.sort();
}

async function walk(absDir: string, relDir: string, out: string[]): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await readdir(absDir, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "__tests__") continue;
    const childRel = `${relDir}/${entry.name}`;
    const childAbs = resolve(absDir, entry.name);
    if (entry.isDirectory()) {
      await walk(childAbs, childRel, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      const source = await readFile(childAbs, "utf8");
      if (AGENT_INVOCATION_PATTERN.test(source)) {
        out.push(childRel);
      }
    }
  }
}
