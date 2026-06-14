/**
 * Characterization tests for the extracted `McpSessionStore` (#3600).
 *
 * The end-to-end session lifecycle (cap, idle sweep, stream-age reclaim) is
 * already exercised through both transports in `hosted.test.ts` and
 * `sse.test.ts` — those stay green and are the behavior-unchanged proof. This
 * file pins the SHARED unit directly where the per-transport suites are thin:
 *
 *   - `dispatchExisting` composes with the caller's `wrap` (hosted threads
 *     `withLiveActor` through it; sse passes none) and fires the GET/POST
 *     stream-liveness hooks against the entry.
 *   - the GET-stream `activeStreams` / `streamOpenedAt` invariant is updated
 *     on open and cleared on close — the one tested unit the issue calls for.
 *
 * These assert the invariant lives in `session-store.ts` and not in either
 * transport (the deletion test): deleting `dispatchExisting` here breaks both.
 */

import { describe, it, expect } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpSessionStore, type SessionEntry } from "../session-store.js";

const enc = new TextEncoder();

/**
 * A minimal `SessionEntry` whose `transport.handleRequest` returns a caller-
 * supplied Response. Only the fields the store reads are populated; the casts
 * are narrow (a stub transport/server) and confined to this fixture.
 */
function fakeEntry(handleRequest: (req: Request) => Promise<Response>): {
  entry: SessionEntry;
  closes: { transport: number; server: number };
} {
  const closes = { transport: 0, server: 0 };
  const transport = {
    sessionId: "sess-1",
    handleRequest,
    close: async () => {
      closes.transport++;
    },
  } as unknown as WebStandardStreamableHTTPServerTransport;
  const server = {
    close: async () => {
      closes.server++;
    },
  } as unknown as McpServer;
  const entry: SessionEntry = {
    transport,
    server,
    lastSeenAt: 0,
    activeStreams: 0,
    streamOpenedAt: undefined,
  };
  return { entry, closes };
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("McpSessionStore.dispatchExisting", () => {
  it("refreshes lastSeenAt pre-dispatch and runs the caller's wrap", async () => {
    const store = new McpSessionStore(() => 100);
    const { entry } = fakeEntry(async () => new Response("ok"));
    entry.lastSeenAt = 1; // stale

    let wrapped = false;
    const before = Date.now();
    const res = await store.dispatchExisting(
      new Request("http://x/mcp", { method: "DELETE" }),
      entry,
      (run) => {
        wrapped = true;
        return run();
      },
    );

    expect(wrapped).toBe(true);
    expect(await res.text()).toBe("ok");
    // lastSeenAt was refreshed PRE-dispatch (a stale value would race the sweep).
    expect(entry.lastSeenAt).toBeGreaterThanOrEqual(before);
  });

  it("tracks GET notification-stream liveness: activeStreams up on open, cleared on close", async () => {
    const store = new McpSessionStore(() => 100);
    // A GET response that stays open until the consumer reads it to completion.
    const { entry } = fakeEntry(async () =>
      sseResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode("data: hi\n\n"));
            controller.close();
          },
        }),
      ),
    );

    const res = await store.dispatchExisting(
      new Request("http://x/mcp", { method: "GET" }),
      entry,
    );

    // onOpen fired synchronously while the stream is live.
    expect(entry.activeStreams).toBe(1);
    expect(entry.streamOpenedAt).toBeGreaterThan(0);

    // Drain the stream → onClose releases the liveness mark.
    await new Response(res.body).text();
    expect(entry.activeStreams).toBe(0);
    expect(entry.streamOpenedAt).toBeUndefined();
  });

  it("keeps lastSeenAt current per-chunk for POST event-streams (#3576)", async () => {
    const store = new McpSessionStore(() => 100);
    const { entry } = fakeEntry(async () =>
      sseResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode("data: chunk\n\n"));
            controller.close();
          },
        }),
      ),
    );
    entry.lastSeenAt = 1;

    const res = await store.dispatchExisting(
      new Request("http://x/mcp", { method: "POST" }),
      entry,
    );
    const before = Date.now();
    await new Response(res.body).text();
    // onActivity (per-chunk) + onClose both bump lastSeenAt to "now".
    expect(entry.lastSeenAt).toBeGreaterThanOrEqual(before);
  });
});

describe("McpSessionStore cap resolution", () => {
  it("503s a new session when the cap resolver reports full (no slot freed by sweep)", async () => {
    // cap = 0 → the cap-pressure branch trips immediately, the sweep frees
    // nothing (empty store), and the new session is refused with the verbatim
    // 503 copy supplied by the spec.
    const store = new McpSessionStore(() => 0);
    const res = await store.dispatchNew(new Request("http://x/mcp", { method: "POST" }), {
      createServer: async () => {
        throw new Error("createServer must not run when the cap is full");
      },
      tooManyMessage: "Too many active MCP sessions. Try again later.",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("too_many_sessions");
    expect(body.message).toBe("Too many active MCP sessions. Try again later.");
  });
});
