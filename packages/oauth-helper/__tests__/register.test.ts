import { describe, expect, test } from "bun:test";

import type { AuthServerMetadata } from "../src/discover";
import { OAuthHelperError } from "../src/errors";
import { register } from "../src/register";
import { captureFetch, jsonResponse } from "./_helpers";

const META: AuthServerMetadata = {
  authorization_endpoint: "https://api.useatlas.dev/api/auth/oauth2/authorize",
  token_endpoint: "https://api.useatlas.dev/api/auth/oauth2/token",
  registration_endpoint: "https://api.useatlas.dev/api/auth/oauth2/register",
  issuer: "https://api.useatlas.dev/api/auth",
};

const PARAMS = {
  redirectUri: "http://127.0.0.1:8080/callback",
  clientName: "Test Client",
  scopes: ["mcp:read", "offline_access"] as const,
};

describe("register", () => {
  test("posts public-client manifest and returns the issued client_id", async () => {
    const { fetchImpl, calls } = captureFetch({
      "/oauth2/register": () => jsonResponse({ client_id: "client-abc" }),
    });

    const clientId = await register(META, PARAMS, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(clientId).toBe("client-abc");
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(META.registration_endpoint);
    expect(calls[0].headers["content-type"]).toBe("application/json");

    const body = JSON.parse(calls[0].body) as Record<string, unknown>;
    expect(body.client_name).toBe("Test Client");
    expect(body.redirect_uris).toEqual([PARAMS.redirectUri]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.scope).toBe("mcp:read offline_access");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
  });

  test("non-2xx → registration_failed surfacing the OAuth error body", async () => {
    const { fetchImpl } = captureFetch({
      "/oauth2/register": () =>
        new Response(
          JSON.stringify({
            error: "invalid_redirect_uri",
            error_description: "must be https or loopback",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    });

    try {
      await register(META, PARAMS, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("registration_failed");
      expect((err as OAuthHelperError).message).toContain("invalid_redirect_uri");
      expect((err as OAuthHelperError).message).toContain("must be https or loopback");
    }
  });

  test("non-JSON success body → registration_failed", async () => {
    const { fetchImpl } = captureFetch({
      "/oauth2/register": () =>
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    });

    try {
      await register(META, PARAMS, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("registration_failed");
    }
  });

  test("response missing client_id → registration_failed", async () => {
    const { fetchImpl } = captureFetch({
      "/oauth2/register": () => jsonResponse({}),
    });

    try {
      await register(META, PARAMS, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("registration_failed");
    }
  });

  test("network error → registration_failed", async () => {
    const fetchImpl = async () => {
      throw new Error("EAI_AGAIN");
    };

    try {
      await register(META, PARAMS, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("registration_failed");
    }
  });
});
