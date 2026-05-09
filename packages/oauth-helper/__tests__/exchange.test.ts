import { describe, expect, test } from "bun:test";

import { OAuthHelperError } from "../src/errors";
import { exchangeCode } from "../src/exchange";
import { captureFetch, jsonResponse } from "./_helpers";

const BASE_PARAMS = {
  tokenEndpoint: "https://api.useatlas.dev/api/auth/oauth2/token",
  clientId: "client-abc",
  redirectUri: "http://127.0.0.1:8080/callback",
  code: "auth-code-123",
  codeVerifier: "verifier-abc",
};

describe("exchangeCode", () => {
  test("posts the form-encoded grant + returns the parsed token response", async () => {
    const { fetchImpl, calls } = captureFetch({
      "/oauth2/token": () =>
        jsonResponse({
          access_token: "at-1",
          refresh_token: "rt-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "mcp:read offline_access",
        }),
    });

    const result = await exchangeCode(BASE_PARAMS, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      access_token: "at-1",
      refresh_token: "rt-1",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp:read offline_access",
    });

    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(BASE_PARAMS.tokenEndpoint);
    expect(calls[0].headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );

    const params = new URLSearchParams(calls[0].body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe(BASE_PARAMS.code);
    expect(params.get("redirect_uri")).toBe(BASE_PARAMS.redirectUri);
    expect(params.get("client_id")).toBe(BASE_PARAMS.clientId);
    expect(params.get("code_verifier")).toBe(BASE_PARAMS.codeVerifier);
  });

  test("rejects http:// (non-loopback) tokenEndpoint with invalid_token_endpoint (#2198)", async () => {
    try {
      await exchangeCode({
        ...BASE_PARAMS,
        tokenEndpoint: "http://evil.example.com/token",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("invalid_token_endpoint");
    }
  });

  test("non-2xx → token_exchange_failed surfacing OAuth error body", async () => {
    const { fetchImpl } = captureFetch({
      "/oauth2/token": () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "code expired",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    });

    try {
      await exchangeCode(BASE_PARAMS, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("token_exchange_failed");
      expect((err as OAuthHelperError).message).toContain("invalid_grant");
      expect((err as OAuthHelperError).message).toContain("code expired");
    }
  });

  test("non-JSON success body → token_exchange_failed", async () => {
    const { fetchImpl } = captureFetch({
      "/oauth2/token": () =>
        new Response("oh no", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    });

    try {
      await exchangeCode(BASE_PARAMS, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("token_exchange_failed");
    }
  });

  test("response missing access_token → token_exchange_failed", async () => {
    const { fetchImpl } = captureFetch({
      "/oauth2/token": () =>
        jsonResponse({ refresh_token: "rt-only", expires_in: 3600 }),
    });

    try {
      await exchangeCode(BASE_PARAMS, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("token_exchange_failed");
    }
  });

  test("network error → token_exchange_failed", async () => {
    const fetchImpl = async () => {
      throw new Error("ETIMEDOUT");
    };
    try {
      await exchangeCode(BASE_PARAMS, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("token_exchange_failed");
    }
  });

  test("loopback http:// tokenEndpoint is accepted", async () => {
    const { fetchImpl } = captureFetch({
      "127.0.0.1": () =>
        jsonResponse({ access_token: "at-2", expires_in: 3600 }),
    });

    const result = await exchangeCode(
      {
        ...BASE_PARAMS,
        tokenEndpoint: "http://127.0.0.1:3001/api/auth/oauth2/token",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.access_token).toBe("at-2");
  });
});
