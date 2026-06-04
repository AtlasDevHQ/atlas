/**
 * #3202 — the demo route must classify provider errors raised WHILE the stream is
 * consumed (the `createUIMessageStream` `onError` path), not only the synchronous
 * catch. `runAgent()` returns the streamText result before the stream is read, so
 * an ECONNREFUSED/ENOTFOUND raised mid-generation never reaches the catch — it
 * lands in `onError`, which used to return a generic string (a 200 with no
 * structured error frame). These tests pin the shared classifier + the mid-stream
 * frame builder so a provider outage carries the same `code` / `retryable` /
 * `requestId` contract whether it surfaces before or after the first byte.
 */

import { describe, it, expect } from "bun:test";

// demo.ts reads env at module load (it imports the agent loop). Set a datasource
// so the import graph resolves without warnings.
process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

import { classifyDemoError, buildDemoMidStreamErrorFrame } from "@atlas/api/api/routes/demo";

const REQUEST_ID = "req-12345678-aaaa-bbbb";

describe("classifyDemoError (#3202)", () => {
  it("labels a mid-stream connection failure (ECONNREFUSED) as provider_unreachable", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const cls = classifyDemoError(err, REQUEST_ID);
    expect(cls.code).toBe("provider_unreachable");
  });

  it("labels a DNS failure (ENOTFOUND) as provider_unreachable", () => {
    const err = new Error("getaddrinfo ENOTFOUND api.anthropic.com");
    expect(classifyDemoError(err, REQUEST_ID).code).toBe("provider_unreachable");
  });

  it("falls back to internal_error (with a quotable ref) for an unrelated error", () => {
    const cls = classifyDemoError(new Error("something odd"), REQUEST_ID);
    expect(cls.code).toBe("internal_error");
    expect(cls.message).toContain(REQUEST_ID.slice(0, 8));
  });

  it("unwraps a connection failure buried on the error's cause (#3206)", () => {
    // The AI SDK wraps a transport failure in an outer error whose top-level
    // message has no ECONNREFUSED — the detail lives on `.cause`.
    const err = new Error("Cannot connect to API", {
      cause: new Error("connect ECONNREFUSED 10.0.0.5:443"),
    });
    expect(classifyDemoError(err, REQUEST_ID).code).toBe("provider_unreachable");
  });

  it("maps a 'fetch failed' transport error to provider_unreachable (#3206)", () => {
    expect(classifyDemoError(new Error("fetch failed"), REQUEST_ID).code).toBe("provider_unreachable");
  });
});

describe("buildDemoMidStreamErrorFrame (#3202)", () => {
  it("emits a structured frame (code + message + retryable + requestId) for a mid-stream outage", () => {
    const err = new Error("connect ECONNREFUSED 10.0.0.5:443");
    const frame = buildDemoMidStreamErrorFrame(err, REQUEST_ID);
    const parsed = JSON.parse(frame) as {
      error: string;
      message: string;
      retryable: boolean;
      requestId: string;
    };
    expect(parsed.error).toBe("provider_unreachable");
    expect(typeof parsed.message).toBe("string");
    expect(parsed.message.length).toBeGreaterThan(0);
    // provider_unreachable is transient — the client should be told it can retry.
    expect(parsed.retryable).toBe(true);
    expect(parsed.requestId).toBe(REQUEST_ID);
  });

  it("is no longer a generic, unstructured string", () => {
    const frame = buildDemoMidStreamErrorFrame(new Error("connect ECONNREFUSED 1.2.3.4:443"), REQUEST_ID);
    // Must be valid JSON (the structured frame), not the old prose sentence.
    expect(() => JSON.parse(frame)).not.toThrow();
    expect(frame).not.toContain("Try sending your message again");
  });
});
