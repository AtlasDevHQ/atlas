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
 * gated on `ANTHROPIC_API_KEY`.
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
  startEvalAuthServer,
  type EvalAuthFixture,
} from "@atlas/mcp/eval/auth";
import {
  EvalMcpClient,
  extractToolJson,
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
 * Captured shape of one tool dispatch the LLM fired through MCP. The
 * grading code below walks the recorded sequence to decide pass / fail
 * categories — keep this shape stable; the unit tests assert on it.
 */
export interface RecordedToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly latencyMs: number;
  /**
   * Either the parsed MCP tool result (via {@link extractToolJson}) or
   * a synthesized error envelope when the dispatch itself threw before
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

export interface McpLlmEvalOptions {
  readonly questionsPath?: string;
  readonly model: LanguageModel;
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
        // intentionally ignored: surfacing the close error would mask
        // the original connect failure, which is the actionable signal.
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
    set[t.name] = dynamicTool({
      description: t.description ?? `MCP tool ${t.name}`,
      inputSchema: jsonSchema(schema),
      execute: async (rawArgs) => {
        const args = (rawArgs as Record<string, unknown> | undefined) ?? {};
        const start = Date.now();
        try {
          const result = await client.callTool(t.name, args);
          const parsed = extractToolJson(result);
          const latencyMs = Date.now() - start;
          recorder.push({
            name: t.name,
            args,
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
  });
}

// ── Grading ──────────────────────────────────────────────────────────

interface GradeInput {
  readonly question: Question;
  readonly toolCalls: readonly RecordedToolCall[];
  readonly finalText: string;
  readonly latencyMs: number;
  readonly baseline: McpLlmEvalOptions["baseline"];
}

/**
 * Per-mode grader. Pass criteria are intentionally lenient on **how**
 * the LLM arrived at the answer (multiple tool sequences are valid for
 * most questions) and strict on **whether** the answer matches the
 * question's contract. This mirrors the deterministic eval's posture —
 * `--mcp-llm` is a regression gate on tool-selection quality, not a
 * style guide for the model.
 */
function grade(input: GradeInput): McpLlmOutcome {
  const { question: q, toolCalls, finalText, latencyMs, baseline } = input;

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
      response: { raw: unparseable.result.raw },
      expected: "JSON envelope from MCP tool",
      summary: `MCP tool ${unparseable.name} returned non-JSON content`,
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

  const modeOutcome = gradeByMode(q, toolCalls, finalText, latencyMs);
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

function gradeByMode(
  q: Question,
  toolCalls: readonly RecordedToolCall[],
  finalText: string,
  latencyMs: number,
): McpLlmOutcome {
  switch (q.mode) {
    case "metric":
      return gradeMetric(q, toolCalls, finalText, latencyMs);
    case "glossary":
      return gradeGlossary(q, toolCalls, finalText, latencyMs);
    case "pattern":
      return gradePattern(q, toolCalls, finalText, latencyMs);
    case "virtual":
      return gradeVirtual(q, toolCalls, finalText, latencyMs);
    default: {
      const _exhaustive: never = q;
      throw new Error(`unreachable mode: ${String(_exhaustive)}`);
    }
  }
}

function gradeMetric(
  q: Extract<Question, { mode: "metric" }>,
  toolCalls: readonly RecordedToolCall[],
  finalText: string,
  latencyMs: number,
): McpLlmOutcome {
  const metricCalls = toolCalls.filter((c) => c.name === "runMetric");
  const sqlCalls = toolCalls.filter((c) => c.name === "executeSQL");

  if (metricCalls.length === 0 && sqlCalls.length === 0) {
    return failOutcome({
      question: q,
      latencyMs,
      finalText,
      toolCalls,
      category: "tool_selection",
      tool: null,
      args: {},
      response: { calledTools: toolCalls.map((c) => c.name) },
      expected: { firstChoice: "runMetric", fallback: "executeSQL" },
      summary: `LLM never called runMetric or executeSQL for metric ${q.metric_id}`,
    });
  }

  const metricSuccess = metricCalls.find(
    (c) => c.args.id === q.metric_id && c.result.kind === "ok",
  );
  if (metricSuccess) return passOutcome(q, toolCalls, finalText, latencyMs);

  const sqlPatterns = q.expect.sql_pattern ?? [];
  const sqlSuccess = findSqlMatch(sqlCalls, sqlPatterns);
  if (sqlSuccess) return passOutcome(q, toolCalls, finalText, latencyMs);

  // Recovery vs tool_selection: scope to mode-relevant tools so a
  // bystander `searchGlossary` returning `ambiguous_term` doesn't get
  // blamed on a metric question. Mirrors `gradeVirtual`'s scoped
  // filter — `gradeMetric` previously caught any error envelope from
  // any tool which made the artifact actively misleading.
  const errorCalls = [...metricCalls, ...sqlCalls].filter(isErrorResult);
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
      summary: `LLM saw ${errorCalls.length} error envelope(s) on runMetric/executeSQL for metric ${q.metric_id} and did not produce a successful answer`,
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
    response: { calledTools: toolCalls.map((c) => c.name) },
    expected: { metric_id: q.metric_id, sql_pattern: sqlPatterns },
    summary: `LLM dispatched runMetric/executeSQL but neither produced a matching successful answer for metric ${q.metric_id}`,
  });
}

function gradeGlossary(
  q: Extract<Question, { mode: "glossary" }>,
  toolCalls: readonly RecordedToolCall[],
  finalText: string,
  latencyMs: number,
): McpLlmOutcome {
  const glossaryCalls = toolCalls.filter((c) => c.name === "searchGlossary");
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
): McpLlmOutcome {
  // Pattern questions accept either the introspection path (describeEntity
  // → executeSQL with the pattern's SQL) or a direct executeSQL whose
  // text matches the expected sql_pattern substrings. Both are valid;
  // the regression class we care about is "neither happened".
  const describeCalls = toolCalls.filter((c) => c.name === "describeEntity");
  const sqlCalls = toolCalls.filter((c) => c.name === "executeSQL");

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
): McpLlmOutcome {
  const sqlCalls = toolCalls.filter((c) => c.name === "executeSQL");
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
