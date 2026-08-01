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
 *      CONDITIONAL spread — `...(toolRegistry ? { tools: toolRegistry } : {})`,
 *      which is what `ee/.../answer-adapter.ts` and `api/routes/chat.ts`
 *      contained (the latter inheriting the default harmlessly, being the
 *      surface that wants it — which is why the shape survived review). A guard
 *      that misses the spelling the bug actually used is theatre, so
 *      `SCANNER_FIXTURES` below pins the scanner against it.
 *
 *      Where an entry in `EXPECTED_REGISTRY` pins a LOCAL IDENTIFIER rather
 *      than a registry name, the identifier's value is guaranteed only by that
 *      surface's behavioural test — named per entry, including the one entry
 *      (`admin-semantic-improve.ts`) whose route test mocks its builder.
 *
 * The safe default is the backstop for anything the scan cannot see (an
 * untyped caller, a plugin compiled separately); naming the registry at the
 * surface is the contract.
 *
 * Sibling guardrail: `agent-surface-registry.test.ts` pins the ACTOR-binding
 * axis (F-54/F-55), but over a DIFFERENT set — its roots are
 * `packages/api/src/api/routes` + `packages/api/src/lib/scheduler` only, so it
 * covers neither `ee/**` nor `lib/chat-plugin/**`. The two files overlap on
 * three FILES; they are complementary, not co-extensive.
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
 * lives there, and an audit that stops at `packages/` misses it entirely. That
 * branch is latent on the SaaS wiring today (see the adapter), which is why it
 * needs a guard rather than a fix-on-report.
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
    if (depth !== 0) {
      // Never found the closing paren. `slice(start, i)` would return the rest
      // of the FILE as the "arguments" — which almost certainly contains a
      // `tools:` somewhere, so the call site would be silently ACCEPTED. Same
      // rule as the sweep's read-fault handling: a degraded scan fails loudly.
      throw new Error(
        `unbalanced runAgent(...) at ${file} offset ${match.index} — the comment ` +
          `stripper likely ate a paren; an unterminated scan silently ACCEPTS the call site`,
      );
    }
    out.push({ file, args: source.slice(start, i) });
  }
  return out;
}

type ToolsProp =
  /** An unconditional `tools: <expr>` at the top level of the options object. */
  | { readonly kind: "value"; readonly text: string }
  /** An unconditional `tools` shorthand property. */
  | { readonly kind: "shorthand" }
  /** `tools` appears, but only inside a spread element. */
  | { readonly kind: "spread-only" }
  /** `tools` is named unconditionally, then RE-ASSIGNED by a LATER spread. */
  | { readonly kind: "overridden" }
  | { readonly kind: "absent" };

/**
 * Locate the `tools` property of a `runAgent(...)` options object.
 *
 * Deliberately a small brace-depth scanner rather than a regex. Every regex
 * spelling of this check has a blind spot that matters:
 *
 *   - `/tools\s*:/` alone accepts a CONDITIONAL spread — and
 *     `...(toolRegistry ? { tools: toolRegistry } : {})` is verbatim what
 *     `ee/src/proactive/answer-adapter.ts` contained before this fix. A guard
 *     that misses the spelling the bug actually used is theatre.
 *   - narrowing the spread to `/\.\.\.\s*\([^)]*tools\s*:/` then misses any
 *     condition containing a paren (`...(hasTools() ? … : {})`).
 *   - either way, a `tools:` nested in `resume: { tools }` counts as a hit.
 *
 * Splitting on top-level commas has none of those holes: spread elements are
 * identified as elements and skipped wholesale however they are spelled, and
 * nesting is excluded by construction.
 */
function inspectToolsProp(args: string): ToolsProp {
  const open = args.indexOf("{");
  // `runAgent(opts)` — no literal to inspect, so the surface's posture is not
  // visible here. Treated as absent: fail closed and make the author inline it.
  if (open === -1) return { kind: "absent" };

  const props: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < args.length; i++) {
    const ch = args[i];
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) {
        props.push(args.slice(start, i));
        break;
      }
    } else if (ch === "," && depth === 1) {
      props.push(args.slice(start, i));
      start = i + 1;
    }
  }

  // Scan ALL properties, never returning early. Object spread is
  // LAST-WRITE-WINS, so a `tools`-carrying spread that appears AFTER the
  // property is what the turn actually runs with — the named registry is then
  // decoration, and every downstream check (including `EXPECTED_REGISTRY`,
  // whose pinned spelling is still literally present) passes while the surface
  // silently runs on the spread's registry. This is the one escape shape whose
  // failure direction is UPWARD: it re-adds `correct_fact`, rather than
  // resolving to `undefined` and landing on the fail-closed default. Stacked
  // conditional spreads are the house idiom at exactly these call sites, so it
  // is a one-line diff away. A spread BEFORE the property is harmless.
  let sawToolsInSpread = false;
  let found: ToolsProp | undefined;
  for (const raw of props) {
    const prop = raw.trim();
    if (prop.startsWith("...")) {
      if (/\btools\b/.test(prop)) {
        if (found) return { kind: "overridden" };
        sawToolsInSpread = true;
      }
      continue;
    }
    if (found) continue;
    const match = /^(?:"tools"|'tools'|tools)\s*(:?)/.exec(prop);
    if (!match) continue;
    if (match[1] !== ":") {
      // Guard against `toolsFoo` matching the bare-identifier arm.
      if (prop !== "tools") continue;
      found = { kind: "shorthand" };
      continue;
    }
    found = { kind: "value", text: prop.slice(match[0].length).trim() };
  }

  if (found) return found;
  return sawToolsInSpread ? { kind: "spread-only" } : { kind: "absent" };
}

/**
 * A call site is an offender if it does not name `tools` UNCONDITIONALLY, with
 * a value that cannot be `undefined`.
 *
 * The last clause matters because `exactOptionalPropertyTypes` is off, so
 * `tools: ToolRegistry | undefined` typechecks against `tools?: ToolRegistry`:
 * `tools: cond ? registry : undefined` reads as explicit and behaves as
 * omission. `SCANNER_FIXTURES` pins every one of these shapes.
 */
function offenceFor(args: string): string | undefined {
  const prop = inspectToolsProp(args);
  switch (prop.kind) {
    case "absent":
      return "omits `tools`";
    case "spread-only":
      return "names `tools` only inside a SPREAD — the surface inherits the default whenever the spread's condition is false";
    case "overridden":
      return "names `tools` unconditionally and then RE-ASSIGNS it from a later spread — object spread is last-write-wins, so the named registry is not what the turn runs with";
    case "shorthand":
      return undefined;
    case "value":
      return /\bundefined\b/.test(prop.text)
        ? "passes a `tools` value that can be `undefined`, which is the same as omitting it"
        : undefined;
  }
}

/**
 * The registry each production surface must resolve to. Pinning what is PASSED,
 * not just that something called `tools` is passed, is what makes this a
 * security guard rather than a style check: "passed a registry" is satisfied
 * equally well by passing the wrong one, and `tools: defaultRegistry` on a new
 * headless surface is precisely the regression #4936 is about.
 *
 * Where the pin is a REGISTRY NAME (`demo.ts`, `resume-turn.ts`) it is exact.
 * Where it is a LOCAL IDENTIFIER (`chat.ts`, `agent-query.ts`,
 * `answer-adapter.ts`, `admin-semantic-improve.ts`) it only proves the surface
 * chose deliberately — what the identifier resolves to is pinned by that
 * surface's behavioural test, named in the `why` string. A text scan cannot
 * close that gap; the behavioural layer is not optional decoration, and where
 * it is thin the `why` string says so.
 *
 * A call-site file absent from this map fails. That is the point — a new
 * `runAgent` surface must make its tool posture a reviewed decision here, not
 * inherit one.
 */
const EXPECTED_REGISTRY: ReadonlyArray<readonly [file: string, expected: RegExp, why: string]> = [
  [
    "packages/api/src/api/routes/chat.ts",
    /tools:\s*(resolvedToolRegistry|workspaceRegistry)\b/,
    "web chat + web resume OWN /dashboards/[id] and have a human in the loop — the two surfaces that opt IN to defaultRegistry. Identity backstopped by chat.test.ts + chat-resume.test.ts",
  ],
  [
    "packages/api/src/api/routes/demo.ts",
    /tools:\s*nonDashboardRegistry\b/,
    "anonymous zero-signup demo — no dashboards route, no workspace",
  ],
  [
    "packages/api/src/api/routes/admin-semantic-improve.ts",
    /tools:\s*expertRegistry\b/,
    "the expert-agent chat runs a purpose-built registry (proposeAmendment, no analyst write verbs). Contents pinned by lib/tools/__tests__/expert-registry.test.ts; the route's own test MOCKS buildExpertRegistry, so the identifier->registry edge is scanner-only",
  ],
  [
    "packages/api/src/lib/agent-query.ts",
    /tools:\s*toolRegistry\b/,
    "the canonical headless surface — resolves buildHeadlessRegistry() just above. Identity backstopped by agent-query.test.ts",
  ],
  [
    "packages/api/src/lib/chat-plugin/resume-turn.ts",
    /tools:\s*toolRegistry\b/,
    "approval resume must rebuild the SAME headless set the parked turn ran under — the local " +
      "binds buildHeadlessRegistry()'s registry half (#4941 split the seam's return into " +
      "{ registry, warnings }, so the inline `await` spelling is gone). Identity backstopped by " +
      "chat-plugin/__tests__/resume-turn.test.ts, which asserts the resumed tool NAMES",
  ],
  [
    "ee/src/proactive/answer-adapter.ts",
    /tools:\s*toolRegistry\b/,
    "both proactive branches assign toolRegistry: nonDashboardRegistry (linked) / public-dataset (unlinked). Identity backstopped by ee answer-adapter.test.ts",
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
   * Fixtures reproduce the exact offending SPELLINGS the pre-fix call sites
   * used (condensed to the relevant argument shape), plus the variants a
   * reasonable person reaches for next — several of which escaped an earlier,
   * regex-based version of `offenceFor`. Without these the scanner's own
   * correctness is untested and it can silently degrade into a check nothing
   * can fail.
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
    // A condition containing a paren — the shape that escaped the first,
    // regex-based version of this predicate.
    [
      "conditional spread whose condition contains a paren",
      `{ messages, ...(hasTools() ? { tools: toolRegistry } : {}), conversationId }`,
      true,
    ],
    [
      "conditional spread, && with a call in the condition",
      `{ messages, ...(isEnabled(ctx) && { tools: toolRegistry }) }`,
      true,
    ],
    [
      "conditional spread across several lines",
      `{\n  messages,\n  ...(toolRegistry\n    ? { tools: toolRegistry }\n    : {}),\n}`,
      true,
    ],
    ["explicit undefined", `{ messages, tools: undefined }`, true],
    // `exactOptionalPropertyTypes` is off, so a value that MAY be undefined
    // typechecks against `tools?: ToolRegistry` and behaves as an omission.
    ["ternary that can yield undefined", `{ messages, tools: cond ? reg : undefined }`, true],
    ["nullish-coalescing to undefined", `{ messages, tools: reg ?? undefined }`, true],
    // A nested `tools` is not the options-object property.
    ["tools nested under another key", `{ messages, resume: { runId, tools: r } }`, true],
    ["a pre-built options bag hides the posture", `opts`, true],
    ["unconditional — the fixed shape", `{ messages, tools: resolvedToolRegistry }`, false],
    ["unconditional, first key", `{ tools: nonDashboardRegistry, messages }`, false],
    [
      "unconditional await",
      `{ messages: [], tools: (await buildHeadlessRegistry()).registry }`,
      false,
    ],
    ["shorthand property", `{ messages, tools }`, false],
    // Last-write-wins escalation — the only escape shape that fails UPWARD.
    [
      "a later spread re-assigns tools",
      `{ messages, tools: nonDashboardRegistry, ...(isInternal && { tools: defaultRegistry }) }`,
      true,
    ],
    [
      "a spread BEFORE tools is harmless — the literal wins",
      `{ messages, ...(x && { tools: defaultRegistry }), tools: nonDashboardRegistry }`,
      false,
    ],
    // A conditional spread of something OTHER than tools must not be flagged —
    // the real chat.ts call site stacks three of them.
    [
      "unconditional tools beside a conditional spread of something ELSE",
      `{ messages, tools: resolvedToolRegistry, ...(warnings.length > 0 && { warnings }) }`,
      false,
    ],
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
        "the `registry` half of `await buildHeadlessRegistry()` if it is an SDK / " +
        "chat-platform / MCP / scheduler " +
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
    // `--untracked` matters locally: without it the file a developer just wrote
    // — exactly the one at risk — is invisible to this guard until it is staged.
    const proc = Bun.spawn(
      [
        "git",
        "grep",
        "-l",
        "--untracked",
        "-E",
        String.raw`\brunAgent\s*\(`,
        "--",
        "*.ts",
        "*.tsx",
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, `git grep failed: ${stderr}`).toBe(0);

    const hits = stdout
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.endsWith(".test.ts") && f !== AGENT_MODULE);

    expect(
      hits.filter((f) => !SCAN_ROOTS.some((root) => f.startsWith(`${root}/`))),
      "file(s) reference runAgent outside SCAN_ROOTS, so no call-site guard above can see " +
        "them. Add the package's src root to SCAN_ROOTS (and the call site to " +
        "EXPECTED_REGISTRY).",
    ).toEqual([]);

    // The walker reads `.ts` only, so a `.tsx` call site INSIDE a scan root
    // would satisfy the assertion above and still be unscanned. None exists
    // today; this fails the moment one does, rather than covering it silently.
    expect(
      hits.filter((f) => f.endsWith(".tsx")),
      "a .tsx file references runAgent — `walk()` only reads .ts, so every call-site check " +
        "above is blind to it. Widen the extension filter in `walk()`.",
    ).toEqual([]);
  });
});
