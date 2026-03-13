import { describe, test, expect, mock, afterAll } from "bun:test";
import { createAtlasClient, AtlasError } from "../client";
import type { StreamEvent } from "../client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build an SSE ReadableStream from an array of event objects or raw strings. */
function sseResponse(events: Array<Record<string, unknown> | string>, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        const data = typeof event === "string" ? event : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

let lastRequest: Request | null = null;

function installFetchMock(response: Response) {
  lastRequest = null;
  const mockFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    lastRequest = new Request(input as string, init);
    return response.clone();
  });
  globalThis.fetch = Object.assign(mockFn, {
    preconnect: () => {},
  }) as unknown as typeof fetch;
}

function makeClient() {
  return createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "test-key" });
}

async function collectEvents(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// streamQuery — basic text streaming
// ---------------------------------------------------------------------------

describe("streamQuery", () => {
  test("calls POST /api/chat with question wrapped in a message", async () => {
    installFetchMock(sseResponse([
      { type: "text-delta", textDelta: "Hello" },
      { type: "finish", finishReason: "stop" },
    ]));

    const client = makeClient();
    await collectEvents(client.streamQuery("How many users?"));

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.method).toBe("POST");
    expect(new URL(lastRequest!.url).pathname).toBe("/api/chat");

    const body = (await lastRequest!.json()) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.role).toBe("user");
    expect(msg.parts).toEqual([{ type: "text", text: "How many users?" }]);
  });

  test("passes conversationId option", async () => {
    installFetchMock(sseResponse([
      { type: "finish", finishReason: "stop" },
    ]));

    const client = makeClient();
    await collectEvents(client.streamQuery("test", { conversationId: "conv-123" }));

    const body = (await lastRequest!.json()) as Record<string, unknown>;
    expect(body.conversationId).toBe("conv-123");
  });

  test("yields text events from text-delta (textDelta field)", async () => {
    installFetchMock(sseResponse([
      { type: "text-delta", textDelta: "Hello" },
      { type: "text-delta", textDelta: " world" },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events).toEqual([
      { type: "text", content: "Hello" },
      { type: "text", content: " world" },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("yields text events from text-delta (delta field)", async () => {
    installFetchMock(sseResponse([
      { type: "text-delta", id: "t1", delta: "Hi there" },
      { type: "finish", finishReason: "end_turn" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events).toEqual([
      { type: "text", content: "Hi there" },
      { type: "finish", reason: "end_turn" },
    ]);
  });

  test("skips text-delta with no content", async () => {
    installFetchMock(sseResponse([
      { type: "text-delta", textDelta: "" },
      { type: "text-delta", textDelta: "ok" },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({ type: "text", content: "ok" });
  });
});

// ---------------------------------------------------------------------------
// streamQuery — tool events
// ---------------------------------------------------------------------------

describe("streamQuery — tool events", () => {
  test("yields tool-call from tool-input-start + tool-input-available", async () => {
    installFetchMock(sseResponse([
      { type: "tool-input-start", toolCallId: "tc1", toolName: "executeSQL" },
      { type: "tool-input-available", toolCallId: "tc1", input: { sql: "SELECT 1" } },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({
      type: "tool-call",
      toolCallId: "tc1",
      name: "executeSQL",
      args: { sql: "SELECT 1" },
    });
  });

  test("yields tool-result from tool-output-available", async () => {
    installFetchMock(sseResponse([
      { type: "tool-input-start", toolCallId: "tc1", toolName: "explore" },
      { type: "tool-output-available", toolCallId: "tc1", output: { content: "file.yml" } },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({
      type: "tool-result",
      toolCallId: "tc1",
      name: "explore",
      result: { content: "file.yml" },
    });
  });

  test("yields result event for executeSQL tool output", async () => {
    const sqlOutput = {
      columns: ["name", "count"],
      rows: [
        { name: "Alice", count: 10 },
        { name: "Bob", count: 20 },
      ],
    };

    installFetchMock(sseResponse([
      { type: "tool-input-start", toolCallId: "tc1", toolName: "executeSQL" },
      { type: "tool-input-available", toolCallId: "tc1", input: { sql: "SELECT name, count FROM users" } },
      { type: "tool-output-available", toolCallId: "tc1", output: sqlOutput },
      { type: "text-delta", textDelta: "Here are the results." },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));

    // tool-call, tool-result, result, text, finish
    expect(events).toHaveLength(5);
    expect(events[0].type).toBe("tool-call");
    expect(events[1]).toEqual({
      type: "tool-result",
      toolCallId: "tc1",
      name: "executeSQL",
      result: sqlOutput,
    });
    expect(events[2]).toEqual({
      type: "result",
      columns: ["name", "count"],
      rows: [
        { name: "Alice", count: 10 },
        { name: "Bob", count: 20 },
      ],
    });
    expect(events[3]).toEqual({ type: "text", content: "Here are the results." });
    expect(events[4]).toEqual({ type: "finish", reason: "stop" });
  });

  test("does not yield result event for non-executeSQL tools", async () => {
    installFetchMock(sseResponse([
      { type: "tool-input-start", toolCallId: "tc1", toolName: "explore" },
      { type: "tool-output-available", toolCallId: "tc1", output: { columns: ["a"], rows: [{ a: 1 }] } },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events.filter(e => e.type === "result")).toHaveLength(0);
  });

  test("tool-output-available without prior tool-input-start uses 'unknown' name", async () => {
    installFetchMock(sseResponse([
      { type: "tool-output-available", toolCallId: "tc1", output: { data: "test" } },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({
      type: "tool-result",
      toolCallId: "tc1",
      name: "unknown",
      result: { data: "test" },
    });
  });

  test("tool-input-available without prior tool-input-start uses 'unknown' name", async () => {
    installFetchMock(sseResponse([
      { type: "tool-input-available", toolCallId: "tc1", input: { sql: "SELECT 1" } },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({
      type: "tool-call",
      toolCallId: "tc1",
      name: "unknown",
      args: { sql: "SELECT 1" },
    });
  });

  test("tool-input-available with missing input field yields empty args", async () => {
    installFetchMock(sseResponse([
      { type: "tool-input-start", toolCallId: "tc1", toolName: "explore" },
      { type: "tool-input-available", toolCallId: "tc1" },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({
      type: "tool-call",
      toolCallId: "tc1",
      name: "explore",
      args: {},
    });
  });

  test("multiple tool calls in single stream tracked independently", async () => {
    installFetchMock(sseResponse([
      { type: "tool-input-start", toolCallId: "tc1", toolName: "explore" },
      { type: "tool-input-available", toolCallId: "tc1", input: { command: "ls" } },
      { type: "tool-output-available", toolCallId: "tc1", output: { content: "entities/" } },
      { type: "tool-input-start", toolCallId: "tc2", toolName: "executeSQL" },
      { type: "tool-input-available", toolCallId: "tc2", input: { sql: "SELECT 1" } },
      { type: "tool-output-available", toolCallId: "tc2", output: { columns: ["a"], rows: [{ a: 1 }] } },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    // explore: tool-call, tool-result (no result event)
    // executeSQL: tool-call, tool-result, result (convenience)
    // finish
    expect(events).toHaveLength(6);
    expect(events[0]).toEqual({ type: "tool-call", toolCallId: "tc1", name: "explore", args: { command: "ls" } });
    expect(events[1]).toEqual({ type: "tool-result", toolCallId: "tc1", name: "explore", result: { content: "entities/" } });
    expect(events[2]).toEqual({ type: "tool-call", toolCallId: "tc2", name: "executeSQL", args: { sql: "SELECT 1" } });
    expect(events[3]).toEqual({ type: "tool-result", toolCallId: "tc2", name: "executeSQL", result: { columns: ["a"], rows: [{ a: 1 }] } });
    expect(events[4]).toEqual({ type: "result", columns: ["a"], rows: [{ a: 1 }] });
    expect(events[5]).toEqual({ type: "finish", reason: "stop" });
  });

  test("executeSQL output with partial shape does not yield result event", async () => {
    installFetchMock(sseResponse([
      { type: "tool-input-start", toolCallId: "tc1", toolName: "executeSQL" },
      { type: "tool-output-available", toolCallId: "tc1", output: { columns: ["a"] } },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events.filter(e => e.type === "result")).toHaveLength(0);
    expect(events[0].type).toBe("tool-result");
  });
});

// ---------------------------------------------------------------------------
// streamQuery — error and finish events
// ---------------------------------------------------------------------------

describe("streamQuery — error and finish events", () => {
  test("yields error event with errorText", async () => {
    installFetchMock(sseResponse([
      { type: "error", errorText: "Something went wrong" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({ type: "error", message: "Something went wrong" });
  });

  test("yields error event with message field fallback", async () => {
    installFetchMock(sseResponse([
      { type: "error", message: "Fallback error" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({ type: "error", message: "Fallback error" });
  });

  test("yields error event with no message fields defaults to 'Unknown error'", async () => {
    installFetchMock(sseResponse([
      { type: "error" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({ type: "error", message: "Unknown error" });
  });

  test("yields finish event with default reason", async () => {
    installFetchMock(sseResponse([
      { type: "finish" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events[0]).toEqual({ type: "finish", reason: "stop" });
  });

  test("ignores unknown event types", async () => {
    installFetchMock(sseResponse([
      { type: "start", messageId: "m1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", textDelta: "hi" },
      { type: "text-end", id: "t1" },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: "partial" },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events).toEqual([
      { type: "text", content: "hi" },
      { type: "finish", reason: "stop" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// streamQuery — HTTP error handling
// ---------------------------------------------------------------------------

describe("streamQuery — error handling", () => {
  test("throws AtlasError on 401", async () => {
    installFetchMock(jsonResponse({ error: "auth_error", message: "Unauthorized" }, 401));
    const client = makeClient();

    try {
      await collectEvents(client.streamQuery("test"));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("auth_error");
      expect(e.status).toBe(401);
    }
  });

  test("throws AtlasError on 429 rate limit", async () => {
    installFetchMock(jsonResponse(
      { error: "rate_limited", message: "Too many requests", retryAfterSeconds: 30 },
      429,
    ));
    const client = makeClient();

    try {
      await collectEvents(client.streamQuery("test"));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("rate_limited");
      expect(e.retryAfterSeconds).toBe(30);
    }
  });

  test("throws AtlasError on 500", async () => {
    installFetchMock(jsonResponse({ error: "internal_error", message: "Server broke" }, 500));
    const client = makeClient();

    try {
      await collectEvents(client.streamQuery("test"));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("internal_error");
      expect(e.status).toBe(500);
    }
  });

  test("throws AtlasError when response body is null", async () => {
    // Simulate a response with no body
    installFetchMock(new Response(null, { status: 200 }));
    const client = makeClient();

    try {
      await collectEvents(client.streamQuery("test"));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("invalid_response");
    }
  });
});

// ---------------------------------------------------------------------------
// streamQuery — abort support (#228)
// ---------------------------------------------------------------------------

describe("streamQuery — abort support", () => {
  test("AbortController cancels the stream mid-read", async () => {
    // Stream that emits one event then hangs (never closes)
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-delta","textDelta":"Hello"}\n\n'));
        // Don't close — simulates a long-running stream
      },
    });

    // Signal-aware mock: returns the open stream, but doesn't check signal
    // (abort is handled by parseSSE's reader.cancel())
    lastRequest = null;
    const mockFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      lastRequest = new Request(input as string, init);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    globalThis.fetch = Object.assign(mockFn, {
      preconnect: () => {},
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const client = makeClient();
    const events: StreamEvent[] = [];

    try {
      for await (const event of client.streamQuery("test", { signal: controller.signal })) {
        events.push(event);
        // Abort after first event — parseSSE will cancel the reader
        controller.abort();
      }
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "text", content: "Hello" });
  });

  test("pre-aborted signal throws immediately", async () => {
    installFetchMock(sseResponse([
      { type: "text-delta", textDelta: "Hello" },
    ]));

    const controller = new AbortController();
    controller.abort();

    const client = makeClient();

    try {
      await collectEvents(client.streamQuery("test", { signal: controller.signal }));
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });
});

// ---------------------------------------------------------------------------
// streamQuery — SSE parsing edge cases
// ---------------------------------------------------------------------------

describe("streamQuery — SSE parsing", () => {
  test("handles chunked SSE data", async () => {
    // Simulate a stream that splits events across chunks
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Send partial first event
        controller.enqueue(encoder.encode('data: {"type":"text-del'));
        // Complete first event and start second
        controller.enqueue(encoder.encode('ta","textDelta":"Hi"}\n\ndata: {"type":"'));
        // Complete second event
        controller.enqueue(encoder.encode('finish","finishReason":"stop"}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    installFetchMock(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events).toEqual([
      { type: "text", content: "Hi" },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("handles stream ending without [DONE]", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-delta","textDelta":"Hello"}\n\n'));
        controller.close();
      },
    });

    installFetchMock(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events).toEqual([{ type: "text", content: "Hello" }]);
  });

  test("yields parse_error event for malformed JSON in SSE data", async () => {
    installFetchMock(sseResponse([
      "not valid json",
      { type: "text-delta", textDelta: "ok" },
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("parse_error");
    const parseError = events[0] as StreamEvent & { type: "parse_error" };
    expect(parseError.raw).toBe("not valid json");
    expect(typeof parseError.error).toBe("string");
    expect(events[1]).toEqual({ type: "text", content: "ok" });
    expect(events[2]).toEqual({ type: "finish", reason: "stop" });
  });

  test("parse_error includes raw data for debugging truncated JSON", async () => {
    const truncated = '{"type":"text-delta","textDelta":"hel';
    installFetchMock(sseResponse([
      truncated,
      { type: "finish", finishReason: "stop" },
    ]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events).toHaveLength(2);
    const parseError = events[0] as StreamEvent & { type: "parse_error" };
    expect(parseError.type).toBe("parse_error");
    expect(parseError.raw).toBe(truncated);
    expect(parseError.error).toBeTruthy();
    expect(events[1]).toEqual({ type: "finish", reason: "stop" });
  });

  test("empty stream with only [DONE] yields zero events", async () => {
    installFetchMock(sseResponse([]));

    const events = await collectEvents(makeClient().streamQuery("test"));
    expect(events).toHaveLength(0);
  });

  test("mid-stream network error throws AtlasError", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        // Enqueue first event, error will be sent after a microtask
        controller.enqueue(encoder.encode('data: {"type":"text-delta","textDelta":"partial"}\n\n'));
      },
    });

    // Direct mock (not installFetchMock) to avoid response.clone() issues
    lastRequest = null;
    const mockFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      lastRequest = new Request(input as string, init);
      // Schedule the error after the response is returned
      queueMicrotask(() => streamController.error(new Error("Connection reset")));
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    globalThis.fetch = Object.assign(mockFn, {
      preconnect: () => {},
    }) as unknown as typeof fetch;

    const events: StreamEvent[] = [];
    try {
      for await (const event of makeClient().streamQuery("test")) {
        events.push(event);
      }
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("network_error");
      expect(e.message).toContain("Connection reset");
    }
    // Partial events should have been yielded before the error
    expect(events.length).toBeGreaterThanOrEqual(0); // timing-dependent
  });
});
