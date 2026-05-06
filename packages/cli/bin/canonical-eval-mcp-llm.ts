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
 * `--mcp-llm` flag. The exported `runMcpLlmEval` function is also reused
 * by `canonical-eval-mcp-llm.test.ts` with a `MockLanguageModelV3` so the
 * dispatch + grading logic itself is unit-tested without burning tokens.
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
  readonly result:
    | { readonly kind: "ok"; readonly data: unknown }
    | { readonly kind: "error"; readonly envelope: unknown }
    | { readonly kind: "unparseable"; readonly raw: string };
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
    await client.connect();
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
  client: EvalMcpClient,
  tools: readonly ToolListEntry[],
  recorder: RecordedToolCall[],
): ToolSet {
  // `dynamicTool` (rather than `tool`) is the right shape here: the
  // input schema comes from the MCP server at runtime, so we cannot
  // statically infer the input type the way `tool({ inputSchema: z.object(...) })`
  // does. `dynamicTool` accepts the schema as `FlexibleSchema<unknown>`
  // and skips the input-typing inference, which matches how the
  // production agent loop binds MCP-discovered tools.
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
          const message = err instanceof Error ? err.message : String(err);
          recorder.push({
            name: t.name,
            args,
            latencyMs,
            result: { kind: "error", envelope: { error: message } },
          });
          // Re-throw so a transport-level failure surfaces in the
          // caller's `streamText` rather than getting silently buried as
          // a tool-result. Recovery-class regressions live at the
          // envelope layer; transport regressions deserve their own loud
          // failure path.
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
  try {
    const result = streamText({
      model: input.model,
      tools: input.tools,
      system: input.systemPrompt,
      messages: [{ role: "user", content: question.question }],
      stopWhen: stepCountIs(getAgentMaxSteps()),
    });
    // Awaiting `.text` drains the stream — every `tool-call` step has
    // executed by the time the promise resolves, so `recorded` is the
    // complete dispatch sequence the grader walks below.
    finalText = await result.text;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return failOutcome({
      question,
      latencyMs,
      finalText,
      toolCalls: [...recorded],
      category: "protocol",
      tool: null,
      args: {},
      response: { error: message },
      expected: "successful streamText round-trip",
      summary: `streamText threw: ${message}`,
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
  // sequence implies.
  const unparseable = toolCalls.find((c) => c.result.kind === "unparseable");
  if (unparseable && unparseable.result.kind === "unparseable") {
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
  const sqlSuccess = sqlCalls.find((c) => {
    if (c.result.kind !== "ok") return false;
    if (sqlPatterns.length === 0) return true;
    const sql = ((c.args.sql as string | undefined) ?? "").toLowerCase();
    return sqlPatterns.every((p) => sql.includes(p.toLowerCase()));
  });
  if (sqlSuccess) return passOutcome(q, toolCalls, finalText, latencyMs);

  // Got error envelopes back — recovery class. Otherwise tool_selection.
  const errorCalls = toolCalls.filter((c) => c.result.kind === "error");
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
      response:
        last.result.kind === "error" ? last.result.envelope : last.result,
      expected: { metric_id: q.metric_id, success: true },
      summary: `LLM saw ${errorCalls.length} error envelope(s) for metric ${q.metric_id} and did not produce a successful answer`,
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

  const matchingCall = glossaryCalls.find(
    (c) => typeof c.args.term === "string" && (c.args.term as string).toLowerCase() === q.term.toLowerCase(),
  );
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
    const ambiguousEnvelope = matchingCall.result.kind === "error"
      ? matchingCall.result.envelope
      : null;
    const code = (ambiguousEnvelope as { code?: unknown } | null)?.code;
    if (code !== "ambiguous_term") {
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
  envelope: unknown,
): boolean {
  const haystack = text.toLowerCase();
  if (!haystack.includes(term.toLowerCase())) return false;
  if (/ambig|multiple|disambig|could mean|either/.test(haystack)) return true;
  // Mention of any `possible_mappings` entry is also acceptable — the
  // LLM may have surfaced "did you mean GMV or net_revenue?" without
  // using the word "ambiguous".
  const mappings = (envelope as { possible_mappings?: unknown[] } | null)
    ?.possible_mappings;
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

  const sqlPatterns = q.expect.sql_pattern ?? [];
  const sqlSuccess = sqlCalls.find((c) => {
    if (c.result.kind !== "ok") return false;
    if (sqlPatterns.length === 0) return true;
    const sql = ((c.args.sql as string | undefined) ?? "").toLowerCase();
    return sqlPatterns.every((p) => sql.includes(p.toLowerCase()));
  });
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

  const sqlPatterns = q.expect.sql_pattern ?? [];
  const success = sqlCalls.find((c) => {
    if (c.result.kind !== "ok") return false;
    if (sqlPatterns.length === 0) return true;
    const sql = ((c.args.sql as string | undefined) ?? "").toLowerCase();
    return sqlPatterns.every((p) => sql.includes(p.toLowerCase()));
  });
  if (success) return passOutcome(q, toolCalls, finalText, latencyMs);

  const errorCalls = sqlCalls.filter((c) => c.result.kind === "error");
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
      response:
        last.result.kind === "error" ? last.result.envelope : last.result,
      expected: { sql_pattern: sqlPatterns },
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
  return {
    questionId: input.question.id,
    status: "fail",
    latencyMs: input.latencyMs,
    toolCalls: input.toolCalls,
    finalText: input.finalText,
    artifact: {
      questionId: input.question.id,
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
 * yet" and skips the latency check. Malformed JSON throws so a
 * corrupted baseline doesn't silently degrade to no-check.
 */
export function readBaseline(
  filePath: string,
): Readonly<Record<string, number>> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
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
 */
export function writeBaseline(
  filePath: string,
  outcomes: readonly McpLlmOutcome[],
): void {
  const out: Record<string, number> = {};
  for (const o of outcomes) out[o.questionId] = o.latencyMs;
  fs.writeFileSync(filePath, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
}
