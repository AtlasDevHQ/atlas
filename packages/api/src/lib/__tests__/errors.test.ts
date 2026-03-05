import { describe, it, expect } from "bun:test";
import {
  parseChatError,
  authErrorMessage,
} from "@atlas/api/lib/errors";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Build an Error whose .message is a JSON string (mimics AI SDK chat errors). */
function jsonError(body: Record<string, unknown>): Error {
  return new Error(JSON.stringify(body));
}

/* ------------------------------------------------------------------ */
/*  parseChatError                                                     */
/* ------------------------------------------------------------------ */

describe("parseChatError", () => {
  // 1. Non-JSON fallback
  it("returns generic fallback when error.message is not JSON", () => {
    const info = parseChatError(new Error("network timeout"), "none");
    expect(info.title).toBe("Something went wrong. Please try again.");
    expect(info.code).toBeUndefined();
  });

  // 2–5. auth_error × each auth mode
  it("auth_error + simple-key → API key message", () => {
    const info = parseChatError(jsonError({ error: "auth_error" }), "simple-key");
    expect(info.title).toContain("API key");
    expect(info.code).toBe("auth_error");
  });

  it("auth_error + managed → session expired message", () => {
    const info = parseChatError(jsonError({ error: "auth_error" }), "managed");
    expect(info.title).toContain("sign in");
    expect(info.code).toBe("auth_error");
  });

  it("auth_error + byot → token expired message", () => {
    const info = parseChatError(jsonError({ error: "auth_error" }), "byot");
    expect(info.title).toContain("token");
    expect(info.code).toBe("auth_error");
  });

  it("auth_error + none → unexpected auth error message", () => {
    const info = parseChatError(jsonError({ error: "auth_error" }), "none");
    expect(info.title).toContain("unexpected");
    expect(info.code).toBe("auth_error");
  });

  // 6. rate_limited WITH retryAfterSeconds
  it("rate_limited with retryAfterSeconds → includes countdown", () => {
    const info = parseChatError(
      jsonError({ error: "rate_limited", retryAfterSeconds: 30 }),
      "none",
    );
    expect(info.title).toBe("Too many requests.");
    expect(info.detail).toContain("30 seconds");
    expect(info.retryAfterSeconds).toBe(30);
    expect(info.code).toBe("rate_limited");
  });

  // 7. rate_limited WITHOUT retryAfterSeconds
  it("rate_limited without retryAfterSeconds → generic wait message", () => {
    const info = parseChatError(
      jsonError({ error: "rate_limited" }),
      "none",
    );
    expect(info.title).toBe("Too many requests.");
    expect(info.detail).toBe("Please wait before trying again.");
    expect(info.retryAfterSeconds).toBeUndefined();
    expect(info.code).toBe("rate_limited");
  });

  // 8. rate_limited with negative retryAfterSeconds → clamped to 0
  it("rate_limited with negative retryAfterSeconds → clamped to 0", () => {
    const info = parseChatError(
      jsonError({ error: "rate_limited", retryAfterSeconds: -5 }),
      "none",
    );
    expect(info.retryAfterSeconds).toBe(0);
    expect(info.detail).toContain("0 seconds");
  });

  // 9. rate_limited with very large retryAfterSeconds → clamped to 300
  it("rate_limited with huge retryAfterSeconds → clamped to 300", () => {
    const info = parseChatError(
      jsonError({ error: "rate_limited", retryAfterSeconds: 9999 }),
      "none",
    );
    expect(info.retryAfterSeconds).toBe(300);
    expect(info.detail).toContain("300 seconds");
  });

  // 10. configuration_error
  it("configuration_error → includes server message as detail", () => {
    const info = parseChatError(
      jsonError({ error: "configuration_error", message: "Missing API key" }),
      "none",
    );
    expect(info.title).toBe("Atlas is not fully configured.");
    expect(info.detail).toBe("Missing API key");
    expect(info.code).toBe("configuration_error");
  });

  // 11. no_datasource
  it("no_datasource → correct title", () => {
    const info = parseChatError(
      jsonError({ error: "no_datasource" }),
      "none",
    );
    expect(info.title).toBe("No data source configured.");
    expect(info.code).toBe("no_datasource");
  });

  // 12. invalid_request
  it("invalid_request → correct title", () => {
    const info = parseChatError(
      jsonError({ error: "invalid_request" }),
      "none",
    );
    expect(info.title).toBe("Invalid request.");
    expect(info.code).toBe("invalid_request");
  });

  // 13. provider_model_not_found
  it("provider_model_not_found → correct title", () => {
    const info = parseChatError(
      jsonError({ error: "provider_model_not_found" }),
      "none",
    );
    expect(info.title).toBe("The configured AI model was not found.");
    expect(info.code).toBe("provider_model_not_found");
  });

  // 14. provider_auth_error
  it("provider_auth_error → correct title", () => {
    const info = parseChatError(
      jsonError({ error: "provider_auth_error", message: "Bad credentials" }),
      "none",
    );
    expect(info.title).toBe("The AI provider could not authenticate.");
    expect(info.detail).toBe("Bad credentials");
    expect(info.code).toBe("provider_auth_error");
  });

  // 15. provider_rate_limit
  it("provider_rate_limit → correct title", () => {
    const info = parseChatError(
      jsonError({ error: "provider_rate_limit" }),
      "none",
    );
    expect(info.title).toBe("The AI provider is rate limiting requests.");
    expect(info.code).toBe("provider_rate_limit");
  });

  // 16. provider_timeout
  it("provider_timeout → correct title", () => {
    const info = parseChatError(
      jsonError({ error: "provider_timeout" }),
      "none",
    );
    expect(info.title).toBe("The AI provider timed out.");
    expect(info.code).toBe("provider_timeout");
  });

  // 17. provider_unreachable
  it("provider_unreachable → correct title", () => {
    const info = parseChatError(
      jsonError({ error: "provider_unreachable" }),
      "none",
    );
    expect(info.title).toBe("Could not reach the AI provider.");
    expect(info.code).toBe("provider_unreachable");
  });

  // 18. internal_error with message
  it("internal_error with message → passes through server message", () => {
    const info = parseChatError(
      jsonError({ error: "internal_error", message: "DB pool exhausted" }),
      "none",
    );
    expect(info.title).toBe("DB pool exhausted");
    expect(info.code).toBe("internal_error");
  });

  // 19. internal_error without message
  it("internal_error without message → generic fallback", () => {
    const info = parseChatError(
      jsonError({ error: "internal_error" }),
      "none",
    );
    expect(info.title).toBe("An unexpected error occurred.");
    expect(info.code).toBe("internal_error");
  });

  // 20. Unknown code with message
  it("unknown code with message → passes through server message", () => {
    const info = parseChatError(
      jsonError({ error: "something_new", message: "New error type" }),
      "none",
    );
    expect(info.title).toBe("New error type");
    expect(info.code).toBeUndefined();
  });

  // 21. Unknown code without message
  it("unknown code without message → generic fallback", () => {
    const info = parseChatError(
      jsonError({ error: "something_new" }),
      "none",
    );
    expect(info.title).toBe("Something went wrong. Please try again.");
  });

  // 22. Valid JSON but error field is not a string
  it("error field is a number → default case", () => {
    const info = parseChatError(
      jsonError({ error: 42, message: "Unexpected" }),
      "none",
    );
    expect(info.title).toBe("Unexpected");
    expect(info.code).toBeUndefined();
  });

  // 23. Valid JSON but empty object
  it("empty JSON object → default case", () => {
    const info = parseChatError(jsonError({}), "none");
    expect(info.title).toBe("Something went wrong. Please try again.");
    expect(info.code).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  authErrorMessage                                                   */
/* ------------------------------------------------------------------ */

describe("authErrorMessage", () => {
  it("simple-key → mentions API key", () => {
    expect(authErrorMessage("simple-key")).toContain("API key");
  });

  it("managed → mentions sign in", () => {
    expect(authErrorMessage("managed")).toContain("sign in");
  });

  it("byot → mentions token", () => {
    expect(authErrorMessage("byot")).toContain("token");
  });

  it("none → mentions unexpected", () => {
    expect(authErrorMessage("none")).toContain("unexpected");
  });
});
