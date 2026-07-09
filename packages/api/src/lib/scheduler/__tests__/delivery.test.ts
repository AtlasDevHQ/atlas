/**
 * Unit tests for the delivery dispatcher (Effect.ts migration).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import { makeTask as makeFixtureTask, makeResult } from "./fixtures";

// Mock formatters
void mock.module("../format-email", () => ({
  formatEmailReport: mock(() => ({ subject: "Subject", body: "<html>body</html>" })),
}));
void mock.module("../format-slack", () => ({
  formatSlackReport: mock(() => ({ text: "Report", blocks: [] })),
}));
void mock.module("../format-webhook", () => ({
  formatWebhookPayload: mock(() => ({ taskId: "t", answer: "A" })),
}));

// Capture span calls to verify the atlas.scheduler.delivery wiring (#1979).
// withEffectSpan composes natively into Effect chains so the stub mirrors
// that — Effect.tap preserves the wrapped Effect's interrupt + retry
// semantics that the production retry policy depends on.
const deliverySpanCalls: { name: string; attributes: Record<string, unknown> }[] = [];
const { Effect: EffectModule } = await import("effect");
void mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (
    _name: string,
    _attrs: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ) => fn(),
  withEffectSpan: (
    name: string,
    attributes: Record<string, unknown>,
    effect: unknown,
  ): unknown =>
    // Push at *run* time, not construction time — retries re-run the
    // Effect, so we want one push per attempt to mirror the real
    // Effect.acquireUseRelease span-per-execution behavior.
    EffectModule.zipRight(
      EffectModule.sync(() => {
        deliverySpanCalls.push({ name, attributes });
      }),
      effect as never,
    ),
}));

// Mock fetch for delivery
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response("ok", { status: 200 })));

const { deliverResult } = await import("../delivery");

// This file's historical defaults differ from the shared fixture (webhook
// channel, terse name/question) — preserved via overrides so the dispatcher
// assertions below stay byte-identical.
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return makeFixtureTask({ name: "Test Report", question: "Q?", deliveryChannel: "webhook", ...overrides });
}

describe("delivery dispatcher", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    deliverySpanCalls.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns zero summary when no recipients", async () => {
    const task = makeTask({ recipients: [] });
    const summary = await deliverResult(task, makeResult());
    expect(summary).toEqual({ attempted: 0, succeeded: 0, failed: 0, permanentFailures: 0, firstPermanentError: null });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("delivers webhook and returns success summary", async () => {
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://hook.example.com" }],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0, permanentFailures: 0, firstPermanentError: null });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(callArgs[0]).toBe("https://hook.example.com");
  });

  it("delivers email via Resend when API key is set", async () => {
    const origKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "re_test_123";

    const task = makeTask({
      deliveryChannel: "email",
      recipients: [{ type: "email", address: "test@example.com" }],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary.succeeded).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(callArgs[0]).toBe("https://api.resend.com/emails");

    if (origKey) process.env.RESEND_API_KEY = origKey;
    else delete process.env.RESEND_API_KEY;
  });

  it("reports failure when no RESEND_API_KEY", async () => {
    const origKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    const task = makeTask({
      deliveryChannel: "email",
      recipients: [{ type: "email", address: "test@example.com" }],
    });
    const summary = await deliverResult(task, makeResult());
    // #3379 — the log-provider fallback is a PERMANENT failure (no sender
    // configured); the summary must say so and carry the actionable message.
    expect(summary).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      permanentFailures: 1,
      firstPermanentError: expect.stringContaining("No email delivery backend configured") as unknown as string,
    });
    expect(mockFetch).not.toHaveBeenCalled();

    if (origKey) process.env.RESEND_API_KEY = origKey;
  });

  it("reports failure on webhook delivery error (retries exhausted)", async () => {
    // Persistent failure — all retry attempts see 500
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response("error", { status: 500 }));

    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://hook.example.com" }],
    });
    const summary = await deliverResult(task, makeResult());
    // Transient (5xx) — failed, but NOT permanent (#3379).
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1, permanentFailures: 0, firstPermanentError: null });
    // Should have retried (original + up to 3 retries)
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("reports failure on fetch network error (retries exhausted)", async () => {
    // Persistent network error — all retry attempts fail
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error("network error"));

    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://hook.example.com" }],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1, permanentFailures: 0, firstPermanentError: null });
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("includes safe custom headers for webhook recipients", async () => {
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://hook.example.com", headers: { "X-Key": "abc" } }],
    });
    await deliverResult(task, makeResult());
    const callArgs = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers["X-Key"]).toBe("abc");
  });

  it("blocks sensitive headers in webhook recipients", async () => {
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://hook.example.com", headers: { "Authorization": "Bearer secret", "X-Safe": "ok" } }],
    });
    await deliverResult(task, makeResult());
    const callArgs = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers["X-Safe"]).toBe("ok");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("blocks webhook URLs targeting private/internal addresses", async () => {
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "http://169.254.169.254/latest/meta-data/" }],
    });
    const summary = await deliverResult(task, makeResult());
    // Blocked URL — permanent failure, surfaced as such (#3379).
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1, permanentFailures: 1, firstPermanentError: "Blocked URL" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks webhook URLs targeting localhost", async () => {
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "http://localhost:3001/api/health" }],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary.failed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks webhook URLs targeting private 10.x.x.x range", async () => {
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "http://10.0.0.1/internal" }],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary.failed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks webhook URLs that pass the old regex but hit the canonical guard (CGNAT)", async () => {
    // 100.64.0.0/10 (CGNAT) was not in the old BLOCKED_HOST_PATTERNS regex —
    // the canonical isSafeExternalUrl blocks it (#3340).
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://100.64.1.1/hook" }],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary.failed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks a public webhook that 302-redirects to an internal address (#3340)", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );

    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://hook.example.com" }],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary.failed).toBe(1);
    expect(summary.permanentFailures).toBe(1);
    expect(summary.firstPermanentError).toContain("Blocked URL (egress guard)");
    // The first request goes out; the redirect target must never be fetched.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrls = mockFetch.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(calledUrls).not.toContain("http://169.254.169.254/latest/meta-data/");
  });

  it("delivers to multiple webhook recipients concurrently", async () => {
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [
        { type: "webhook", url: "https://hook1.example.com" },
        { type: "webhook", url: "https://hook2.example.com" },
        { type: "webhook", url: "https://hook3.example.com" },
      ],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary).toEqual({ attempted: 3, succeeded: 3, failed: 0, permanentFailures: 0, firstPermanentError: null });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles mixed success/failure (blocked URL + valid URL)", async () => {
    // Mix a blocked URL (permanent failure, no retry) with valid URLs
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [
        { type: "webhook", url: "https://hook1.example.com" },
        { type: "webhook", url: "http://localhost:3001/internal" },
        { type: "webhook", url: "https://hook2.example.com" },
      ],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    // The single failure is the blocked URL — a permanent one (#3379).
    expect(summary.permanentFailures).toBe(1);
    expect(summary.firstPermanentError).toBe("Blocked URL");
  });

  it("counts only the permanent failures when failures are mixed (#3379)", async () => {
    // One blocked URL (permanent, no retry) + one persistent 500 (transient,
    // retries exhausted). permanentFailures must count ONLY the former, and
    // firstPermanentError must carry its message — the executor uses
    // permanentFailures === failed to decide "failed_permanent", so a mixed
    // run stays plain "failed".
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response("err", { status: 500 }));

    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [
        { type: "webhook", url: "http://localhost:3001/internal" },
        { type: "webhook", url: "https://hook.example.com" },
      ],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary.failed).toBe(2);
    expect(summary.permanentFailures).toBe(1);
    expect(summary.firstPermanentError).toBe("Blocked URL");
  }, 30_000);

  describe("OTel span coverage (#1979)", () => {
    it("emits atlas.scheduler.delivery once per recipient on the success path", async () => {
      const task = makeTask({
        deliveryChannel: "webhook",
        recipients: [
          { type: "webhook", url: "https://hook1.example.com" },
          { type: "webhook", url: "https://hook2.example.com" },
        ],
      });
      await deliverResult(task, makeResult());

      const spans = deliverySpanCalls.filter(
        (s) => s.name === "atlas.scheduler.delivery",
      );
      expect(spans.length).toBe(2);
      for (const span of spans) {
        expect(span.attributes["atlas.task_id"]).toBe(task.id);
        expect(span.attributes["atlas.channel"]).toBe("webhook");
      }
    });

    it("emits a fresh span per attempt when Effect.retry re-runs the delivery", async () => {
      // The production retry policy is exponential-backoff for non-permanent
      // failures. A 500 retries up to 3 times. Each attempt re-executes the
      // span-wrapped Effect — operators see one span per network attempt,
      // not just one for the whole logical delivery.
      mockFetch.mockResolvedValue(new Response("err", { status: 500 }));
      const task = makeTask({
        deliveryChannel: "webhook",
        recipients: [{ type: "webhook", url: "https://hook.example.com" }],
      });
      await deliverResult(task, makeResult());

      const spans = deliverySpanCalls.filter(
        (s) => s.name === "atlas.scheduler.delivery",
      );
      // 1 initial attempt + 3 retries = 4 spans for one logical delivery.
      expect(spans.length).toBeGreaterThanOrEqual(2);
      expect(spans.every((s) => s.attributes["atlas.channel"] === "webhook")).toBe(true);
    }, 30_000);

    it("emits no delivery spans when there are no recipients", async () => {
      const task = makeTask({ recipients: [] });
      await deliverResult(task, makeResult());
      expect(
        deliverySpanCalls.filter((s) => s.name === "atlas.scheduler.delivery"),
      ).toHaveLength(0);
    });
  });
});
