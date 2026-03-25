/**
 * Unit tests for the delivery dispatcher (Effect.ts migration).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";

// Mock formatters
mock.module("../format-email", () => ({
  formatEmailReport: mock(() => ({ subject: "Subject", body: "<html>body</html>" })),
}));
mock.module("../format-slack", () => ({
  formatSlackReport: mock(() => ({ text: "Report", blocks: [] })),
}));
mock.module("../format-webhook", () => ({
  formatWebhookPayload: mock(() => ({ taskId: "t", answer: "A" })),
}));

// Mock fetch for delivery
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response("ok", { status: 200 })));

const { deliverResult } = await import("../delivery");

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-123",
    ownerId: "u1",
    name: "Test Report",
    question: "Q?",
    cronExpression: "0 9 * * 1",
    deliveryChannel: "webhook",
    recipients: [],
    connectionId: null,
    approvalMode: "auto",
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeResult(): AgentQueryResult {
  return {
    answer: "Revenue was $1M",
    sql: ["SELECT SUM(revenue) FROM orders"],
    data: [{ columns: ["total"], rows: [{ total: 1000000 }] }],
    steps: 3,
    usage: { totalTokens: 1500 },
  };
}

describe("delivery dispatcher", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns zero summary when no recipients", async () => {
    const task = makeTask({ recipients: [] });
    const summary = await deliverResult(task, makeResult());
    expect(summary).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("delivers webhook and returns success summary", async () => {
    const task = makeTask({
      deliveryChannel: "webhook",
      recipients: [{ type: "webhook", url: "https://hook.example.com" }],
    });
    const summary = await deliverResult(task, makeResult());
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
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
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
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
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
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
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
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
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
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
    expect(summary).toEqual({ attempted: 3, succeeded: 3, failed: 0 });
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
  });
});
