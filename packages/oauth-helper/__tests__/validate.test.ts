import { describe, expect, test } from "bun:test";

import { OAuthHelperError } from "../src/errors";
import { validateIssuerUrl, validateTokenEndpoint } from "../src/validate";

describe("validateIssuerUrl", () => {
  test("accepts https://", () => {
    expect(() => validateIssuerUrl("https://api.useatlas.dev")).not.toThrow();
  });

  test("accepts http://localhost", () => {
    expect(() => validateIssuerUrl("http://localhost:3001")).not.toThrow();
  });

  test("accepts http://127.0.0.1", () => {
    expect(() => validateIssuerUrl("http://127.0.0.1:3001")).not.toThrow();
  });

  test("rejects http:// for non-loopback hosts", () => {
    try {
      validateIssuerUrl("http://evil.example.com");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("invalid_api_url");
    }
  });

  test("rejects malformed URLs with invalid_api_url", () => {
    try {
      validateIssuerUrl("not-a-url");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("invalid_api_url");
    }
  });

  test("rejects ftp:// and other non-http(s) schemes", () => {
    expect(() => validateIssuerUrl("ftp://api.useatlas.dev")).toThrowError(/https/);
  });
});

describe("validateTokenEndpoint", () => {
  test("accepts https://", () => {
    expect(() =>
      validateTokenEndpoint("https://api.useatlas.dev/api/auth/oauth2/token"),
    ).not.toThrow();
  });

  test("accepts http://127.0.0.1 (loopback)", () => {
    expect(() =>
      validateTokenEndpoint("http://127.0.0.1:3001/oauth/token"),
    ).not.toThrow();
  });

  test("rejects http:// non-loopback with invalid_token_endpoint code (#2198 hardening)", () => {
    try {
      validateTokenEndpoint("http://evil.example.com/token");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("invalid_token_endpoint");
    }
  });

  test("rejects malformed URLs with invalid_token_endpoint", () => {
    try {
      validateTokenEndpoint("definitely-not-a-url");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("invalid_token_endpoint");
    }
  });
});
