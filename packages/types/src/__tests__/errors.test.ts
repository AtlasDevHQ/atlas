import { describe, expect, test } from "bun:test";
import {
  matchError,
  parseChatError,
  classifyClientError,
  isChatErrorCode,
  isRetryableError,
  CHAT_ERROR_CODES,
  CLIENT_ERROR_CODES,
  type ChatErrorCode,
  type ClientErrorCode,
  type MatchedError,
  type AuthMode,
} from "../index";

// ---------------------------------------------------------------------------
// matchError
// ---------------------------------------------------------------------------

describe("matchError", () => {
  test("returns null for unrecognized errors", () => {
    expect(matchError(new Error("something completely unknown"))).toBeNull();
    expect(matchError("random string")).toBeNull();
    expect(matchError(42)).toBeNull();
    expect(matchError(null)).toBeNull();
  });

  // --- Pool exhaustion ---

  test("matches PostgreSQL 'too many clients already'", () => {
    const err = new Error("sorry, too many clients already");
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("rate_limited");
    expect(result.message).toContain("pool exhausted");
    expect(result.message).toContain("try again");
  });

  test("matches MySQL 'Too many connections'", () => {
    const err = new Error("ER_CON_COUNT_ERROR: Too many connections");
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("rate_limited");
    expect(result.message).toContain("pool exhausted");
  });

  test("matches generic 'Connection pool exhausted'", () => {
    const err = new Error("Connection pool exhausted");
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("rate_limited");
  });

  test("matches PostgreSQL 'remaining connection slots are reserved'", () => {
    const err = new Error("FATAL: remaining connection slots are reserved for non-replication superuser connections");
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("rate_limited");
    expect(result.message).toContain("pool exhausted");
  });

  test("pool exhaustion is classified as retryable", () => {
    const err = new Error("sorry, too many clients already");
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(isRetryableError(result.code)).toBe(true);
  });

  // --- ECONNREFUSED ---

  test("matches ECONNREFUSED with host:port", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("internal_error");
    expect(result.message).toContain("Database unreachable");
    expect(result.message).toContain("127.0.0.1:5432");
    expect(result.message).not.toContain("postgresql://");
  });

  test("matches ECONNREFUSED with IPv6", () => {
    const err = new Error("connect ECONNREFUSED ::1:5432");
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.message).toContain("::1:5432");
  });

  test("ECONNREFUSED never exposes connection strings", () => {
    const err = new Error(
      "connect ECONNREFUSED 10.0.0.5:3306 - error connecting to postgresql://admin:secret@10.0.0.5:3306/db",
    );
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.message).toContain("10.0.0.5:3306");
    // The function extracts only the host from the ECONNREFUSED token, not the full URL
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("admin");
    expect(result.message).not.toContain("postgresql://");
  });

  // --- Timeout ---

  test("matches timeout errors with default seconds", () => {
    const err = new Error("Query read timeout");
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("provider_timeout");
    expect(result.message).toContain("30-second timeout");
  });

  test("matches timeout errors with custom seconds", () => {
    const err = new Error("statement timeout");
    const result = matchError(err, { timeoutSeconds: 60 }) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.message).toContain("60-second timeout");
  });

  test("matches 'timed out' variant", () => {
    const result = matchError(new Error("Connection timed out")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("provider_timeout");
  });

  test("matches AbortError", () => {
    const result = matchError(new Error("AbortError: The operation was aborted")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("provider_timeout");
  });

  // --- ENOTFOUND (DNS) ---

  test("matches ENOTFOUND with hostname", () => {
    const err = new Error("getaddrinfo ENOTFOUND db.example.com");
    const result = matchError(err) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("internal_error");
    expect(result.message).toContain("Could not resolve hostname");
    expect(result.message).toContain("db.example.com");
  });

  // --- SSL / TLS ---

  test("matches SSL connection error", () => {
    const result = matchError(new Error("SSL connection has been closed unexpectedly")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("internal_error");
    expect(result.message).toContain("SSL connection failed");
    expect(result.message).toContain("sslmode");
  });

  test("matches TLS handshake error", () => {
    const result = matchError(new Error("TLS handshake failed: connection reset")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.message).toContain("SSL connection failed");
  });

  test("matches self-signed certificate error", () => {
    const result = matchError(new Error("SELF_SIGNED_CERT_IN_CHAIN")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.message).toContain("SSL connection failed");
  });

  test("matches UNABLE_TO_VERIFY_LEAF_SIGNATURE", () => {
    const result = matchError(new Error("UNABLE_TO_VERIFY_LEAF_SIGNATURE")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.message).toContain("SSL connection failed");
  });

  test("matches certificate has expired", () => {
    const result = matchError(new Error("certificate has expired")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.message).toContain("SSL connection failed");
  });

  test("does NOT match bare 'SSL' or 'certificate' in column names", () => {
    expect(matchError(new Error('column "ssl_enabled" does not exist'))).toBeNull();
    expect(matchError(new Error('relation "tls_config" does not exist'))).toBeNull();
    expect(matchError(new Error('column "certificate_id" is ambiguous'))).toBeNull();
  });

  // --- 502 / 503 ---

  test("matches 502 Bad Gateway", () => {
    const result = matchError(new Error("502 Bad Gateway")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("provider_unreachable");
    expect(result.message).toContain("AI provider API unavailable");
    expect(result.message).toContain("retry");
  });

  test("matches 503 Service Unavailable", () => {
    const result = matchError(new Error("503 Service Unavailable")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("provider_unreachable");
  });

  test("does NOT match bare 502/503 in unrelated contexts", () => {
    expect(matchError(new Error("Port 5032 is already in use"))).toBeNull();
    expect(matchError(new Error("Error at line 503 of query"))).toBeNull();
    expect(matchError(new Error('column "col503" does not exist'))).toBeNull();
    expect(matchError(new Error("Row count: 50299"))).toBeNull();
  });

  // --- fetch failed ---

  test("matches fetch failed", () => {
    const result = matchError(new Error("TypeError: fetch failed")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.code).toBe("provider_unreachable");
    expect(result.message).toContain("unreachable");
  });

  // --- No stack traces in messages ---

  test("ECONNREFUSED without trailing host returns unknown host", () => {
    const result = matchError(new Error("ECONNREFUSED")) as MatchedError;
    expect(result).not.toBeNull();
    expect(result.message).toContain("(unknown host)");
  });

  test("no stack traces in any matched message", () => {
    const errors = [
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      new Error("getaddrinfo ENOTFOUND bad.host"),
      new Error("SSL connection has been closed"),
      new Error("Query read timeout"),
      new Error("502 Bad Gateway"),
      new Error("TypeError: fetch failed"),
    ];
    for (const err of errors) {
      err.stack = "Error: something\n    at Object.<anonymous> (/app/src/index.ts:42:5)";
      const result = matchError(err);
      expect(result).not.toBeNull();
      expect(result!.message).not.toContain("at Object");
      expect(result!.message).not.toContain(".ts:");
      expect(result!.message).not.toContain("index.ts");
    }
  });

  // --- Non-Error inputs ---

  test("handles string input", () => {
    const result = matchError("connect ECONNREFUSED 10.0.0.1:5432");
    expect(result).not.toBeNull();
    expect(result!.message).toContain("Database unreachable");
  });

  test("handles undefined/null gracefully", () => {
    expect(matchError(undefined)).toBeNull();
    expect(matchError(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseChatError — requestId extraction
// ---------------------------------------------------------------------------

describe("parseChatError requestId", () => {
  const authMode: AuthMode = "none";

  test("extracts requestId from valid JSON error response", () => {
    const err = new Error(
      JSON.stringify({
        error: "internal_error",
        message: "An unexpected error occurred.",
        requestId: "abc12345",
      }),
    );
    const info = parseChatError(err, authMode);
    expect(info.code).toBe("internal_error");
    expect(info.requestId).toBe("abc12345");
  });

  test("requestId is undefined when not present in response", () => {
    const err = new Error(
      JSON.stringify({
        error: "internal_error",
        message: "Something happened",
      }),
    );
    const info = parseChatError(err, authMode);
    expect(info.requestId).toBeUndefined();
  });

  test("requestId is passed through even for unknown codes", () => {
    const err = new Error(
      JSON.stringify({
        error: "totally_unknown_code",
        message: "wat",
        requestId: "req-xyz",
      }),
    );
    const info = parseChatError(err, authMode);
    expect(info.requestId).toBe("req-xyz");
  });

  test("requestId is undefined for non-JSON errors", () => {
    const err = new Error("plain text error");
    const info = parseChatError(err, authMode);
    expect(info.requestId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isChatErrorCode — basic sanity
// ---------------------------------------------------------------------------

describe("isChatErrorCode", () => {
  test("recognizes valid codes", () => {
    expect(isChatErrorCode("internal_error")).toBe(true);
    expect(isChatErrorCode("provider_timeout")).toBe(true);
    expect(isChatErrorCode("auth_error")).toBe(true);
    expect(isChatErrorCode("session_expired")).toBe(true);
    expect(isChatErrorCode("forbidden_role")).toBe(true);
    expect(isChatErrorCode("org_not_found")).toBe(true);
  });

  test("rejects invalid codes", () => {
    expect(isChatErrorCode("fake_code")).toBe(false);
    expect(isChatErrorCode("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe("isRetryableError", () => {
  const retryableCodes: ChatErrorCode[] = [
    "rate_limited",
    "provider_timeout",
    "provider_unreachable",
    "provider_error",
    "provider_rate_limit",
    "internal_error",
  ];

  const nonRetryableCodes: ChatErrorCode[] = [
    "auth_error",
    "session_expired",
    "configuration_error",
    "no_datasource",
    "invalid_request",
    "provider_model_not_found",
    "provider_auth_error",
    "validation_error",
    "not_found",
    "forbidden",
    "forbidden_role",
    "org_not_found",
  ];

  test("marks transient codes as retryable", () => {
    for (const code of retryableCodes) {
      expect(isRetryableError(code)).toBe(true);
    }
  });

  test("marks permanent codes as not retryable", () => {
    for (const code of nonRetryableCodes) {
      expect(isRetryableError(code)).toBe(false);
    }
  });

  test("every ChatErrorCode is classified", () => {
    const all = new Set([...retryableCodes, ...nonRetryableCodes]);
    for (const code of CHAT_ERROR_CODES) {
      expect(all.has(code)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parseChatError — retryable field
// ---------------------------------------------------------------------------

describe("parseChatError retryable", () => {
  const authMode: AuthMode = "none";

  test("retryable is true for all transient error codes", () => {
    for (const code of ["rate_limited", "provider_timeout", "provider_unreachable", "provider_error", "provider_rate_limit", "internal_error"] as const) {
      const err = new Error(JSON.stringify({ error: code, message: "fail" }));
      const info = parseChatError(err, authMode);
      expect(info.retryable).toBe(true);
    }
  });

  test("retryable is false for all permanent error codes", () => {
    for (const code of ["auth_error", "session_expired", "configuration_error", "no_datasource", "invalid_request", "provider_model_not_found", "provider_auth_error", "validation_error", "not_found", "forbidden", "forbidden_role", "org_not_found"] as const) {
      const err = new Error(JSON.stringify({ error: code, message: "fail" }));
      const info = parseChatError(err, authMode);
      expect(info.retryable).toBe(false);
    }
  });

  test("retryable is undefined for non-JSON errors", () => {
    const err = new Error("plain text");
    const info = parseChatError(err, authMode);
    expect(info.retryable).toBeUndefined();
  });

  test("retryable is undefined for unknown error codes", () => {
    const err = new Error(JSON.stringify({ error: "unknown_xyz", message: "wat" }));
    const info = parseChatError(err, authMode);
    expect(info.retryable).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseChatError — rate_limited detail uses server message for pool exhaustion
// ---------------------------------------------------------------------------

describe("parseChatError rate_limited detail", () => {
  const authMode: AuthMode = "none";

  test("uses retryAfterSeconds when present (API rate limit)", () => {
    const err = new Error(
      JSON.stringify({
        error: "rate_limited",
        message: "Too many requests. Please wait before trying again.",
        retryAfterSeconds: 30,
      }),
    );
    const info = parseChatError(err, authMode);
    expect(info.detail).toBe("Try again in 30 seconds.");
    expect(info.retryAfterSeconds).toBe(30);
  });

  test("uses server message when retryAfterSeconds is absent (pool exhaustion)", () => {
    const err = new Error(
      JSON.stringify({
        error: "rate_limited",
        message: "Database connection pool exhausted — try again in a few seconds, or reduce concurrent queries",
      }),
    );
    const info = parseChatError(err, authMode);
    expect(info.detail).toContain("pool exhausted");
    expect(info.retryAfterSeconds).toBeUndefined();
  });

  test("falls back to generic message when no server message and no retryAfterSeconds", () => {
    const err = new Error(
      JSON.stringify({
        error: "rate_limited",
      }),
    );
    const info = parseChatError(err, authMode);
    expect(info.detail).toBe("Please wait before trying again.");
  });
});

// ---------------------------------------------------------------------------
// classifyClientError — client-side error detection
// ---------------------------------------------------------------------------

describe("classifyClientError", () => {
  test("returns null for unrecognized errors", () => {
    expect(classifyClientError(new Error("something random"))).toBeNull();
  });

  test("detects TypeError as api_unreachable", () => {
    const err = new TypeError("fetch failed");
    expect(classifyClientError(err)).toBe("api_unreachable");
  });

  test("detects 'Failed to fetch' as api_unreachable", () => {
    expect(classifyClientError(new Error("Failed to fetch"))).toBe("api_unreachable");
  });

  test("detects 'NetworkError' as api_unreachable", () => {
    expect(classifyClientError(new Error("NetworkError when attempting to fetch resource"))).toBe("api_unreachable");
  });

  test("detects ECONNREFUSED as api_unreachable", () => {
    expect(classifyClientError(new Error("connect ECONNREFUSED 127.0.0.1:3001"))).toBe("api_unreachable");
  });

  test("detects ENOTFOUND as api_unreachable", () => {
    expect(classifyClientError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe("api_unreachable");
  });

  test("detects 401 Unauthorized as auth_failure", () => {
    expect(classifyClientError(new Error("401 Unauthorized"))).toBe("auth_failure");
  });

  test("detects bare 'Unauthorized' as auth_failure", () => {
    expect(classifyClientError(new Error("Unauthorized"))).toBe("auth_failure");
  });

  test("detects 429 Too Many Requests as rate_limited_http", () => {
    expect(classifyClientError(new Error("429 Too Many Requests"))).toBe("rate_limited_http");
  });

  test("detects 500 Internal Server Error as server_error", () => {
    expect(classifyClientError(new Error("500 Internal Server Error"))).toBe("server_error");
  });

  test("detects 502 Bad Gateway as server_error", () => {
    expect(classifyClientError(new Error("502 Bad Gateway"))).toBe("server_error");
  });

  test("detects 503 Service Unavailable as server_error", () => {
    expect(classifyClientError(new Error("503 Service Unavailable"))).toBe("server_error");
  });

  test("every CLIENT_ERROR_CODES entry is a valid ClientErrorCode", () => {
    // Ensure the const array matches the type
    const codes: readonly ClientErrorCode[] = CLIENT_ERROR_CODES;
    expect(codes.length).toBeGreaterThan(0);
  });

  test("returns null for JSON-shaped messages (server response bodies)", () => {
    // A JSON error body like '{"error":"rate_limited","message":"Too Many Requests"}'
    // should NOT be classified by regex — parseChatError handles it via JSON.parse.
    const jsonBody = new Error('{"error":"rate_limited","message":"Too Many Requests"}');
    expect(classifyClientError(jsonBody)).toBeNull();

    const jsonArray = new Error('[{"error":"something"}]');
    expect(classifyClientError(jsonArray)).toBeNull();
  });

  test("detects navigator.onLine === false as offline", () => {
    const origNav = globalThis.navigator;
    const origWin = (globalThis as Record<string, unknown>).window;
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        configurable: true,
      });
      // window must be defined for the browser-environment check
      if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
        Object.defineProperty(globalThis, "window", {
          value: {},
          configurable: true,
        });
      }
      expect(classifyClientError(new Error("any error"))).toBe("offline");
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: origNav,
        configurable: true,
      });
      if (origWin === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// parseChatError — client-side error classification
// ---------------------------------------------------------------------------

describe("parseChatError client-side errors", () => {
  const authMode: AuthMode = "none";

  test("classifies TypeError as api_unreachable with friendly message", () => {
    const err = new TypeError("fetch failed");
    const info = parseChatError(err, authMode);
    expect(info.clientCode).toBe("api_unreachable");
    expect(info.title).toContain("Unable to connect");
    expect(info.retryable).toBe(true);
  });

  test("classifies 'Failed to fetch' as api_unreachable", () => {
    const err = new Error("Failed to fetch");
    const info = parseChatError(err, authMode);
    expect(info.clientCode).toBe("api_unreachable");
    expect(info.title).toContain("Unable to connect");
  });

  test("classifies 401 non-JSON response as auth_failure", () => {
    const err = new Error("401 Unauthorized");
    const info = parseChatError(err, authMode);
    expect(info.clientCode).toBe("auth_failure");
    expect(info.retryable).toBe(false);
  });

  test("auth_failure uses authMode-specific message", () => {
    const err = new Error("401 Unauthorized");
    const infoSimpleKey = parseChatError(err, "simple-key");
    expect(infoSimpleKey.title).toContain("API key");

    const infoManaged = parseChatError(err, "managed");
    expect(infoManaged.title).toContain("session");
  });

  test("classifies 429 non-JSON response as rate_limited_http with countdown", () => {
    const err = new Error("429 Too Many Requests");
    const info = parseChatError(err, authMode);
    expect(info.clientCode).toBe("rate_limited_http");
    expect(info.retryAfterSeconds).toBe(30);
    expect(info.retryable).toBe(true);
  });

  test("classifies 500 non-JSON response as server_error", () => {
    const err = new Error("500 Internal Server Error");
    const info = parseChatError(err, authMode);
    expect(info.clientCode).toBe("server_error");
    expect(info.title).toContain("Something went wrong");
    expect(info.retryable).toBe(true);
  });

  test("server JSON errors still use server code (not client classification)", () => {
    // When the server returns valid JSON, server code takes precedence
    const err = new Error(JSON.stringify({
      error: "auth_error",
      message: "Invalid API key",
    }));
    const info = parseChatError(err, authMode);
    expect(info.code).toBe("auth_error");
    // clientCode is not set because JSON parse succeeded and server code took over
    expect(info.clientCode).toBeUndefined();
  });

  test("plain text non-matching error falls through to generic", () => {
    const err = new Error("some random error text");
    const info = parseChatError(err, authMode);
    expect(info.clientCode).toBeUndefined();
    expect(info.title).toBe("Something went wrong. Please try again.");
  });
});
