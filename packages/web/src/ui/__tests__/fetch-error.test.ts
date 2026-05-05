import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import {
  buildFetchError,
  extractFetchError,
  friendlyError,
  friendlyErrorOrNull,
} from "../lib/fetch-error";

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
  test("server message wins on 401 (typed body)", () => {
    // After the #2081 precedence flip, a server-authored body message reaches
    // the user verbatim — masking it with the canned "sign in" copy is what
    // produced the "Admin role required" lie for unenrolled admins.
    expect(friendlyError({ message: "Session expired.", status: 401 })).toBe(
      "Session expired.",
    );
  });

  test("server message wins on 403 (typed body)", () => {
    // The motivating bug: an unenrolled admin saw "Admin role required" when
    // the real cause was `mfa_enrollment_required`. The server-authored
    // message must reach the user.
    expect(
      friendlyError({
        message: "Two-factor authentication is required for admin accounts.",
        status: 403,
        code: "mfa_enrollment_required",
      }),
    ).toBe("Two-factor authentication is required for admin accounts.");
  });

  test("server message wins on 404 (typed body)", () => {
    expect(friendlyError({ message: "Workspace not found.", status: 404 })).toBe(
      "Workspace not found.",
    );
  });

  test("server message wins on 503 (typed body)", () => {
    expect(
      friendlyError({ message: "Datasource pool draining.", status: 503 }),
    ).toBe("Datasource pool draining.");
  });

  test("falls back to canned 401 copy when body is empty (HTTP status placeholder)", () => {
    // `extractFetchError` substitutes `HTTP ${status}` when the body had no
    // usable message field. `friendlyError` recognizes that placeholder and
    // swaps in the canned copy — otherwise the user would see "HTTP 401".
    expect(friendlyError({ message: "HTTP 401", status: 401 })).toBe(
      "Not authenticated. Please sign in.",
    );
  });

  test("falls back to canned 403 copy when body is empty", () => {
    expect(friendlyError({ message: "HTTP 403", status: 403 })).toBe(
      "Access denied. You may need additional permissions to view this page.",
    );
  });

  test("falls back to canned 404 copy when body is empty", () => {
    expect(friendlyError({ message: "HTTP 404", status: 404 })).toBe(
      "This feature is not enabled on this server.",
    );
  });

  test("falls back to canned 503 copy when body is empty", () => {
    expect(friendlyError({ message: "HTTP 503", status: 503 })).toBe(
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

  test("appends requestId to canned fallback copy", () => {
    expect(
      friendlyError({ message: "HTTP 401", status: 401, requestId: "req-abc" }),
    ).toBe("Not authenticated. Please sign in. (Request ID: req-abc)");
  });

  test("appends requestId to server-authored message", () => {
    expect(
      friendlyError({
        message: "Two-factor required.",
        status: 403,
        code: "mfa_enrollment_required",
        requestId: "req-mfa",
      }),
    ).toBe("Two-factor required. (Request ID: req-mfa)");
  });

  test("routes schema_mismatch to a version-drift specific message", () => {
    // No status field — emulates the useAdminFetch schema-failure throw, which
    // is the only legitimate producer of `code: "schema_mismatch"`.
    expect(friendlyError({ message: "raw", code: "schema_mismatch" })).toContain(
      "out of sync",
    );
  });

  test("server message wins over schema_mismatch when status is set", () => {
    // Defensive: if a server response body ever sets `error: "schema_mismatch"`
    // on an HTTP error, the server message reaches the user — masking it with
    // "out of sync" would override the real auth/role/feature signal.
    expect(
      friendlyError({ message: "Bad token.", status: 401, code: "schema_mismatch" }),
    ).toBe("Bad token.");
    expect(
      friendlyError({ message: "Forbidden by policy.", status: 403, code: "schema_mismatch" }),
    ).toBe("Forbidden by policy.");
  });

  test("schema_mismatch with status + empty body falls through to canned copy", () => {
    // The `HTTP 401` placeholder triggers the canned fallback, not the
    // schema-mismatch copy — schema_mismatch only wins on the no-status path.
    expect(
      friendlyError({ message: "HTTP 401", status: 401, code: "schema_mismatch" }),
    ).toBe("Not authenticated. Please sign in.");
  });

  test("schema_mismatch falls through to raw message when status is set without a friendly mapping", () => {
    // 500 has no friendly mapping, so the raw message wins (not "out of sync").
    expect(
      friendlyError({ message: "raw 500", status: 500, code: "schema_mismatch" }),
    ).toBe("raw 500");
  });
});

describe("extractFetchError empty-message clobber guard", () => {
  test("preserves HTTP status fallback when server returns empty message", async () => {
    // A misconfigured server or truncated JSON can emit `{ message: "" }`.
    // The old extractor accepted empty strings and clobbered the fallback,
    // which then propagated blank banners through friendlyError and
    // combineMutationErrors. Guard: require non-empty.
    const res = new Response(JSON.stringify({ message: "", requestId: "req-empty" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "HTTP 500", status: 500, requestId: "req-empty" });
  });

  test("preserves structured code even when message is empty", async () => {
    const res = new Response(
      JSON.stringify({ message: "", error: "enterprise_required" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    const err = await extractFetchError(res);
    expect(err).toEqual({ message: "HTTP 403", status: 403, code: "enterprise_required" });
  });
});

describe("buildFetchError empty-message invariant", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test("returns a FetchError with trimmed message on happy path", () => {
    const err = buildFetchError({
      message: "  Server error  ",
      status: 500,
      code: "internal",
      requestId: "req-abc",
    });
    expect(err).toEqual({
      message: "Server error",
      status: 500,
      code: "internal",
      requestId: "req-abc",
    });
  });

  test("omits undefined optional fields", () => {
    const err = buildFetchError({ message: "msg" });
    expect(err).toEqual({ message: "msg" });
    expect("status" in err).toBe(false);
    expect("code" in err).toBe(false);
    expect("requestId" in err).toBe(false);
  });

  test("throws in development when message is empty", () => {
    process.env.NODE_ENV = "development";
    expect(() => buildFetchError({ message: "", status: 500 })).toThrow(
      /refused to construct FetchError with empty message/,
    );
  });

  test("throws in development when message is whitespace-only", () => {
    process.env.NODE_ENV = "development";
    expect(() => buildFetchError({ message: "   ", status: 500 })).toThrow(
      /refused to construct FetchError with empty message/,
    );
  });

  test("throws in development when message is undefined", () => {
    process.env.NODE_ENV = "development";
    expect(() => buildFetchError({ status: 500 })).toThrow(
      /refused to construct FetchError with empty message/,
    );
  });

  test("throws in non-production (e.g. test env too)", () => {
    process.env.NODE_ENV = "test";
    expect(() => buildFetchError({ message: "" })).toThrow();
  });

  test("substitutes a generic message in production", () => {
    process.env.NODE_ENV = "production";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const err = buildFetchError({ message: "", status: 502 });
      expect(err).toEqual({
        message: "Request failed (502)",
        status: 502,
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("production substitute uses 'unknown' when status is undefined", () => {
    process.env.NODE_ENV = "production";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const err = buildFetchError({ message: undefined });
      expect(err).toEqual({ message: "Request failed (unknown)" });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("production substitute still preserves code and requestId", () => {
    process.env.NODE_ENV = "production";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const err = buildFetchError({
        message: "",
        status: 403,
        code: "enterprise_required",
        requestId: "req-ee",
      });
      expect(err).toEqual({
        message: "Request failed (403)",
        status: 403,
        code: "enterprise_required",
        requestId: "req-ee",
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("friendlyErrorOrNull", () => {
  test("returns null for null input", () => {
    expect(friendlyErrorOrNull(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(friendlyErrorOrNull(undefined)).toBeNull();
  });

  test("returns friendlyError output for a FetchError", () => {
    const err = { message: "Unauthorized", status: 401, requestId: "req-x" } as const;
    expect(friendlyErrorOrNull(err)).toBe(friendlyError(err));
  });

  test("preserves server message on non-null 403 path", () => {
    // Routes through friendlyError — server-authored messages reach the user
    // verbatim (post-#2081 precedence flip).
    expect(
      friendlyErrorOrNull({
        message: "Two-factor required.",
        status: 403,
        code: "mfa_enrollment_required",
      }),
    ).toBe("Two-factor required.");
  });

  test("falls back to canned 403 copy on empty-body 403", () => {
    expect(friendlyErrorOrNull({ message: "HTTP 403", status: 403 })).toBe(
      "Access denied. You may need additional permissions to view this page.",
    );
  });
});
