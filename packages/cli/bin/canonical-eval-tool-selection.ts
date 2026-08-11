/**
 * Tool-selection accuracy grader for the MCP tool-description audit
 * (#2075). Wired into the existing `--mcp-llm` harness via the
 * `--tool-selection` flag.
 *
 * The deterministic / canonical-question / `--mcp-llm` paths grade
 * end-to-end answer correctness. This grader is narrower: did the LLM
 * pick the right tool for the question? It exists because tool-selection
 * regressions (a description rewrite that subtly biases the LLM toward
 * the wrong route) can pass canonical-question grading by recovering
 * after several wasted dispatches — the rubric audit needs a held-out
 * signal that fires on the FIRST decision.
 *
 * Pass criterion per item: the first tool call's `name` is either
 * `expected_tool` or a member of `expected_alternates`. Overall
 * acceptance: items_passing / items_total >= `rubric.acceptance_floor`.
 * The default floor (`DEFAULT_ACCEPTANCE_FLOOR` below) is a starting
 * point — fixtures override it.
 */

import * as fs from "fs";

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
import { Hono } from "hono";

import { getAgentMaxSteps } from "@atlas/api/lib/agent";
import {
  liftEvalClientRateLimit,
  startEvalAuthServer,
  type EvalAuthFixture,
} from "@atlas/mcp/eval/auth";
import { EvalMcpClient, type ToolListEntry } from "@atlas/mcp/eval/client";
import { createHostedMcpRouter } from "@atlas/mcp/hosted";
import {
  assertTextContractToolsPresent,
  classifyToolContract,
  interpretResult,
} from "@atlas/mcp/eval/tool-contract";
import {
  isRateLimitedEnvelope,
  throttleAbortError,
  type ThrottledDispatch,
} from "@atlas/mcp/eval/throttle";

// ── Public types ──────────────────────────────────────────────────────

export interface ToolSelectionFixtureItem {
  readonly id: string;
  readonly prompt: string;
  readonly expected_tool: string;
  readonly expected_alternates?: readonly string[];
  readonly rationale?: string;
}

export interface ToolSelectionFixture {
  readonly description?: string;
  readonly rubric?: {
    readonly first_tool_must_match?: string;
    readonly acceptance_floor?: number;
  };
  readonly items: readonly ToolSelectionFixtureItem[];
}

/**
 * One dispatch the model fired, as the recorder captures it.
 *
 * ⚠️ ONE RECORD PER DISPATCH, NOT A NAME ARRAY BESIDE A THROTTLE ARRAY (#5136).
 * The throttle abort needs both the ORDER (the grader scores the first tool) and
 * the ENVELOPE, and two parallel arrays reset independently — forget one
 * `length = 0` between fixture items and a throttle leaks into the next item's
 * verdict, which is a worse bug than the one the abort was added to fix.
 *
 * `throttle` is mutable and starts `null` because the NAME is recorded BEFORE
 * the dispatch awaits — the grader needs it even when the call never resolves —
 * while the envelope only exists afterwards. Written once, at the one seam that
 * knows the result.
 */
export interface RecordedDispatch {
  readonly name: string;
  /** The throttle envelope this dispatch came back with, or `null` for every other result. */
  throttle: ThrottledDispatch | null;
}

export interface ToolSelectionOutcome {
  readonly id: string;
  readonly prompt: string;
  readonly expected: readonly string[];
  readonly firstTool: string | null;
  readonly toolSequence: readonly string[];
  readonly passed: boolean;
  readonly latencyMs: number;
}

export interface ToolSelectionResult {
  readonly outcomes: readonly ToolSelectionOutcome[];
  readonly accuracy: number;
  readonly acceptanceFloor: number;
}

const DEFAULT_ACCEPTANCE_FLOOR = 0.9;

// Bias the model toward picking once and answering instead of taking the
// dispatch loop on a tour. The audit grader only inspects the first tool
// call, so a verbose system prompt would skew accuracy upward by giving
// the model a routing hint it would NOT have under the production system
// prompt.
const TOOL_SELECTION_SYSTEM_PROMPT = [
  "You are Atlas, a data analyst. Use the MCP tools to answer the user's question.",
  "Pick the best single tool first; recover only if the tool returns an error envelope.",
].join("\n");

// ── Fixture I/O ───────────────────────────────────────────────────────

/**
 * Load and validate a tool-selection fixture. Throws with a contextful
 * message on missing-file / parse failures so a contributor with a
 * mangled fixture sees the path in the error rather than a bare
 * `SyntaxError` from `JSON.parse`.
 */
export function loadToolSelectionFixture(
  filePath: string,
): ToolSelectionFixture {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Tool-selection fixture not found at ${filePath}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse tool-selection fixture ${filePath}: ${msg}`, {
      cause: err,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Tool-selection fixture ${filePath} must be a JSON object with an \`items\` array.`,
    );
  }
  const root = parsed as Record<string, unknown>;
  const items = root.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
      `Tool-selection fixture ${filePath} has no \`items\` — at least one prompt is required.`,
    );
  }
  for (const [i, item] of items.entries()) {
    if (!item || typeof item !== "object") {
      throw new Error(`Tool-selection fixture ${filePath} item #${i} is not an object.`);
    }
    const it = item as Record<string, unknown>;
    if (typeof it.id !== "string" || it.id.trim() === "") {
      throw new Error(`Tool-selection fixture ${filePath} item #${i} is missing string \`id\`.`);
    }
    if (typeof it.prompt !== "string" || it.prompt.trim() === "") {
      throw new Error(
        `Tool-selection fixture ${filePath} item "${it.id}" is missing string \`prompt\`.`,
      );
    }
    if (typeof it.expected_tool !== "string" || it.expected_tool.trim() === "") {
      throw new Error(
        `Tool-selection fixture ${filePath} item "${it.id}" is missing string \`expected_tool\`.`,
      );
    }
    if (
      it.expected_alternates !== undefined &&
      (!Array.isArray(it.expected_alternates) ||
        !it.expected_alternates.every((a) => typeof a === "string"))
    ) {
      throw new Error(
        `Tool-selection fixture ${filePath} item "${it.id}" has malformed \`expected_alternates\` — expected string[].`,
      );
    }
  }
  return parsed as ToolSelectionFixture;
}

// ── Grader ────────────────────────────────────────────────────────────

/**
 * Grade a recorded tool-call sequence against one fixture item. Pure —
 * exposed so the unit test surface can pin grader behavior without
 * booting an LLM or MCP transport.
 *
 * ⚠️ ABORTS ON A THROTTLE BEFORE IT SCORES ANYTHING (#5136), which is where
 * `runMcpLlmEval` puts the same check and for the same reason: a throttle is a
 * HARNESS fault and must not produce a number. This grader scores the FIRST tool
 * call, so a throttled dispatch that pushes the model to retry or switch tools
 * reads as a tool-selection MISS — and the accuracy floor then moves with
 * dispatch volume rather than with tool-selection quality, which is exactly the
 * defect #5122 removed from the sibling eval.
 *
 * Inside the grader rather than in the run loop so the abort is unit-testable
 * without a live MCP transport, and so it cannot be skipped by a future caller
 * that grades an item without going through the loop.
 */
export function gradeToolSelection(
  item: ToolSelectionFixtureItem,
  dispatches: readonly RecordedDispatch[],
  latencyMs: number,
): ToolSelectionOutcome {
  const throttled = dispatches.find((d) => d.throttle !== null);
  if (throttled?.throttle) throw throttleAbortError(item.id, throttled.throttle);
  const toolSequence = dispatches.map((d) => d.name);
  const expected = [item.expected_tool, ...(item.expected_alternates ?? [])];
  const firstTool = toolSequence[0] ?? null;
  const passed = firstTool !== null && expected.includes(firstTool);
  return {
    id: item.id,
    prompt: item.prompt,
    expected,
    firstTool,
    toolSequence,
    passed,
    latencyMs,
  };
}

// ── Driver ────────────────────────────────────────────────────────────

export interface ToolSelectionRunOptions {
  readonly fixturePath: string;
  readonly model: LanguageModel;
  /** Optional pre-built auth fixture (test surface). When omitted the runner boots and tears down its own. */
  readonly fixture?: EvalAuthFixture;
  /** Optional cap on items processed (test surface). */
  readonly maxItems?: number;
  /** Optional system prompt override (test surface). */
  readonly systemPrompt?: string;
}

/**
 * Boot the in-process MCP route, hand the LLM the discovered tool
 * surface, and grade each fixture item by first-tool match. Mirrors
 * `runMcpLlmEval` in `canonical-eval-mcp-llm.ts` — same MCP transport,
 * same `dynamicTool`-based binder. Diverges only in:
 *   - input source (JSON fixture, not `questions.yml`)
 *   - grader (first-tool match, not per-mode answer correctness)
 *   - acceptance metric (accuracy floor across items)
 */
export async function runToolSelectionEval(
  opts: ToolSelectionRunOptions,
): Promise<ToolSelectionResult> {
  const fixture = loadToolSelectionFixture(opts.fixturePath);
  const acceptanceFloor =
    fixture.rubric?.acceptance_floor ?? DEFAULT_ACCEPTANCE_FLOOR;

  const ownsAuth = !opts.fixture;
  const authFixture = opts.fixture ?? (await bootDefaultFixture());

  try {
    // ⚠️ THIS EVAL SHARES THE OAUTH CLIENT AND THE TOOL SURFACE WITH `--mcp-llm`,
    // AND IT NEVER CALLED THIS (#5136). `runMcpLlmEval` lifts the quota precisely
    // because a full run out-dispatches the 60/min default (#5122); the hosted
    // per-OAuth-client limiter runs ahead of every tool body, so nothing about
    // this eval's smaller corpus makes it exempt — and the two evals run back to
    // back against the same bucket. Applied whether or not we own the fixture: a
    // shared fixture accumulates MORE load against that bucket, not less.
    //
    // INSIDE the `try` that owns the fixture, not before it: `setClientRateLimit`
    // is an in-memory map write and unlikely to throw, but a throw from outside
    // would leak the booted auth server — `close()` never runs and the process
    // hangs on an open handle instead of reporting the fault.
    liftEvalClientRateLimit(authFixture);
    const client = new EvalMcpClient({
      baseUrl: authFixture.baseUrl,
      workspaceId: authFixture.workspaceId,
      bearer: authFixture.bearer,
      clientName: "atlas-tool-selection-eval",
    });

    try {
      await client.connect();
    } catch (err) {
      try {
        await client.close();
      } catch (closeErr) {
        // Logged, not re-thrown: the connect failure is the actionable signal
        // and must be the error that propagates.
        process.stderr.write(
          `[tool-selection-eval] client.close after failed connect threw: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}\n`,
        );
      }
      throw err;
    }

    try {
      const tools = await client.listTools();
      const recorded: RecordedDispatch[] = [];
      const aiTools = bindToolsForRecording(client, tools, recorded);

      const items = fixture.items.slice(0, opts.maxItems ?? fixture.items.length);
      const outcomes: ToolSelectionOutcome[] = [];
      const systemPrompt = opts.systemPrompt ?? TOOL_SELECTION_SYSTEM_PROMPT;

      for (const item of items) {
        recorded.length = 0;
        const start = Date.now();
        let streamErr: unknown = null;
        try {
          const result = streamText({
            model: opts.model,
            tools: aiTools,
            system: systemPrompt,
            messages: [{ role: "user", content: item.prompt }],
            stopWhen: stepCountIs(getAgentMaxSteps()),
            onError: ({ error }: { error: unknown }) => {
              streamErr = error;
            },
          });
          await result.text;
          if (streamErr !== null) throw streamErr;
        } catch (err) {
          // streamText throwing here counts as "didn't pick the right tool" —
          // let the grader judge whatever was recorded before the failure. NOT
          // necessarily empty: `execute` pushes the name BEFORE dispatching, so a
          // stream that died after two calls leaves two records.
          process.stderr.write(
            `[tool-selection-eval] streamText threw on "${item.id}": ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        const latencyMs = Date.now() - start;
        // ⚠️ REACHED AFTER THE `catch` ABOVE, AND THAT IS LOAD-BEARING. The catch
        // deliberately swallows a `streamText` failure and grades WHATEVER WAS
        // RECORDED before it — possibly empty, but not necessarily, since names
        // are pushed before dispatch. (An earlier version of this comment said
        // "into an empty sequence", which is the premise a future reader would
        // reason from and it is wrong.) Either way a throttle severe enough to
        // abort the stream would be absorbed there and graded as a miss, so
        // `gradeToolSelection` reads the recorded dispatches and aborts on one
        // before it scores anything (#5136).
        outcomes.push(gradeToolSelection(item, [...recorded], latencyMs));
      }

      const passing = outcomes.filter((o) => o.passed).length;
      const accuracy = outcomes.length === 0 ? 0 : passing / outcomes.length;

      return { outcomes, accuracy, acceptanceFloor };
    } finally {
      await client.close();
    }
  } finally {
    if (ownsAuth) authFixture.close();
  }
}

async function bootDefaultFixture(): Promise<EvalAuthFixture> {
  const mcpRouter = new Hono();
  mcpRouter.route("/", createHostedMcpRouter());
  return startEvalAuthServer({ mcpRouter });
}

// Bind every MCP-discovered tool to a `dynamicTool` that records its
// `name` in dispatch order. We don't need the result envelope here —
// the grader only inspects the call sequence.
//
// ⚠️ ANCHORED, for the same reason the mcp-llm binder is: the imported
// text-contract list is spelled as a NAME, so renaming `explore` would silently
// turn the exemption back into a fabricated `{ error: "unparseable" }` for a
// successful `ls`.
//
// That cannot move THIS eval's score — `gradeToolSelection` reads
// `toolSequence[0]` only, and the name is recorded before the dispatch resolves,
// so no result can change the verdict. The reason to fix it here anyway is
// fidelity: the model must see the surface production shows it, or the tool
// choice being audited is made against a lie.
function bindToolsForRecording(
  client: { callTool: EvalMcpClient["callTool"] },
  tools: readonly ToolListEntry[],
  recorder: RecordedDispatch[],
): ToolSet {
  assertTextContractToolsPresent(tools);
  const set: Record<string, Tool> = {};
  for (const t of tools) {
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
        // Push BEFORE the dispatch so a transport-level throw still
        // shows up in the recorded sequence — the grader needs the
        // `name` for first-tool-match scoring even when the underlying
        // call fails. `throttle` is filled in below, on the one record this
        // dispatch owns.
        const record: RecordedDispatch = { name: t.name, throttle: null };
        recorder.push(record);
        const result = await client.callTool(t.name, args);
        // A text-contract tool's product IS its text (#5131). This eval does
        // not grade `protocol`, so the mis-grading half of that bug never
        // applied here; the model-facing half does, and fidelity is the reason
        // to close it (see the binder's note above).
        //
        // ⚠️ CALLS the shared `interpretResult` rather than restating its rule.
        // An earlier cut spelled the same three-way decision out inline here,
        // with a comment promising it matched — an invariant enforced by prose,
        // which a third carve-out added on the other side would silently break.
        const parsed = interpretResult(result, contract);
        if (parsed.kind === "error") {
          // ⚠️ RECORDED HERE AND RETURNED ANYWAY (#5136). The envelope still
          // goes back to the model, because aborting from inside `execute` is
          // indistinguishable to the AI SDK from a transport failure and lands
          // in the run loop's `catch`, which grades whatever was recorded before
          // the failure. `gradeToolSelection` reads the throttle after the stream
          // drains instead — the one place the abort can be loud.
          if (isRateLimitedEnvelope(parsed.envelope)) {
            record.throttle = {
              toolName: t.name,
              contract,
              envelope: parsed.envelope,
            };
          }
          return parsed.envelope;
        }
        if (parsed.kind === "unparseable") {
          return { error: "unparseable", raw: parsed.raw };
        }
        return parsed.data;
      },
    });
  }
  return set as ToolSet;
}

// ── Test surface ──────────────────────────────────────────────────────

/**
 * Internal helper exposed for direct unit testing. The full
 * `runToolSelectionEval` path requires a live MCP transport + auth
 * fixture; the `bindToolsForRecording` shape is the load-bearing piece
 * of the audit's grader contract (push-before-dispatch, error envelope
 * pass-through, unparseable fallback) and is cheaply exercised against
 * a fake `callTool`.
 */
export const __forTesting__ = {
  bindToolsForRecording: (
    client: { callTool: EvalMcpClient["callTool"] },
    tools: readonly ToolListEntry[],
    recorder: RecordedDispatch[],
  ): ToolSet => bindToolsForRecording(client, tools, recorder),
} as const;
