/**
 * SDK streaming integration tests — exercises streamQuery() against a real
 * mock HTTP server (Bun.serve on a random port).
 *
 * Unlike stream.test.ts (which mocks globalThis.fetch), these tests hit a real
 * HTTP server to validate SSE parsing, event typing, abort, and error handling
 * end-to-end through the full network stack.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createAtlasClient, AtlasError } from "../client";
import type { StreamEvent } from "../client";
import { startMockServer, VALID_API_KEY, type MockServer } from "./mock-server";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: MockServer;
let baseUrl: string;

beforeAll(() => {
  server = startMockServer();
  baseUrl = server.url;
});

afterAll(() => {
  server?.stop();
});

function client() {
  return createAtlasClient({ baseUrl, apiKey: VALID_API_KEY });
}

async function collectEvents(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Full stream consumption
// ---------------------------------------------------------------------------

describe("streamQuery integration — full lifecycle", () => {
  test("yields all event types in order: text, tool-call, tool-result, result, finish", async () => {
    const events = await collectEvents(client().streamQuery("__full_lifecycle__"));

    // Expected sequence:
    // 0: text "Analyzing"
    // 1: text " your data..."
    // 2: tool-call (explore, tc1)
    // 3: tool-result (explore, tc1) — no result event for non-executeSQL
    // 4: tool-call (executeSQL, tc2)
    // 5: tool-result (executeSQL, tc2)
    // 6: result (convenience event from executeSQL output)
    // 7: text "There are 42 users."
    // 8: finish
    expect(events).toHaveLength(9);

    expect(events[0]).toEqual({ type: "text", content: "Analyzing" });
    expect(events[1]).toEqual({ type: "text", content: " your data..." });

    expect(events[2]).toEqual({
      type: "tool-call",
      toolCallId: "tc1",
      name: "explore",
      args: { command: "ls" },
    });

    expect(events[3]).toEqual({
      type: "tool-result",
      toolCallId: "tc1",
      name: "explore",
      result: { content: "entities/" },
    });

    expect(events[4]).toEqual({
      type: "tool-call",
      toolCallId: "tc2",
      name: "executeSQL",
      args: { sql: "SELECT count(*) FROM users" },
    });

    expect(events[5]).toEqual({
      type: "tool-result",
      toolCallId: "tc2",
      name: "executeSQL",
      result: { columns: ["count"], rows: [{ count: 42 }] },
    });

    expect(events[6]).toEqual({
      type: "result",
      columns: ["count"],
      rows: [{ count: 42 }],
    });

    expect(events[7]).toEqual({ type: "text", content: "There are 42 users." });
    expect(events[8]).toEqual({ type: "finish", reason: "stop" });
  });

  test("text events contain correct content strings", async () => {
    const events = await collectEvents(client().streamQuery("__full_lifecycle__"));
    const textEvents = events.filter((e): e is StreamEvent & { type: "text" } => e.type === "text");

    expect(textEvents).toHaveLength(3);
    expect(textEvents.map((e) => e.content)).toEqual([
      "Analyzing",
      " your data...",
      "There are 42 users.",
    ]);
  });

  test("result convenience event has columns and rows from executeSQL", async () => {
    const events = await collectEvents(client().streamQuery("__full_lifecycle__"));
    const resultEvents = events.filter((e) => e.type === "result");

    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toEqual({
      type: "result",
      columns: ["count"],
      rows: [{ count: 42 }],
    });
  });

  test("explore tool-result does not produce a result convenience event", async () => {
    const events = await collectEvents(client().streamQuery("__full_lifecycle__"));
    // After the explore tool-result (index 3), the next event should be
    // a tool-call for executeSQL (index 4), not a result event
    expect(events[4].type).toBe("tool-call");
  });
});

// ---------------------------------------------------------------------------
// Mid-stream abort
// ---------------------------------------------------------------------------

describe("streamQuery integration — mid-stream abort", () => {
  test("AbortController cancels after 2 events, iterator terminates cleanly", async () => {
    const controller = new AbortController();
    const events: StreamEvent[] = [];

    try {
      for await (const event of client().streamQuery("__hanging_stream__", { signal: controller.signal })) {
        events.push(event);
        if (events.length >= 2) {
          controller.abort();
        }
      }
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text", content: "Event one" });
    expect(events[1]).toEqual({ type: "text", content: "Event two" });
  });

  test("pre-aborted signal throws immediately without consuming events", async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await collectEvents(client().streamQuery("__full_lifecycle__", { signal: controller.signal }));
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });
});

// ---------------------------------------------------------------------------
// Client reuse after abort
// ---------------------------------------------------------------------------

describe("streamQuery integration — client reuse after abort", () => {
  test("same client instance streams successfully after a previous abort", async () => {
    const c = client();

    // First stream: abort it
    const controller = new AbortController();
    try {
      for await (const _event of c.streamQuery("__hanging_stream__", { signal: controller.signal })) {
        controller.abort();
      }
    } catch {
      // Expected AbortError — ignore
    }

    // Second stream: should complete successfully on the same client
    const events = await collectEvents(c.streamQuery("__full_lifecycle__"));
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toEqual({ type: "finish", reason: "stop" });
  });
});

// ---------------------------------------------------------------------------
// Network error
// ---------------------------------------------------------------------------

describe("streamQuery integration — network error", () => {
  test("unreachable server throws AtlasError with network_error code", async () => {
    const c = createAtlasClient({ baseUrl: "http://localhost:1", apiKey: VALID_API_KEY });

    try {
      await collectEvents(c.streamQuery("test"));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("network_error");
      expect(e.status).toBe(0);
    }
  });

  test("HTTP 500 on streaming endpoint throws AtlasError", async () => {
    try {
      await collectEvents(client().streamQuery("__trigger_500__"));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("internal_error");
      expect(e.status).toBe(500);
    }
  });

  test("server-side error event is yielded with appropriate message", async () => {
    const events = await collectEvents(client().streamQuery("__error_event__"));

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text", content: "Starting analysis..." });
    expect(events[1]).toEqual({ type: "error", message: "Internal server error: model rate limited" });
    expect(events[2]).toEqual({ type: "finish", reason: "error" });
  });
});
