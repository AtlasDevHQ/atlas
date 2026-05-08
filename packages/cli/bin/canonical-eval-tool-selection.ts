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
  startEvalAuthServer,
  type EvalAuthFixture,
} from "@atlas/mcp/eval/auth";
import {
  EvalMcpClient,
  extractToolJson,
  type ToolListEntry,
} from "@atlas/mcp/eval/client";
import { createHostedMcpRouter } from "@atlas/mcp/hosted";

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
 */
export function gradeToolSelection(
  item: ToolSelectionFixtureItem,
  toolSequence: readonly string[],
  latencyMs: number,
): ToolSelectionOutcome {
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
        // intentionally ignored: surfacing the close error would mask
        // the original connect failure, which is the actionable signal.
        process.stderr.write(
          `[tool-selection-eval] client.close after failed connect threw: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}\n`,
        );
      }
      throw err;
    }

    try {
      const tools = await client.listTools();
      const recorded: string[] = [];
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
          // streamText throwing here counts as "didn't pick the right
          // tool" — record an empty sequence and let the grader fail it.
          process.stderr.write(
            `[tool-selection-eval] streamText threw on "${item.id}": ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        const latencyMs = Date.now() - start;
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
function bindToolsForRecording(
  client: { callTool: EvalMcpClient["callTool"] },
  tools: readonly ToolListEntry[],
  recorder: string[],
): ToolSet {
  const set: Record<string, Tool> = {};
  for (const t of tools) {
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
        // Push BEFORE the dispatch so a transport-level throw still
        // shows up in the recorded sequence — the grader needs the
        // `name` for first-tool-match scoring even when the underlying
        // call fails.
        recorder.push(t.name);
        const result = await client.callTool(t.name, args);
        const parsed = extractToolJson(result);
        if (parsed.kind === "error") return parsed.envelope;
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
    recorder: string[],
  ): ToolSet => bindToolsForRecording(client, tools, recorder),
} as const;
