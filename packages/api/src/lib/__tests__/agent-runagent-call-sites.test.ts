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
 * Three surfaces did: the proactive linked-asker branch, the chat-plugin
 * approval resume, and the zero-signup demo.
 *
 * `registry.test.ts` pins WHICH REGISTRY CONTAINS THE TOOL. Nothing pinned
 * WHICH REGISTRY EACH CALL SITE RESOLVES TO. This file closes that axis from
 * both ends:
 *
 *   1. BEHAVIOURAL — a real `runAgent` turn with no `tools` hands the model a
 *      tool set with no brain-write and no dashboard-write verb. The same turn
 *      with `defaultRegistry` passed explicitly DOES carry them, so the
 *      assertion is a real gate and not a tautology about an empty tool set.
 *   2. STRUCTURAL — every production `runAgent(...)` call site resolves to the
 *      registry its surface is supposed to have. Not merely "passes something
 *      called `tools`": `EXPECTED_REGISTRY` pins the actual expression per
 *      file, because "passed a registry" is satisfied just as well by passing
 *      the WRONG one, and a text match for `tools:` is satisfied by a
 *      CONDITIONAL spread — which is the exact shape two of the three
 *      pre-fix call sites had (`...(toolRegistry ? { tools: toolRegistry } :
 *      {})`). A guard that misses the spelling the bug actually used is
 *      theatre, so `SCANNER_FIXTURES` below pins the scanner against the
 *      historical spellings.
 *
 * The safe default is the backstop for anything the scan cannot see (an
 * untyped caller, a plugin compiled separately); naming the registry at the
 * surface is the contract.
 *
 * Sibling guardrail: `agent-surface-registry.test.ts` pins the ACTOR-binding
 * axis (F-54/F-55), but over a DIFFERENT set — its roots are
 * `packages/api/src/api/routes` + `packages/api/src/lib/scheduler` only, so it
 * covers neither `ee/**` nor `lib/chat-plugin/**`. The two files overlap on
 * three call sites; they are complementary, not co-extensive.
 */

import { describe, expect, it, mock } from "bun:test";
import type { Dirent } from "node:fs";
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
//
// Each mock covers its module's FULL named-export surface, not just the names
// this file's import graph happens to reach today. bun's `mock.module` replaces
// the module wholesale, so a missing name fails the whole import with "Export
// named 'X' not found" the moment some other module in the graph wants it —
// surfacing as an unrelated, opaque error. This PR had to repair two such
// mocks already (`cors.test.ts`, `chat-plugin/__tests__/resume-turn.test.ts`).
void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      describe: () => [{ id: "default", dbType: "postgres" }],
    },
  }),
);

void mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["orders"]),
  getWhitelistedTablesStrict: () => new Set(["orders"]),
  SemanticLayerScanError: class SemanticLayerScanError extends Error {},
  getCrossSourceJoins: () => [],
  registerPluginEntities: () => {},
  _resetWhitelists: () => {},
  loadOrgWhitelist: async () => new Map(),
  getOrgWhitelistedTables: () => new Set(),
  invalidateOrgWhitelist: () => {},
  invalidateOrgSemanticIndex: () => {},
  getOrgSemanticIndex: async () => "",
}));

void mock.module("@atlas/api/lib/plugins/tools", () => ({
  setPluginTools: () => {},
  getPluginTools: () => undefined,
  setContextFragments: () => {},
  getContextFragments: () => [],
  setDialectHints: () => {},
  getDialectHints: () => [],
  pluginDialectModules: () => [],
}));

void mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  DEFAULT_RETRIEVAL_TURNS: 3,
  DEFAULT_LATENCY_BUDGET_MS: 1000,
  getRetrievalTurns: () => 3,
  getConfidenceThreshold: () => 0,
  getLatencyBudgetMs: () => 1000,
  extractKeywords: () => new Set(),
  perfWeight: () => 0,
  rankPatterns: () => [],
  invalidatePatternCache: () => {},
  _resetPatternCache: () => {},
  buildRetrievalQuery: () => "",
  getRelevantPatterns: async () => [],
  buildLearnedPatternsSection: async () => "",
}));

void mock.module("@atlas/api/lib/learn/org-knowledge-section", () => ({
  buildOrgKnowledgeSection: () => "",
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

/**
 * `Partial<…>` rather than a hand-written bag: it is tied to `runAgent`'s real
 * signature, so a misspelled option (`tolls:`) is a compile error instead of a
 * silently ignored key that would turn the negative assertions below into a
 * tautology about a default-tools turn.
 */
async function toolNamesForTurn(
  extra: Partial<Parameters<typeof runAgent>[0]>,
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
// 2. Structural — every production call site names the RIGHT registry
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");

/**
 * Source trees that may contain a production `runAgent` call. `ee/` is
 * included deliberately: the proactive answer adapter — the call site with the
 * most authority (a real linked user, resolved to their real `member.role`)
 * and the least supervision (autonomous Slack answer, no confirmation UI) —
 * lives there, and an audit that stops at `packages/` misses it entirely.
 *
 * This is an allowlist, so it can rot silently as packages are added.
 * `no runAgent call site lives outside SCAN_ROOTS` below is the drift guard.
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
 * Strip comments so a doc comment that mentions `runAgent({ resume })` — several
 * modules narrate the seam that way — isn't mistaken for a call site, and so a
 * commented-out `// tools: defaultRegistry` can't satisfy the checks below.
 *
 * The line-comment pattern deliberately requires the `//` not be preceded by
 * `:`, which leaves `https://` inside string literals intact. Otherwise
 * deliberately naive about comment-like sequences in strings: over-stripping
 * can only ever HIDE a call site, and the non-vacuity assertion below fails if
 * the known ones stop being found.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
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

/**
 * A call site is an offender if it does not name `tools` UNCONDITIONALLY.
 *
 * The three rejected shapes are not hypothetical — the first two are verbatim
 * what `ee/src/proactive/answer-adapter.ts` and `packages/api/src/api/routes/
 * chat.ts` contained before this fix. A predicate that only asks "does the
 * substring `tools:` appear?" passes both, i.e. would have reported #4936 as
 * clean. `SCANNER_FIXTURES` pins that it does not.
 */
function offenceFor(args: string): string | undefined {
  if (/\.\.\.\s*\([^)]*\btools\s*:/.test(args)) {
    return "passes `tools` through a CONDITIONAL spread — the surface inherits the default whenever the condition is false";
  }
  if (/(^|[\s{,])tools\s*:\s*undefined\b/.test(args)) {
    return "passes `tools: undefined`, which is the same as omitting it";
  }
  if (!/(^|[\s{,])tools\s*:/.test(args)) {
    return "omits `tools`";
  }
  return undefined;
}

/**
 * The registry each production surface must resolve to. Pinning the EXPRESSION,
 * not just the presence of a `tools` key, is what makes this a security guard
 * rather than a style check: "passed a registry" is satisfied equally well by
 * passing the wrong one, and `tools: defaultRegistry` on a new headless surface
 * is precisely the regression #4936 is about.
 *
 * A call-site file absent from this map fails. That is the point — a new
 * `runAgent` surface must make its tool posture a reviewed decision here, not
 * inherit one.
 */
const EXPECTED_REGISTRY: ReadonlyArray<readonly [file: string, expected: RegExp, why: string]> = [
  [
    "packages/api/src/api/routes/chat.ts",
    /tools:\s*(resolvedToolRegistry|workspaceRegistry)\b/,
    "web chat + web resume OWN /dashboards/[id] and have a human in the loop — the two surfaces that opt IN to defaultRegistry",
  ],
  [
    "packages/api/src/api/routes/demo.ts",
    /tools:\s*nonDashboardRegistry\b/,
    "anonymous zero-signup demo — no dashboards route, no workspace",
  ],
  [
    "packages/api/src/api/routes/admin-semantic-improve.ts",
    /tools:\s*expertRegistry\b/,
    "the expert-agent chat runs a purpose-built registry (proposeAmendment, no analyst write verbs)",
  ],
  [
    "packages/api/src/lib/agent-query.ts",
    /tools:\s*toolRegistry\b/,
    "the canonical headless surface — resolves buildHeadlessRegistry() just above",
  ],
  [
    "packages/api/src/lib/chat-plugin/resume-turn.ts",
    /tools:\s*await buildHeadlessRegistry\(\)/,
    "approval resume must rebuild the SAME headless set the parked turn ran under",
  ],
  [
    "ee/src/proactive/answer-adapter.ts",
    /tools:\s*toolRegistry\b/,
    "both proactive branches assign toolRegistry: nonDashboardRegistry (linked) / public-dataset (unlinked)",
  ],
];

const EXPECTED_REGISTRY_FILES = new Set(EXPECTED_REGISTRY.map(([file]) => file));

/**
 * Roots that could not be read. A root missing from a partial checkout is
 * tolerable; a read fault anywhere else is not, because it silently shrinks the
 * sweep and the suite reports "no offenders" — the same false negative as
 * `catch { return false }` on a security check, one level up.
 */
const skippedRoots: string[] = [];

async function collectCallSites(): Promise<CallSite[]> {
  skippedRoots.length = 0;
  const out: CallSite[] = [];
  for (const root of SCAN_ROOTS) {
    await walk(resolve(REPO_ROOT, root), root, out, true);
  }
  return out;
}

async function walk(
  absDir: string,
  relDir: string,
  out: CallSite[],
  isRoot = false,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // Only a declared ROOT may be absent (a partial checkout). A mid-tree read
    // fault — EACCES, ELOOP, EMFILE — must fail loudly rather than quietly
    // remove a subtree from a security sweep.
    if (!isRoot || code !== "ENOENT") throw err;
    skippedRoots.push(relDir);
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
const REQUIRED_CALL_SITE_FILES = [...EXPECTED_REGISTRY_FILES];

describe("#4936 — the call-site scanner detects the shapes the bug actually had", () => {
  /**
   * Fixtures are the VERBATIM pre-fix argument text of the three regressed call
   * sites, plus the shapes a reasonable person might reach for next. Without
   * these, the scanner's own correctness is untested and it can silently
   * degrade into a check that nothing can fail.
   */
  const SCANNER_FIXTURES: ReadonlyArray<readonly [label: string, args: string, isOffender: boolean]> = [
    [
      "pre-fix ee/answer-adapter — ternary conditional spread",
      `{ messages, aiModel, ...(toolRegistry ? { tools: toolRegistry } : {}), answerStyle }`,
      true,
    ],
    [
      "pre-fix routes/chat.ts — && conditional spread",
      `{ messages, ...(toolRegistry && { tools: toolRegistry }), conversationId }`,
      true,
    ],
    [
      "pre-fix resume-turn.ts / demo.ts — omitted entirely",
      `{ messages: [], conversationId, resume }`,
      true,
    ],
    ["explicit undefined", `{ messages, tools: undefined }`, true],
    ["unconditional — the fixed shape", `{ messages, tools: resolvedToolRegistry }`, false],
    ["unconditional, first key", `{ tools: nonDashboardRegistry, messages }`, false],
    ["unconditional await", `{ messages: [], tools: await buildHeadlessRegistry() }`, false],
  ];

  for (const [label, args, isOffender] of SCANNER_FIXTURES) {
    it(`${isOffender ? "flags" : "accepts"}: ${label}`, () => {
      expect(offenceFor(args) !== undefined, `args: ${args}`).toBe(isOffender);
    });
  }

  it("strips a commented-out `tools:` but keeps a `https://` URL intact", () => {
    // A trailing `// tools: defaultRegistry` must not satisfy the predicate…
    const commented = stripComments(`runAgent({ messages, // tools: defaultRegistry\n});`);
    expect(offenceFor(commented)).toBeDefined();
    // …while the `//` in a URL must not eat the rest of the line, which would
    // truncate real call sites out of the sweep.
    expect(stripComments(`const u = "https://x.dev/a"; const t = 1;`)).toContain("const t = 1");
  });
});

describe("#4936 — every production runAgent call site names the right registry", () => {
  it("scans a non-vacuous set of call sites (guard against a silently dead sweep)", async () => {
    const sites = await collectCallSites();
    const files = new Set(sites.map((s) => s.file));
    for (const required of REQUIRED_CALL_SITE_FILES) {
      expect(
        files.has(required),
        `expected a runAgent call site in ${required}; the scan found: ${[...files].sort().join(", ")}`,
      ).toBe(true);
    }
    expect(
      skippedRoots,
      "a skipped scan root means this guard covered less than it claims to",
    ).toEqual([]);
  });

  it("no call site inherits the default (omitted, conditional, or explicitly undefined)", async () => {
    const sites = await collectCallSites();
    const offenders = sites
      .map((s) => ({ s, offence: offenceFor(s.args) }))
      .filter((x) => x.offence !== undefined)
      .map((x) => `${x.s.file}: ${x.offence} — runAgent(${x.s.args.trim().slice(0, 120)}…)`);

    expect(
      offenders,
      "runAgent call site(s) that inherit the default tool registry. The default is " +
        "fail-closed (`nonDashboardRegistry`), so this is not an open door — but the " +
        "surface's tool posture must be declared AT the surface, unconditionally. Pass " +
        "`defaultRegistry` if it owns `/dashboards/[id]` and has a human in the loop; " +
        "`buildHeadlessRegistry()` if it is an SDK / chat-platform / MCP / scheduler " +
        "surface; a purpose-built registry otherwise. See #4936 and the gating comment " +
        "in lib/tools/registry.ts.",
    ).toEqual([]);
  });

  it("each call site resolves to the registry its surface is supposed to have", async () => {
    const sites = await collectCallSites();
    const wrong: string[] = [];

    for (const [file, expected, why] of EXPECTED_REGISTRY) {
      for (const site of sites.filter((s) => s.file === file)) {
        if (!expected.test(site.args)) {
          wrong.push(`${file}: expected ${expected} (${why}) — got runAgent(${site.args.trim().slice(0, 120)}…)`);
        }
      }
    }

    expect(
      wrong,
      "a call site passes `tools`, but not the registry its surface is supposed to have. " +
        "Passing the WRONG registry is the same class of bug as passing none.",
    ).toEqual([]);
  });

  it("a new call-site file must declare its expected registry here", async () => {
    const sites = await collectCallSites();
    const undeclared = [...new Set(sites.map((s) => s.file))].filter(
      (f) => !EXPECTED_REGISTRY_FILES.has(f),
    );

    expect(
      undeclared,
      "a production runAgent call site with no entry in EXPECTED_REGISTRY. Add one — a " +
        "new agent surface's tool posture is a decision to review, not to inherit.",
    ).toEqual([]);
  });
});

describe("#4936 — the fail-closed defaults are pinned in source", () => {
  it("runAgent defaults `tools` to nonDashboardRegistry, never a write-carrying registry", async () => {
    const source = await readFile(resolve(REPO_ROOT, AGENT_MODULE), "utf8");

    expect(
      source,
      "runAgent's `tools` default must stay the least-privileged registry — reverting it " +
        "to `defaultRegistry` re-opens #4936 for every caller that omits `tools`.",
    ).toMatch(/tools:\s*toolRegistry\s*=\s*nonDashboardRegistry/);
  });

  it("buildSystemParam defaults `registry` to nonDashboardRegistry too", async () => {
    // The prompt half of the same invariant. Reverting only this one would
    // re-advertise `createDashboard` / `correct_fact` GUIDANCE to a surface
    // whose tool set doesn't carry them — the model is told to use a verb it
    // hasn't got. The `tools` pin above does not cover it.
    const source = await readFile(resolve(REPO_ROOT, AGENT_MODULE), "utf8");

    expect(source).toMatch(/registry\s*=\s*nonDashboardRegistry,/);
  });
});

describe("#4936 — SCAN_ROOTS has not rotted", () => {
  it("no runAgent call site lives outside SCAN_ROOTS", async () => {
    // SCAN_ROOTS is a hand-maintained allowlist. A new package that starts
    // calling `runAgent` would otherwise be invisible to every check above,
    // forever, with no signal. Grep the whole repo and assert every production
    // hit is inside a declared root.
    const proc = Bun.spawn(
      [
        "git",
        "grep",
        "-l",
        "-E",
        String.raw`\brunAgent\s*\(`,
        "--",
        "*.ts",
        "*.tsx",
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited, "git grep failed").toBe(0);

    const outside = stdout
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.endsWith(".test.ts") && f !== AGENT_MODULE)
      .filter((f) => !SCAN_ROOTS.some((root) => f.startsWith(`${root}/`)));

    expect(
      outside,
      "file(s) reference runAgent outside SCAN_ROOTS, so no call-site guard above can see " +
        "them. Add the package's src root to SCAN_ROOTS (and the call site to " +
        "EXPECTED_REGISTRY).",
    ).toEqual([]);
  });
});
