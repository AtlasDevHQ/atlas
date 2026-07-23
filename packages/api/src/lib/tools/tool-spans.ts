/**
 * Per-tool OTel spans, applied once at the `ToolRegistry` seam (#4464).
 *
 * Before this wrapper only the tools that remembered to self-instrument
 * (`atlas.sql.execute`, `atlas.explore`, `atlas.python.execute`,
 * `atlas.profile.table`) carried an `atlas.*` segment of their own;
 * `searchKnowledge`, `createDashboard`, `executeRestOperation` and the action
 * tools had none, so latency could not be attributed within a turn by the
 * `atlas.`-prefixed views. Wrapping at the seam makes the span a property of
 * *being registered* rather than of each tool's own diligence: a newly
 * registered tool gets one with zero per-tool code.
 *
 * The seam span is the FLOOR, not the ceiling — a tool that self-instruments
 * keeps its inner span, which simply nests under the seam span (the wrapper
 * uses `startActiveSpan`, so the tool body runs inside the seam span's
 * context). It nests in turn under the AI SDK's own `ai.toolCall` span when
 * `experimental_telemetry` is on; what it adds over that one is documented in
 * `docs/development/telemetry.md`.
 *
 * `withSpan` is deliberately NOT reused here: it is typed `Promise<T>` and
 * always awaits, which would collapse the AI SDK's non-promise `execute`
 * return arms (a plain value, or an `AsyncIterable` for a streaming tool) into
 * a promise and change the shape this wrapper hands back to its caller.
 *
 * Naming/attribute convention + the seam's known boundaries:
 * `docs/development/telemetry.md`.
 */

import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import type { ToolSet, ToolExecutionOptions } from "ai";
import { createLogger } from "@atlas/api/lib/logger";

const tracer = trace.getTracer("atlas");
const log = createLogger("tool-spans");

/** Span-name prefix for the seam wrapper: `atlas.tool.<toolName>`. */
export const TOOL_SPAN_PREFIX = "atlas.tool.";

/** Span name for a registered tool. Exported so tests assert one spelling. */
export function toolSpanName(toolName: string): string {
  return `${TOOL_SPAN_PREFIX}${toolName}`;
}

// The async-iterable predicate is copied from the SDK's own `executeTool`
// dispatch (@ai-sdk/provider-utils) rather than tightened, so the seam can
// never classify the streaming arm differently from the SDK that consumes it.
// The SDK has no promise predicate — it just awaits — so this one mirrors what
// that await does.
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof (value as { then?: unknown }).then === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

/**
 * Most Atlas tools report failure by RETURNING an error envelope rather than
 * throwing — the model needs to read the failure and retry. Those calls are
 * successful spans (the tool answered) but must still be countable, so the
 * outcome rides as an attribute instead of the span status.
 *
 * Two envelopes are recognized: a string `error` field (`searchKnowledge`,
 * `profileTable`, `proposeAmendment`, …) and `success: false` (`executeSQL`).
 * KNOWN GAP, deliberate — two shapes read as `false` here:
 *   - tools that discriminate on their own vocabulary (`sendEmail` /
 *     `createLinearIssue` return `{ status: "no_workspace" | … }`), because a
 *     generic seam cannot know each tool's per-status success words without
 *     encoding a table that silently rots; and
 *   - tools that return a bare string (`explore` returns `Error (exit N): …`
 *     as text), which can carry no envelope at all.
 * Treat `atlas.tool.error` as a lower bound on returned failures, and see
 * `docs/development/telemetry.md`.
 */
export function toolResultAttributes(result: unknown): Attributes {
  if (typeof result !== "object" || result === null) {
    return { "atlas.tool.error": false };
  }
  const envelope = result as { error?: unknown; success?: unknown };
  return {
    "atlas.tool.error": typeof envelope.error === "string" || envelope.success === false,
  };
}

/** Span-mutation phases, for the degraded-telemetry log. */
type SpanPhase = "result" | "status" | "exception" | "streaming" | "abort" | "end";

interface GuardedSpan {
  /** Run a span-adjacent operation. Never throws. */
  readonly safe: (phase: SpanPhase, op: () => void) => void;
  /** Mutate the span. No-ops once ended; never throws. */
  readonly mutate: (phase: SpanPhase, op: () => void) => void;
  /** End the span. Idempotent; never throws. */
  readonly end: () => void;
}

/**
 * Span mutation must never become a new way for a tool call to fail. The
 * wrapper now sits in front of EVERY tool, so an exporter that throws on
 * `end()`, or an SDK that rejects an attribute value, would otherwise turn a
 * successful call into a failed turn — or, worse on the error path, replace
 * the tool's real error with a telemetry one. Same stance as the
 * durable-session span attributes in `agent.ts` (which logs) and `withSpan`'s
 * result callback in `tracing.ts` (which swallows silently): never propagate.
 *
 * Each mutation is guarded separately, so one failing operation degrades only
 * itself — a `setStatus` that throws must not also cost the span its recorded
 * exception. `end()` latches BEFORE calling through, so a throwing exporter
 * cannot unlatch it, and `mutate` no-ops afterwards so nothing touches a
 * closed span.
 */
function guardSpan(span: Span, toolName: string): GuardedSpan {
  let ended = false;

  const safe = (phase: SpanPhase, op: () => void): void => {
    try {
      op();
    } catch (err) {
      log.warn(
        { tool: toolName, phase, err: err instanceof Error ? err.message : String(err) },
        "Tool span mutation failed — telemetry degraded, tool result unaffected",
      );
    }
  };

  return {
    safe,
    mutate: (phase, op) => {
      if (ended) return;
      safe(phase, op);
    },
    end: () => {
      if (ended) return;
      ended = true;
      safe("end", () => span.end());
    },
  };
}

/**
 * Wrap every executable tool in `toolSet` with an `atlas.tool.<name>` span.
 * Tools without an `execute` (client-side / provider-executed) pass through
 * untouched. Returns a new ToolSet; the input is not mutated.
 */
export function withToolSpans(toolSet: ToolSet): ToolSet {
  const wrapped: ToolSet = {};

  for (const [name, entry] of Object.entries(toolSet)) {
    if (!entry.execute) {
      wrapped[name] = entry;
      continue;
    }

    const origExecute = entry.execute;
    const spanName = toolSpanName(name);

    wrapped[name] = {
      ...entry,
      execute: (input: unknown, options: ToolExecutionOptions) =>
        tracer.startActiveSpan(
          spanName,
          {
            attributes: {
              "atlas.tool.name": name,
              "atlas.tool.call_id": options.toolCallId,
            },
          },
          (span) => {
            const guarded = guardSpan(span, name);

            // Backstop for a turn aborted mid-call (client disconnect): a tool
            // that doesn't honour the signal may never settle, which would
            // otherwise leave the span open forever and the call invisible.
            const signal = options.abortSignal;
            const onAbort = () => {
              guarded.mutate("abort", () => span.setAttributes({ "atlas.tool.aborted": true }));
              guarded.end();
            };
            // Guarded like every other span-adjacent operation: a signal-like
            // object with a missing/throwing listener API must not become the
            // tool's failure, and a throwing `detach` must not pre-empt the
            // status/exception recording that follows it.
            guarded.safe("abort", () =>
              signal?.addEventListener("abort", onAbort, { once: true }),
            );
            const detach = () =>
              guarded.safe("abort", () => signal?.removeEventListener("abort", onAbort));
            // A signal already aborted before the call started never fires the
            // listener, so close the span here rather than leak it.
            if (signal?.aborted) onAbort();

            const succeed = (result: unknown) => {
              detach();
              guarded.mutate("result", () => span.setAttributes(toolResultAttributes(result)));
              guarded.mutate("status", () => span.setStatus({ code: SpanStatusCode.OK }));
              guarded.end();
            };

            const fail = (err: unknown) => {
              detach();
              const error = err instanceof Error ? err : new Error(String(err));
              guarded.mutate("status", () =>
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message }),
              );
              guarded.mutate("exception", () => span.recordException(error));
              guarded.end();
            };

            try {
              // `.call(entry, …)` because the SDK invokes tools as
              // `tool.execute.bind(tool)` — a tool authored with method
              // shorthand may rely on `this`.
              const out: unknown = origExecute.call(entry, input, options);

              // `execute` has three legal return arms (`ToolExecuteFunction`):
              // an AsyncIterable, a PromiseLike, or a plain value. The arm
              // dispatch itself is inside the try: a thenable whose `then` is a
              // throwing getter must not escape with the span still open.
              if (isAsyncIterable(out)) {
                // Streaming tool. The span closes when `execute` RETURNS the
                // iterable — before any chunk is pulled — so it measures setup
                // only and cannot see a mid-stream failure. Status is therefore
                // left UNSET rather than OK: "outcome unknown" must not be
                // laundered into "succeeded" (same rationale as the
                // pure-interrupt case in `withEffectSpan`).
                detach();
                guarded.mutate("streaming", () =>
                  span.setAttributes({ "atlas.tool.streaming": true }),
                );
                guarded.end();
                return out;
              }

              if (!isPromiseLike(out)) {
                succeed(out);
                return out;
              }

              return out.then(
                (result) => {
                  succeed(result);
                  return result;
                },
                (err: unknown) => {
                  fail(err);
                  throw err;
                },
              );
            } catch (err) {
              fail(err);
              throw err;
            }
          },
        ),
    };
  }

  return wrapped;
}
