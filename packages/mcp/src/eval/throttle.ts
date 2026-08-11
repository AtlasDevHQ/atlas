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
 * ⚠️ AND IT BRANCHES ON THE MESSAGE, NOT ON `retry_after`. This is the SECOND
 * spelling of #5133's mistake and it survived the move: an earlier cut of this
 * function accepted `typeof retry_after === "number"` as proof of the hosted
 * quota, on the stated ground that only the hosted limiter sets it. Measured
 * false — `packages/mcp/src/tools.ts:316` sets `extras.retry_after` from the
 * DATASOURCE limiter's `retryAfterMs` (`lib/tools/sql.ts`) on a throttled
 * `executeSQL`, which is the very case this function's `else` arm describes as
 * downstream. So a datasource throttle was routed to the hosted arm and told an
 * operator to raise a quota that had not fired — on a weekly, paid run, whose
 * only response is to re-run and abort identically.
 *
 * The MESSAGE is the exact discriminator. Both hosted denial paths — bucket
 * overflow and loader failure — build it with `rateLimitedMessage()`
 * (`rate-limit/middleware.ts`), so the phrase `hosted-MCP quota` is guaranteed
 * present there and is produced nowhere else. `retry_after` is still PRINTED as
 * a detail; it is no longer trusted as evidence.
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
  // No cast: `ToolErrorEnvelope` carries an index signature, so this reads as
  // `unknown` already. Casting to a structural type WITHOUT that signature would
  // keep compiling if the envelope were ever tightened to explicit fields —
  // silently reading a property the declared shape no longer has.
  const retryAfter = envelope.retry_after;
  const message = typeof envelope.message === "string" ? envelope.message : "";
  const isHostedQuota = /hosted-MCP quota/.test(message);
  const remedy = isHostedQuota
    ? `This is the eval throttling ITSELF, not a model failure: the run's own dispatch ` +
      `volume exceeded the eval client's hosted-MCP quota (${throttled.toolName} is just the ` +
      `dispatch that happened to hit it). Raise it via liftEvalClientRateLimit ` +
      `(EVAL_CLIENT_REQUESTS_PER_MINUTE).`
    : `The message carries no hosted-quota marker, so a limiter DOWNSTREAM of the eval ` +
      `client fired — for a text-contract tool that is the sandbox backend ` +
      `(classifyExploreError); for a JSON one, the datasource QPM/pool or the billing ` +
      `throttle. Raising EVAL_CLIENT_REQUESTS_PER_MINUTE will not help; read the message ` +
      `above and check that limiter.` +
      (typeof retryAfter === "number"
        ? ` (It carries retry_after=${retryAfter}s, which the DATASOURCE limiter also sets — ` +
          `mcp/tools.ts — so that field is not evidence of the hosted quota.)`
        : "");
  return new Error(
    `[harness] ${subject}: MCP dispatch was rate limited on ${throttled.toolName} ` +
      `(contract: ${throttled.contract}) — ${message || "no message"} ${remedy} ` +
      `Either way the run stops rather than letting the throttle be graded as a ` +
      `recovery regression.`,
  );
}
