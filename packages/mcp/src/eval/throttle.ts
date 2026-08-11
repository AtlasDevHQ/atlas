/**
 * The eval harnesses' shared throttle abort.
 *
 * ⚠️ A THROTTLE IS A HARNESS FAULT, NOT A MODEL FAULT, AND MUST NOT BE GRADED
 * (#5122). Both LLM-driven evals share ONE OAuth client and ONE tool surface, so
 * both are exposed to the hosted per-OAuth-client quota that runs ahead of every
 * tool body (`rateLimitOrNull` in `mcp-dispatch.ts`) — and a `rate_limited`
 * envelope reaches the model as an ordinary tool result, which means the grader
 * scores whatever the model did next. In `--mcp-llm` that was two questions
 * charged to `recovery`; in `--tool-selection` it is a first-tool MISS whenever a
 * throttled dispatch pushes the model to retry or switch tools, so the accuracy
 * floor moves with dispatch volume.
 *
 * `liftEvalClientRateLimit` raises the ceiling so this should not fire. When it
 * does, the honest outcome is a loud stop rather than a quieter score.
 *
 * ── Why the remedy lives here and not at either call site (#5136) ──
 *
 * The prose below tells an operator WHICH limiter fired and what to do about it,
 * and getting that wrong is not hypothetical: an earlier cut keyed it on the
 * tool's output CONTRACT and was measured wrong in #5133. Two copies of a rule
 * that subtle is two chances to reintroduce it, and only one of them is under
 * test at a time.
 */

import type { ToolErrorEnvelope } from "./client.js";
import type { ToolContract } from "./tool-contract.js";

/** The MCP error code the hosted quota and every downstream limiter emit. */
export const RATE_LIMITED_CODE = "rate_limited";

/** One dispatch that came back throttled, with what the abort needs to explain it. */
export interface ThrottledDispatch {
  readonly toolName: string;
  /**
   * The tool's output contract — DIAGNOSTIC ONLY. It is printed so an operator
   * reading the abort knows which lane the tool was in; it is NOT what decides
   * which limiter fired. See {@link throttleAbortError}.
   */
  readonly contract: ToolContract;
  readonly envelope: ToolErrorEnvelope;
}

/** Is this envelope the throttle? */
export function isRateLimitedEnvelope(envelope: ToolErrorEnvelope): boolean {
  return envelope.code === RATE_LIMITED_CODE;
}

/**
 * The error to throw when a dispatch came back throttled.
 *
 * ⚠️ THE REMEDY BRANCHES ON THE ENVELOPE, NOT ON THE TOOL'S CONTRACT — an
 * earlier cut keyed it on `contract === "text"` and asserted that a throttled
 * `explore` could only be the sandbox's limiter. That is false, and false in the
 * dominant direction: the hosted per-OAuth-client quota runs ahead of EVERY tool
 * body (`rateLimitOrNull` in `mcp-dispatch.ts`), and `explore` is charged weight
 * 5 there — tied with `executeSQL` for the second-priciest tool, so it is one of
 * the largest contributors to the exhaustion `liftEvalClientRateLimit` exists to
 * prevent. Output shape simply does not encode which limiter fired.
 *
 * The envelope does. The hosted limiter always sets `retry_after` + `hint`
 * (`rate-limit/middleware.ts`); the sandbox path builds its envelope with no
 * extras for `rate_limited` (`tools.ts` → `classifyExploreError`), so the field
 * is absent there.
 *
 * `subject` is whatever the caller grades one of — a canonical question id in
 * `--mcp-llm`, a fixture item id in `--tool-selection` — so the abort names the
 * unit of work that stopped rather than a tool call nobody can find.
 */
export function throttleAbortError(
  subject: string,
  throttled: ThrottledDispatch,
): Error {
  const { envelope } = throttled;
  const retryAfter = (envelope as { retry_after?: unknown }).retry_after;
  const message = typeof envelope.message === "string" ? envelope.message : "";
  const isHostedQuota =
    typeof retryAfter === "number" || /hosted-MCP quota/.test(message);
  const remedy = isHostedQuota
    ? `This is the eval throttling ITSELF, not a model failure: the run's own dispatch ` +
      `volume exceeded the eval client's hosted-MCP quota (${throttled.toolName} is just the ` +
      `dispatch that happened to hit it). Raise it via liftEvalClientRateLimit ` +
      `(EVAL_CLIENT_REQUESTS_PER_MINUTE).`
    : `The envelope carries no hosted-quota markers, so a limiter DOWNSTREAM of the eval ` +
      `client fired — for a text-contract tool that is the sandbox backend ` +
      `(classifyExploreError); for a JSON one, the datasource QPM/pool or the billing ` +
      `throttle. Raising EVAL_CLIENT_REQUESTS_PER_MINUTE will not help; read the message ` +
      `above and check that limiter.`;
  return new Error(
    `[harness] ${subject}: MCP dispatch was rate limited on ${throttled.toolName} ` +
      `(contract: ${throttled.contract}) — ${message || "no message"} ${remedy} ` +
      `Either way the run stops rather than letting the throttle be graded as a ` +
      `recovery regression.`,
  );
}
