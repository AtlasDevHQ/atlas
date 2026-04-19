import { describe, expect, test } from "bun:test";
import { extractFetchError, friendlyError } from "../lib/fetch-error";

function mockResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  const init: ResponseInit = { status, headers };
  if (body === undefined) {
    return new Response(null, init);
  }
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("extractFetchError", () => {
  test("extracts message and requestId from JSON body", async () => {
    const res = mockResponse(500, { message: "Something broke", requestId: "req-123" });
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "Something broke", status: 500, requestId: "req-123" });
  });

  test("extracts message without requestId", async () => {
    const res = mockResponse(400, { message: "Bad input" });
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "Bad input", status: 400 });
  });

  test("falls back to HTTP status when body has no message field but captures error code", async () => {
    const res = mockResponse(403, { error: "forbidden" });
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "HTTP 403", status: 403, code: "forbidden" });
  });

  test("captures enterprise_required code alongside message", async () => {
    const res = mockResponse(403, {
      error: "enterprise_required",
      message: "SCIM requires an enterprise license.",
    });
    const err = await extractFetchError(res);
    expect(err).toEqual({
      message: "SCIM requires an enterprise license.",
      status: 403,
      code: "enterprise_required",
    });
  });

  test("ignores non-string error field", async () => {
    const res = mockResponse(500, { message: "x", error: 42 });
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "x", status: 500 });
  });

  test("falls back to HTTP status for non-JSON body", async () => {
    const res = new Response("Not Found", { status: 404 });
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "HTTP 404", status: 404 });
  });

  test("falls back to HTTP status for empty body", async () => {
    const res = new Response(null, { status: 502 });
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "HTTP 502", status: 502 });
  });

  test("handles JSON array body (not object)", async () => {
    const res = mockResponse(500, [1, 2, 3]);
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "HTTP 500", status: 500 });
  });

  test("ignores non-string message fields", async () => {
    const res = mockResponse(500, { message: 42, requestId: true });
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "HTTP 500", status: 500 });
  });

  test("extracts requestId even without message", async () => {
    const res = mockResponse(500, { requestId: "req-456" });
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "HTTP 500", status: 500, requestId: "req-456" });
  });
});

describe("friendlyError", () => {
  test("maps 401 to sign-in message", () => {
    expect(friendlyError({ message: "Unauthorized", status: 401 })).toBe(
      "Not authenticated. Please sign in.",
    );
  });

  test("maps 403 to access denied", () => {
    expect(friendlyError({ message: "Forbidden", status: 403 })).toBe(
      "Access denied. Admin role required to view this page.",
    );
  });

  test("maps 404 to feature not enabled", () => {
    expect(friendlyError({ message: "Not Found", status: 404 })).toBe(
      "This feature is not enabled on this server.",
    );
  });

  test("maps 503 to service unavailable", () => {
    expect(friendlyError({ message: "Service Unavailable", status: 503 })).toBe(
      "A required service is unavailable. Check server configuration.",
    );
  });

  test("passes through raw message for unknown status codes", () => {
    expect(friendlyError({ message: "Rate limited", status: 429 })).toBe("Rate limited");
  });

  test("passes through raw message when status is undefined", () => {
    expect(friendlyError({ message: "Network error" })).toBe("Network error");
  });

  test("appends requestId when present", () => {
    expect(friendlyError({ message: "Server error", status: 500, requestId: "req-789" })).toBe(
      "Server error (Request ID: req-789)",
    );
  });

  test("appends requestId to friendly-mapped messages", () => {
    expect(friendlyError({ message: "x", status: 401, requestId: "req-abc" })).toBe(
      "Not authenticated. Please sign in. (Request ID: req-abc)",
    );
  });
});
