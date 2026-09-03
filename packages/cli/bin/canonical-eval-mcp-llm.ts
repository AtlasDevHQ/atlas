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
  type LanguageModelUsage,
  type Tool,
  type ToolSet,
} from "ai";

import { getAgentMaxSteps } from "@atlas/api/lib/agent";
import {
  liftEvalClientRateLimit,
  startEvalAuthServer,
  type EvalAuthFixture,
} from "@atlas/mcp/eval/auth";
import {
  EvalMcpClient,
  type ExtractedToolJson,
  type ToolErrorEnvelope,
  type ToolListEntry,
} from "@atlas/mcp/eval/client";
import {
  assertTextContractToolsPresent,
  classifyToolContract,
  interpretResult,
  TEXT_CONTRACT_TOOL_NAMES,
  type ToolContract,
} from "@atlas/mcp/eval/tool-contract";
import {
  isRateLimitedEnvelope,
  throttleAbortError,
} from "@atlas/mcp/eval/throttle";
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
 * Re-exported from `@atlas/mcp/eval/tool-contract`, where the contract now lives
 * (#5135), because {@link RecordedToolCall} — this module's shape — is typed by
 * it, so a consumer narrowing a recorded call can reach the type without a
 * second import.
 *
 * No such consumer exists today: everything that needs `ToolContract` takes it
 * from the owning module. Said plainly, because an earlier version of this note
 * justified the re-export by "every consumer … reads it from this file", which
 * is true only vacuously and reads as if call sites exist.
 */
export type { ToolContract };

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
      /**
       * Set when dispatch ran >25% over the committed baseline. The question
       * still PASSED — this is the early-warning signal `eval-llm.yml`
       * describes, not a verdict.
       *
       * ⚠️ Only on the passing variant, and that is not an oversight: the
       * latency check is layered on top of an already-successful answer and
       * returns early for a failing one, so a `fail` outcome never carries it.
       *
       * Deliberately NOT an `McpFailureArtifact` — the `--json` payload runs
       * within ~4 KB of the ~65536 stdout truncation cliff (#5134), and a full
       * artifact per slow question re-spends that margin to restate numbers
       * already on the outcome.
       */
      readonly latencyWarning?: {
        readonly baselineMs: number;
        readonly ceilingMs: number;
        readonly summary: string;
      };
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
 * One group of the authoritative grouped result — its display label and the
 * numbers it computed, kept TOGETHER.
 *
 * ⚠️ ONE RECORD PER GROUP, NOT TWO PARALLEL ARRAYS. The label and its measures
 * are two projections of one row; storing them as `labels[]` + `measures[]`
 * lets them desync, and every consumer below cares which measure belongs to
 * which group — {@link keyedResultMatches} grades PER GROUP.
 */
export interface AuthoritativeGroup {
  /**
   * The grouping key cell VERBATIM — or `null` when the authoritative SQL
   * grouped on a NULL key. Case/whitespace folding happens at comparison time
   * ({@link authoritativeLabels}) so the operator-facing note can print the
   * label the SQL actually wrote.
   *
   * ⚠️ `null` IS NOT THE STRING `"null"`, AND THE DIFFERENCE WAS A LIVE FALSE
   * NEGATIVE. An earlier cut harvested this as `String(cell)`, so a NULL group
   * became the label `"null"` and counted toward the cardinality — while
   * {@link columnValueSets} skips nullish cells on the observed side. A model
   * returning the byte-identical authoritative result then graded FAIL, which
   * is precisely the defect class #5128 exists to remove, one layer down. Both
   * sides now reduce a cell through {@link cellKey} and neither counts a NULL
   * as a distinct value.
   */
  readonly label: string | null;
  /**
   * The numeric cells this group's row produced OUTSIDE the key column.
   *
   * The key is excluded STRUCTURALLY rather than by type, so a numeric grouping
   * key could never become a value the model must reproduce — though no corpus
   * key is numeric today: every `month` grouping is
   * `TO_CHAR(created_at, 'YYYY-MM')`, which is a string.
   */
  readonly measures: readonly number[];
}

/**
 * Grouped metric — compared on SUBSTANCE (what each group computed, and how
 * many groups there were), never on what the groups are CALLED.
 *
 * ⚠️ THE PREVIOUS ARM CARRIED `keys: string[]` AND WAS THE THIRD PRESENTATION
 * CHECK IN A ROW (#5128). The value grader was tightened three times and each
 * tightening caught a *display* difference rather than a substantive one:
 *
 *   original   SQL text        `AVG(total_cents / 100.0)` vs `AVG(total_cents)`
 *   fix 1      exact numbers   `11.22` vs a metric publishing `ROUND(…,1)` = `11.2`
 *   fix 2      group labels    `'With Promotion'` vs `'With Promo'`
 *
 * Fix 2 is this arm's old shape. `orders_with_promotions` labels its groups
 * with a hand-written `CASE … THEN 'With Promo'`; a model that computed the
 * identical categorisation, filter and measures but wrote `'With Promotion'`
 * was graded wrong. Nobody chose to make display text load-bearing — ground
 * truth was harvested from the first column because that is what came back
 * first, and the first column of a grouped query is USUALLY a presentation
 * column. The exception — a `SELECT DISTINCT status` shape, where it is the data
 * — is what {@link keyedResultMatches}' measure-less branch exists for.
 *
 * So the labels stay, DIAGNOSTIC ONLY (see {@link labelDriftNote}), and the
 * verdict keys on what a relabel cannot touch.
 *
 * The grouping CARDINALITY is derived from `groups` rather than stored beside
 * it ({@link authoritativeLabels}) — a count kept next to the thing it counts
 * is a state that is only ever consistent by construction.
 */
export interface KeyedExpectation {
  readonly kind: "keyed";
  readonly groups: readonly AuthoritativeGroup[];
}

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
  | KeyedExpectation;

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
   * it cannot introduce one.
   *
   * ⚠️ ONE CARVE-OUT, ADDED WITH #5128: `keyedResultMatches` THROWS on ground
   * truth that cannot adjudicate anything (no groups, or every key NULL), and
   * that throw reaches this lane through `matchesAnyAnsweringResult`, aborting
   * the run. That is not a false negative — no question is graded wrong — but it
   * is a way this path can now end a run, where before it could only decline to
   * help. The harvester's own failures stay non-fatal (`resolveExpectations`
   * catches, prints a `note:`, and disables the accept path for that question),
   * so this is reachable only from a caller-supplied expectation. Metric mode could be replaced outright because its
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

/**
 * Tokens one `streamText` round-trip consumed.
 *
 * ⚠️ TOTAL, NOT PARTIAL. The AI SDK types every field of `LanguageModelUsage` as
 * `number | undefined`, so a provider may report all, some, or none. A value of
 * this type means the reported figures were complete AT THE FIELD LEVEL — see
 * {@link toTokenUsage}, which returns `null` rather than filling a gap.
 *
 * ⚠️ IT DOES NOT MEAN EVERY STEP REPORTED. The source is `totalUsage`, which the
 * SDK sums with `addTokenCounts` — a step that reports nothing contributes 0 and
 * is indistinguishable from a step that genuinely used none. So `unreported`
 * means "no step reported anything for this question", not "this question was
 * fully measured". Stated rather than tightened: distinguishing them means
 * walking `result.steps`, which is real machinery for a case the Gateway
 * providers do not currently produce. Half a measurement recorded as a
 * whole one is a guess wearing a measurement's formatting, which is the exact
 * thing #5123 exists to remove: the workflow's own *"under $0.05 per run"* was
 * never measured, and order-of-magnitude arithmetic on a 20-question /
 * 124-tool-call run puts it nearer $0.50–$2.00, which is also not a measurement.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** One question's token measurement, or the fact that there wasn't one. */
export interface QuestionTokenUsage {
  readonly questionId: string;
  readonly usage: TokenUsage | null;
}

/**
 * What a run cost, in tokens.
 *
 * ── The shape was decided, not defaulted (#5123) ──
 *
 * **Both** per-question and accumulated, because they answer different
 * questions and are not in tension: `totals` answers #5039's spend criterion,
 * `byQuestion` answers *which* questions are expensive. `totals` is DERIVED from
 * `byQuestion` by summation rather than accumulated beside it — a count kept
 * next to the thing it counts is only ever consistent by construction, the same
 * reason {@link authoritativeLabels} derives its cardinality.
 *
 * **On the RESULT, not on {@link McpLlmOutcome}.** That union is the GRADER's
 * vocabulary: `grade()` is pure and synchronously unit-testable, and putting
 * usage on its arms would make `failOutcome`, `passOutcome`, all four per-mode
 * graders (`gradeMetric`, `gradeGlossary`, `gradePattern`, `gradeVirtual`) and
 * every test call site carry a field no verdict reads. Token usage
 * is a measurement OF the run, not an input TO a verdict. Adding it as an
 * OPTIONAL field on both arms — the shape #5123 warned against — would also
 * hand every consumer an `undefined` to narrow.
 *
 * **`unreported` is named, not implied.** A total silently short by however many
 * questions the provider declined to measure is the same class of unmeasured
 * number this field exists to replace, so the ids travel with it.
 */
export interface EvalTokenUsage {
  /** Summed over every question in {@link byQuestion} with a non-null `usage`. */
  readonly totals: TokenUsage;
  /** Every question the run graded, in order. */
  readonly byQuestion: readonly QuestionTokenUsage[];
  /** Ids whose usage the provider did not report — excluded from {@link totals}. */
  readonly unreported: readonly string[];
}

export interface McpLlmEvalResult {
  readonly outcomes: readonly McpLlmOutcome[];
  readonly artifacts: readonly McpFailureArtifact[];
  readonly usage: EvalTokenUsage;
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
    // A full run out-dispatches the default hosted-MCP quota (#5122) — see
    // `liftEvalClientRateLimit`. Applied whether or not we own the fixture: the
    // OAuth client is the same either way, and a shared fixture across several
    // runs accumulates MORE load against the same bucket, not less.
    //
    // INSIDE the `try` that owns the fixture, not before it: `setClientRateLimit`
    // is an in-memory map write and unlikely to throw, but a throw from outside
    // would leak the booted auth server — `close()` never runs and the process
    // hangs on an open handle instead of reporting the fault.
    liftEvalClientRateLimit(fixture);
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
      // Self-identifying (each entry carries its `questionId`) rather than
      // positional against `outcomes`, so the two lists cannot desync into a
      // question being charged another question's tokens.
      const tokenUsage: QuestionTokenUsage[] = [];

      const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
      for (const q of questions.slice(0, limit)) {
        // Reset the buffer between questions — we want a per-question
        // tool-call sequence, not a cumulative log. Mutating in place
        // (rather than passing a fresh array per call) keeps the bound
        // tool closures pointing at the same recorder instance.
        recorded.length = 0;
        const { outcome, usage } = await runOneQuestion({
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
        tokenUsage.push({ questionId: q.id, usage });
        if (outcome.status === "fail") artifacts.push(outcome.artifact);

        // Reporting only — computed AFTER the verdict and incapable of changing
        // it (#5128). Goes to stderr rather than the outcome so the run's JSON
        // shape is untouched.
        //
        // ⚠️ WRAPPED BECAUSE THE ONLY `return` IS AFTER THIS LOOP. A throw here
        // unwinds past every outcome accumulated so far, so a reporting fault
        // would cost a 20-question paid run its entire score and surface as a
        // harness stack instead of a grade. `keyedResultMatches` DOES throw —
        // on ground truth that cannot adjudicate anything — and reaches here via
        // `labelDriftNote`; it survives today only because `canonical-eval-run`
        // rejects a zero-row harvest upstream. The invariant is enforced rather
        // than trusted precisely because that guard is two files away.
        try {
          const drift = labelDriftNote(
            outcome,
            expectationForQuestion(q, opts.metricExpectations, opts.answerExpectations),
          );
          if (drift) process.stderr.write(`  note: ${drift}\n`);
        } catch (err) {
          // Logged, never re-thrown: grading is the run's product and a
          // diagnostic must not be able to discard it.
          process.stderr.write(
            `[mcp-llm-eval] drift note failed for ${q.id}: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      return { outcomes, artifacts, usage: summarizeTokenUsage(tokenUsage) };
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
//
// The contract itself — `TEXT_CONTRACT_TOOLS`, `classifyToolContract`,
// `interpretResult`, `assertTextContractToolsPresent` — moved to
// `@atlas/mcp/eval/tool-contract` in #5135. It is a property of the MCP
// surface rather than of either eval, and living in `packages/mcp` is what
// lets the REQUIRED `tools.test.ts` pin the name list against a real
// `tools/list`. The one piece that stays here is the disjointness assertion
// below, because the list it must not overlap (`ANSWERING_TOOLS`) is this
// file's grading vocabulary and means nothing to the MCP package.

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

/**
 * Render a thrown non-Error for the artifact bundle — both the transport
 * envelope in `bindMcpToolsForLlm` and the `streamText` catch in
 * `runOneQuestion` read it. `String(obj)` is
 * `[object Object]`; JSON keeps whatever the provider put in the payload
 * (status, message, body). Falls back to `String` for values JSON cannot
 * take (bigint, cycles).
 */
function describeNonError(err: unknown): string {
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch (jsonErr) {
    // stderr, not console: fd 1 is the `--json` artifact and is pinned.
    process.stderr.write(
      `[mcp-llm-eval] non-Error throw not serialisable (${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)})\n`,
    );
    return String(err);
  }
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
            error: err instanceof Error ? err.message : describeNonError(err),
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

/** {@link runOneQuestion}'s product: the verdict, and what it cost to reach. */
interface OneQuestionResult {
  readonly outcome: McpLlmOutcome;
  readonly usage: TokenUsage | null;
}

async function runOneQuestion(
  input: OneQuestionInput,
): Promise<OneQuestionResult> {
  const { question, recorded, baseline } = input;
  const start = Date.now();
  let finalText = "";
  let usage: TokenUsage | null = null;
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
    // ⚠️ THE ANNOTATION IS THE GUARD, AND IT HAS TO BE HERE — ON THE LOCAL — NOT
    // ONLY ON `runTokenUsage`'S PARAMETER. Round 1 put it on the parameter and
    // measured TS2339 on reverting the helper's BODY; that measured a mutation
    // nobody makes. The mutation that shipped #5123's defect was at THIS line's
    // consumer — `toTokenUsage(await result.usage)` — and it recompiled clean and
    // green, because `result` was still the full `StreamTextResult` carrying both
    // fields. Inlining a one-line private helper is a routine refactor and it was
    // all that stood between here and the defect.
    //
    // Narrowing the binding closes the class: `result.usage` is now TS2339 at
    // every read in this function, so neither inlining the helper nor passing
    // `{ totalUsage: result.usage }` into it compiles. `PromiseLike`, not
    // `Promise` — `StreamTextResult` declares both fields as `PromiseLike`.
    const result: {
      readonly text: PromiseLike<string>;
      readonly totalUsage: PromiseLike<ReportedUsage>;
    } = streamText({
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
    // ⚠️ `totalUsage`, NOT `usage` — THE TWO ARE THE SAME TYPE AND DIFFER BY A
    // FACTOR OF SEVEN HERE. The AI SDK documents `result.usage` as "the token
    // usage of the LAST STEP" (`ai/dist/index.d.ts`; the getter resolves
    // `finalStep.then(step => step.usage)`), while `totalUsage` is the sum over
    // every step. This is a multi-step tool loop — `stopWhen:
    // stepCountIs(getAgentMaxSteps())` — and the corpus runs ~124 tool calls
    // across 20 questions, so `usage` measures one step of roughly seven.
    //
    // Both are `LanguageModelUsage`, so TypeScript cannot tell them apart and
    // the narrowing tests below pass identically on either. Reading the wrong
    // one ships a number that is systematically low in the REASSURING direction
    // — a guess wearing a measurement's formatting, which is the exact failure
    // `TokenUsage`'s own docstring names and #5123 exists to end.
    //
    // ⚠️ INSIDE THE `try`: a provider-side rejection belongs in the catch below
    // rather than unwinding the run, and a question whose stream REJECTED then
    // keeps `usage: null` — an honest "not measured" rather than a zero that
    // would silently deflate the run total.
    //
    // Ordering after `.text` is for the RECORDER, not the promise: `recorded`
    // must be the complete dispatch sequence before the grader walks it. An
    // earlier version of this comment claimed awaiting `totalUsage` first would
    // "block on a stream that has not been drained" — false, the SDK's getter
    // calls `consumeStream()` itself.
    //
    // ⚠️ AND `usage: null` IS NOT WHAT EVERY FAILED QUESTION CARRIES. This line
    // runs BEFORE the `streamErr` re-throw below, so a question that failed via
    // `onError` — the path tool-execute and provider-side errors take — reaches
    // the catch with a REAL measurement. That is correct (the tokens were spent)
    // and it is not what "a question whose stream threw keeps null" implied.
    usage = await runTokenUsage(result);
    if (streamErr !== null) throw streamErr;
  } catch (err) {
    const latencyMs = Date.now() - start;
    // A non-Error throw is usually a provider's raw error payload (the
    // gateway hands `onError` a plain object for some models), and
    // `String(err)` renders it as `[object Object]` — an artifact that
    // names nothing. Serialise it instead so the bundle carries the payload.
    const message = err instanceof Error ? err.message : describeNonError(err);
    const errorName = err instanceof Error ? err.name : "Unknown";
    const stack = err instanceof Error ? err.stack : undefined;
    return {
      usage,
      outcome: failOutcome({
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
      }),
    };
  }
  const latencyMs = Date.now() - start;
  return {
    usage,
    outcome: grade({
      question,
      toolCalls: [...recorded],
      finalText,
      latencyMs,
      baseline,
      metricExpectations: input.metricExpectations,
      answerExpectations: input.answerExpectations,
    }),
  };
}

/**
 * The run's token usage: EVERY step, summed.
 *
 * ⚠️ THE TYPE IS THE FALSIFIER — AND THE LOAD-BEARING HALF IS THE ANNOTATION ON
 * THE CALLER'S LOCAL, not this parameter. See the note at the `streamText` call.
 * A runtime falsifier is not impossible, only expensive: a two-step
 * `MockLanguageModelV3` driven through `runOneQuestion` would do it, and needs
 * the MCP auth fixture that `runMcpLlmEval` has never had a test for.
 * `result.usage` and `result.totalUsage` are BOTH `LanguageModelUsage`, so
 * reading the wrong one is invisible to the type checker at the call site,
 * invisible to `toTokenUsage`'s tests (which pin the narrowing, not the source),
 * and invisible to every runtime assertion short of a live multi-step run. It is
 * a wrong number in the reassuring direction — precisely the thing #5123 exists
 * to stop shipping.
 *
 * Naming ONLY `totalUsage` in the parameter type makes `await result.usage` a
 * COMPILE ERROR inside this function. `bun run type` is the gate; `bun test`
 * cannot see it, which is why the property is expressed as a type rather than
 * asserted in a test.
 *
 * Structural, not `StreamTextResult`, so the unit test can hand it a plain
 * object carrying BOTH fields with different values and pin which one is read.
 */
async function runTokenUsage(result: {
  readonly totalUsage: PromiseLike<ReportedUsage>;
}): Promise<TokenUsage | null> {
  return toTokenUsage(await result.totalUsage);
}

/**
 * The three fields {@link toTokenUsage} reads, projected off the SDK's own type
 * rather than restated.
 *
 * `Pick`, not a hand-written triple: a rename upstream (`inputTokens` →
 * something else) then breaks the build here instead of silently narrowing every
 * usage to `null` and reporting a run that cost nothing. The SDK's real shape
 * also carries `inputTokenDetails` / `outputTokenDetails`, which this function
 * does not read and a test fixture should not have to fabricate.
 */
type ReportedUsage = Pick<
  LanguageModelUsage,
  "inputTokens" | "outputTokens" | "totalTokens"
>;

/**
 * Narrow the AI SDK's reported usage — every field `number | undefined` — to a
 * {@link TokenUsage}, or `null` when it cannot be one.
 *
 * ⚠️ A PARTIAL REPORT BECOMES `null`, NOT A ZERO-FILLED RECORD. `inputTokens`
 * and `outputTokens` are both required because cost needs both (they are priced
 * differently by roughly 5x), and a record with one of them zeroed reads as a
 * cheap question rather than an unmeasured one. `totalTokens` is taken when the
 * provider gives it and derived only when it is absent — the provider's own
 * figure is authoritative and may not equal the sum.
 *
 * ⚠️ AN EARLIER VERSION OF THIS COMMENT EXPLAINED THE MISMATCH AS REASONING
 * TOKENS "counted there and in neither of the other two". False for the pinned
 * SDK: reasoning tokens live in `outputTokenDetails.reasoningTokens`, i.e.
 * INSIDE `outputTokens`. Trusting the provider's total remains right; the reason
 * given for it was not.
 */
function toTokenUsage(usage: ReportedUsage | undefined): TokenUsage | null {
  if (!usage) return null;
  const { inputTokens, outputTokens, totalTokens } = usage;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      typeof totalTokens === "number" ? totalTokens : inputTokens + outputTokens,
  };
}

/**
 * Sum the per-question measurements into the run's {@link EvalTokenUsage}.
 *
 * Derived rather than accumulated as the loop runs: the totals and the
 * per-question records are then two views of one list and cannot disagree.
 */
function summarizeTokenUsage(
  byQuestion: readonly QuestionTokenUsage[],
): EvalTokenUsage {
  const totals = byQuestion.reduce<TokenUsage>(
    (acc, q) =>
      q.usage === null
        ? acc
        : {
            inputTokens: acc.inputTokens + q.usage.inputTokens,
            outputTokens: acc.outputTokens + q.usage.outputTokens,
            totalTokens: acc.totalTokens + q.usage.totalTokens,
          },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  return {
    totals,
    byQuestion,
    unreported: byQuestion.filter((q) => q.usage === null).map((q) => q.questionId),
  };
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
  // `.filter(isErrorResult)` first, so the arm is narrowed by the file's own
  // type predicate rather than re-checked. An earlier cut wrote `find(...)` and
  // then `if (!throttled || throttled.result.kind !== "error") return;` — whose
  // second clause is unreachable and whose disposition is a SILENT return, from
  // the one function whose entire job is to be loud.
  const throttled = toolCalls
    .filter(isErrorResult)
    .find((c) => isRateLimitedEnvelope(c.result.envelope));
  if (!throttled) return;
  // ⚠️ CALLS the shared builder rather than restating the remedy. The
  // hosted-vs-downstream branch is the part #5133 measured wrong, and
  // `--tool-selection` grew the same abort in #5136 — two copies of a rule that
  // subtle is two chances to reintroduce it, with only one under test at a time.
  throw throttleAbortError(q.id, {
    toolName: throttled.name,
    contract: throttled.contract,
    envelope: throttled.result.envelope,
  });
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

  // Latency is layered on top of a successful answer — "a slow answer is still
  // an answer" — so it WARNS and does not gate.
  //
  // ⚠️ It used to `failOutcome`, which counted against the 18/20 acceptance
  // floor. That contradicted both this comment and `eval-llm.yml`, which calls
  // latency an "early-warning signal"; the contradiction was invisible while
  // the committed baseline was the 3 bytes `{}`, because no baseline meant no
  // comparison. Seeding it (#5039) made the check live and the defect
  // immediate.
  //
  // MEASURED across two CI runs of IDENTICAL code: per-question dispatch moved
  // -29% to +71%, and 5 of 20 questions cleared a +25% ceiling on noise alone
  // — 18/20 became 14/20, under the floor. On a pull_request the informational
  // gate renders that green, so it would have surfaced first as a TAG PUSH
  // exiting 1: every release blocked by jitter. A single-sample baseline
  // cannot gate a corpus whose natural spread is ~3x the threshold (#5129 is
  // the same defect in the pass-floor channel).
  //
  // Widening the ceiling to swallow +71% was the alternative and is worse: a
  // signal that needs a near-doubling to fire detects nothing worth knowing.
  // So the ceiling stays tight and the consequence goes away.
  const baselineMs = baseline?.[q.id];
  if (typeof baselineMs === "number" && baselineMs > 0) {
    const ceiling = Math.round(baselineMs * 1.25);
    if (latencyMs > ceiling) {
      return {
        ...modeOutcome,
        latencyWarning: {
          baselineMs,
          ceilingMs: ceiling,
          summary: `dispatch ${latencyMs}ms exceeded baseline ${baselineMs}ms by >25% (cap ${ceiling}ms)`,
        },
      };
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
  const expectation = expectationForQuestion(q, metricExpectations, answerExpectations);
  switch (q.mode) {
    case "metric":
      return gradeMetric(q, toolCalls, finalText, latencyMs, expectation);
    case "glossary":
      return gradeGlossary(q, toolCalls, finalText, latencyMs);
    case "pattern":
      return gradePattern(q, toolCalls, finalText, latencyMs, expectation);
    case "virtual":
      return gradeVirtual(q, toolCalls, finalText, latencyMs, expectation);
    default: {
      const _exhaustive: never = q;
      throw new Error(unreachableModeMessage(_exhaustive));
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
            : // ⚠️ `authoritativeLabels(...).size`, NOT `groups.length` — those
              // diverge whenever two rows normalize to one label or a key is
              // NULL, and printing the row count tells an operator the grader
              // wanted a cardinality it never asked for. Both conditions are
              // named because condition 2 is what fails the realistic shapes.
              `${expectation.groups.length} authoritative row(s), each needing one of its own ` +
              `measures, AND some column carrying exactly ` +
              `${authoritativeLabels(expectation).size} distinct value(s) ` +
              `— ${expectation.groups
                .map((g) => `${displayLabel(g)}: [${g.measures.join(", ")}]`)
                .join(" · ")} — labels themselves are NOT compared`
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
 * Unit scalings accepted when comparing a scalar — and, since #5128, each
 * group's measures on the keyed path ({@link keyedResultMatches}). Widening this
 * constant now moves both.
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

  return keyedResultMatches(rows, expectation);
}

/**
 * Does this grouped result carry the authoritative SUBSTANCE?
 *
 * Two conditions, neither of which moves under a relabel (#5128):
 *
 *  1. **every authoritative GROUP is represented** — for each group, at least
 *     one of the numbers it computed has an approximate match among the
 *     observed numbers, modulo {@link UNIT_SCALINGS}. Subset, not equality; and
 *  2. **one column SEPARATES the authoritative groups at the expected
 *     cardinality** — some observed column whose distinct-value count matches
 *     the authoritative one AND which gives a DIFFERENT value to each
 *     authoritative label ({@link separatesAuthoritativeGroups}). Per-column and
 *     distinct, so extra breakdown rows on an existing group don't move it.
 *
 * ⚠️ CONDITION 1 IS PER GROUP, NOT PER CELL, AND THE DIFFERENCE IS INSTANCE #4
 * OF THIS ISSUE'S OWN TABLE. The obvious spelling — *every authoritative
 * measure CELL must appear* — was written first and flips currently-PASSING
 * questions to fail, because the corpus's metrics publish auxiliary columns no
 * natural answer includes:
 *
 *   revenue_by_category   revenue, order_count, units_sold  · cq-004 asks for revenue
 *   monthly_gmv_trend     order_count, gmv, aov             · cq-009 asks for GMV
 *   customers_by_…        customer_count, active_count, active_pct
 *
 * A model answering "revenue by category" with `SELECT category, SUM(revenue)`
 * has answered the question. Failing it for omitting `units_sold` is the same
 * "rejected a correct answer over presentation" mistake as the three before it,
 * reintroduced as an EXHAUSTIVENESS difference. Per-group keeps what matters —
 * a dropped filter moves every number in every group, so no group is
 * represented; a missing group is exactly a group with nothing matched.
 *
 * ⚠️ CONDITION 2 REQUIRES THE COLUMN TO SEPARATE THE GROUPS, NOT MERELY TO COUNT
 * TO THE RIGHT NUMBER (#5143). The earlier spelling accepted if ANY column
 * carried the authoritative distinct count, which is nearly vacuous in the
 * permitting direction: a bystander does it for free. Measured — the
 * *wrong grouping whose numbers happen to CONTAIN the authoritative ones*
 * fixture (five shipping regions against a two-group ground truth) failed ONLY
 * because none of its columns happened to carry two distinct values. Adding one
 * plausible `domestic: yes/no` column passed the same wrong grouping, and that
 * was pinned as a limitation rather than fixed.
 *
 * Separation closes it without guessing which observed column is the grouping
 * key — the guess #5128 exists to stop making. The candidate column is not
 * named or positioned; it EARNS the role by being able to tell the
 * authoritative groups apart, which is what a grouping key does and what a
 * bystander cannot. `domestic` gives both represented rows `"yes"`, so it
 * separates nothing and no longer counts.
 *
 * It stays a shape guard, not a second correctness check — condition 1 does the
 * grading. And it stays weak in one place, stated rather than implied: at a
 * group count of 1 there is no partition to disagree about, so any column with
 * one distinct value satisfies it.
 *
 * ⚠️ CONDITION 1 HAS ITS OWN WEAKNESS, AND IT IS A FALSE **POSITIVE** — the one
 * direction this issue was not about. The observed numbers are one flat pool,
 * searched independently and without consumption, widened ×3 by
 * {@link UNIT_SCALINGS}. So N groups sharing a value are all satisfied by one
 * occurrence of it. `top_customers_by_spend` groups on `full_name` with
 * `order_count` among its measures — small integers that repeat across
 * customers — so an answer listing the top 20 by ORDER COUNT (different
 * customers entirely) can satisfy all 20 groups, while its own name column
 * supplies condition 2. **The old label-set rule caught that** and this one
 * need not. Tracked in #5143; not fixed here because a multiset/consume-on-match
 * rule is new grading machinery arriving with no round left to review it.
 *
 * ⚠️ KNOWN LIMITS. Of the four correct-but-differently-shaped answers #5143
 * listed, ONE is closed here and three are not — and which is which is a
 * statement about what condition 2 can express, not about how much effort was
 * spent:
 *
 *   COALESCE    CLOSED. `COALESCE(channel, 'unknown')` renders a NULL group as
 *               a value, so the observed count is N where {@link
 *               authoritativeLabels} counts N−1. The two sides now disagree by
 *               construction, and the fix is to say so: an expectation carrying
 *               a NULL group accepts N−1 OR N ({@link expectedCardinalities}).
 *   pivoted     NOT CLOSED, AND NOT CLOSEABLE HERE. One row of `COUNT(*) FILTER
 *               (WHERE …) AS with_promo, …` puts the grouping key in the COLUMN
 *               NAMES, so no column separates anything — which is the same shape
 *               as the ungrouped answer condition 2 exists to reject. A rule
 *               that admits the pivot admits `SELECT COUNT(*) a, COUNT(*) b`
 *               whose two numbers happen to hit both groups. Accepting pivots
 *               means DELETING condition 2, not refining it.
 *   rollup      NOT CLOSED. An appended `Total` row makes the key column N+1
 *               distinct. Separable from a genuinely wrong grouping only by
 *               recognising the extra row as a TOTAL of the others — real new
 *               machinery, and a sixth heuristic on a comparison whose first
 *               five were all wrong.
 *   top-N       NOT A CONDITION-2 QUESTION AT ALL. `top_customers_by_spend` ends
 *               `LIMIT 20`, so a top-10 answer is short ten groups on CONDITION
 *               1 — every one of those groups' measures is absent. Fixing
 *               condition 2 could never have unblocked it, and #5143's table
 *               cites only the cardinality half.
 *
 * ⚠️ THE THREE THAT REMAIN FAILED UNDER THE RULE THIS ONE REPLACES TOO —
 * verified row by row against `origin/main`, and the claim to re-check before
 * "fixing" one. The old rule was set equality on labels, i.e. cardinality
 * **and** membership: pivoted, top-N and rollup failed it on cardinality, and
 * COALESCE failed it on membership (`{…, "null"}` vs `{…, unknown}` — same size,
 * different members).
 *
 * So against its predecessor this comparison is stricter on VALUES, looser on
 * LABELS, and — since #5143 — stricter on SHAPE in the permitting direction
 * while accepting the one rendering difference that made ground truth and the
 * answer disagree about how many groups there were.
 *
 * Throws rather than returning `false` on ground truth that cannot adjudicate
 * anything — empty `groups`, or every grouping key NULL. That means ground truth
 * was never established, and charging it to the model would print a
 * `tool_selection` artifact blaming the model for a harness fault. Same
 * disposition as {@link gradeMetric}'s missing-expectation throw.
 *
 * ⚠️ REACHED ONLY WHEN THE MODEL RETURNED ROWS. {@link resultMatchesExpectation}
 * short-circuits an empty result to `false` before calling here, so a harness
 * fault paired with a model that answered nothing still reads as the model's
 * failure. Narrow, and stated rather than implied.
 */
function keyedResultMatches(
  rows: ReadonlyArray<Record<string, unknown>>,
  expectation: KeyedExpectation,
): boolean {
  if (expectation.groups.length === 0) {
    throw new Error(
      "[harness] keyed expectation has no groups — ground truth was not established, " +
        "so no answer can be adjudicated. A harvested expectation always has ≥1 group; " +
        "check keyedExpectationFrom's caller.",
    );
  }

  const labels = authoritativeLabels(expectation);

  // ⚠️ EVERY GROUPING KEY WAS NULL, so there is no cardinality to compare
  // against and no label to compare either. That is a harness fault — an
  // all-NULL `GROUP BY` key, or a `CASE`/`NULLIF` that folded every row — and it
  // gets the same disposition as empty ground truth above.
  //
  // An earlier cut returned `true` here so that condition 1 could stand alone.
  // That was the unsafe direction twice over: it passes the ungrouped answer
  // condition 2 exists to reject, and it DISAGREED with `labelSetMatches`, which
  // returns `false` on the identical predicate — so which way a degenerate
  // expectation went was decided by whether any measure happened to parse.
  if (labels.size === 0) {
    throw new Error(
      "[harness] every authoritative grouping key is NULL, so the grouping " +
        "cardinality cannot be established and no answer can be adjudicated on " +
        "shape. Check the key column in the authoritative SQL — an all-NULL " +
        "GROUP BY key, or a CASE/NULLIF that folded every row.",
    );
  }

  // No numeric measures anywhere — a `SELECT DISTINCT status`-shaped result. The
  // key column is then the DATA rather than a display label, and cardinality
  // alone would pass any result with the right number of distinct values, so
  // compare the values themselves. This is the old label-set rule, kept exactly
  // where it is still the strongest thing available.
  if (!expectation.groups.some((g) => g.measures.length > 0)) {
    return labelSetMatches(rows, labels);
  }

  // Row-indexed rather than one flat pool, because condition 2 needs to know
  // WHICH rows carry a group's numbers, not merely that some row does. Condition
  // 1's verdict is unchanged by the indexing: "some row carries a match" and
  // "the flat pool carries a match" are the same predicate over the same cells.
  const byRow = rows.map((row) => numericValues([row]));

  const representingRows = expectation.groups.map((g) =>
    rowsRepresenting(g, byRow),
  );
  const everyGroupRepresented = expectation.groups.every(
    (g, i) =>
      // A group the authoritative SQL gave no numbers for has nothing to match;
      // it is carried by the cardinality check alone.
      g.measures.length === 0 || (representingRows[i]?.size ?? 0) > 0,
  );
  if (!everyGroupRepresented) return false;

  return separatesAuthoritativeGroups(rows, expectation, representingRows);
}

/**
 * The rows whose numbers include one of this group's measures, modulo
 * {@link UNIT_SCALINGS}.
 *
 * A group can legitimately land on more than one row — the *overlapping* fixture
 * has `beta`'s measures on both rows — so this is a SET, and
 * {@link separatesAuthoritativeGroups} picks a representative from it rather than
 * assuming there is only one. (The *stock health* fixture shows the converse, one
 * row carrying two groups' measures; an earlier version of this note cited it for
 * this claim, which it does not support.)
 */
function rowsRepresenting(
  group: AuthoritativeGroup,
  byRow: ReadonlyArray<readonly number[]>,
): ReadonlySet<number> {
  const out = new Set<number>();
  byRow.forEach((values, index) => {
    const hit = group.measures.some((measure) =>
      values.some((candidate) =>
        UNIT_SCALINGS.some((s) => approximatelyEqual(candidate * s, measure)),
      ),
    );
    if (hit) out.add(index);
  });
  return out;
}

/**
 * Condition 2: some observed column both counts to the authoritative grouping
 * cardinality AND gives a different value to each authoritative label.
 *
 * ⚠️ SEPARATION IS WHAT MAKES THE COLUMN A GROUPING KEY, and it is deliberately
 * not a guess about which column that is. The old rule was cardinality alone, so
 * a bystander column with the right number of distinct values satisfied it for
 * free — measured on the *bystander column* fixture, where a plausible
 * `domestic: yes/no` beside a wrong five-region grouping turned a FAIL into a
 * PASS. Here `domestic` gives both represented rows `"yes"`, so it separates
 * nothing and cannot stand in for the key.
 *
 * ⚠️ LABELS, NOT GROUPS, ARE WHAT MUST BE SEPARATED. Two authoritative groups
 * whose labels case-fold together (`'In Stock'` / `'in stock '`) are ONE group
 * as far as the observed result can tell — {@link authoritativeLabels} already
 * collapses them for the count — so requiring them to land on different values
 * would fail a byte-correct answer. They are collapsed here through the same
 * {@link cellKey}, from the same expectation, so the two cannot drift apart.
 *
 * ⚠️ A MATCHING, NOT A GREEDY WALK. A label class may be carried by several rows
 * and two classes' candidate rows may overlap, so "assign each class a row and
 * hope" can fail on an assignment order while a valid one exists. The augmenting
 * search below answers the question the rule actually asks — *does a system of
 * distinct representatives exist* — rather than an order-dependent approximation
 * of it.
 */
function separatesAuthoritativeGroups(
  rows: ReadonlyArray<Record<string, unknown>>,
  expectation: KeyedExpectation,
  representingRows: ReadonlyArray<ReadonlySet<number>>,
): boolean {
  // label key → the rows any of its groups is represented by.
  const rowsByLabel = new Map<string, Set<number>>();
  expectation.groups.forEach((g, i) => {
    const key = cellKey(g.label);
    // A NULL-labelled group is excluded from the cardinality target
    // (`authoritativeLabels`) because the observed side cannot produce one, so
    // it has no label to be separated BY either. It is still graded — condition
    // 1 covers it — it just does not constrain the shape.
    if (key === null) return;
    // ⚠️ AND NEITHER DOES A MEASURE-LESS GROUP. Condition 1 exempts one
    // explicitly — "nothing to match; carried by the cardinality check alone" —
    // and this function has to honour the same exemption or the two conditions
    // CONTRADICT: `rowsRepresenting` returns the empty set for it, an empty
    // candidate set can never be assigned a representative, and condition 2
    // becomes unsatisfiable for EVERY column. A byte-correct answer then grades
    // FAIL, which is the false-negative class this comparison exists to remove.
    //
    // Reachable, not hypothetical: `keyedExpectationFrom` builds `measures`
    // through `numericValues`, which drops NULL and non-numeric cells — so an
    // `AVG` over an all-NULL subset, or a LEFT-JOINed measure, produces exactly
    // this. The ALL-measure-less case is caught upstream by the `labelSetMatches`
    // branch; the MIXED case falls through to here and had no test.
    if (g.measures.length === 0) return;
    let set = rowsByLabel.get(key);
    if (!set) {
      set = new Set();
      rowsByLabel.set(key, set);
    }
    for (const r of representingRows[i] ?? []) set.add(r);
  });

  // ⚠️ AN EMPTY CANDIDATE **SET** CANNOT BE ASSIGNED; AN EMPTY CANDIDATE **LIST**
  // IS VACUOUSLY SATISFIED, AND THAT ASYMMETRY IS A LIVE FALSE POSITIVE.
  //
  // Both skips above — NULL-labelled and measure-less — remove a group from
  // `rowsByLabel`. When they remove ALL of them, `hasDistinctRepresentatives([])`
  // returns `true` on a zero-iteration loop, and condition 2 collapses to "some
  // column has the right number of distinct values": exactly the bystander rule
  // this condition was written to replace. Measured on the round-1 fix:
  // `groups: [{label: null, measures: [412]}, {label: "ups", measures: []}]`
  // PASSED an ungrouped one-row answer `SELECT COUNT(*)` — a false POSITIVE
  // introduced by the fix for a false negative.
  //
  // Reachable from the same ground truth the measure-less skip cites: a NULL key
  // row carrying the only numbers, beside a labelled row whose measure came back
  // NULL. Unadjudicable, so it gets this function's standing disposition for
  // unadjudicable ground truth — the loud one, like the two throws above — and
  // NOT a permissive default on the gate.
  // ⚠️ THE THRESHOLD IS TWO, NOT ONE, AND `=== 0` WAS THE FIRST CUT'S OWN
  // UNDER-FIRE. This is a PAIRWISE-distinctness gate: with a single surviving
  // label there is no pair, `hasDistinctRepresentatives` imposes nothing, and
  // condition 2 collapses to bare cardinality just as completely as it does at
  // zero. Measured on that cut — take this file's own bystander fixture (five
  // shipping regions, a `domestic: yes/no` column) and make ONE authoritative
  // group measure-less: `rowsByLabel.size` is 1, the guard stays quiet, and the
  // wrong grouping that `a BYSTANDER column no longer satisfies the shape check`
  // pins as a FAIL passes again.
  //
  // `min(2, labelCount)` rather than a flat 2, because a genuine one-label
  // expectation has no pair to form and is the documented weak case above —
  // there the honest answer is bare cardinality, not a throw.
  const labelCount = authoritativeLabels(expectation).size;
  if (rowsByLabel.size < Math.min(2, labelCount)) {
    throw new Error(
      `[harness] only ${rowsByLabel.size} authoritative group(s) both carry a label ` +
        `and carry measures, against ${labelCount} distinct label(s) — so there is no ` +
        `pair left for a column to tell apart and the grouping shape cannot be ` +
        `adjudicated. Every other group was skipped as NULL-labelled or measure-less. ` +
        `Passing here would accept an UNGROUPED answer, which is what this check exists ` +
        `to reject. Look at the key column and the measure columns in the authoritative ` +
        `SQL — an all-NULL key row, or a measure that came back NULL for every row of a ` +
        `group, produces exactly this.`,
    );
  }

  const targets = expectedCardinalities(expectation);
  for (const [column, values] of columnValueSets(rows)) {
    if (!targets.has(values.size)) continue;
    const candidates = [...rowsByLabel.values()].map(
      (rowIndices) => cellKeysAt(rows, rowIndices, column),
    );
    if (hasDistinctRepresentatives(candidates)) return true;
  }
  return false;
}

/**
 * The distinct-value counts an observed column may carry and still be the
 * grouping key.
 *
 * `authoritativeLabels().size` is the base — the NON-NULL, case-folded label
 * count. The `+ 1` arm exists for exactly one rendering difference, and it is
 * #5143's COALESCE case: a NULL authoritative group is dropped from the base
 * because {@link columnValueSets} cannot produce a nullish cell on the observed
 * side, but `COALESCE(channel, 'unknown')` renders that same group as an
 * ordinary VALUE — so the model's key column carries one more distinct value
 * than ground truth counts, for an answer that is byte-correct.
 *
 * ⚠️ CONDITIONAL ON GROUND TRUTH HAVING A NULL GROUP, not a blanket tolerance.
 * A free `N+1` would also admit an appended `Total` row and a genuinely-finer
 * grouping that happens to be one wider, on every expectation — including the
 * ones with no NULL group to explain it. The widening is licensed by a fact
 * about the AUTHORITATIVE side, so it is available only where that fact holds.
 */
function expectedCardinalities(expectation: KeyedExpectation): ReadonlySet<number> {
  const base = authoritativeLabels(expectation).size;
  const hasNullGroup = expectation.groups.some((g) => cellKey(g.label) === null);
  return hasNullGroup ? new Set([base, base + 1]) : new Set([base]);
}

/** The {@link cellKey}s `column` takes across the given rows, nullish cells dropped. */
function cellKeysAt(
  rows: ReadonlyArray<Record<string, unknown>>,
  rowIndices: ReadonlySet<number>,
  column: string,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const i of rowIndices) {
    const key = cellKey(rows[i]?.[column]);
    if (key !== null) out.add(key);
  }
  return out;
}

/**
 * Can each candidate set be assigned a value no other set takes — a system of
 * distinct representatives?
 *
 * Kuhn's augmenting-path matching. Exact rather than greedy: with candidate sets
 * `[{a}, {a, b}]` a left-to-right walk assigns `a` to the first and then finds
 * `b` for the second, but `[{a, b}, {a}]` assigns `a` to the first and fails —
 * same family, opposite verdict. Augmenting re-homes the earlier assignment
 * instead of giving up, so the answer does not depend on the order the
 * expectation happened to list its groups in.
 *
 * An EMPTY candidate set can never be assigned, which is the right answer: a
 * label whose rows all carry a null cell in this column is not separated by it.
 */
function hasDistinctRepresentatives(
  candidates: ReadonlyArray<ReadonlySet<string>>,
): boolean {
  const takenBy = new Map<string, number>();
  const assign = (index: number, seen: Set<string>): boolean => {
    for (const value of candidates[index] ?? []) {
      if (seen.has(value)) continue;
      seen.add(value);
      const holder = takenBy.get(value);
      if (holder === undefined || assign(holder, seen)) {
        takenBy.set(value, index);
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < candidates.length; i++) {
    if (!assign(i, new Set())) return false;
  }
  return true;
}

/**
 * The authoritative grouping keys, normalized and de-duplicated. NULL keys are
 * excluded, because {@link columnValueSets} cannot produce one on the observed
 * side — counting them here would make an identical answer un-passable.
 *
 * `.size` is the grouping cardinality. Derived on demand rather than stored:
 * a count kept beside the thing it counts can disagree with it.
 */
function authoritativeLabels(expectation: KeyedExpectation): ReadonlySet<string> {
  const out = new Set<string>();
  // `cellKey`, not `normalizeKey` — the observed side reduces through `cellKey`,
  // and calling the same function is a guarantee where calling an equivalent one
  // is only a proof. `cellLabel` is the identity on strings TODAY; if it ever
  // grows a rule (NFC folding, truncation) this line would silently reopen the
  // two-spellings defect it was written to close.
  for (const g of expectation.groups) {
    const key = cellKey(g.label);
    if (key !== null) out.add(key);
  }
  return out;
}

/**
 * Some column of the result carries EXACTLY the given values, as a set — so
 * column aliasing, extra measure columns and `ORDER BY` differences don't
 * matter, while a missing or spurious group does.
 */
function labelSetMatches(
  rows: ReadonlyArray<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): boolean {
  if (expected.size === 0) return false;
  for (const set of columnValueSets(rows).values()) {
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

/** `columnName` → set of its {@link cellKey}s. Nullish cells are not values. */
function columnValueSets(
  rows: ReadonlyArray<Record<string, unknown>>,
): Map<string, Set<string>> {
  const byColumn = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const [col, cell] of Object.entries(row)) {
      const key = cellKey(cell);
      if (key === null) continue;
      let set = byColumn.get(col);
      if (!set) {
        set = new Set();
        byColumn.set(col, set);
      }
      set.add(key);
    }
  }
  return byColumn;
}

/**
 * The ONE "is this cell a group at all, and what does it read as" rule, called
 * from both sides of the comparison.
 *
 * ⚠️ TWO SPELLINGS OF THIS IS A FALSE NEGATIVE. `origin/main` harvested with
 * `String(cell)` while the observed side skipped nullish cells, so a NULL group
 * harvested as the label `"null"` and counted toward a cardinality no observed
 * result could ever reach — a model returning the byte-identical authoritative
 * rows would have graded FAIL. One function, both callers.
 *
 * LATENT, NOT OBSERVED, and worth the distinction: no corpus grouping key is
 * nullable today — `acquisition_source` is populated for every seeded row, and
 * every other keyed question groups on a `CASE`, a `TO_CHAR`, a join key or
 * `full_name` — so this never fired in a paid run. Found in review, pinned by a
 * test, not measured on a score.
 *
 * Returns the cell VERBATIM rather than normalized: {@link labelDriftNote}
 * prints these back to an operator, and `with promo` is harder to find in a
 * `query_patterns` block than the `'With Promo'` the SQL actually wrote.
 * Normalization is {@link normalizeKey}'s job, applied at comparison time.
 */
function cellLabel(cell: unknown): string | null {
  return cell === null || cell === undefined ? null : String(cell);
}

/** How a group's label reads in operator-facing text. Spelled once, not twice. */
function displayLabel(g: AuthoritativeGroup): string {
  return g.label === null ? "<null>" : g.label;
}

/** `cellLabel` + case/whitespace folding — the form the two sides compare in. */
function cellKey(cell: unknown): string | null {
  const label = cellLabel(cell);
  return label === null ? null : normalizeKey(label);
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Reduce one authoritative grouped result to its {@link KeyedExpectation}.
 *
 * Lives beside the comparison rather than beside the SQL execution in
 * `canonical-eval-run.ts` on purpose: harvesting and comparison are two halves
 * of one rule, and #5128 is what a split between them looks like — ground truth
 * was harvested from a display column while the comparison assumed it was data.
 *
 * `keyColumn` is the grouping key — `columns[0]` by convention across the
 * corpus (`channel`, `carrier`, `stock_status`, `month`, `promo_status`) — and
 * `measureColumns` is everything after it. Taking them as two parameters rather
 * than one `columns` array consumes the non-emptiness the caller has already
 * proved, instead of re-checking it with a throw.
 */
export function keyedExpectationFrom(
  keyColumn: string,
  measureColumns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): KeyedExpectation {
  return {
    kind: "keyed",
    groups: rows.map((r) => ({
      label: cellLabel(r[keyColumn]),
      // Reuses `numericValues`' row shape so Postgres `numeric`-as-a-string is
      // parsed identically on both sides. The key column is never included,
      // so a numeric `month` label is not a value the model must reproduce.
      measures: numericValues([Object.fromEntries(measureColumns.map((c) => [c, r[c]]))]),
    })),
  };
}

/**
 * Diagnostic for a grouped answer that matched on substance while carrying
 * NONE of the authoritative display labels — i.e. exactly the case the old
 * label-set rule failed and this one passes.
 *
 * ⚠️ REPORTING, NOT GRADING. It is computed after the verdict and cannot change
 * it. The point is that a relabel stays *visible*: if the corpus and the
 * entity's `query_patterns` drift apart, or a model starts inventing its own
 * vocabulary wholesale, the run says so instead of silently absorbing it.
 *
 * Returns `null` when there is nothing to report: a non-keyed or absent
 * expectation, a `fail`, no matching result, or a matching result that did
 * carry the labels.
 *
 * ⚠️ SUPPRESSED ON A FAIL, AND THE GUARD IS LOAD-BEARING FOR THREE BRANCHES,
 * NOT ONE. {@link grade} can return `fail` with a substance-matching answer via
 * `latency`, `protocol` (unparseable) and `protocol` (transport) — in all three
 * the artifact already carries the expectation, and a "matched but relabelled"
 * line beside a failure verdict reads as a second, contrary verdict.
 *
 * A MEASURE-LESS expectation needs no guard of its own: `keyedResultMatches` is
 * then exactly `labelSetMatches`, so anything in `matching` necessarily
 * satisfies the label suppression below. An explicit early return for it looked
 * like a fourth case and was dead code — a mutation deleting it changed nothing.
 */
function labelDriftNote(
  outcome: McpLlmOutcome,
  expectation: MetricExpectation | undefined,
): string | null {
  if (outcome.status !== "pass") return null;
  if (expectation === undefined || expectation.kind !== "keyed") return null;

  const labels = authoritativeLabels(expectation);
  const matching = outcome.toolCalls.flatMap((c) => {
    if (!isAnsweringCall(c) || c.result.kind !== "ok") return [];
    const rows = collectRows(c.result.data);
    return rows.length > 0 && keyedResultMatches(rows, expectation) ? [rows] : [];
  });

  if (matching.length === 0) return null;
  if (matching.some((rows) => labelSetMatches(rows, labels))) return null;

  // Printed VERBATIM, not from the normalized `labels` set — an operator greps
  // the entity's `query_patterns` for this string.
  const written = expectation.groups.map(displayLabel).join(", ");
  return (
    `${outcome.questionId}: grouped answer matched the authoritative measures and ` +
    `${labels.size} group(s), but relabelled them — none of ` +
    `[${written}] appears in any result column. ` +
    `Not a verdict: those are display labels from the authoritative SQL, not data.`
  );
}

/**
 * The one place that answers "which expectation governs this question".
 *
 * Both {@link gradeByMode} and the run loop's drift note need it, and a second
 * copy is how the note ends up describing a different expectation than the one
 * that produced the verdict.
 */
function expectationForQuestion(
  q: Question,
  metricExpectations: McpLlmEvalOptions["metricExpectations"],
  answerExpectations: McpLlmEvalOptions["answerExpectations"],
): MetricExpectation | undefined {
  switch (q.mode) {
    case "metric":
      return metricExpectations?.[q.metric_id];
    case "pattern":
    case "virtual":
      return answerExpectations?.[q.id];
    case "glossary":
      return undefined;
    default: {
      const _exhaustive: never = q;
      throw new Error(unreachableModeMessage(_exhaustive));
    }
  }
}

/**
 * ⚠️ `String(question)` RENDERS `[object Object]` — no id, no mode, nothing to
 * grep the corpus with, on a message whose whole job is to say which row of
 * `questions.yml` is malformed. The one pre-existing guard (`gradeByMode`) used
 * that spelling and the new `expectationForQuestion` guard would have copied it;
 * this is the one place that phrases it.
 */
function unreachableModeMessage(q: never): string {
  // No cast: `never` is assignable to every type, so the annotation alone reads
  // the fields. `JSON.stringify(x) ?? fallback` would look dead to a reader —
  // `lib.d.ts` types the return as `string` — while firing at runtime, because
  // `JSON.stringify(undefined)` really is `undefined`. Spelled as a ternary so
  // the live branch is visible, and applied to BOTH fields: an absent `mode` is
  // as likely as an absent id in a malformed corpus row.
  const { id, mode }: { id?: unknown; mode?: unknown } = q;
  const show = (v: unknown, absent: string) =>
    v === undefined ? absent : JSON.stringify(v);
  return (
    `unreachable question mode ${show(mode, "<no mode>")} on question ` +
    `${show(id, "<no id>")} — loadQuestions validates \`mode\` against ` +
    `VALID_MODES, so reaching here means the corpus and this switch disagree.`
  );
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
 * are not here for a stronger reason since #5135: they are no longer this
 * module's at all. They live in `@atlas/mcp/eval/tool-contract`, which both
 * evals import as an ordinary dependency.
 */
export const __forTesting__ = {
  grade: (input: GradeInput) => grade(input),
  describeNonError,
  gradeMetric,
  gradeGlossary,
  gradePattern,
  gradeVirtual,
  bindMcpToolsForLlm,
  labelDriftNote,
  // #5123 — the boundary narrow. Every field of the AI SDK's usage shape is
  // `number | undefined`, so this is where "the provider reported nothing
  // usable" becomes a value rather than a zero, and it needs its own tests.
  toTokenUsage,
  // #5123 — reads `totalUsage`, and its PARAMETER TYPE is what enforces that.
  runTokenUsage,
  summarizeTokenUsage,
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
