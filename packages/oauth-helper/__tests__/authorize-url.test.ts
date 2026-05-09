import { describe, expect, test } from "bun:test";

import { buildAuthorizationUrl } from "../src/authorize-url";

describe("buildAuthorizationUrl", () => {
  const PARAMS = {
    authorizationEndpoint: "https://api.useatlas.dev/api/auth/oauth2/authorize",
    clientId: "client-abc",
    redirectUri: "http://127.0.0.1:8080/callback",
    state: "state-123",
    codeChallenge: "challenge-xyz",
    scopes: ["mcp:read", "offline_access"] as const,
  };

  test("emits all required OAuth 2.1 parameters", () => {
    const url = new URL(buildAuthorizationUrl(PARAMS));

    expect(url.origin + url.pathname).toBe(PARAMS.authorizationEndpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(PARAMS.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(PARAMS.redirectUri);
    expect(url.searchParams.get("scope")).toBe("mcp:read offline_access");
    expect(url.searchParams.get("state")).toBe(PARAMS.state);
    expect(url.searchParams.get("code_challenge")).toBe(PARAMS.codeChallenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("appends with `?` when the endpoint has no query string", () => {
    const url = buildAuthorizationUrl(PARAMS);
    expect(url).toContain(`${PARAMS.authorizationEndpoint}?`);
  });

  test("appends with `&` when the endpoint already has a query string", () => {
    const url = buildAuthorizationUrl({
      ...PARAMS,
      authorizationEndpoint: `${PARAMS.authorizationEndpoint}?prompt=login`,
    });
    expect(url).toContain("?prompt=login&");
    expect(url).toContain("&response_type=code");
  });

  test("scope joins multiple values with a single space", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...PARAMS,
        scopes: ["openid", "profile", "mcp:read", "offline_access"],
      }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "openid profile mcp:read offline_access",
    );
  });

  test("URL-encodes special chars in clientId / redirectUri / state", () => {
    const url = buildAuthorizationUrl({
      ...PARAMS,
      clientId: "client with space",
      redirectUri: "https://example.com/callback?return_to=/x",
      state: "a&b",
    });
    expect(url).toContain("client_id=client+with+space");
    expect(url).toContain(
      "redirect_uri=https%3A%2F%2Fexample.com%2Fcallback%3Freturn_to%3D%2Fx",
    );
    expect(url).toContain("state=a%26b");
  });
});
