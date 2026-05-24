/**
 * TwentyCredentialResolver unit tests — env-var path.
 */
import { describe, test, expect } from "bun:test";
import {
  resolveCredentialsFromEnv,
  tryResolveCredentialsFromEnv,
  TwentyCredentialError,
} from "../src/credential-resolver";

describe("resolveCredentialsFromEnv", () => {
  test("returns the apiKey when TWENTY_API_KEY is set; baseUrl is undefined without TWENTY_BASE_URL", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc123" },
    });
    expect(result.apiKey).toBe("abc123");
    // No hard-coded fallback — caller supplies its own default.
    expect(result.baseUrl).toBeUndefined();
  });

  test("returns the configured baseUrl when TWENTY_BASE_URL is set", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "https://crm.example.com" },
    });
    expect(result.baseUrl).toBe("https://crm.example.com");
  });

  test("trims trailing slashes on baseUrl (no regex backtracking)", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "https://crm.example.com///" },
    });
    expect(result.baseUrl).toBe("https://crm.example.com");
  });

  test("trims surrounding whitespace on apiKey", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "  abc  " },
    });
    expect(result.apiKey).toBe("abc");
  });

  test("throws TwentyCredentialError with actionable message when TWENTY_API_KEY is absent", () => {
    try {
      resolveCredentialsFromEnv({ env: {} });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyCredentialError);
      const msg = (err as Error).message;
      expect(msg).toContain("TWENTY_API_KEY");
      expect(msg).toContain("TWENTY_BASE_URL");
    }
  });

  test("throws when TWENTY_API_KEY is the empty string", () => {
    expect(() =>
      resolveCredentialsFromEnv({ env: { TWENTY_API_KEY: "" } }),
    ).toThrow(TwentyCredentialError);
  });

  test("throws when TWENTY_API_KEY is whitespace only", () => {
    expect(() =>
      resolveCredentialsFromEnv({ env: { TWENTY_API_KEY: "   " } }),
    ).toThrow(TwentyCredentialError);
  });

  test("baseUrl is undefined when TWENTY_BASE_URL is empty", () => {
    const result = resolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc", TWENTY_BASE_URL: "" },
    });
    expect(result.baseUrl).toBeUndefined();
  });
});

describe("tryResolveCredentialsFromEnv", () => {
  test("returns the resolved credentials when env is set", () => {
    const result = tryResolveCredentialsFromEnv({
      env: { TWENTY_API_KEY: "abc" },
    });
    expect(result?.apiKey).toBe("abc");
  });

  test("returns null when TWENTY_API_KEY is absent (no throw)", () => {
    const result = tryResolveCredentialsFromEnv({ env: {} });
    expect(result).toBeNull();
  });
});
