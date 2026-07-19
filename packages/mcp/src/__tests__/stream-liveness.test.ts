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

  it("fires onError then onClose and propagates when the source errors mid-stream", async () => {
    let closes = 0;
    let onErrorArg: unknown = null;
    const boom = new Error("source exploded");
    const src = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Error on the first pull so the wrapper's catch branch runs.
        controller.error(boom);
      },
    });

    const tracked = trackResponseStreamLifetime(sseResponse(src), {
      onOpen: () => {},
      onClose: () => closes++,
      onError: (err) => {
        onErrorArg = err;
      },
    });

    const reader = tracked.body!.getReader();
    // The error must propagate to the consumer (not be swallowed)...
    await expect(reader.read()).rejects.toThrow("source exploded");
    // ...and the caller must be notified for server-side logging, exactly once,
    // with the original error, alongside the single onClose.
    expect(onErrorArg).toBe(boom);
    expect(closes).toBe(1);
  });

  it("normalizes a non-Error rejection before propagating", async () => {
    const errors: unknown[] = [];
    const src = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error("plain string failure");
      },
    });

    const tracked = trackResponseStreamLifetime(sseResponse(src), {
      onOpen: () => {},
      onClose: () => {},
      onError: (err) => errors.push(err),
    });

    const reader = tracked.body!.getReader();
    await expect(reader.read()).rejects.toThrow("plain string failure");
    // onError sees the raw value; the propagated error is wrapped in an Error.
    expect(errors).toEqual(["plain string failure"]);
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

  // ── #3576 — POST event-stream liveness via onActivity ────────────────
  //
  // For long-running POST event-streams (streaming tool calls), `onActivity`
  // fires on each successfully enqueued chunk so `lastSeenAt` can be kept
  // current. Without this, a 2-hour streaming query would see its session's
  // `lastSeenAt` age out to dispatch-time and the idle sweep could evict it.

  it("fires onActivity on every enqueued chunk (POST liveness, #3576)", async () => {
    let activityCount = 0;
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("data: a\n\n"));
        controller.enqueue(enc.encode("data: b\n\n"));
        controller.enqueue(enc.encode("data: c\n\n"));
        controller.close();
      },
    });

    const tracked = trackResponseStreamLifetime(sseResponse(src), {
      onOpen: () => {},
      onClose: () => {},
      onActivity: () => { activityCount++; },
    });

    await new Response(tracked.body).text();
    // One fire per enqueued chunk (3 chunks); NOT fired on the close frame.
    expect(activityCount).toBe(3);
  });

  it("does not fire onActivity on error (only on successful enqueues)", async () => {
    let activityCount = 0;
    const src = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("boom"));
      },
    });

    const tracked = trackResponseStreamLifetime(sseResponse(src), {
      onOpen: () => {},
      onClose: () => {},
      onActivity: () => { activityCount++; },
    });

    const reader = tracked.body!.getReader();
    await expect(reader.read()).rejects.toThrow("boom");
    expect(activityCount).toBe(0); // no chunks were enqueued before the error
  });

  // ── #4734 — transport-agnostic SSE keepalive on the POST tool-call stream ──

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("injects SSE keepalive frames while the source idles, without dropping or reordering data (#4734)", async () => {
    const enc = new TextEncoder();
    // Source emits two data frames, each after a ~40ms idle gap, then closes.
    // With keepaliveMs=10 the wrapper should fill each gap with comment frames.
    let step = 0;
    const src = new ReadableStream<Uint8Array>({
      async pull(controller) {
        step++;
        if (step === 1) {
          await delay(40);
          controller.enqueue(enc.encode("data: one\n\n"));
          return;
        }
        if (step === 2) {
          await delay(40);
          controller.enqueue(enc.encode("data: two\n\n"));
          return;
        }
        controller.close();
      },
    });

    let activity = 0;
    const tracked = trackResponseStreamLifetime(
      sseResponse(src),
      { onOpen: () => {}, onClose: () => {}, onActivity: () => { activity++; } },
      { keepaliveMs: 10 },
    );

    const text = await new Response(tracked.body).text();

    // Both data frames survive intact and in order — the keepalive race never
    // abandons the pending read.
    expect(text).toContain("data: one\n\n");
    expect(text).toContain("data: two\n\n");
    expect(text.indexOf("data: one")).toBeLessThan(text.indexOf("data: two"));
    // At least one keepalive comment frame was injected during an idle gap.
    expect(text).toContain(": keepalive\n\n");
    // A keepalive counts as activity (keeps the idle sweep from evicting a
    // mid-run session), so onActivity fired more than the two data chunks.
    expect(activity).toBeGreaterThan(2);
  });

  it("injects NO keepalive frames when keepaliveMs is omitted (GET-stream behavior unchanged)", async () => {
    const enc = new TextEncoder();
    const src = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await delay(30);
        controller.enqueue(enc.encode("data: only\n\n"));
        controller.close();
      },
    });
    const tracked = trackResponseStreamLifetime(sseResponse(src), {
      onOpen: () => {},
      onClose: () => {},
    });
    const text = await new Response(tracked.body).text();
    expect(text).toBe("data: only\n\n");
    expect(text).not.toContain(": keepalive");
  });
});
