/**
 * #4936 — the `runAgent` tool-surface guardrail.
 *
 * #4915 keeps `correct_fact` — a brain-mutating WRITE — off the read-safe
 * agent surface by registering it only when a `dashboardUrlResolver` is
 * present (`lib/tools/registry.ts`). That gate decides what each REGISTRY
 * contains. It says nothing about which registry a given turn actually gets —
 * and `runAgent` used to answer that question with a default parameter
 * (`tools: toolRegistry = defaultRegistry`), so every caller that omitted
 * `tools` silently received the dashboards-owning, write-carrying registry.
 * Three live surfaces did: the proactive linked-asker branch, the chat-plugin
 * approval resume, and the zero-signup demo.
 *
 * `registry.test.ts` pins WHICH REGISTRY CONTAINS THE TOOL. Nothing pinned
 * WHICH REGISTRY EACH CALL SITE RESOLVES TO — which is why no per-slice
 * reviewer of the Brain M2 diff could have caught it: the gate was correct,
 * the bypass lived in a default parameter and in call sites the milestone
 * never touched. This file closes that axis from both ends:
 *
 *   1. BEHAVIOURAL — a real `runAgent` turn with no `tools` hands the model a
 *      tool set with no brain-write and no dashboard-write verb. The same turn
 *      with `defaultRegistry` passed explicitly DOES carry them, so the
 *      assertion is a real gate and not a tautology about an empty tool set.
 *   2. STRUCTURAL — every production `runAgent(...)` call site, across
 *      `packages/**` AND `ee/**`, passes `tools` explicitly. The safe default
 *      is the backstop; naming the registry at the surface is the contract.
 *      A new headless surface can therefore neither inherit nor omit its way
 *      into a write-carrying tool set.
 *
 * Sibling guardrail: `agent-surface-registry.test.ts` pins the ACTOR-binding
 * axis (F-54/F-55) over the same call sites.
 */

import { describe, expect, it, mock } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";

// ---------------------------------------------------------------------------
// 1. Behavioural — what tool set does the model actually receive?
// ---------------------------------------------------------------------------

// Same mock floor as the other mock-LLM seam tests (agent-dialect-specialist-
// seam.test.ts): runAgent runs with NO request context, so every org-scoped
// loader must be stubbed or the turn reaches a DB.
void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      describe: () => [{ id: "default", dbType: "postgres" }],
    },
  }),
);

void mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

void mock.module("@atlas/api/lib/plugins/tools", () => ({
  getContextFragments: () => [],
  getDialectHints: () => [],
  pluginDialectModules: () => [],
  setContextFragments: () => {},
  setDialectHints: () => {},
  setPluginTools: () => {},
  getPluginTools: () => undefined,
}));

void mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  buildRetrievalQuery: () => "",
  getRetrievalTurns: () => 3,
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
}));

void mock.module("@atlas/api/lib/learn/org-knowledge-section", () => ({
  resolveOrgKnowledgeSection: async () => "",
}));

const { runAgent } = await import("@atlas/api/lib/agent");
const { defaultRegistry } = await import("@atlas/api/lib/tools/registry");

let lastToolNames: string[] | undefined;

/**
 * Pull the tool names out of the provider-level call options. The AI SDK has
 * carried these as an array of `{ name }` and as a keyed record across
 * versions, so read both shapes rather than pinning one — a silently empty
 * list would make every `not.toContain` below vacuously pass, which the
 * positive-control test guards against.
 */
function extractToolNames(opts: unknown): string[] | undefined {
  const tools = (opts as { tools?: unknown })?.tools;
  if (Array.isArray(tools)) {
    return tools.map((t) => String((t as { name?: unknown })?.name ?? ""));
  }
  if (tools && typeof tools === "object") return Object.keys(tools);
  return undefined;
}

function makeSpyingModel(): InstanceType<typeof MockLanguageModelV3> {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "text-0", delta: "ok" },
    {
      type: "finish",
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      finishReason: { unified: "stop", raw: "end_turn" },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async (opts: unknown) => {
      const names = extractToolNames(opts);
      if (names) lastToolNames = names;
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

function userMessages(text: string): UIMessage[] {
  return [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text }] }];
}

async function toolNamesForTurn(
  extra: Parameters<typeof runAgent>[0] extends infer _ ? Record<string, unknown> : never,
): Promise<string[]> {
  lastToolNames = undefined;
  const result = await runAgent({
    messages: userMessages("How many orders last month?"),
    aiModel: {
      model: makeSpyingModel(),
      providerType: "openai",
      modelId: "mock-runagent-call-sites",
    },
    ...extra,
  });
  await result.text;
  expect(lastToolNames, "the spying model never received a tool set").toBeDefined();
  return lastToolNames ?? [];
}

/** Tools that WRITE — none may reach a turn that didn't ask for them. */
const BRAIN_WRITE_TOOL = "correct_fact";
const DASHBOARD_WRITE_TOOL = "createDashboard";

describe("#4936 — runAgent's default tool surface fails closed", () => {
  it("a turn that omits `tools` gets no brain-write and no dashboard-write verb", async () => {
    const names = await toolNamesForTurn({});

    // The whole point of the issue: omitting `tools` used to yield
    // `defaultRegistry`, which carries both of these.
    expect(names).not.toContain(BRAIN_WRITE_TOOL);
    expect(names).not.toContain(DASHBOARD_WRITE_TOOL);
    // Not vacuous — the read tools are still there, so this is a narrowed
    // surface, not a broken one.
    expect(names).toContain("executeSQL");
    expect(names).toContain("explore");
    expect(names).toContain("searchBrain");
  });

  it("positive control: passing `defaultRegistry` explicitly DOES carry both write verbs", async () => {
    // Without this the assertions above would pass just as happily against a
    // model that never receives tools at all, or against a registry rename
    // that made both names unreachable. The workspace surface is the one place
    // these tools belong, and it must still get them.
    const names = await toolNamesForTurn({ tools: defaultRegistry });

    expect(names).toContain(BRAIN_WRITE_TOOL);
    expect(names).toContain(DASHBOARD_WRITE_TOOL);
  });
});

// ---------------------------------------------------------------------------
// 2. Structural — every production call site names its registry
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");

/**
 * Source trees that may contain a production `runAgent` call. `ee/` is
 * included deliberately: the proactive answer adapter — the call site with the
 * most authority (a real linked user, resolved to their real `member.role`)
 * and the least supervision (autonomous Slack answer, no confirmation UI) —
 * lives there, and an audit that stops at `packages/` misses it entirely.
 */
const SCAN_ROOTS = [
  "packages/api/src",
  "packages/mcp/src",
  "packages/sdk/src",
  "ee/src",
];

/** The definition itself, not a call site. */
const AGENT_MODULE = "packages/api/src/lib/agent.ts";

interface CallSite {
  readonly file: string;
  readonly args: string;
}

/**
 * Strip line and block comments so a doc comment that mentions
 * `runAgent({ resume })` — several modules narrate the seam that way — isn't
 * mistaken for a call site. Deliberately naive about comment-like sequences
 * inside string literals: over-stripping can only ever HIDE a call site, and
 * the non-vacuity assertion below fails if the known ones stop being found.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Extract the balanced `(...)` argument text for each `runAgent(` in `source`. */
function findRunAgentCalls(file: string, source: string): CallSite[] {
  const out: CallSite[] = [];
  const pattern = /\brunAgent\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const start = i + 1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ file, args: source.slice(start, i) });
  }
  return out;
}

async function collectCallSites(): Promise<CallSite[]> {
  const out: CallSite[] = [];
  for (const root of SCAN_ROOTS) {
    await walk(resolve(REPO_ROOT, root), root, out);
  }
  return out;
}

async function walk(absDir: string, relDir: string, out: CallSite[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await readdir(absDir, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
  } catch (err) {
    // A root that isn't checked out in this tree is not a failure — but it
    // must not pass silently either, or the scan degrades to a no-op.
    // eslint-disable-next-line no-console
    console.debug(
      `[agent-runagent-call-sites] skipping unreadable scan root ${relDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  for (const entry of entries) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const childRel = `${relDir}/${entry.name}`;
    const childAbs = resolve(absDir, entry.name);
    if (entry.isDirectory()) {
      await walk(childAbs, childRel, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      childRel !== AGENT_MODULE
    ) {
      const source = stripComments(await readFile(childAbs, "utf8"));
      if (!source.includes("runAgent")) continue;
      out.push(...findRunAgentCalls(childRel, source));
    }
  }
}

/**
 * Call sites that MUST exist. If the scan stops finding these — a rename, a
 * moved file, a regex that quietly matches nothing — the guard has become a
 * no-op and this test says so instead of reporting a clean sweep of zero
 * files.
 */
const REQUIRED_CALL_SITE_FILES = [
  "packages/api/src/api/routes/chat.ts",
  "packages/api/src/api/routes/demo.ts",
  "packages/api/src/api/routes/admin-semantic-improve.ts",
  "packages/api/src/lib/agent-query.ts",
  "packages/api/src/lib/chat-plugin/resume-turn.ts",
  "ee/src/proactive/answer-adapter.ts",
];

describe("#4936 — every production runAgent call site names its registry", () => {
  it("scans a non-vacuous set of call sites (guard against a silently dead sweep)", async () => {
    const sites = await collectCallSites();
    const files = new Set(sites.map((s) => s.file));
    for (const required of REQUIRED_CALL_SITE_FILES) {
      expect(
        files.has(required),
        `expected a runAgent call site in ${required}; the scan found: ${[...files].sort().join(", ")}`,
      ).toBe(true);
    }
  });

  it("no call site omits `tools` (an omission inherits a default the surface never chose)", async () => {
    const sites = await collectCallSites();
    const offenders = sites
      .filter((s) => !/(^|[\s{,])tools\s*:/.test(s.args))
      .map((s) => `${s.file}: runAgent(${s.args.trim().slice(0, 120)}…)`);

    expect(
      offenders,
      "runAgent call site(s) without an explicit `tools`. The default is fail-closed " +
        "(`nonDashboardRegistry`), so this is not an open door — but the surface's tool " +
        "posture must be declared AT the surface. Pass `defaultRegistry` if it owns " +
        "`/dashboards/[id]` and has a human in the loop; `buildHeadlessRegistry()` if it " +
        "is an SDK / chat-platform / MCP / scheduler surface; a purpose-built registry " +
        "otherwise. See #4936 and the gating comment in lib/tools/registry.ts.",
    ).toEqual([]);
  });
});

describe("#4936 — the fail-closed default is pinned in source", () => {
  it("runAgent defaults `tools` to nonDashboardRegistry, never a write-carrying registry", async () => {
    const source = await readFile(resolve(REPO_ROOT, AGENT_MODULE), "utf8");

    expect(
      source,
      "runAgent's `tools` default must stay the least-privileged registry — reverting it " +
        "to `defaultRegistry` re-opens #4936 for every caller that omits `tools`.",
    ).toMatch(/tools:\s*toolRegistry\s*=\s*nonDashboardRegistry/);
  });
});
