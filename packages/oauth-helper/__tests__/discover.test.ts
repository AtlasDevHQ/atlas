import { describe, expect, test } from "bun:test";

import { discover } from "../src/discover";
import { OAuthHelperError } from "../src/errors";
import { captureFetch, jsonResponse } from "./_helpers";

const API = "https://api.useatlas.dev";

const VALID_BODY = {
  authorization_endpoint: `${API}/api/auth/oauth2/authorize`,
  token_endpoint: `${API}/api/auth/oauth2/token`,
  registration_endpoint: `${API}/api/auth/oauth2/register`,
  issuer: `${API}/api/auth`,
};

describe("discover", () => {
  test("fetches /.well-known/oauth-authorization-server/api/auth and returns metadata", async () => {
    const { fetchImpl, calls } = captureFetch({
      ".well-known/oauth-authorization-server": () => jsonResponse(VALID_BODY),
    });

    const meta = await discover(API, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(meta).toEqual(VALID_BODY);
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      `${API}/.well-known/oauth-authorization-server/api/auth`,
    );
    expect(calls[0].headers["accept"]).toBe("application/json");
  });

  test("trims trailing slashes from the apiUrl", async () => {
    const { fetchImpl, calls } = captureFetch({
      ".well-known/oauth-authorization-server": () => jsonResponse(VALID_BODY),
    });

    await discover(`${API}//`, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(calls[0].url).toBe(
      `${API}/.well-known/oauth-authorization-server/api/auth`,
    );
  });

  test("non-2xx response → discovery_failed", async () => {
    const { fetchImpl } = captureFetch({
      ".well-known/oauth-authorization-server": () =>
        new Response("not found", { status: 404 }),
    });

    try {
      await discover(API, { fetchImpl: fetchImpl as unknown as typeof fetch });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("discovery_failed");
    }
  });

  test("non-JSON body → discovery_failed", async () => {
    const { fetchImpl } = captureFetch({
      ".well-known/oauth-authorization-server": () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    });

    try {
      await discover(API, { fetchImpl: fetchImpl as unknown as typeof fetch });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("discovery_failed");
    }
  });

  test("missing required fields → discovery_failed", async () => {
    const { fetchImpl } = captureFetch({
      ".well-known/oauth-authorization-server": () =>
        jsonResponse({
          authorization_endpoint: VALID_BODY.authorization_endpoint,
          token_endpoint: VALID_BODY.token_endpoint,
          // missing registration_endpoint and issuer
        }),
    });

    try {
      await discover(API, { fetchImpl: fetchImpl as unknown as typeof fetch });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("discovery_failed");
    }
  });

  test("network error → discovery_failed (cause preserved)", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };

    try {
      await discover(API, { fetchImpl: fetchImpl as unknown as typeof fetch });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthHelperError);
      expect((err as OAuthHelperError).code).toBe("discovery_failed");
      expect(((err as OAuthHelperError).cause as Error).message).toBe(
        "ECONNREFUSED",
      );
    }
  });
});
