import { describe, expect, test } from "bun:test";

import { describeOAuthErrorBody } from "../src/_internal/http";

describe("describeOAuthErrorBody", () => {
  test("empty body → empty string", async () => {
    const res = new Response("", { status: 400 });
    const out = await describeOAuthErrorBody(res);
    expect(out).toBe("");
  });

  test("RFC 6749 §5.2 canonical shape → joined error : description : see uri", async () => {
    const res = new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "code expired",
        error_uri: "https://example.com/oauth-errors",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const out = await describeOAuthErrorBody(res);
    expect(out).toBe(
      "invalid_grant: code expired: see https://example.com/oauth-errors",
    );
  });

  test("partial canonical shape (error only) → just error", async () => {
    const res = new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    const out = await describeOAuthErrorBody(res);
    expect(out).toBe("invalid_grant");
  });

  test("JSON without canonical fields → falls back to raw text", async () => {
    const body = JSON.stringify({ unrelated: "shape", count: 7 });
    const res = new Response(body, {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    const out = await describeOAuthErrorBody(res);
    // The raw text branch fires because none of error/error_description/
    // error_uri are populated.
    expect(out).toBe(body);
  });

  test("non-JSON body → raw text", async () => {
    const res = new Response("Service Unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const out = await describeOAuthErrorBody(res);
    expect(out).toBe("Service Unavailable");
  });

  test("text > 1KiB is truncated with ellipsis", async () => {
    const huge = "x".repeat(2000);
    const res = new Response(huge, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
    const out = await describeOAuthErrorBody(res);
    expect(out.length).toBe(1025); // 1024 chars + "…"
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("x")).toBe(true);
  });

  test("res.text() failure surfaces the read error inline (no silent loss)", async () => {
    // Build a Response whose body stream will tear when read.
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error("stream torn mid-read"));
      },
    });
    const res = new Response(stream, { status: 500 });
    const out = await describeOAuthErrorBody(res);
    expect(out).toContain("failed to read response body");
    expect(out).toContain("stream torn mid-read");
  });

  test("body that's literal numeric string (parses as JSON but not the canonical shape)", async () => {
    const res = new Response("42", {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    const out = await describeOAuthErrorBody(res);
    // JSON.parse("42") → 42 (number, not the canonical object). The
    // partial-fields branch returns nothing useful, so we fall through
    // to raw text.
    expect(out).toBe("42");
  });
});
