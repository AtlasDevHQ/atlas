/**
 * Tests for the registry-seam tool-span wrapper (#4464).
 *
 * Unlike the `atlas.profile.*` / `stripe.webhook.process` span tests — which
 * instrument code paths you can't call directly, and so settle for testing the
 * pure attribute builder — `withToolSpans` is a directly-callable function that
 * re-implements the whole span lifecycle inline (it can't reuse `withSpan`; see
 * the module header). So the lifecycle IS tested here, with a stub
 * `TracerProvider` built from `@opentelemetry/api` alone — no
 * `@opentelemetry/sdk-trace-base` devDep, which is the cost those other tests
 * declined to pay.
 *
 * The provider is installed in `beforeAll` and torn down in `afterAll` (never
 * at module top level) so the file stays self-contained under the isolated
 * runner.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import {
  trace,
  SpanStatusCode,
  type Attributes,
  type Span,
  type SpanOptions,
  type TracerProvider,
} from "@opentelemetry/api";
import type { ToolSet, ToolExecutionOptions } from "ai";
import {
  withToolSpans,
  toolSpanName,
  toolResultAttributes,
  TOOL_SPAN_PREFIX,
} from "../tool-spans";

// ── Stub tracer ────────────────────────────────────────────────────────────
interface RecordedSpan {
  name: string;
  attributes: Attributes;
  statusCode?: SpanStatusCode;
  statusMessage?: string;
  exceptions: unknown[];
  endCount: number;
}

let recorded: RecordedSpan[] = [];
/** Span methods that should throw, to prove telemetry can't fail a tool call. */
let faults = new Set<"setAttributes" | "setStatus" | "recordException" | "end">();
/**
 * `Span` has ~11 members and the stub implements 4. Any other member the
 * wrapper reaches for would throw INSIDE the production guard, be logged as
 * degraded telemetry, and leave the test green with the span silently lost —
 * so unimplemented access is recorded and the happy-path tests assert it stayed
 * empty.
 */
let unstubbed: string[] = [];

function fault(method: "setAttributes" | "setStatus" | "recordException" | "end") {
  if (faults.has(method)) throw new Error(`span.${method} exploded`);
}

function makeStubSpan(name: string, attributes: Attributes): Span {
  const rec: RecordedSpan = { name, attributes: { ...attributes }, exceptions: [], endCount: 0 };
  recorded.push(rec);
  const impl = {
    setAttributes(attrs: Attributes) {
      fault("setAttributes");
      Object.assign(rec.attributes, attrs);
      return this;
    },
    setStatus(status: { code: SpanStatusCode; message?: string }) {
      fault("setStatus");
      rec.statusCode = status.code;
      rec.statusMessage = status.message;
      return this;
    },
    recordException(err: unknown) {
      fault("recordException");
      rec.exceptions.push(err);
    },
    end() {
      fault("end");
      rec.endCount++;
    },
  };
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      unstubbed.push(String(prop));
      return () => {
        throw new Error(`stub Span has no ${String(prop)}`);
      };
    },
  }) as unknown as Span;
}

const stubProvider = {
  getTracer: () => ({
    // The seam MUST use startActiveSpan: that is the only reason a
    // self-instrumented tool's inner span (atlas.sql.execute, …) nests under
    // it. A regression to startSpan would flatten the hierarchy in production
    // and still pass a stub that recorded both — so this one refuses.
    startSpan: () => {
      throw new Error(
        "tool-spans must use startActiveSpan so the tool body runs in the span's context",
      );
    },
    startActiveSpan: (name: string, options: SpanOptions, fn: (span: Span) => unknown) =>
      fn(makeStubSpan(name, options.attributes ?? {})),
  }),
} as unknown as TracerProvider;

beforeAll(() => {
  // The module-level `trace.getTracer("atlas")` in tool-spans.ts already ran at
  // import time; this still reaches it because @opentelemetry/api hands back a
  // ProxyTracer that resolves its delegate lazily, per span. Assert the
  // registration took, so a pre-registered provider fails here rather than as a
  // pile of confusing "no span named …" errors.
  expect(trace.setGlobalTracerProvider(stubProvider)).toBe(true);
});
afterAll(() => {
  trace.disable();
});
beforeEach(() => {
  recorded = [];
  faults = new Set();
  unstubbed = [];
});

function spanFor(name: string): RecordedSpan {
  const span = recorded.find((s) => s.name === toolSpanName(name));
  if (!span) {
    throw new Error(
      `no span named ${toolSpanName(name)} — recorded: ${recorded.map((s) => s.name).join(", ") || "(none)"}`,
    );
  }
  return span;
}

// ── Fixtures ───────────────────────────────────────────────────────────────
function makeTool(execute?: ToolSet[string]["execute"]) {
  return tool({
    description: "test tool",
    inputSchema: z.object({ value: z.string().optional() }),
    ...(execute ? { execute } : {}),
  });
}

/** Invoke a wrapped tool's execute with the AI SDK's (input, options) shape. */
function call(
  entry: ToolSet[string],
  input: Record<string, unknown> = {},
  options: Partial<ToolExecutionOptions> = {},
): unknown {
  const execute = entry.execute;
  if (!execute) throw new Error("tool has no execute");
  return execute(input, { toolCallId: "call-1", messages: [], ...options });
}

describe("toolSpanName", () => {
  it("prefixes the tool name with the atlas.* seam prefix", () => {
    expect(toolSpanName("searchKnowledge")).toBe("atlas.tool.searchKnowledge");
    expect(TOOL_SPAN_PREFIX).toBe("atlas.tool.");
  });
});

describe("toolResultAttributes", () => {
  it("flags a returned { error } result as failed", () => {
    expect(toolResultAttributes({ error: "no workspace" })).toEqual({
      "atlas.tool.error": true,
    });
  });

  it("does not flag a normal result", () => {
    expect(toolResultAttributes({ columns: ["a"], rows: [] })).toEqual({
      "atlas.tool.error": false,
    });
  });

  it("does not flag a non-string error field or a non-object result", () => {
    // A tool returning `{ error: false }` / a bare string is reporting success.
    expect(toolResultAttributes({ error: false })).toEqual({ "atlas.tool.error": false });
    expect(toolResultAttributes("ok")).toEqual({ "atlas.tool.error": false });
    expect(toolResultAttributes(null)).toEqual({ "atlas.tool.error": false });
  });
});

describe("withToolSpans — pass-through semantics", () => {
  it("wraps every executable tool without changing its result", async () => {
    const wrapped = withToolSpans({
      alpha: makeTool(async () => "alpha-result"),
      beta: makeTool(async () => ({ rows: [1] })),
    });

    expect(Object.keys(wrapped).sort()).toEqual(["alpha", "beta"]);
    expect(await call(wrapped.alpha)).toBe("alpha-result");
    expect(await call(wrapped.beta)).toEqual({ rows: [1] });
  });

  it("passes input and options through to the original execute", async () => {
    let seen: { input: unknown; toolCallId: unknown } | undefined;
    const wrapped = withToolSpans({
      echo: makeTool(async (input, options) => {
        seen = { input, toolCallId: options.toolCallId };
        return "ok";
      }),
    });

    await call(wrapped.echo, { value: "hi" }, { toolCallId: "call-42" });
    expect(seen).toEqual({ input: { value: "hi" }, toolCallId: "call-42" });
  });

  it("rethrows the ORIGINAL error object, never a telemetry one", async () => {
    const sentinel = new Error("tool exploded");
    const wrapped = withToolSpans({
      boom: makeTool(async () => {
        throw sentinel;
      }),
    });

    await expect(call(wrapped.boom) as Promise<unknown>).rejects.toBe(sentinel);
  });

  it("propagates an error thrown synchronously by execute", () => {
    const sentinel = new Error("sync boom");
    const wrapped = withToolSpans({
      sync: makeTool(() => {
        throw sentinel;
      }),
    });

    expect(() => call(wrapped.sync)).toThrow(sentinel);
  });

  it("passes through tools with no execute (client-side / provider-executed)", () => {
    const clientTool = makeTool();
    const wrapped = withToolSpans({ clientSide: clientTool });
    expect(wrapped.clientSide).toBe(clientTool);
    expect(recorded).toHaveLength(0);
  });

  it("does not mutate the input tool set", () => {
    const original = makeTool(async () => "ok");
    const toolSet: ToolSet = { alpha: original };
    const wrapped = withToolSpans(toolSet);

    expect(toolSet.alpha).toBe(original);
    expect(wrapped.alpha).not.toBe(original);
  });

  it("preserves every non-execute tool property", () => {
    const original = makeTool(async () => "ok");
    const wrapped = withToolSpans({ alpha: original });
    expect(Object.keys(wrapped.alpha).sort()).toEqual(Object.keys(original).sort());
    expect(wrapped.alpha.description).toBe(original.description);
    expect(wrapped.alpha.inputSchema).toBe(original.inputSchema);
  });
});

describe("withToolSpans — span lifecycle", () => {
  it("emits one atlas.tool.<name> span per call, named and attributed", async () => {
    const wrapped = withToolSpans({ searchKnowledge: makeTool(async () => "ok") });

    await call(wrapped.searchKnowledge, {}, { toolCallId: "call-7" });

    expect(recorded).toHaveLength(1);
    const span = spanFor("searchKnowledge");
    expect(span.attributes["atlas.tool.name"]).toBe("searchKnowledge");
    expect(span.attributes["atlas.tool.call_id"]).toBe("call-7");
    expect(span.statusCode).toBe(SpanStatusCode.OK);
    expect(span.endCount).toBe(1);
    expect(unstubbed).toEqual([]);
  });

  it("keeps concurrent calls of one tool on independent spans", async () => {
    let release: Array<(value: string) => void> = [];
    const wrapped = withToolSpans({
      parallel: makeTool(() => new Promise<string>((resolve) => { release.push(resolve); })),
    });

    const a = call(wrapped.parallel, {}, { toolCallId: "call-a" }) as Promise<string>;
    const b = call(wrapped.parallel, {}, { toolCallId: "call-b" }) as Promise<string>;
    release[0]?.("a");
    release[1]?.("b");
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);

    // Two spans, each ended once — a `guardSpan` hoisted per tool instead of
    // per call would cross-latch `ended` and silently drop the second.
    expect(recorded).toHaveLength(2);
    expect(recorded.map((s) => s.endCount)).toEqual([1, 1]);
    expect(
      recorded.map((s) => String(s.attributes["atlas.tool.call_id"])).toSorted(),
    ).toEqual(["call-a", "call-b"]);
    release = [];
  });

  it("tags a RETURNED { error } result without failing the span", async () => {
    const wrapped = withToolSpans({
      failing: makeTool(async () => ({ error: "no active workspace" })),
    });

    const result = await call(wrapped.failing);

    expect(result).toEqual({ error: "no active workspace" });
    const span = spanFor("failing");
    expect(span.attributes["atlas.tool.error"]).toBe(true);
    expect(span.statusCode).toBe(SpanStatusCode.OK);
    expect(span.endCount).toBe(1);
  });

  it("records ERROR status + the exception when execute rejects", async () => {
    const sentinel = new Error("query failed");
    const wrapped = withToolSpans({
      boom: makeTool(async () => {
        throw sentinel;
      }),
    });

    await expect(call(wrapped.boom) as Promise<unknown>).rejects.toBe(sentinel);

    const span = spanFor("boom");
    expect(span.statusCode).toBe(SpanStatusCode.ERROR);
    expect(span.statusMessage).toBe("query failed");
    expect(span.exceptions).toEqual([sentinel]);
    expect(span.endCount).toBe(1);
  });

  it("records a non-Error rejection as a narrowed Error", async () => {
    const wrapped = withToolSpans({
      stringy: makeTool(async () => {
        throw "just a string";
      }),
    });

    await expect(call(wrapped.stringy) as Promise<unknown>).rejects.toBe("just a string");

    const span = spanFor("stringy");
    expect(span.statusMessage).toBe("just a string");
    expect(span.exceptions[0]).toBeInstanceOf(Error);
  });

  it("ends the span exactly once on the sync-throw path", () => {
    const wrapped = withToolSpans({
      sync: makeTool(() => {
        throw new Error("sync boom");
      }),
    });

    expect(() => call(wrapped.sync)).toThrow("sync boom");
    const span = spanFor("sync");
    expect(span.statusCode).toBe(SpanStatusCode.ERROR);
    expect(span.endCount).toBe(1);
  });
});

describe("withToolSpans — the three execute return arms", () => {
  it("treats a plain synchronous return as a result, not as a stream", () => {
    const wrapped = withToolSpans({
      syncValue: makeTool(() => ({ error: "sync failure" })),
    });

    expect(call(wrapped.syncValue)).toEqual({ error: "sync failure" });

    const span = spanFor("syncValue");
    // The bug this pins: keying the stream branch on "not a promise" would
    // mislabel this call as streaming AND drop its error attribute.
    expect(span.attributes["atlas.tool.streaming"]).toBeUndefined();
    expect(span.attributes["atlas.tool.error"]).toBe(true);
    expect(span.statusCode).toBe(SpanStatusCode.OK);
    expect(span.endCount).toBe(1);
  });

  it("returns a streaming (AsyncIterable) result unwrapped and leaves status UNSET", async () => {
    async function* stream() {
      yield "chunk";
    }
    const wrapped = withToolSpans({ streamer: makeTool(() => stream()) });

    const out = call(wrapped.streamer);
    expect(typeof (out as { then?: unknown }).then).not.toBe("function");
    expect(typeof (out as AsyncIterable<string>)[Symbol.asyncIterator]).toBe("function");

    const chunks: string[] = [];
    for await (const chunk of out as AsyncIterable<string>) chunks.push(chunk);
    expect(chunks).toEqual(["chunk"]);

    const span = spanFor("streamer");
    expect(span.attributes["atlas.tool.streaming"]).toBe(true);
    // The span closed before the first chunk was pulled, so it cannot claim
    // the stream succeeded — "outcome unknown" must not read as OK.
    expect(span.statusCode).toBeUndefined();
    expect(span.endCount).toBe(1);
  });
});

describe("withToolSpans — telemetry never fails the tool call", () => {
  it("returns the result even when every span mutation throws", async () => {
    faults = new Set(["setAttributes", "setStatus", "recordException", "end"]);
    const wrapped = withToolSpans({ alpha: makeTool(async () => "still fine") });

    expect(await call(wrapped.alpha)).toBe("still fine");
  });

  it("preserves the tool's own error when span mutation throws", async () => {
    faults = new Set(["setStatus", "recordException", "end"]);
    const sentinel = new Error("the real failure");
    const wrapped = withToolSpans({
      boom: makeTool(async () => {
        throw sentinel;
      }),
    });

    await expect(call(wrapped.boom) as Promise<unknown>).rejects.toBe(sentinel);
  });

  it("degrades one mutation at a time — a failing setStatus still records the exception", async () => {
    faults = new Set(["setStatus"]);
    const sentinel = new Error("the real failure");
    const wrapped = withToolSpans({
      boom: makeTool(async () => {
        throw sentinel;
      }),
    });

    await expect(call(wrapped.boom) as Promise<unknown>).rejects.toBe(sentinel);

    const span = spanFor("boom");
    expect(span.statusCode).toBeUndefined(); // the faulted mutation
    expect(span.exceptions).toEqual([sentinel]); // …did not cost us this one
    expect(span.endCount).toBe(1);
  });
});

describe("withToolSpans — aborted turn", () => {
  it("closes the span when the turn aborts before the tool settles", async () => {
    const controller = new AbortController();
    const wrapped = withToolSpans({
      hung: makeTool(() => new Promise<string>(() => {})), // never settles
    });

    void call(wrapped.hung, {}, { abortSignal: controller.signal });
    const span = spanFor("hung");
    expect(span.endCount).toBe(0);

    controller.abort();

    expect(span.attributes["atlas.tool.aborted"]).toBe(true);
    expect(span.endCount).toBe(1);
  });

  it("does not double-end when the tool settles after an abort", async () => {
    const controller = new AbortController();
    let release: (value: string) => void = () => {};
    const wrapped = withToolSpans({
      slow: makeTool(() => new Promise<string>((resolve) => { release = resolve; })),
    });

    const pending = call(wrapped.slow, {}, { abortSignal: controller.signal }) as Promise<string>;
    controller.abort();
    release("late");

    expect(await pending).toBe("late");
    expect(spanFor("slow").endCount).toBe(1);
  });

  // The common real shape: the client disconnects, the tool's own AbortError
  // rejects. The rejection must still reach the SDK, and the span must not
  // end twice.
  it("still propagates a rejection that arrives after the abort", async () => {
    const controller = new AbortController();
    let reject: (err: unknown) => void = () => {};
    const sentinel = new Error("aborted by caller");
    const wrapped = withToolSpans({
      cancelled: makeTool(() => new Promise<string>((_resolve, rej) => { reject = rej; })),
    });

    const pending = call(wrapped.cancelled, {}, { abortSignal: controller.signal }) as Promise<string>;
    controller.abort();
    reject(sentinel);

    await expect(pending).rejects.toBe(sentinel);
    expect(spanFor("cancelled").endCount).toBe(1);
  });

  it("ends the span when the signal is already aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const wrapped = withToolSpans({ late: makeTool(async () => "ok") });

    expect(await (call(wrapped.late, {}, { abortSignal: controller.signal }) as Promise<string>)).toBe("ok");
    const span = spanFor("late");
    expect(span.attributes["atlas.tool.aborted"]).toBe(true);
    expect(span.endCount).toBe(1);
  });

  // The abort signal is turn-scoped and shared by every tool call in the turn:
  // a listener left attached per completed call retains its span for the rest
  // of the turn.
  it("detaches its abort listener once the call settles", async () => {
    const listeners = new Map<object, number>();
    const signal = {
      aborted: false,
      addEventListener: (_type: string, fn: object) => {
        listeners.set(fn, (listeners.get(fn) ?? 0) + 1);
      },
      removeEventListener: (_type: string, fn: object) => {
        listeners.delete(fn);
      },
    } as unknown as AbortSignal;

    const wrapped = withToolSpans({ tidy: makeTool(async () => "ok") });
    await call(wrapped.tidy, {}, { abortSignal: signal });

    expect(listeners.size).toBe(0);
  });
});

describe("withToolSpans — the guard logs rather than swallows", () => {
  // Structural source guard, in the style of the scheduler span-name check in
  // `lib/effect/__tests__/layers.test.ts`. The fault-injection tests above
  // prove a telemetry failure can't break a tool call — but they would stay
  // green if `safe()`'s catch were collapsed to a bare `catch {}`, which
  // CLAUDE.md forbids. This pins that the catch still reports.
  it("keeps a log call in the guard's catch block", async () => {
    const source = await Bun.file(
      new URL("../tool-spans.ts", import.meta.url).pathname,
    ).text();
    const guard = source.slice(
      source.indexOf("const safe = (phase: SpanPhase"),
      source.indexOf("return {\n    safe,"),
    );
    expect(guard).toContain("} catch (err) {");
    expect(guard).toContain("log.warn(");
    expect(guard).toContain("err instanceof Error ? err.message : String(err)");
  });
});
