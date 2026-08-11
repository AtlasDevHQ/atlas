/**
 * LLM-driven canonical-question eval through the MCP path (#2119 Part B).
 *
 * Phase 1 (#2074, PR #2120) shipped the deterministic MCP eval that drives
 * every canonical question through a typed dispatch (`runMetric`,
 * `searchGlossary`, `describeEntity`, `executeSQL`) and asserts on the
 * envelope shape — proves the **protocol** layer.
 *
 * Phase 2 part A (#2125, merged eb7efe18) replaced the `verifyAccessToken`
 * mock with a real OAuth 2.1 round-trip — proves the **JWT/JWKS** path.
 *
 * This module is Phase 2 part B. It hands an LLM the same MCP tool surface
 * the typed eval uses, asks the canonical question as a user message, and
 * grades the LLM's tool-call sequence against the question's expectation.
 * The regressions caught here that the typed eval cannot:
 *
 *   - **tool_selection** — a tool description that's misleading enough to
 *     route the LLM to the wrong tool (e.g. agent picks `executeSQL` for a
 *     metric the semantic layer already defines as `runMetric` ground truth).
 *   - **recovery** — an `unknown_metric` / `ambiguous_term` envelope that
 *     the LLM ignores instead of self-correcting (the recovery contract
 *     documented in the typed-tool descriptions stops working).
 *   - **latency** — dispatch fan-out that grows past the committed baseline
 *     by >25% (early-warning for a serialization regression).
 *
 * The CLI driver in `canonical-eval-run.ts` exposes this via the
 * `--mcp-llm` flag. The per-mode graders + the tool binder are exposed
 * via `__forTesting__` and unit-tested in `canonical-eval-mcp-llm.test.ts`
 * against synthetic tool-call sequences (no real LLM tokens, no real
 * MCP connection). The end-to-end `runMcpLlmEval` integration path is
 * exercised in CI by the `eval-mcp-llm` job, which wires a real LLM
 * through the AI gateway, gated on `AI_GATEWAY_API_KEY` — NOT on
 * `ANTHROPIC_API_KEY`, which would exercise the wrong credential path
 * (`.github/workflows/eval-llm.yml`).
 *
 * ── Real-DB SQL execution ────────────────────────────────────────────
 *
 * Unlike `canonical-mcp-eval.evalspec.ts` (which uses `mock.module()` to
 * stub `executeSQL`), this module runs in a normal Bun process and so
 * cannot use `mock.module()` — and we want the LLM-mode eval to actually
 * exercise SQL correctness end-to-end. The CLI driver seeds Postgres
 * before invoking us; the production `executeSQL` tool the MCP server
 * registers therefore runs against real `atlas_demo`. `DATABASE_URL`
 * stays unset so `hasInternalDB()` short-circuits the audit writes (the
 * same trick #2125's auth helper relies on).
 */

import * as fs from "fs";
import { Hono } from "hono";
import {
  dynamicTool,
  jsonSchema,
  stepCountIs,
  streamText,
  type JSONSchema7,
  type LanguageModel,
  type Tool,
  type ToolSet,
} from "ai";

import { getAgentMaxSteps } from "@atlas/api/lib/agent";
import {
  liftEvalClientRateLimit,
  startEvalAuthServer,
  type EvalAuthFixture,
} from "@atlas/mcp/eval/auth";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  EvalMcpClient,
  extractToolJson,
  joinTextContent,
  type ExtractedToolJson,
  type ToolErrorEnvelope,
  type ToolListEntry,
} from "@atlas/mcp/eval/client";
import {
  type FailureCategory,
  type McpFailureArtifact,
} from "@atlas/mcp/eval/failure-artifact";
import { createHostedMcpRouter } from "@atlas/mcp/hosted";
import {
  DEFAULT_QUESTIONS_PATH,
  loadQuestions,
  type Question,
} from "./canonical-eval";

// ── Public types ──────────────────────────────────────────────────────

/**
 * What a tool's result is CONTRACTED to look like.
 *
 * - `"json"` — the tool answers with a JSON body (success) or an
 *   `AtlasMcpToolError` envelope (failure). Non-JSON from one of these is an
 *   MCP protocol regression and the grader fails the question for it.
 * - `"text"` — the tool's declared output is free-form text. `explore` is a
 *   sandboxed **shell**: `ls -la` answering with a directory listing is the
 *   contract being honoured, not broken.
 *
 * Resolved once per tool at bind time by {@link classifyToolContract} and
 * applied by {@link interpretResult}, which is where #5131 is actually closed.
 * The stamp on {@link RecordedToolCall} is the RECORD of that decision, not the
 * mechanism: `grade()`'s VERDICT is contract-blind ({@link isUnparseable} never
 * sees the field), and it reads `contract` only to choose which remedy an
 * artifact prints.
 */
export type ToolContract = "json" | "text";

/**
 * Captured shape of one tool dispatch the LLM fired through MCP. The
 * grading code below walks the recorded sequence to decide pass / fail
 * categories — keep this shape stable; the unit tests assert on it.
 */
export interface RecordedToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly latencyMs: number;
  /**
   * The dispatched tool's output contract, resolved once at bind time.
   *
   * ⚠️ NOT WHAT CLOSES #5131 — {@link interpretResult} is, from the same value
   * passed as an argument. This field is the forensic record of that decision,
   * read only to shape two diagnostics: the throttle abort message, and the
   * `protocol` artifact, where `explore / contract: text` tells an operator
   * immediately that they are in the flagged-error-or-empty lane rather than
   * the shell-output one. It is NOT a discriminator — {@link assertNotRateLimited}
   * branches on the envelope, not on this.
   *
   * REQUIRED rather than optional-with-a-default: it costs nothing, it keeps
   * the recorder total (no `undefined` arm to narrow at every read), and every
   * construction site is forced to state the answer rather than inherit one.
   */
  readonly contract: ToolContract;
  /**
   * The MCP tool result read according to its contract (via
   * {@link interpretResult} — parsed JSON for a `json` contract, the RAW TEXT
   * BODY for a `text` one, so `ok.data` is a string there), or a synthesized
   * error envelope when the dispatch itself threw before
   * MCP returned a frame. Synthesized envelopes carry `__transport: true`
   * + an `error`/`errorName`/`stack` triple so artifact bundles can
   * distinguish a transport hang-up from a typed `AtlasMcpToolError`.
   */
  readonly result: ExtractedToolJson;
}

/**
 * Synthesized error envelope used by {@link bindMcpToolsForLlm} when
 * `client.callTool` rejects (transport hang-up, abort, malformed
 * response). The `__transport: true` flag distinguishes it from a real
 * `AtlasMcpToolError` envelope so the grader doesn't classify a
 * transport regression as an MCP-tool-error regression.
 */
interface TransportErrorEnvelope extends ToolErrorEnvelope {
  readonly __transport: true;
  readonly error: string;
  readonly errorName: string;
  readonly stack?: string;
}

/**
 * Per-question outcome. Discriminated by `status` so the CLI summary
 * narrows on `artifact` without a guard each time it touches it. Mirrors
 * the shape `canonical-mcp-eval.evalspec.ts` already uses for the
 * deterministic outcomes — keeps both surfaces feeding the same artifact
 * formatter (`formatArtifactBundle`).
 */
export type McpLlmOutcome =
  | {
      readonly questionId: string;
      readonly status: "pass";
      readonly latencyMs: number;
      readonly toolCalls: readonly RecordedToolCall[];
      readonly finalText: string;
    }
  | {
      readonly questionId: string;
      readonly status: "fail";
      readonly latencyMs: number;
      readonly toolCalls: readonly RecordedToolCall[];
      readonly finalText: string;
      readonly artifact: McpFailureArtifact;
    };

/**
 * Ground truth for one metric question, derived by EXECUTING the metric's own
 * authoritative SQL (`findMetricById(id).sql`) against the same datasource the
 * model queries — never hand-written.
 *
 * ⚠️ THIS REPLACES `expect.sql_pattern` MATCHING IN LLM METRIC MODE, AND THE
 * REASON IS THAT THE NEEDLES COULD NEVER FAIL WHERE THEY WERE WRITTEN (#5122).
 * `total_customers`' authoritative SQL is
 * `SELECT COUNT(DISTINCT id) AS total_customers FROM customers`, and its needle
 * is `["COUNT(DISTINCT id)", "FROM customers"]` — a verbatim substring of the
 * SQL the DETERMINISTIC eval executes, so there it matches by construction and
 * tests nothing. The LLM grader then reused the identical needle to judge SQL
 * the model wrote from scratch, which turns it into a spelling test:
 *
 *   cq-002  model ran `SELECT COUNT(*) FROM customers` — correct on a primary
 *           key, and marked wrong for not saying `COUNT(DISTINCT id)`.
 *   cq-003  model ran `AVG(total_cents / 100.0)` — the same metric in dollars,
 *           and marked wrong because the needle `AVG(total_cents)` carries the
 *           closing paren. cq-001 passed only because ITS conversion happened
 *           to land outside the parens.
 *
 * Comparing values instead grades whether the question was answered. It is also
 * strictly stronger: a spelling check passes canonical-looking SQL with a wrong
 * filter, and a value check does not.
 */
export type MetricExpectation =
  /** Single-row, single-number metric — compare the number. */
  | { readonly kind: "scalar"; readonly value: number }
  /**
   * Grouped metric — compare the SET of grouping keys (the authoritative SQL's
   * first column). Robust to the extra columns, aliases, and orderings a model
   * legitimately adds, while still failing a wrong grouping or a wrong filter.
   */
  | { readonly kind: "keyed"; readonly keys: readonly string[] };

export interface McpLlmEvalOptions {
  readonly questionsPath?: string;
  readonly model: LanguageModel;
  /**
   * `metricId → expectation`, precomputed by the caller before the question
   * loop so {@link grade} stays pure and synchronously unit-testable.
   *
   * A metric question with no entry FAILS THE RUN rather than passing — a
   * missing expectation means the harness could not establish ground truth,
   * and a gate that silently stops checking is worse than one that stops.
   */
  readonly metricExpectations?: Readonly<Record<string, MetricExpectation>>;
  /**
   * `questionId → expectation` for PATTERN and VIRTUAL questions, derived the
   * same way metric ground truth is: by executing the question's own
   * authoritative SQL (the entity's `query_patterns[*].sql`, or the inline
   * `sql:` a virtual-dimension question carries).
   *
   * ⚠️ ADDITIVE, unlike metric mode. Here the value check is an EXTRA accept
   * path layered over the existing `sql_pattern` / structural checks rather
   * than a replacement, so it can only ever turn a false negative into a pass —
   * it cannot introduce one. Metric mode could be replaced outright because its
   * needles were provably vacuous where they were authored; the pattern needles
   * are not obviously so, and widening was the change that could be made
   * without a second round of measurement to justify it.
   *
   * cq-016 is why it exists: it PASSED on 2026-08-10 and FAILED on the next
   * run, on the same corpus and the same model, because the model phrased the
   * promotion filter differently the second time. A gate that flips on SQL
   * phrasing is not measuring what it claims to.
   */
  readonly answerExpectations?: Readonly<Record<string, MetricExpectation>>;
  /**
   * Map of `questionId → baselineMs`. When present, the grader emits a
   * `latency` artifact for any question whose total dispatch exceeded
   * `baseline * 1.25`. Missing entries are treated as "no baseline yet"
   * (passes through). Regenerate with `--write-baseline` from the CLI.
   */
  readonly baseline?: Readonly<Record<string, number>>;
  /**
   * Cap on the number of canonical questions processed. Used by the unit
   * tests to keep the loop short; the CLI passes the full set.
   */
  readonly maxQuestions?: number;
  /**
   * Optional pre-built auth fixture. When omitted, `runMcpLlmEval` boots
   * its own and tears it down. Tests pass in a shared fixture so multiple
   * runs in the same describe-block reuse one MCP server instance.
   */
  readonly fixture?: EvalAuthFixture;
  /**
   * Optional system prompt override. Tests pass a short string to keep
   * mock-model fixtures predictable; the CLI uses {@link DEFAULT_SYSTEM_PROMPT}.
   */
  readonly systemPrompt?: string;
}

export interface McpLlmEvalResult {
  readonly outcomes: readonly McpLlmOutcome[];
  readonly artifacts: readonly McpFailureArtifact[];
}

// ── System prompt ─────────────────────────────────────────────────────

/**
 * System prompt for the LLM dispatch loop. Deliberately short — the
 * MCP tool descriptions (audited in `canonical-mcp-eval.evalspec.ts`)
 * carry the contract. The prompt only primes the model on tool ordering
 * and the recovery contract so the eval is grading model behavior, not
 * prompt-engineering quality.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are Atlas, a data analyst. Use the MCP tools to answer the user's question.",
  "- For named business metrics, prefer runMetric with the metric id.",
  "- For glossary terms with multiple meanings, call searchGlossary FIRST and surface the ambiguity in your answer.",
  "- Use describeEntity to inspect entity columns, joins, and query_patterns before writing ad-hoc SQL.",
  "- Use executeSQL only when no metric or pattern fits.",
  "Always respect error envelopes (read `code` and `hint`) and self-correct rather than re-running the same call.",
].join("\n");

// ── Driver ────────────────────────────────────────────────────────────

/**
 * Boot the in-process auth + MCP route, hand the LLM the discovered
 * tool surface, and grade each canonical question against its
 * expectation. The fixture is owned by this call unless `opts.fixture`
 * is supplied.
 */
export async function runMcpLlmEval(
  opts: McpLlmEvalOptions,
): Promise<McpLlmEvalResult> {
  const ownsFixture = !opts.fixture;
  const fixture = opts.fixture ?? (await bootDefaultFixture());

  // A full run out-dispatches the default hosted-MCP quota (#5122) — see
  // `liftEvalClientRateLimit`. Applied whether or not we own the fixture: the
  // OAuth client is the same either way, and a shared fixture across several
  // runs accumulates MORE load against the same bucket, not less.
  liftEvalClientRateLimit(fixture);

  try {
    const client = new EvalMcpClient({
      baseUrl: fixture.baseUrl,
      workspaceId: fixture.workspaceId,
      bearer: fixture.bearer,
      clientName: "atlas-canonical-mcp-llm-eval",
    });

    // Defensive teardown: if `client.connect()` rejects, the transport
    // already allocated by the constructor (abort controller + fetch
    // state) leaks because `client.close()` short-circuits on
    // `!connected`. Wrap connect specifically so the transport gets
    // torn down on connect failure too. Anything thrown by close()
    // here is ignored — we're already on the failure path and want
    // the original connect error to propagate.
    try {
      await client.connect();
    } catch (err) {
      try {
        await client.close();
      } catch (closeErr) {
        // Logged, not re-thrown: the connect failure is the actionable signal
        // and must be the error that propagates.
        process.stderr.write(
          `[mcp-llm-eval] client.close after failed connect threw: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}\n`,
        );
      }
      throw err;
    }

    try {
      const tools = await client.listTools();
      const recorded: RecordedToolCall[] = [];
      const aiTools = bindMcpToolsForLlm(client, tools, recorded);

      const questions = loadQuestions(
        opts.questionsPath ?? DEFAULT_QUESTIONS_PATH,
      );
      const limit = opts.maxQuestions ?? questions.length;
      const outcomes: McpLlmOutcome[] = [];
      const artifacts: McpFailureArtifact[] = [];

      const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
      for (const q of questions.slice(0, limit)) {
        // Reset the buffer between questions — we want a per-question
        // tool-call sequence, not a cumulative log. Mutating in place
        // (rather than passing a fresh array per call) keeps the bound
        // tool closures pointing at the same recorder instance.
        recorded.length = 0;
        const outcome = await runOneQuestion({
          model: opts.model,
          tools: aiTools,
          systemPrompt,
          question: q,
          recorded,
          baseline: opts.baseline,
          metricExpectations: opts.metricExpectations,
          answerExpectations: opts.answerExpectations,
        });
        outcomes.push(outcome);
        if (outcome.status === "fail") artifacts.push(outcome.artifact);
      }
      return { outcomes, artifacts };
    } finally {
      await client.close();
    }
  } finally {
    if (ownsFixture) fixture.close();
  }
}

async function bootDefaultFixture(): Promise<EvalAuthFixture> {
  const mcpRouter = new Hono();
  mcpRouter.route("/", createHostedMcpRouter());
  return startEvalAuthServer({ mcpRouter });
}

// ── Tool output contracts ────────────────────────────────────────────

/**
 * MCP tools whose declared output is free-form TEXT rather than JSON.
 *
 * ⚠️ THIS IS A NAME LIST, DELIBERATELY, AND THE ALTERNATIVES WERE MEASURED
 * RATHER THAN ASSUMED (#5131).
 *
 * 1. There is nothing on the wire to derive it from. `bindMcpToolsForLlm`
 *    classifies from `ToolListEntry`, which is `{ name, description?,
 *    inputSchema? }` — the `tools/list` response carries no statement about
 *    the shape of a tool's OUTPUT. Any "marker set at bind time" is therefore
 *    still computed from the name; a marker relocates this list, it cannot
 *    replace it.
 * 2. The one machine-readable candidate — MCP `outputSchema` — is provably
 *    unfaithful here. In `packages/mcp/src/semantic-tools.ts`, `listEntities`,
 *    `describeEntity` and `searchGlossary` all answer JSON and declare NO
 *    `outputSchema`; `runMetric` is the only one in that file that does.
 *    Exempting "no outputSchema" would exempt three of the four typed tools the
 *    protocol check exists to protect — it would disable the detector rather
 *    than sharpen it. `explore` declares none either, so the signal does not
 *    discriminate in EITHER direction. (Grep the registrations rather than
 *    trusting line numbers; an earlier draft of this note cited four and every
 *    one had drifted before the PR merged.)
 *
 * What a name list genuinely gets wrong is ROT: rename or drop `explore` and
 * the exemption silently stops matching, restoring the bug with no signal.
 * That is closed by {@link assertTextContractToolsPresent}, which anchors every
 * name here against the live discovered surface — not by a type, since both
 * spellings of the type carry the same string.
 *
 * ── Backend dependence: what the fix removes, and what it does not ───
 *
 * `explore` resolves to a different sandbox backend locally than on the CI
 * runner (`packages/api/src/lib/tools/backends/selection.ts`), which is how
 * #5131 stayed invisible across four local runs. The fix removes the dependence
 * on output SHAPE only. Three backend-sensitive paths remain, recorded rather
 * than papered over — each reaches the right verdict, but the backend has not
 * stopped mattering:
 *
 *   - **Latency.** The GRADER's `latencyMs` (`GradeInput`, not the per-dispatch
 *     {@link RecordedToolCall} field) is whole-question wall clock, so a slow
 *     sandbox cold start can trip the `baseline * 1.25` ceiling.
 *   - **Throttling.** `rate_limited` on `explore` can come from the sandbox
 *     backend OR the hosted quota; see {@link assertNotRateLimited}.
 *   - **Content.** A backend that lists the semantic layer and one that fails
 *     to start give the model different information to answer from. No grader
 *     change can remove this — the honest fix is pinning the eval's backend.
 */
const TEXT_CONTRACT_TOOL_NAMES = ["explore"] as const;
const TEXT_CONTRACT_TOOLS: ReadonlySet<string> = new Set(TEXT_CONTRACT_TOOL_NAMES);

/**
 * Tools whose successful `data` is read as parsed JSON somewhere in grading:
 * {@link resultMatchesExpectation} via {@link isAnsweringCall}, and the
 * `entity.query_patterns` cast in {@link gradePattern}.
 *
 * A text contract puts RAW PROSE in `data` ({@link interpretResult}), so a tool
 * in both lists would have a directory listing compared against a metric's
 * authoritative value, or `data?.entity` read off a string: no crash, no
 * artifact, just `false`. A silent false negative rather than a loud stop —
 * hence a COMPILE-time check rather than a comment.
 */
type DataReadingToolName = (typeof ANSWERING_TOOLS)[number] | "describeEntity";

type _AssertContractsDisjoint =
  Extract<
    DataReadingToolName,
    (typeof TEXT_CONTRACT_TOOL_NAMES)[number]
  > extends never
    ? true
    : never;
/**
 * The assignment IS the assertion — it stops compiling if the lists overlap.
 * Type-only on purpose: a runtime `[...ANSWERING_TOOLS, …]` here would be a TDZ
 * reference, since `ANSWERING_TOOLS` is declared further down the file.
 */
const _contractsAreDisjoint: _AssertContractsDisjoint = true;

/** Resolve a discovered tool's output contract. See {@link TEXT_CONTRACT_TOOLS}. */
export function classifyToolContract(name: string): ToolContract {
  return TEXT_CONTRACT_TOOLS.has(name) ? "text" : "json";
}

/**
 * Read one `tools/call` result according to the calling tool's contract.
 *
 * ⚠️ THE CONTRACT IS APPLIED HERE, AT THE RECORDING SEAM — NOT IN THE GRADER.
 * `grade()`'s protocol branch stays a plain `result.kind === "unparseable"`
 * test, so a future branch that reads `kind` directly cannot reopen #5131, and
 * a successful `ls` never wears the word "unparseable" in a failure artifact.
 *
 * For a `"json"` contract this is exactly {@link extractToolJson}. For a
 * `"text"` contract the tool's product IS its text, so a successful call is
 * recorded as `ok` carrying that text verbatim — including when the text
 * happens to parse as JSON (`wc -l` printing `3`), which otherwise makes the
 * SAME tool record under two different arms depending on what the directory
 * contained.
 *
 * Two cases stay in the `unparseable` (→ `protocol`) lane, and both are
 * regressions rather than shell output:
 *
 *   - **`isError` was flagged.** `extractToolJson` reaches its `unparseable`
 *     arm from the `JSON.parse` catch, BEFORE it consults `isError`, so a
 *     server-flagged error with a prose body — what the MCP SDK's own
 *     `createToolError` emits for an uncaught throw — is indistinguishable
 *     from shell output by shape alone. Exempting it would turn #5131's loud
 *     false FAIL into a silent false PASS, with the model reading an internal
 *     error message as directory contents.
 *   - **No text content at all.** `explore` cannot produce this: it normalises
 *     a silent command to `"(no output)"`
 *     (`packages/api/src/lib/tools/explore.ts`), and every failure path returns
 *     an `Error:`-prefixed string. An empty `content` array is a protocol
 *     anomaly for every tool, whatever its output contract.
 */
export function interpretResult(
  result: CallToolResult,
  contract: ToolContract,
): ExtractedToolJson {
  if (contract !== "text") return extractToolJson(result);
  const text = joinTextContent(result);
  if (result.isError === true || text === "") {
    // Not shell output — fall back to the JSON reading so a typed envelope is
    // still recorded as `error`, and anything else stays `unparseable`.
    return extractToolJson(result);
  }
  return { kind: "ok", data: text };
}

/**
 * Fail the run when a declared text-contract tool is absent from the surface
 * the eval actually discovered.
 *
 * This is the anchor that makes {@link TEXT_CONTRACT_TOOLS} safe to spell as
 * names. Without it, renaming `explore` (or dropping it from the hosted
 * registration) turns the exemption into a no-op and every successful shell
 * call starts failing its question as `protocol` again — the #5131 defect,
 * back, with no diagnostic. Called against the real `tools/list` result, so a
 * rename is a loud stop at boot rather than five silent mis-graded questions.
 */
export function assertTextContractToolsPresent(tools: readonly ToolListEntry[]): void {
  const discovered = new Set(tools.map((t) => t.name));
  const missing = [...TEXT_CONTRACT_TOOLS].filter((n) => !discovered.has(n));
  if (missing.length === 0) return;
  throw new Error(
    `[harness] text-contract tool(s) not on the MCP surface: ${missing.join(", ")}. ` +
      `TEXT_CONTRACT_TOOLS exempts these from the JSON/protocol check because their ` +
      `declared output is free-form text; a name that no longer resolves means the ` +
      `exemption is dead and successful text output would be graded as a protocol ` +
      `regression (#5131). If the tool was RENAMED, point TEXT_CONTRACT_TOOLS at the ` +
      `new name. If it was deliberately REMOVED from this surface, delete the name — ` +
      `re-adding a dead one is the wrong repair. ` +
      `Discovered: ${
        discovered.size === 0
          ? "(empty — tools/list returned no tools)"
          : [...discovered].sort().join(", ")
      }`,
  );
}

/**
 * Translate the MCP tool surface to a Vercel AI SDK `ToolSet`. Every
 * tool's `execute` dispatches back through the MCP transport so the
 * round-trip the LLM sees is identical to what an external client
 * (Claude Desktop, Cursor) would see in production. The recorder
 * captures each call so the per-question grader can walk the sequence.
 *
 * **Why pass error envelopes back as data:** the AI SDK treats a thrown
 * Error in `execute` as a hard failure (the model can't see it). Returning
 * the error envelope as the tool result lets the model branch on `code`
 * and self-correct — which is the recovery contract the eval is grading.
 */
function bindMcpToolsForLlm(
  client: { callTool: EvalMcpClient["callTool"] },
  tools: readonly ToolListEntry[],
  recorder: RecordedToolCall[],
): ToolSet {
  // ⚠️ THE ANCHOR LIVES INSIDE THE BINDER, NOT IN A WRAPPER AROUND IT.
  // A wrapper leaves an unanchored binder callable beside it, so swapping the
  // wrapper back out at the one production call site is invisible — `runMcpLlmEval`
  // has no test, so nothing would go red. Binding a surface and vouching for it
  // are one operation here; the sibling binder in `canonical-eval-tool-selection.ts`
  // calls the anchor the same way, from inside itself.
  assertTextContractToolsPresent(tools);
  // `dynamicTool` (rather than `tool`) is the right shape here: the
  // input schema comes from the MCP server at runtime, so we cannot
  // statically infer the input type. The production agent loop binds
  // MCP-discovered tools the same way.
  const set: Record<string, Tool> = {};
  for (const t of tools) {
    // Fall back to a permissive object schema if the server didn't
    // advertise one — `jsonSchema({})` errors on some validators, so the
    // explicit `additionalProperties: true` makes the loose path safe.
    const schema =
      (t.inputSchema as JSONSchema7 | undefined) ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      };
    const contract = classifyToolContract(t.name);
    set[t.name] = dynamicTool({
      description: t.description ?? `MCP tool ${t.name}`,
      inputSchema: jsonSchema(schema),
      execute: async (rawArgs) => {
        const args = (rawArgs as Record<string, unknown> | undefined) ?? {};
        const start = Date.now();
        try {
          const result = await client.callTool(t.name, args);
          const parsed = interpretResult(result, contract);
          const latencyMs = Date.now() - start;
          recorder.push({
            name: t.name,
            args,
            contract,
            latencyMs,
            result: parsed,
          });
          if (parsed.kind === "error") return parsed.envelope;
          if (parsed.kind === "unparseable") {
            return { error: "unparseable", raw: parsed.raw };
          }
          return parsed.data;
        } catch (err) {
          const latencyMs = Date.now() - start;
          // Capture the error class name + stack so an artifact bundle
          // can distinguish AbortError from TypeError from a generic
          // socket hang-up. The `__transport: true` flag is the
          // grader's signal to classify this as `protocol`, not the
          // typed `AtlasMcpToolError` recovery case.
          const transportEnvelope: TransportErrorEnvelope = {
            __transport: true,
            error: err instanceof Error ? err.message : String(err),
            errorName: err instanceof Error ? err.name : "Unknown",
            stack: err instanceof Error ? err.stack : undefined,
          };
          recorder.push({
            name: t.name,
            args,
            contract,
            latencyMs,
            result: { kind: "error", envelope: transportEnvelope },
          });
          // Re-throw so a transport-level failure surfaces in the
          // caller's `streamText` (via `onError`) rather than silently
          // becoming a tool-result. Recovery-class regressions live at
          // the envelope layer; transport regressions deserve their own
          // loud failure path.
          throw err;
        }
      },
    });
  }
  return set as ToolSet;
}

interface OneQuestionInput {
  readonly model: LanguageModel;
  readonly tools: ToolSet;
  readonly systemPrompt: string;
  readonly question: Question;
  readonly recorded: RecordedToolCall[];
  readonly baseline: McpLlmEvalOptions["baseline"];
  readonly metricExpectations: McpLlmEvalOptions["metricExpectations"];
  readonly answerExpectations: McpLlmEvalOptions["answerExpectations"];
}

async function runOneQuestion(
  input: OneQuestionInput,
): Promise<McpLlmOutcome> {
  const { question, recorded, baseline } = input;
  const start = Date.now();
  let finalText = "";
  // Capture stream-level errors via the AI SDK `onError` callback. The
  // SDK does NOT reject `result.text` on tool-execute failures or
  // provider-side errors — those surface here. Without this hook a
  // transport regression bound through `bindMcpToolsForLlm` re-throws
  // into a tool-call step, the SDK swallows it as a tool-error part,
  // `result.text` resolves with whatever text the model produced, and
  // the grader silently classifies the question by partial state. The
  // production agent loop in `@atlas/api/lib/agent` wires the same
  // hook for the same reason.
  let streamErr: unknown = null;
  try {
    const result = streamText({
      model: input.model,
      tools: input.tools,
      system: input.systemPrompt,
      messages: [{ role: "user", content: question.question }],
      stopWhen: stepCountIs(getAgentMaxSteps()),
      onError: ({ error }: { error: unknown }) => {
        streamErr = error;
      },
    });
    // Awaiting `.text` drains the stream — every `tool-call` step has
    // executed by the time the promise resolves, so `recorded` is the
    // complete dispatch sequence the grader walks below.
    finalText = await result.text;
    if (streamErr !== null) throw streamErr;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const errorName = err instanceof Error ? err.name : "Unknown";
    const stack = err instanceof Error ? err.stack : undefined;
    return failOutcome({
      question,
      latencyMs,
      finalText,
      toolCalls: [...recorded],
      category: "protocol",
      tool: null,
      args: {},
      // Stack + errorName matter for CI debugging — without them an
      // AbortError, a TypeError from a bad schema, and a socket
      // hang-up all render as "streamText threw: <message>" in the
      // artifact bundle.
      response: { error: message, errorName, stack },
      expected: "successful streamText round-trip",
      summary: `streamText threw (${errorName}): ${message}`,
    });
  }
  const latencyMs = Date.now() - start;
  return grade({
    question,
    toolCalls: [...recorded],
    finalText,
    latencyMs,
    baseline,
    metricExpectations: input.metricExpectations,
    answerExpectations: input.answerExpectations,
  });
}

// ── Grading ──────────────────────────────────────────────────────────

interface GradeInput {
  readonly question: Question;
  readonly toolCalls: readonly RecordedToolCall[];
  readonly finalText: string;
  readonly latencyMs: number;
  readonly baseline: McpLlmEvalOptions["baseline"];
  readonly metricExpectations: McpLlmEvalOptions["metricExpectations"];
  readonly answerExpectations: McpLlmEvalOptions["answerExpectations"];
}

/**
 * Abort the run when any dispatch came back `rate_limited`.
 *
 * ⚠️ A THROTTLE IS A HARNESS FAULT, NOT A MODEL FAULT, AND MUST NOT BE GRADED
 * (#5122). Before this, the per-mode graders saw the quota envelope as "the LLM
 * saw an error envelope and did not recover" and charged it to `recovery` — so
 * two questions lost points for a limit the model would have kept hitting
 * however it behaved, and the score moved with dispatch timing rather than with
 * tool-selection quality. `liftEvalClientRateLimit` raises the ceiling so this
 * should not fire; if it does, the run's dispatch volume has outgrown the
 * override and the honest outcome is a loud stop, not a quieter score.
 */
function assertNotRateLimited(
  q: Question,
  toolCalls: readonly RecordedToolCall[],
): void {
  const throttled = toolCalls.find(
    (c) => c.result.kind === "error" && c.result.envelope.code === "rate_limited",
  );
  if (!throttled) return;
  const envelope =
    throttled.result.kind === "error" ? throttled.result.envelope : null;
  // ⚠️ THE REMEDY BRANCHES ON THE ENVELOPE, NOT ON THE TOOL'S CONTRACT — an
  // earlier cut keyed it on `contract === "text"` and asserted that a throttled
  // `explore` could only be the sandbox's limiter. That is false, and false in
  // the dominant direction: the hosted per-OAuth-client quota runs ahead of
  // EVERY tool body (`rateLimitOrNull` in mcp-dispatch), and `explore` is
  // charged weight 5 there — tied with `executeSQL` for the second-priciest
  // tool, so it is one of the largest contributors to the exhaustion
  // `liftEvalClientRateLimit` exists to prevent. Output shape simply does not
  // encode which limiter fired.
  //
  // The envelope does. The hosted limiter always sets `retry_after` + `hint`
  // (rate-limit/middleware.ts); the sandbox path builds its envelope with no
  // extras for `rate_limited` (tools.ts → classifyExploreError), so the field
  // is absent there.
  const retryAfter = (envelope as { retry_after?: unknown } | null)?.retry_after;
  const message = typeof envelope?.message === "string" ? envelope.message : "";
  const isHostedQuota =
    typeof retryAfter === "number" || /hosted-MCP quota/.test(message);
  const remedy = isHostedQuota
    ? `This is the eval throttling ITSELF, not a model failure: the run's own dispatch ` +
      `volume exceeded the eval client's hosted-MCP quota (${throttled.name} is just the ` +
      `dispatch that happened to hit it). Raise it via liftEvalClientRateLimit ` +
      `(EVAL_CLIENT_REQUESTS_PER_MINUTE).`
    : `The envelope carries no hosted-quota markers, so a limiter DOWNSTREAM of the eval ` +
      `client fired — for a text-contract tool that is the sandbox backend ` +
      `(classifyExploreError); for a JSON one, the datasource QPM/pool or the billing ` +
      `throttle. Raising EVAL_CLIENT_REQUESTS_PER_MINUTE will not help; read the message ` +
      `above and check that limiter.`;
  throw new Error(
    `[harness] ${q.id}: MCP dispatch was rate limited on ${throttled.name} ` +
      `(contract: ${throttled.contract}) — ${message || "no message"} ${remedy} ` +
      `Either way the run stops rather than letting the throttle be graded as a ` +
      `recovery regression.`,
  );
}

function grade(input: GradeInput): McpLlmOutcome {
  const { question: q, toolCalls, finalText, latencyMs, baseline } = input;

  // Before ANY per-mode grading — a throttled run must not produce a score.
  assertNotRateLimited(q, toolCalls);

  // Surface unparseable tool results immediately — those are MCP-layer
  // protocol regressions and would mask any per-mode grading the call
  // sequence implies. Type predicate narrows the union arm so the
  // closure-broken `result` access doesn't need a re-check.
  const unparseable = toolCalls.find(isUnparseable);
  if (unparseable) {
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "protocol",
      tool: unparseable.name,
      args: unparseable.args,
      response: { raw: unparseable.result.raw, contract: unparseable.contract },
      // ⚠️ THE REMEDY DIFFERS BY CONTRACT, AND THE WRONG ONE IS A NO-OP.
      // A text-contract tool only reaches this branch through
      // `interpretResult`'s two carve-outs, and in both the tool is ALREADY in
      // TEXT_CONTRACT_TOOLS — the anchor guarantees it or the run would not
      // have booted. Telling that operator to add it would be an instruction
      // that provably changes nothing. The json arm is the newly-added-text-
      // tool case, which the anchor cannot detect (it proves declared ⊆
      // discovered, never the reverse).
      expected:
        unparseable.contract === "text"
          ? "text body from a declared text-contract tool"
          : "JSON envelope from MCP tool",
      summary:
        unparseable.contract === "text"
          ? `MCP tool ${unparseable.name} is a DECLARED text-contract tool, so this is ` +
            `NOT shell output: it ${
              unparseable.result.raw === ""
                ? "returned no text content at all"
                : "carried a server-flagged error with a prose body"
            }. Adding it to TEXT_CONTRACT_TOOLS will not help — it is already there. ` +
            `Check the sandbox backend the eval resolved (backends/selection.ts).`
          : `MCP tool ${unparseable.name} returned content that could not be read as ` +
            `JSON. If this tool's DECLARED output is free-form text (as \`explore\`'s ` +
            `is), add it to TEXT_CONTRACT_TOOLS; otherwise this is a genuine MCP ` +
            `protocol regression — note that a server-flagged error carrying a prose ` +
            `body also lands here.`,
    });
  }

  // Surface transport-class regressions before per-mode grading. A
  // recorded `__transport: true` envelope means `bindMcpToolsForLlm`
  // re-threw a transport hang-up; without this branch the per-mode
  // grader would classify it as `recovery`, masking the real signal.
  const transportFail = toolCalls.find(isTransportFail);
  if (transportFail && transportFail.result.kind === "error") {
    const env = transportFail.result.envelope as TransportErrorEnvelope;
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "protocol",
      tool: transportFail.name,
      args: transportFail.args,
      response: { error: env.error, errorName: env.errorName, stack: env.stack },
      expected: "successful MCP transport round-trip",
      summary: `MCP transport threw on ${transportFail.name} (${env.errorName}): ${env.error}`,
    });
  }

  const modeOutcome = gradeByMode(
    q,
    toolCalls,
    finalText,
    latencyMs,
    input.metricExpectations,
    input.answerExpectations,
  );
  if (modeOutcome.status === "fail") return modeOutcome;

  // Latency check is layered on top of a successful answer — a slow
  // answer is still an answer, but it deserves an artifact so a future
  // baseline shift is easy to spot.
  const baselineMs = baseline?.[q.id];
  if (typeof baselineMs === "number" && baselineMs > 0) {
    const ceiling = Math.round(baselineMs * 1.25);
    if (latencyMs > ceiling) {
      return failOutcome({
        question: q,
        latencyMs,
        finalText,
        toolCalls,
        category: "latency",
        tool: null,
        args: {},
        response: { latencyMs },
        expected: { baselineMs, ceilingMs: ceiling },
        summary: `dispatch ${latencyMs}ms exceeded baseline ${baselineMs}ms by >25% (cap ${ceiling}ms)`,
      });
    }
  }

  return modeOutcome;
}

/**
 * Per-mode grader. Pass criteria are intentionally lenient on **how**
 * the LLM arrived at the answer (multiple tool sequences are valid for
 * most questions) and strict on **whether** the answer matches the
 * question's contract. This mirrors the deterministic eval's posture —
 * `--mcp-llm` is a regression gate on tool-selection quality, not a
 * style guide for the model.
 */
function gradeByMode(
  q: Question,
  toolCalls: readonly RecordedToolCall[],
  finalText: string,
  latencyMs: number,
  metricExpectations: McpLlmEvalOptions["metricExpectations"],
  answerExpectations: McpLlmEvalOptions["answerExpectations"],
): McpLlmOutcome {
  switch (q.mode) {
    case "metric":
      return gradeMetric(
        q,
        toolCalls,
        finalText,
        latencyMs,
        metricExpectations?.[q.metric_id],
      );
    case "glossary":
      return gradeGlossary(q, toolCalls, finalText, latencyMs);
    case "pattern":
      return gradePattern(q, toolCalls, finalText, latencyMs, answerExpectations?.[q.id]);
    case "virtual":
      return gradeVirtual(q, toolCalls, finalText, latencyMs, answerExpectations?.[q.id]);
    default: {
      const _exhaustive: never = q;
      throw new Error(`unreachable mode: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Tools that can legitimately ANSWER a data question.
 *
 * ⚠️ `query` BELONGS HERE BECAUSE THE TOOL SURFACE SAYS SO (#5122).
 * `QUERY_TOOL_DESCRIPTION` tells the client in as many words: *"This is the
 * recommended path for question-answering… prefer it when answer quality
 * matters."* The grader counted only `runMetric` / `executeSQL`, so a model
 * that followed the surface's own recommendation was scored as a
 * `tool_selection` failure (cq-008). An eval whose rubric contradicts the
 * descriptions it is grading measures the disagreement, not the model.
 */
const ANSWERING_TOOLS = ["runMetric", "executeSQL", "query"] as const;

function isAnsweringCall(c: RecordedToolCall): boolean {
  return (ANSWERING_TOOLS as readonly string[]).includes(c.name);
}

function gradeMetric(
  q: Extract<Question, { mode: "metric" }>,
  toolCalls: readonly RecordedToolCall[],
  finalText: string,
  latencyMs: number,
  expectation: MetricExpectation | undefined,
): McpLlmOutcome {
  const answering = toolCalls.filter(isAnsweringCall);

  if (answering.length === 0) {
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "tool_selection",
      tool: null,
      args: {},
      response: { calledTools: toolCalls.map((c) => c.name) },
      expected: { firstChoice: "runMetric", alsoAccepted: ANSWERING_TOOLS },
      summary: `LLM never called an answering tool (${ANSWERING_TOOLS.join(" / ")}) for metric ${q.metric_id}`,
    });
  }

  // `runMetric` with the right id runs the semantic layer's own SQL, so it is
  // correct by construction — no value comparison needed or possible to fail.
  const metricSuccess = answering.find(
    (c) => c.name === "runMetric" && c.args.id === q.metric_id && c.result.kind === "ok",
  );
  if (metricSuccess) return passOutcome(q, toolCalls, finalText, latencyMs);

  // Ground truth is needed ONLY to adjudicate a successful answer. A run that
  // produced no successful answering call is classified below from the call
  // sequence alone, so requiring an expectation there would turn a legitimate
  // `recovery` verdict into a harness crash.
  const succeeded = answering.filter((c) => c.result.kind === "ok");
  if (succeeded.length > 0) {
    // Missing it means the harness never established what the right answer is —
    // fail loudly rather than fall through to a weaker check and report a
    // number nobody verified.
    if (!expectation) {
      throw new Error(
        `[harness] ${q.id}: no MetricExpectation for "${q.metric_id}". ` +
          `Ground truth is derived by executing the metric's authoritative SQL; ` +
          `without it a successful answer cannot be adjudicated. Check that ` +
          `findMetricById resolves "${q.metric_id}" in the installed semantic layer.`,
      );
    }
    const matched = succeeded.some(
      (c) => c.result.kind === "ok" && resultMatchesExpectation(c.result.data, expectation),
    );
    if (matched) return passOutcome(q, toolCalls, finalText, latencyMs);
  }

  // Recovery vs tool_selection: scope to mode-relevant tools so a
  // bystander `searchGlossary` returning `ambiguous_term` doesn't get
  // blamed on a metric question.
  const errorCalls = answering.filter(isErrorResult);
  if (errorCalls.length > 0) {
    const last = errorCalls[errorCalls.length - 1]!;
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "recovery",
      tool: last.name,
      args: last.args,
      response: last.result.envelope,
      expected: { metric_id: q.metric_id, success: true },
      summary: `LLM saw ${errorCalls.length} error envelope(s) on ${ANSWERING_TOOLS.join("/")} for metric ${q.metric_id} and did not produce a successful answer`,
    });
  }

  return failOutcome({
    question: q,
    latencyMs,
    finalText,
    toolCalls,
    category: "tool_selection",
    tool: null,
    args: {},
    response: {
      calledTools: toolCalls.map((c) => c.name),
      observedValues: answering
        .filter((c) => c.result.kind === "ok")
        .flatMap((c) => (c.result.kind === "ok" ? numericValues(collectRows(c.result.data)) : []))
        .slice(0, 12),
    },
    expected: { metric_id: q.metric_id, expectation: expectation ?? null },
    summary:
      `LLM answered metric ${q.metric_id} but no result matched the authoritative value ` +
      `(${
        expectation === undefined
          ? "no expectation resolved"
          : expectation.kind === "scalar"
            ? `scalar ${expectation.value}`
            : `keys [${expectation.keys.join(", ")}]`
      })`,
  });
}

/**
 * True when ANY answering call's result matches the expectation. Shared by the
 * pattern / virtual graders, which use it as an extra accept path.
 */
function matchesAnyAnsweringResult(
  toolCalls: readonly RecordedToolCall[],
  expectation: MetricExpectation,
): boolean {
  return toolCalls
    .filter(isAnsweringCall)
    .some((c) => c.result.kind === "ok" && resultMatchesExpectation(c.result.data, expectation));
}

// ── Answer comparison ────────────────────────────────────────────────

/**
 * Pull result rows out of whichever answering tool produced them.
 * `runMetric` / `executeSQL` answer `{ columns, rows }`; `query` answers
 * `{ answer, sql, data }` where `data` is one entry per SELECT its agent ran.
 */
function collectRows(data: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  const obj = data as { rows?: unknown; data?: unknown };
  const out: Record<string, unknown>[] = [];
  if (Array.isArray(obj.rows)) {
    for (const r of obj.rows) if (r && typeof r === "object") out.push(r as Record<string, unknown>);
  }
  if (Array.isArray(obj.data)) {
    for (const entry of obj.data) out.push(...collectRows(entry));
  }
  return out;
}

/**
 * Every finite number appearing in the rows. Postgres returns `numeric` as a
 * STRING over the wire, so string cells that parse as numbers count — without
 * that, every `SUM`/`AVG`/`COUNT` answer would look non-numeric.
 */
function numericValues(rows: ReadonlyArray<Record<string, unknown>>): number[] {
  const out: number[] = [];
  for (const row of rows) {
    for (const cell of Object.values(row)) {
      if (typeof cell === "number" && Number.isFinite(cell)) out.push(cell);
      else if (typeof cell === "string" && cell.trim() !== "") {
        const n = Number(cell);
        if (Number.isFinite(n)) out.push(n);
      }
    }
  }
  return out;
}

/**
 * Unit scalings accepted when comparing a scalar.
 *
 * The demo layer stores money in CENTS and several metrics divide by 100 to
 * present dollars, so cents-vs-dollars is a presentation choice the model makes
 * freely (cq-003 answered AOV in dollars against a cents-denominated metric).
 * Accepting the two conversions is deliberate and bounded — it is NOT a
 * tolerance on correctness: a wrong total is still wrong at every scaling.
 */
const UNIT_SCALINGS = [1, 100, 0.01] as const;

/** Decimal places carried by a number's shortest exact representation. */
function decimalPlaces(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  const dot = s.indexOf(".");
  if (dot === -1) return 0;
  const exp = s.indexOf("e");
  if (exp !== -1) return Math.min(20, Math.max(0, exp - dot - 1));
  return Math.min(20, s.length - dot - 1);
}

/**
 * Equal to the precision the LESS precise of the two actually expresses.
 *
 * ⚠️ THIS EXISTS BECAUSE THE FIRST CUT OF THE VALUE GRADER REPRODUCED THE VERY
 * DEFECT IT REPLACED. A plain 1e-6 relative tolerance failed cq-019: the
 * `return_rate` metric ends in `ROUND(…, 1)` and publishes `11.2`, the model
 * rounded the identical ratio to two places and answered `11.22`, and the
 * grader called it wrong. That is the same "rejected a correct answer over
 * presentation" mistake as the `AVG(total_cents)` needle — reintroduced one
 * layer down, by the fix, and caught only because cq-019 had passed the run
 * before and regressed.
 *
 * Rounding BOTH sides to `min(dp(a), dp(b))` accepts a difference in displayed
 * precision and nothing else:
 *
 *   expected 11.2  (1dp)  vs 11.22 (2dp) → 11.2 vs 11.2   → equal
 *   expected 11.2  (1dp)  vs 11.9  (1dp) → 11.2 vs 11.9   → NOT equal
 *   expected 180.194362   vs 180.19      → 180.19 both    → equal
 *   expected 8000  (0dp)  vs 7999        → 8000 vs 7999   → NOT equal
 *
 * The trade-off, stated rather than hidden: an answer coarser than the
 * authoritative value is accepted at its own precision (a model answering
 * "about $180" for 180.194362 passes). That is the right call — the metric
 * publishes no claim finer than what it prints, so the eval cannot assert one
 * — but it does mean this check grades magnitude, not significant figures.
 */
function approximatelyEqual(a: number, b: number): boolean {
  if (a === b) return true;
  const dp = Math.min(decimalPlaces(a), decimalPlaces(b));
  if (a.toFixed(dp) === b.toFixed(dp)) return true;
  // Float artifacts below the compared precision (0.1 + 0.2 ≠ 0.3) still need a
  // relative epsilon; without it two values that ARE equal to `dp` places can
  // straddle a rounding boundary and miss.
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= (scale > 1 ? scale * 1e-9 : 1e-12);
}

function resultMatchesExpectation(data: unknown, expectation: MetricExpectation): boolean {
  const rows = collectRows(data);
  if (rows.length === 0) return false;

  if (expectation.kind === "scalar") {
    return numericValues(rows).some((candidate) =>
      UNIT_SCALINGS.some((s) => approximatelyEqual(candidate * s, expectation.value)),
    );
  }

  // Keyed: some column of the model's result must carry exactly the
  // authoritative grouping keys. Compared as a SET so column aliasing, extra
  // measure columns, and ORDER BY differences don't matter, while a missing or
  // spurious group does.
  const expected = new Set(expectation.keys.map(normalizeKey));
  if (expected.size === 0) return false;
  const byColumn = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const [col, cell] of Object.entries(row)) {
      if (cell === null || cell === undefined) continue;
      let set = byColumn.get(col);
      if (!set) {
        set = new Set();
        byColumn.set(col, set);
      }
      set.add(normalizeKey(String(cell)));
    }
  }
  for (const set of byColumn.values()) {
    if (set.size !== expected.size) continue;
    let allPresent = true;
    for (const k of expected) {
      if (!set.has(k)) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) return true;
  }
  return false;
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase();
}

function gradeGlossary(
  q: Extract<Question, { mode: "glossary" }>,
  toolCalls: readonly RecordedToolCall[],
  finalText: string,
  latencyMs: number,
): McpLlmOutcome {
  const glossaryCalls = toolCalls.filter((c) => c.name === "searchGlossary");

  // ── The contract is "ASK, never silently pick" (#5122) ──────────────
  //
  // questions.yml states it in as many words above the glossary block:
  // *"`status: ambiguous` terms — agent must ASK, never silently pick."* The
  // grader instead demanded a literal `searchGlossary({term})` DISPATCH, which
  // is a different claim, and the corpus was never authored to support it: the
  // deterministic harness does not invoke the agent for glossary mode at all
  // (`runWithAgent` returns semantic-layer state directly), so these three
  // questions assert glossary STATE and the LLM grader repurposed them as
  // tool-selection tests — the same category error as the `sql_pattern` needles.
  //
  // Both accept paths below are evidenced by captured answers, not assumed:
  //
  //   cq-013  dispatched `query` (which consults the glossary server-side) and
  //           answered "the glossary shows there are MULTIPLE ways to measure
  //           revenue… Which type would you like to see?" — the contract,
  //           performed exactly, and graded a tool_selection failure.
  //   cq-014  "Filter by status" → "I need more context. Could you please
  //           clarify: what data are you looking at?" with NO tool dispatched.
  //   cq-015  "What's the price?" → the same shape.
  //
  // ⚠️ The second path requires that NO answering tool ran. That is what keeps
  // it from being a loophole: the regression this eval exists to catch is an
  // agent that guesses a mapping and returns a number, and an answer that
  // dispatched nothing cannot have done that.
  if (q.expect.status === "ambiguous") {
    const envelopeForTerm =
      glossaryCalls.find((c) => c.result.kind === "error")?.result.kind === "error"
        ? (glossaryCalls.find((c) => c.result.kind === "error")!
            .result as { envelope: ToolErrorEnvelope }).envelope
        : null;
    if (surfacedAmbiguity(finalText, q.term, envelopeForTerm)) {
      return passOutcome(q, toolCalls, finalText, latencyMs);
    }
    const answered = toolCalls.some(isAnsweringCall);
    if (!answered && asksForClarification(finalText)) {
      return passOutcome(q, toolCalls, finalText, latencyMs);
    }
  }

  if (glossaryCalls.length === 0) {
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "tool_selection",
      tool: null,
      args: {},
      response: { calledTools: toolCalls.map((c) => c.name) },
      expected: { tool: "searchGlossary", term: q.term },
      summary: `LLM never called searchGlossary for term "${q.term}"`,
    });
  }

  const matchingCall = glossaryCalls.find((c) => {
    const term = c.args.term;
    return typeof term === "string" && term.toLowerCase() === q.term.toLowerCase();
  });
  if (!matchingCall) {
    const got = glossaryCalls.map((c) => c.args.term);
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "tool_selection",
      tool: "searchGlossary",
      args: { calledWith: got },
      response: { calledTerms: got },
      expected: { term: q.term },
      summary: `LLM called searchGlossary but never with "${q.term}"`,
    });
  }

  // For ambiguous terms, the eval cares about two things:
  //   1. The MCP tool returned an `ambiguous_term` envelope (semantic-
  //      layer correctness — already covered by the typed eval).
  //   2. The LLM did NOT immediately recover by dispatching `executeSQL`
  //      with a guessed mapping. The recovery contract says it should
  //      surface the ambiguity to the user — which we proxy by checking
  //      the dispatch sequence stopped, OR the final text mentions the
  //      ambiguity / a synonym from `possible_mappings`.
  if (q.expect.status === "ambiguous") {
    const ambiguousEnvelope: ToolErrorEnvelope | null =
      matchingCall.result.kind === "error" ? matchingCall.result.envelope : null;
    if (ambiguousEnvelope?.code !== "ambiguous_term") {
      return failOutcome({
        question: q,
        latencyMs,
        finalText,
        toolCalls,
        category: "recovery",
        tool: "searchGlossary",
        args: matchingCall.args,
        response: matchingCall.result,
        expected: { code: "ambiguous_term" },
        summary: `searchGlossary did not return ambiguous_term envelope for "${q.term}"`,
      });
    }
    // Did the LLM proceed to executeSQL anyway? Acceptable IFF the final
    // text surfaces the ambiguity (e.g. "the term 'revenue' is
    // ambiguous — did you mean GMV or net revenue?"). We accept any
    // mention of the term + "ambig" / "multiple" / a `possible_mappings`
    // entry as evidence the LLM honored the recovery contract.
    const proceededAfter = toolCalls
      .slice(toolCalls.indexOf(matchingCall) + 1)
      .some((c) => c.name === "executeSQL");
    if (proceededAfter && !surfacedAmbiguity(finalText, q.term, ambiguousEnvelope)) {
      return failOutcome({
        question: q,
        latencyMs,
        finalText,
        toolCalls,
        category: "recovery",
        tool: "executeSQL",
        args: {},
        response: { finalText: finalText.slice(0, 256) },
        expected: { surface: `ambiguity for "${q.term}"` },
        summary: `LLM ignored ambiguous_term envelope for "${q.term}" and dispatched executeSQL without surfacing the ambiguity`,
      });
    }
  }

  return passOutcome(q, toolCalls, finalText, latencyMs);
}

/**
 * True when the answer is a request for disambiguation rather than an answer.
 *
 * Requires an actual question plus a clarification cue, so a confident wrong
 * answer that merely happens to contain "what" does not qualify. Paired with
 * the "no answering tool ran" guard at the call site, which is what makes this
 * safe: together they say "the agent returned no figure and asked instead".
 */
function asksForClarification(text: string): boolean {
  if (!text.includes("?")) return false;
  return /\bclarif|more context|could you|can you|which (one|type|of these)|what (specific|data|are you|exactly)/i.test(
    text,
  );
}

function surfacedAmbiguity(
  text: string,
  term: string,
  envelope: ToolErrorEnvelope | null,
): boolean {
  const haystack = text.toLowerCase();
  if (!haystack.includes(term.toLowerCase())) return false;
  if (/ambig|multiple|disambig|could mean|either/.test(haystack)) return true;
  // Mention of any `possible_mappings` entry is also acceptable — the
  // LLM may have surfaced "did you mean GMV or net_revenue?" without
  // using the word "ambiguous".
  const mappings = envelope?.possible_mappings;
  if (Array.isArray(mappings)) {
    return mappings.some(
      (m) => typeof m === "string" && haystack.includes(m.toLowerCase()),
    );
  }
  return false;
}

function gradePattern(
  q: Extract<Question, { mode: "pattern" }>,
  toolCalls: readonly RecordedToolCall[],
  finalText: string,
  latencyMs: number,
  expectation: MetricExpectation | undefined,
): McpLlmOutcome {
  // Pattern questions accept either the introspection path (describeEntity
  // → executeSQL with the pattern's SQL) or a direct executeSQL whose
  // text matches the expected sql_pattern substrings. Both are valid;
  // the regression class we care about is "neither happened".
  const describeCalls = toolCalls.filter((c) => c.name === "describeEntity");
  const sqlCalls = toolCalls.filter((c) => c.name === "executeSQL");

  // Value match against the pattern's OWN SQL — the accept path that makes a
  // correctly-answered question pass regardless of how the model phrased the
  // filter (#5122; cq-016 flipped pass→fail across two runs on phrasing alone).
  if (expectation && matchesAnyAnsweringResult(toolCalls, expectation)) {
    return passOutcome(q, toolCalls, finalText, latencyMs);
  }

  if (describeCalls.length === 0 && sqlCalls.length === 0) {
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "tool_selection",
      tool: null,
      args: {},
      response: { calledTools: toolCalls.map((c) => c.name) },
      expected: {
        firstChoice: `describeEntity({name: "${q.entity}"})`,
        orFallback: "executeSQL with pattern SQL",
      },
      summary: `LLM never called describeEntity or executeSQL for pattern ${q.entity}.${q.pattern}`,
    });
  }

  // Empty `sql_pattern` falls back to a structural check that the
  // dispatched SQL at least references `q.entity` — the deterministic
  // eval grades these by row-count bounds, but the LLM-mode grader
  // can't see rows directly without an entity-aware adapter, so an
  // entity-name reference is the cheapest meaningful check that
  // prevents `SELECT 1` from passing as "answered the pattern question".
  const sqlPatterns = q.expect.sql_pattern ?? [];
  const fallbackPatterns =
    sqlPatterns.length === 0 ? [q.entity] : sqlPatterns;
  const sqlSuccess = findSqlMatch(sqlCalls, fallbackPatterns);
  if (sqlSuccess) return passOutcome(q, toolCalls, finalText, latencyMs);

  // Accept describeEntity that returned an entity carrying the pattern
  // — the LLM may have chosen to surface the pattern without re-issuing
  // the SQL. The deterministic eval pins this same shape.
  const entityCarriesPattern = describeCalls.some((c) => {
    if (c.result.kind !== "ok") return false;
    const data = c.result.data as
      | { entity?: { query_patterns?: Array<{ name?: unknown }> } }
      | null;
    const patterns = data?.entity?.query_patterns ?? [];
    return patterns.some((p) => p?.name === q.pattern);
  });
  if (entityCarriesPattern) return passOutcome(q, toolCalls, finalText, latencyMs);

  return failOutcome({
    question: q,
    latencyMs,
    finalText,
    toolCalls,
    category: "tool_selection",
    tool: null,
    args: {},
    response: { calledTools: toolCalls.map((c) => c.name) },
    expected: { entity: q.entity, pattern: q.pattern, sql_pattern: sqlPatterns },
    summary: `LLM dispatched describeEntity/executeSQL but neither matched pattern ${q.entity}.${q.pattern}`,
  });
}

function gradeVirtual(
  q: Extract<Question, { mode: "virtual" }>,
  toolCalls: readonly RecordedToolCall[],
  finalText: string,
  latencyMs: number,
  expectation: MetricExpectation | undefined,
): McpLlmOutcome {
  const sqlCalls = toolCalls.filter((c) => c.name === "executeSQL");

  // Same additive value-match accept path as `gradePattern`.
  if (expectation && matchesAnyAnsweringResult(toolCalls, expectation)) {
    return passOutcome(q, toolCalls, finalText, latencyMs);
  }

  if (sqlCalls.length === 0) {
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "tool_selection",
      tool: null,
      args: {},
      response: { calledTools: toolCalls.map((c) => c.name) },
      expected: { tool: "executeSQL", virtual_dimension: q.dimension },
      summary: `LLM never called executeSQL for virtual dimension ${q.entity}.${q.dimension}`,
    });
  }

  // Empty `sql_pattern` falls back to checking that the dispatched
  // SQL at least references `q.dimension` (or `q.entity`) — without
  // this fallback an LLM that returned `SELECT 1` would pass virtual-
  // dimension questions, hiding a real semantic-layer regression. The
  // deterministic eval gates on row-count bounds but the LLM grader
  // can't reach into the result rows without entity-shape knowledge.
  const sqlPatterns = q.expect.sql_pattern ?? [];
  const fallbackPatterns =
    sqlPatterns.length === 0 ? [q.dimension] : sqlPatterns;
  const success = findSqlMatch(sqlCalls, fallbackPatterns);
  if (success) return passOutcome(q, toolCalls, finalText, latencyMs);

  const errorCalls = sqlCalls.filter(isErrorResult);
  if (errorCalls.length > 0) {
    const last = errorCalls[errorCalls.length - 1]!;
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "recovery",
      tool: "executeSQL",
      args: last.args,
      response: last.result.envelope,
      expected: { sql_pattern: fallbackPatterns },
      summary: `executeSQL returned error envelope(s) for virtual ${q.entity}.${q.dimension} and LLM did not recover`,
    });
  }

  return failOutcome({
    question: q,
    latencyMs,
    finalText,
    toolCalls,
    category: "tool_selection",
    tool: "executeSQL",
    args: {},
    response: { sqlCalls: sqlCalls.map((c) => c.args.sql) },
    expected: { sql_pattern: sqlPatterns },
    summary: `LLM dispatched executeSQL but no call matched virtual ${q.entity}.${q.dimension}`,
  });
}

// ── Outcome constructors ─────────────────────────────────────────────

/**
 * Inputs for {@link failOutcome}. `question` and `latencyMs` are the
 * only invariants both the outcome wrapper AND the inner artifact
 * need to share — taking the artifact as `Omit<…, "questionId" | "latencyMs">`
 * eliminates the per-site duplication that previously made it possible
 * to construct an outcome whose `questionId` disagreed with its
 * `artifact.questionId`.
 */
interface FailOutcomeInput {
  readonly question: Question;
  readonly latencyMs: number;
  readonly finalText: string;
  readonly toolCalls: readonly RecordedToolCall[];
  readonly category: FailureCategory;
  readonly tool: string | null;
  readonly args: Readonly<Record<string, unknown>>;
  readonly response: unknown;
  readonly expected: unknown;
  readonly summary: string;
}

function failOutcome(input: FailOutcomeInput): McpLlmOutcome {
  const questionId = input.question.id;
  return {
    questionId,
    status: "fail",
    latencyMs: input.latencyMs,
    toolCalls: input.toolCalls,
    finalText: input.finalText,
    artifact: {
      questionId,
      category: input.category,
      tool: input.tool,
      args: input.args,
      latencyMs: input.latencyMs,
      response: input.response,
      expected: input.expected,
      summary: input.summary,
    },
  };
}

function passOutcome(
  q: Question,
  toolCalls: readonly RecordedToolCall[],
  finalText: string,
  latencyMs: number,
): McpLlmOutcome {
  return {
    questionId: q.id,
    status: "pass",
    latencyMs,
    toolCalls,
    finalText,
  };
}

// ── Type predicates / shared helpers ─────────────────────────────────

/**
 * Find an `executeSQL` call whose result is `ok` AND whose SQL contains
 * every required substring (case-insensitive). Extracted because the
 * exact body was duplicated in `gradeMetric`, `gradePattern`, and
 * `gradeVirtual`. Empty `patterns` accepts any successful SQL — the
 * per-mode graders pass a structural fallback (entity / dimension name)
 * when the question's `expect.sql_pattern` is empty so an LLM can't
 * pass a metric question with `SELECT 1`.
 */
function findSqlMatch(
  sqlCalls: readonly RecordedToolCall[],
  patterns: readonly string[],
): RecordedToolCall | undefined {
  return sqlCalls.find((c) => {
    if (c.result.kind !== "ok") return false;
    if (patterns.length === 0) return true;
    const sql = ((c.args.sql as string | undefined) ?? "").toLowerCase();
    return patterns.every((p) => sql.includes(p.toLowerCase()));
  });
}

/**
 * A call whose result could not be read as the protocol requires.
 *
 * ⚠️ DELIBERATELY CONTRACT-BLIND. #5131 was a text-output tool graded against
 * the JSON contract, and the tempting fix was a `contract === "json"` clause
 * right here — which would have put the exemption in a guard body, leaving
 * every other reader of `result.kind` free to reopen the bug. The contract is
 * applied by {@link interpretResult} at the recording seam instead, so by the
 * time a call reaches this predicate `unparseable` already means the same
 * thing for every tool: nobody could read it, and that is a regression.
 */
type UnparseableCall = RecordedToolCall & {
  readonly result: { readonly kind: "unparseable"; readonly raw: string };
};
function isUnparseable(c: RecordedToolCall): c is UnparseableCall {
  return c.result.kind === "unparseable";
}

type ErrorCall = RecordedToolCall & {
  readonly result: { readonly kind: "error"; readonly envelope: ToolErrorEnvelope };
};
function isErrorResult(c: RecordedToolCall): c is ErrorCall {
  return c.result.kind === "error";
}
function isTransportFail(c: RecordedToolCall): c is ErrorCall {
  if (c.result.kind !== "error") return false;
  return (c.result.envelope as TransportErrorEnvelope).__transport === true;
}

// ── Test surface ─────────────────────────────────────────────────────

/**
 * Per-mode graders + the top-level grade dispatcher exposed for direct
 * unit testing. Production callers use {@link runMcpLlmEval} which threads
 * tool calls through MCP and then hands the recorded sequence here.
 *
 * Kept in an `__forTesting__` namespace (rather than exported as
 * top-level functions) so a future caller doesn't accidentally take a
 * dependency on the per-mode graders' shape and lock the grader
 * implementation. The unit tests in `canonical-eval-mcp-llm.test.ts`
 * are the only intended consumers.
 *
 * `classifyToolContract`, `interpretResult` and `assertTextContractToolsPresent`
 * are deliberately NOT here: `canonical-eval-tool-selection.ts` consumes them as
 * real dependencies, so they are ordinary top-level exports. Listing them here
 * as well would imply a test-only surface they do not have.
 */
export const __forTesting__ = {
  grade: (input: GradeInput) => grade(input),
  gradeMetric,
  gradeGlossary,
  gradePattern,
  gradeVirtual,
  bindMcpToolsForLlm,
} as const;

// ── Baseline I/O ────────────────────────────────────────────────────

/**
 * Read a per-question latency baseline from disk. Returns `undefined`
 * when the file is missing — the grader treats that as "no baseline
 * yet" and skips the latency check. Malformed / empty JSON throws so a
 * corrupted baseline doesn't silently degrade to no-check.
 *
 * Every error path includes the file path so a contributor with a
 * mangled baseline (typically a merge-conflict casualty) can act on
 * the message without having to diff against `git`.
 */
export function readBaseline(
  filePath: string,
): Readonly<Record<string, number>> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf-8");
  if (raw.trim() === "") {
    throw new Error(
      `baseline file ${filePath} is empty. Either delete it or regenerate via --write-baseline.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse baseline file ${filePath}: ${msg}`, {
      cause: err,
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`baseline file ${filePath} is not a JSON object`);
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Write a per-question baseline derived from a successful eval run.
 * The CLI surfaces this via `--write-baseline`; the docs describe how
 * to regenerate when the dispatch shape legitimately shifts.
 *
 * Permission / quota / parent-dir errors are wrapped with a "Tip:"
 * hint so a CI runner with a read-only filesystem leaves an actionable
 * trail rather than the bare `EACCES` / `EROFS` / `ENOSPC` Node FS
 * errors. Mirrors the wrap pattern in `seedDemoPostgres` at
 * `canonical-eval-run.ts:428-438`.
 */
export function writeBaseline(
  filePath: string,
  outcomes: readonly McpLlmOutcome[],
): void {
  const out: Record<string, number> = {};
  for (const o of outcomes) out[o.questionId] = o.latencyMs;
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to write baseline to ${filePath}: ${msg}. ` +
        `Tip: ensure the parent directory exists and the file is writable.`,
      { cause: err },
    );
  }
}
