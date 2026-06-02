/**
 * Behavioral tests for `deliverWebhook`: success, 4xx-permanent vs
 * 5xx/transport-retry, the backoff schedule, per-attempt timeout, and the
 * `onFailedAttempt` observation hook — all via injected `fetcher` / `sleep`
 * seams so the suite never waits on a real timer.
 */

import { describe, it, expect } from "bun:test";

import {
  deliverWebhook,
  cappedExponentialDelays,
  type Fetcher,
  type FailedAttempt,
} from "../deliver";
import { rawBody, timestamped } from "../sign";

const SIGN = rawBody({ secret: "test-secret" });
const URL = "https://hooks.example.com/endpoint";

/** A fetcher that returns a fixed status, recording each call. */
function statusFetcher(status: number, bodyText = "") {
  const calls: RequestInit[] = [];
  const fetcher: Fetcher = async (_url, init) => {
    calls.push(init);
    return new Response(bodyText || null, { status });
  };
  return { fetcher, calls };
}

/** A recording sleep that resolves immediately. */
function recordingSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("deliverWebhook — success", () => {
  it("returns kind=ok and stops after the first 2xx", async () => {
    const { fetcher, calls } = statusFetcher(200);
    const outcome = await deliverWebhook({
      url: URL,
      payload: { a: 1 },
      sign: SIGN,
      retry: { maxAttempts: 3, delaysMs: [10, 20] },
      fetcher,
    });
    expect(outcome).toMatchObject({ kind: "ok", status: 200, attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it("signs the exact serialized body and sends the strategy headers", async () => {
    let seen: { body?: string; headers?: Record<string, string> } = {};
    const fetcher: Fetcher = async (_url, init) => {
      seen = {
        body: init.body as string,
        headers: init.headers as Record<string, string>,
      };
      return new Response(null, { status: 204 });
    };
    const payload = { event: "report", n: 42 };
    const outcome = await deliverWebhook({ url: URL, payload, sign: SIGN, fetcher });
    expect(seen.body).toBe(JSON.stringify(payload));
    expect(seen.headers?.["X-Atlas-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.headers?.["Content-Type"]).toBe("application/json");
    // The surfaced signature equals the header value.
    if (outcome.kind === "ok") {
      expect(seen.headers?.["X-Atlas-Signature"]).toBe(outcome.signature);
    }
  });
});

describe("deliverWebhook — 4xx is permanent", () => {
  it("does not retry on 4xx and captures a body excerpt", async () => {
    const { fetcher, calls } = statusFetcher(422, "validation failed: field x");
    const { waits, sleep } = recordingSleep();
    const outcome = await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 5, delaysMs: [1, 1, 1, 1] },
      fetcher,
      sleep,
    });
    expect(outcome.kind).toBe("http_error");
    if (outcome.kind === "http_error") {
      expect(outcome.status).toBe(422);
      expect(outcome.attempts).toBe(1);
      expect(outcome.error).toBe("http_422");
      expect(outcome.responseText).toBe("validation failed: field x");
    }
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("truncates an oversized error body to 200 chars + ellipsis", async () => {
    const long = "x".repeat(500);
    const { fetcher } = statusFetcher(400, long);
    const outcome = await deliverWebhook({ url: URL, payload: {}, sign: SIGN, fetcher });
    if (outcome.kind === "http_error") {
      expect(outcome.responseText).toBe(`${"x".repeat(200)}…`);
    } else {
      throw new Error(`expected http_error, got ${outcome.kind}`);
    }
  });

  it("still returns a tagged http_error when the body is unreadable", async () => {
    // An already-consumed/closed stream makes res.text() reject. The 4xx must
    // not turn into an unhandled throw — it stays a tagged outcome with no
    // excerpt (the status is the load-bearing signal; the body is a breadcrumb).
    const unreadable = {
      ok: false,
      status: 409,
      text: () => Promise.reject(new Error("body stream already read")),
    } as unknown as Response;
    const fetcher: Fetcher = async () => unreadable;
    const outcome = await deliverWebhook({ url: URL, payload: {}, sign: SIGN, fetcher });
    expect(outcome).toMatchObject({ kind: "http_error", status: 409, attempts: 1 });
    if (outcome.kind === "http_error") {
      expect(outcome.responseText).toBeUndefined();
    }
  });
});

describe("deliverWebhook — signs once, byte-identical across retries", () => {
  // The load-bearing invariant for byte-identical consumer migration: the body
  // is stringified once and signed once OUTSIDE the retry loop, so the
  // timestamp + signature + body are identical on every attempt. A refactor
  // that moved signing into the loop would regenerate the timestamp per attempt
  // and silently change the wire bytes mid-delivery — this test would fail.
  it("sends the same timestamp, signature, and body on every attempt", async () => {
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    let n = 0;
    const fetcher: Fetcher = async (_url, init) => {
      seen.push({
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      });
      n += 1;
      return new Response(null, { status: n < 3 ? 500 : 200 });
    };
    const { sleep } = recordingSleep();
    const outcome = await deliverWebhook({
      url: URL,
      payload: { event: "added", entry: { name: "Vercel" } },
      sign: timestamped({ secret: "shared", timestampSeconds: 1700000000 }),
      retry: { maxAttempts: 3, delaysMs: [1, 1] },
      fetcher,
      sleep,
    });
    expect(outcome).toMatchObject({ kind: "ok", attempts: 3 });
    expect(seen).toHaveLength(3);
    const [first] = seen;
    expect(first.headers["X-Webhook-Timestamp"]).toBe("1700000000");
    for (const attempt of seen) {
      expect(attempt.headers["X-Webhook-Timestamp"]).toBe(first.headers["X-Webhook-Timestamp"]);
      expect(attempt.headers["X-Webhook-Signature"]).toBe(first.headers["X-Webhook-Signature"]);
      expect(attempt.body).toBe(first.body);
    }
  });
});

describe("deliverWebhook — 5xx retries", () => {
  it("retries up to maxAttempts and reports the final status", async () => {
    const { fetcher, calls } = statusFetcher(502);
    const { waits, sleep } = recordingSleep();
    const outcome = await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 3, delaysMs: [10, 20] },
      fetcher,
      sleep,
    });
    expect(outcome.kind).toBe("http_error");
    if (outcome.kind === "http_error") {
      expect(outcome.status).toBe(502);
      expect(outcome.attempts).toBe(3);
      expect(outcome.error).toBe("http_502");
      // 5xx exhaustion does not read the body — no excerpt.
      expect(outcome.responseText).toBeUndefined();
    }
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([10, 20]);
  });

  it("does not read the body on 5xx exhaustion, even when one is present", async () => {
    // A non-empty 5xx body must still yield responseText: undefined — proving
    // readExcerpt is skipped for transient failures (only 4xx reads it).
    const { fetcher } = statusFetcher(500, "upstream stack trace");
    const { sleep } = recordingSleep();
    const outcome = await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 2, delaysMs: [1] },
      fetcher,
      sleep,
    });
    if (outcome.kind === "http_error") {
      expect(outcome.responseText).toBeUndefined();
    } else {
      throw new Error(`expected http_error, got ${outcome.kind}`);
    }
  });

  it("stops early if a retry succeeds", async () => {
    let n = 0;
    const fetcher: Fetcher = async () => {
      n += 1;
      return new Response(null, { status: n < 3 ? 500 : 200 });
    };
    const { sleep } = recordingSleep();
    const outcome = await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 5, delaysMs: [1, 1, 1, 1] },
      fetcher,
      sleep,
    });
    expect(outcome).toMatchObject({ kind: "ok", status: 200, attempts: 3 });
  });
});

describe("deliverWebhook — transport errors retry", () => {
  it("retries a throwing fetcher and returns transport_error after exhaustion", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    };
    const { waits, sleep } = recordingSleep();
    const outcome = await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 3, delaysMs: [5, 5] },
      fetcher,
      sleep,
    });
    expect(outcome.kind).toBe("transport_error");
    if (outcome.kind === "transport_error") {
      expect(outcome.attempts).toBe(3);
      expect(outcome.error).toBe("ECONNRESET");
    }
    expect(calls).toBe(3);
    expect(waits).toEqual([5, 5]);
  });

  it("aborts an attempt that exceeds timeoutMs (→ transport_error)", async () => {
    // Fetcher hangs until the AbortController fires, then rejects like fetch.
    const fetcher: Fetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    const outcome = await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      timeoutMs: 5,
      retry: { maxAttempts: 1, delaysMs: [] },
      fetcher,
    });
    expect(outcome.kind).toBe("transport_error");
    if (outcome.kind === "transport_error") {
      expect(outcome.attempts).toBe(1);
    }
  });
});

describe("deliverWebhook — backoff schedule", () => {
  it("repeats the last delay when the schedule is shorter than the gaps", async () => {
    const { fetcher } = statusFetcher(500);
    const { waits, sleep } = recordingSleep();
    await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 4, delaysMs: [5] },
      fetcher,
      sleep,
    });
    expect(waits).toEqual([5, 5, 5]);
  });

  it("uses 0ms when the schedule is empty", async () => {
    const { fetcher } = statusFetcher(500);
    const { waits, sleep } = recordingSleep();
    await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 3, delaysMs: [] },
      fetcher,
      sleep,
    });
    expect(waits).toEqual([0, 0]);
  });

  it("clamps maxAttempts below 1 to a single attempt", async () => {
    const { fetcher, calls } = statusFetcher(500);
    const { waits, sleep } = recordingSleep();
    const outcome = await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 0, delaysMs: [] },
      fetcher,
      sleep,
    });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
    if (outcome.kind === "http_error") expect(outcome.attempts).toBe(1);
  });
});

describe("deliverWebhook — onFailedAttempt", () => {
  it("reports each failed attempt with the correct willRetry flag", async () => {
    const { fetcher } = statusFetcher(503);
    const { sleep } = recordingSleep();
    const seen: FailedAttempt[] = [];
    await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 3, delaysMs: [1, 1] },
      fetcher,
      sleep,
      onFailedAttempt: (a) => seen.push(a),
    });
    expect(seen.map((a) => a.willRetry)).toEqual([true, true, false]);
    expect(seen.every((a) => a.failure.kind === "http_error")).toBe(true);
  });

  it("marks a 4xx failure as willRetry=false even with attempts remaining", async () => {
    const { fetcher } = statusFetcher(404);
    const seen: FailedAttempt[] = [];
    await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 3, delaysMs: [1, 1] },
      fetcher,
      onFailedAttempt: (a) => seen.push(a),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].willRetry).toBe(false);
  });

  it("reports the full FailedAttempt shape for an http failure", async () => {
    const { fetcher } = statusFetcher(503);
    const { sleep } = recordingSleep();
    const seen: FailedAttempt[] = [];
    await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 2, delaysMs: [1] },
      fetcher,
      sleep,
      onFailedAttempt: (a) => seen.push(a),
    });
    expect(seen).toEqual([
      { attempt: 1, maxAttempts: 2, willRetry: true, failure: { kind: "http_error", status: 503 } },
      { attempt: 2, maxAttempts: 2, willRetry: false, failure: { kind: "http_error", status: 503 } },
    ]);
  });

  it("reports the full FailedAttempt shape for a transport failure", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("boom");
    };
    const { sleep } = recordingSleep();
    const seen: FailedAttempt[] = [];
    await deliverWebhook({
      url: URL,
      payload: {},
      sign: SIGN,
      retry: { maxAttempts: 2, delaysMs: [1] },
      fetcher,
      sleep,
      onFailedAttempt: (a) => seen.push(a),
    });
    expect(seen).toEqual([
      { attempt: 1, maxAttempts: 2, willRetry: true, failure: { kind: "transport_error", error: "boom" } },
      { attempt: 2, maxAttempts: 2, willRetry: false, failure: { kind: "transport_error", error: "boom" } },
    ]);
  });
});

describe("cappedExponentialDelays", () => {
  it("doubles from the base by default", () => {
    expect(cappedExponentialDelays({ baseMs: 1000, count: 3 })).toEqual([1000, 2000, 4000]);
  });

  it("honors a custom factor", () => {
    expect(cappedExponentialDelays({ baseMs: 100, count: 3, factor: 3 })).toEqual([100, 300, 900]);
  });

  it("clamps each delay to maxMs", () => {
    expect(cappedExponentialDelays({ baseMs: 1000, count: 4, maxMs: 3000 })).toEqual([
      1000, 2000, 3000, 3000,
    ]);
  });

  it("returns an empty schedule for count 0", () => {
    expect(cappedExponentialDelays({ baseMs: 1000, count: 0 })).toEqual([]);
  });
});
