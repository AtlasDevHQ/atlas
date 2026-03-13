import { describe, expect, test } from "bun:test";
import {
  matchError,
  parseChatError,
  isChatErrorCode,
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
  });

  test("rejects invalid codes", () => {
    expect(isChatErrorCode("fake_code")).toBe(false);
    expect(isChatErrorCode("")).toBe(false);
  });
});
