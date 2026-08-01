/**
 * #4936 — the `runAgent` tool-surface guardrail.
 *
 * DIVISION OF LABOUR (changed by #4943). `tools` is now a REQUIRED property of
 * `runAgent`'s options, so the COMPILER is the primary enforcement: it rejects
 * all five shapes of this bug class — conditional spread on a ternary, on `&&`,
 * a spread of a partial options object, plain omission, and a possibly-
 * `undefined` value. The mechanism is not spread-over-union distribution:
 * TypeScript MERGES `{ tools: T } | {}` into one object type with `tools`
 * OPTIONAL, and that fails the required target on property incompatibility
 * ("Type 'undefined' is not assignable to type 'ToolRegistry'"). Section 1b
 * below pins each shape with a `@ts-expect-error`, which is also what stops the
 * property being silently re-widened to `tools?:`.
 *
 * This file is the BACKSTOP, and it is not redundant. Four things it catches
 * that a required parameter cannot:
 *
 *   - WHICH registry each surface must resolve to (`EXPECTED_REGISTRY`). No
 *     type expresses "the demo route gets the restricted one"; passing the
 *     WRONG registry typechecks perfectly.
 *   - `runAgent(opts)`, where a pre-built bag typed as the options object
 *     compiles clean while laundering the posture out of sight.
 *   - A LATER spread that RE-ASSIGNS `tools` (`{ tools: nonDashboardRegistry,
 *     ...(isInternal && { tools: defaultRegistry }) }`). Object spread is
 *     last-write-wins, so this compiles clean under a required property — and
 *     it is the one escape shape whose failure direction is UPWARD, re-adding
 *     `correct_fact` rather than landing on the fail-closed default. The most
 *     dangerous shape here is the one the compiler cannot see at all.
 *   - Anything outside the type-checked graph — an `any`-typed caller, a
 *     separately compiled plugin, or a tree the root tsconfig excludes
 *     (`scripts/`, `deploy/`, `examples/*`, `plugins/obsidian`), which the
 *     repo-wide `git grep` drift check at the bottom of this file covers. That
 *     is also why `runAgent` keeps its fail-closed fall-back coalesce rather
 *     than trusting the signature.
 *
 * The rest of this comment is the original bug's shape, plus the two axes this
 * file still pins.
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
 *   1. BEHAVIOURAL — a real `runAgent` turn that reaches the fall-back
 *      coalesce (since #4943 a typed caller cannot omit `tools`, so the turn
 *      goes through the `OMIT_TOOLS` stand-in for an untyped one) hands the
 *      model a tool set with no brain-write and no dashboard-write verb. The
 *      same turn with `defaultRegistry` passed explicitly DOES carry them, so
 *      the assertion is a real gate and not a tautology about an empty tool set.
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
 * The safe fall-back is the backstop for anything neither the scan nor the
 * compiler can see (an untyped caller, a plugin compiled separately); naming
 * the registry at the surface is the contract.
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
import type { ToolRegistry } from "@atlas/api/lib/tools/registry";

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
 * tautology about the base call's own registry.
 *
 * This is the one place a `Partial` of `runAgent`'s options is legitimate —
 * erasing the #4943 requirement is the entire point, because there is otherwise
 * no way to reach the fall-back coalesce from typed code. Everywhere else, a
 * helper that forwards to `runAgent` takes the FULL parameter type (see
 * `agent-resume.test.ts`), or it silently exempts every caller behind it.
 *
 * The base call deliberately passes `defaultRegistry`, NOT the value the
 * default resolves to. If it passed `nonDashboardRegistry`, the assertions
 * below would hold whether or not the `OMIT_TOOLS` override actually landed —
 * the test would be pinning a registry it supplied itself. Passing the
 * write-carrying registry makes the override load-bearing: any future edit that
 * stops `...extra` winning (reordering it above `tools:`, or a defensive
 * `tools: extra.tools ?? …`) fails both `not.toContain` assertions loudly.
 */
async function toolNamesForTurn(
  extra: Partial<Parameters<typeof runAgent>[0]>,
): Promise<string[]> {
  lastToolNames = undefined;
  const result = await runAgent({
    messages: userMessages("How many orders last month?"),
    tools: defaultRegistry,
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

/**
 * The omission `runAgent`'s fall-back coalesce exists for. Since #4943 a
 * TYPED caller cannot omit `tools` at all, so the only way left to reach that
 * default is to stand in for a caller the type system never sees — an
 * `any`-typed options bag, a separately compiled plugin.
 *
 * Shaped as a `Pick` fragment rather than `undefined as unknown as ToolRegistry`
 * so nothing is mis-typed as a registry: this value cannot be dereferenced, it
 * can only be spread. `...extra` is spread LAST in `toolNamesForTurn`, and an
 * own key whose value is `undefined` still wins over the base literal, so the
 * property arrives as `undefined` and the default fires.
 *
 * Deleting this is not a cleanup: with the 16 test files that used to exercise
 * the default now naming their registry explicitly, this is the only remaining
 * BEHAVIOURAL assertion that the default is least-privileged. The source-text
 * pin in "the fail-closed defaults are pinned in source" below is its only
 * other net, and that one reads spelling, not behaviour.
 */
const OMIT_TOOLS = { tools: undefined } as unknown as Pick<
  Parameters<typeof runAgent>[0],
  "tools"
>;

describe("#4936 — runAgent's default tool surface fails closed", () => {
  it("a turn that reaches the fall-back coalesce gets no brain-write and no dashboard-write verb", async () => {
    const names = await toolNamesForTurn(OMIT_TOOLS);

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
// 1b. Compile-time — the PRIMARY gate pins itself
// ---------------------------------------------------------------------------

/**
 * #4943's gate is a TYPE, so its guard has to be a type too.
 *
 * Nothing below runs. The assertion IS each `@ts-expect-error`: `tsgo --noEmit`
 * reports an UNUSED directive as an error, so `bun run type` fails the moment
 * the shape it marks stops being rejected. Test files are inside the root
 * program (`packages/api/tsconfig.json` includes `src/**` and the root config
 * excludes neither), so this is a live CI gate, not decoration.
 *
 * Without it, widening `tools: ToolRegistry` back to `tools?: ToolRegistry` is
 * SILENT: every test in this file still passes, every call site still passes
 * `tools`, and the two source pins below only read the DEFAULT's spelling —
 * which is byte-identical either way. Enforcement would quietly drop back to
 * text-scanning, while the header six hundred lines up kept claiming otherwise.
 *
 * `maybeRegistry` is `declare`d rather than assigned because a `const`
 * initialised from a definite value is narrowed by control flow, and the last
 * two shapes then compile clean — a false pass that this fixture, of all
 * things, must not have. (Learned the hard way while verifying #4943.)
 */
declare function maybeRegistry(): ToolRegistry | undefined;

// oxlint-disable-next-line no-unused-vars -- compile-time fixture; never invoked
function _compilerRejectsEveryOmissionShape(): void {
  const messages: UIMessage[] = [];
  const maybe = maybeRegistry();
  const partial: Partial<Parameters<typeof runAgent>[0]> = {};

  // @ts-expect-error #4943 — ternary conditional spread (the pre-fix ee/answer-adapter.ts shape)
  void runAgent({ messages, ...(maybe ? { tools: maybe } : {}) });
  // @ts-expect-error #4943 — `&&` conditional spread (the pre-fix routes/chat.ts shape)
  void runAgent({ messages, ...(maybe && { tools: maybe }) });
  // @ts-expect-error #4943 — spread of a partial options object
  void runAgent({ messages, ...partial });
  // @ts-expect-error #4943 — plain omission (the pre-fix resume-turn.ts / demo.ts shape)
  void runAgent({ messages });
  // @ts-expect-error #4943 — a value that may be `undefined`
  void runAgent({ messages, tools: maybe });
}

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
 * Since #4943 a typed caller cannot reach most of these shapes at all — the
 * required property rejects them. The `undefined` arms are kept because this is
 * a TEXT guard over trees the compiler may not cover (the root tsconfig
 * excludes `scripts/`, `deploy/`, `examples/*`, `plugins/obsidian`) and callers
 * it never sees, and because a second, independently-spelled signal is the
 * point of a backstop.
 *
 * The assertion arm is new pressure created by #4943: a caller holding a
 * `ToolRegistry | undefined` can no longer pass it, so the path of least
 * resistance becomes `tools: reg!` or `tools: reg as ToolRegistry`. Both
 * typecheck, both satisfy `EXPECTED_REGISTRY`'s regexes, and both can still be
 * `undefined` at runtime — the requirement is declared and not met. It fails
 * DOWNWARD onto the fail-closed default, so it is not an open door, but it
 * voids the "declared unconditionally at the surface" contract silently.
 * `SCANNER_FIXTURES` pins every one of these shapes.
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
      if (/\bundefined\b/.test(prop.text)) {
        return "passes a `tools` value that can be `undefined`, which is the same as omitting it";
      }
      // A trailing `!` or `as ToolRegistry` on the whole value — `reg!`,
      // `map.get(id)!`, `maybeReg as ToolRegistry`. Deliberately anchored to the
      // END of the value so an assertion INSIDE a resolved expression
      // (`(await buildHeadlessRegistry()).registry`) is untouched.
      return /(?:!|\bas\s+ToolRegistry)\s*$/.test(prop.text)
        ? "asserts the `tools` value non-null (`!` / `as ToolRegistry`) rather than resolving one — " +
            "the assertion hides exactly the `undefined` the required parameter exists to reject"
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
    // Rejected by the compiler too since #4943; kept because this guard also
    // covers trees the root tsconfig excludes and callers it never typechecks.
    ["ternary that can yield undefined", `{ messages, tools: cond ? reg : undefined }`, true],
    ["nullish-coalescing to undefined", `{ messages, tools: reg ?? undefined }`, true],
    // The shape a required `tools` pressures a caller toward: the requirement is
    // declared, the assertion is what actually satisfies it, and the value can
    // still be undefined at runtime.
    ["non-null assertion on a maybe-registry", `{ messages, tools: maybeReg! }`, true],
    ["non-null assertion on a lookup", `{ messages, tools: registries.get(id)! }`, true],
    ["cast that erases the undefined", `{ messages, tools: maybeReg as ToolRegistry }`, true],
    // …but an assertion INSIDE an otherwise-resolved expression is not the
    // `tools` value being asserted, and must not be flagged.
    [
      "an assertion nested inside a resolved value",
      `{ messages, tools: (await buildRegistry(opts!)).registry }`,
      false,
    ],
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

    // #4943 moved this off the destructuring default: a default on a REQUIRED
    // property is dead code to the compiler, and the repo's type-aware lint
    // (`typescript/no-useless-default-assignment`) errors on it. Same invariant,
    // spelled as a body coalesce — so this pin reads the coalesce.
    expect(
      source,
      "runAgent's `tools` backstop must stay the least-privileged registry — reverting it " +
        "to `defaultRegistry` re-opens #4936 for every caller the type system never sees.",
    ).toMatch(/declaredToolRegistry\s*\?\?\s*nonDashboardRegistry/);
  });

  it("buildSystemParam defaults `registry` to nonDashboardRegistry too", async () => {
    // The prompt half of the same invariant. Reverting only this one would
    // re-advertise `createDashboard` / `correct_fact` GUIDANCE to a surface
    // whose tool set doesn't carry them — the model is told to use a verb it
    // hasn't got. The `tools` pin above does not cover it.
    const source = await readFile(resolve(REPO_ROOT, AGENT_MODULE), "utf8");

    expect(source).toMatch(/registry\s*=\s*nonDashboardRegistry,/);
  });

  it("#4943 — `tools` is still REQUIRED on the options type", async () => {
    // Second signal for the compile-time fixtures above, in a different CI job:
    // `_compilerRejectsEveryOmissionShape` fails the `type` gate, this fails the
    // `test` gate. A revert to `tools?: ToolRegistry` demotes the compiler back
    // to a no-op and leaves text scanning as the only enforcement — the posture
    // #4943 exists to end. Both nets read the signature; neither reads the other.
    const source = await readFile(resolve(REPO_ROOT, AGENT_MODULE), "utf8");

    expect(
      source,
      "runAgent's `tools` must stay REQUIRED. Making it optional again means the compiler " +
        "stops rejecting the five omission shapes (#4943) and this file's text scan becomes " +
        "the only gate.",
    ).not.toMatch(/^\s*tools\?:\s*ToolRegistry/m);
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
