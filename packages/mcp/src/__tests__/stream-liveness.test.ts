import { describe, it, expect } from "bun:test";
import { trackResponseStreamLifetime } from "../stream-liveness.js";

const enc = new TextEncoder();

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("trackResponseStreamLifetime", () => {
  it("fires onOpen immediately and onClose exactly once when the source ends", async () => {
    let opens = 0;
    let closes = 0;
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("data: hi\n\n"));
        controller.close();
      },
    });

    const tracked = trackResponseStreamLifetime(sseResponse(src), {
      onOpen: () => opens++,
      onClose: () => closes++,
    });

    // onOpen is synchronous; onClose waits for the stream to drain.
    expect(opens).toBe(1);
    expect(closes).toBe(0);

    const text = await new Response(tracked.body).text();
    expect(text).toContain("data: hi");
    expect(closes).toBe(1);
  });

  it("fires onClose when the consumer cancels mid-stream", async () => {
    let closes = 0;
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit one chunk and stay open — mimics an idle notification stream.
        controller.enqueue(enc.encode("data: hi\n\n"));
      },
    });

    const tracked = trackResponseStreamLifetime(sseResponse(src), {
      onOpen: () => {},
      onClose: () => closes++,
    });

    const reader = tracked.body!.getReader();
    await reader.read(); // pull the first chunk
    expect(closes).toBe(0);
    await reader.cancel();
    expect(closes).toBe(1);
  });

  it("passes a byte-for-byte copy of the source through", async () => {
    const payload = "event: message\ndata: {\"x\":1}\n\nevent: ping\ndata: {}\n\n";
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split across chunks to exercise the pull loop.
        controller.enqueue(enc.encode(payload.slice(0, 10)));
        controller.enqueue(enc.encode(payload.slice(10)));
        controller.close();
      },
    });

    const tracked = trackResponseStreamLifetime(sseResponse(src), {
      onOpen: () => {},
      onClose: () => {},
    });

    expect(await new Response(tracked.body).text()).toBe(payload);
  });

  it("returns non-SSE responses untouched without firing onOpen", () => {
    let opens = 0;
    const res = new Response("ok", {
      headers: { "content-type": "application/json" },
    });
    const out = trackResponseStreamLifetime(res, {
      onOpen: () => opens++,
      onClose: () => {},
    });
    expect(out).toBe(res);
    expect(opens).toBe(0);
  });

  it("returns body-less responses untouched", () => {
    let opens = 0;
    const res = new Response(null, {
      status: 204,
      headers: { "content-type": "text/event-stream" },
    });
    const out = trackResponseStreamLifetime(res, {
      onOpen: () => opens++,
      onClose: () => {},
    });
    expect(out).toBe(res);
    expect(opens).toBe(0);
  });
});
