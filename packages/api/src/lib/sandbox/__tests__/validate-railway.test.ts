/**
 * Railway credential validation tests (#3231). The Railway branch of
 * `validateCredentials` hits a fixed GraphQL endpoint — these tests mock
 * `globalThis.fetch` and assert the dispatch contract: required fields,
 * environment-scoped validation, GraphQL-errors-as-200 handling, and HTTP
 * auth failures.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { validateCredentials, validateRailwayCredentials } from "../validate";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

function mockFetchJson(body: unknown, status = 200): FetchFn {
  return mock(async (): Promise<Response> => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("validateCredentials — railway dispatch", () => {
  it("rejects a missing token without any network call", async () => {
    let called = false;
    globalThis.fetch = mock(async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as FetchFn;

    const result = await validateCredentials("railway", {});
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("API token is required");
    expect(called).toBe(false);
  });

  it("validates the environment when environmentId is supplied", async () => {
    const fetchMock = mockFetchJson({
      data: { environment: { id: "env-1", name: "staging" } },
    });
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("railway", {
      token: "rw_tok",
      environmentId: "env-1",
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.displayName).toBe("Railway (staging)");

    // The request must target the fixed Railway endpoint with the env query
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const [url, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://backboard.railway.com/graphql/v2");
    expect(String(init.headers && (init.headers as Record<string, string>).Authorization)).toBe(
      "Bearer rw_tok",
    );
    const body = JSON.parse((init.body as string)) as { query: string; variables?: { id: string } };
    expect(body.query).toContain("environment(id: $id)");
    expect(body.variables?.id).toBe("env-1");
  });

  it("rejects a missing environmentId without any network call (#3370)", async () => {
    // The BYOC runtime never falls back to the operator's
    // RAILWAY_ENVIRONMENT_ID env var, so a connect without environmentId
    // would store credentials that can never run.
    let called = false;
    globalThis.fetch = mock(async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as FetchFn;

    const result = await validateCredentials("railway", { token: "rw_tok" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Environment ID is required");
    expect(called).toBe(false);
  });

  it("validateRailwayCredentials still supports the me-query fallback directly", async () => {
    // The function-level optional param remains for callers outside the
    // connect dispatch (the dispatch itself requires environmentId).
    const fetchMock = mockFetchJson({ data: { me: { name: "Ada" } } });
    globalThis.fetch = fetchMock;

    const result = await validateRailwayCredentials("rw_tok");
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.displayName).toBe("Railway (Ada)");

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const [, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse((init.body as string)) as { query: string };
    expect(body.query).toContain("me { name }");
  });
});

describe("validateRailwayCredentials — failure shapes", () => {
  it("treats GraphQL errors (HTTP 200) as invalid", async () => {
    globalThis.fetch = mockFetchJson({
      errors: [{ message: "Not Authorized" }],
    });
    const result = await validateRailwayCredentials("rw_bad", "env-1");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Not Authorized");
      expect(result.error).toContain("env-1");
    }
  });

  it("scrubs control chars and truncates upstream GraphQL error text", async () => {
    globalThis.fetch = mockFetchJson({
      errors: [{ message: `bad\u0007token\u001b[31m ${"x".repeat(500)}` }],
    });
    const result = await validateRailwayCredentials("rw_bad", "env-1");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("bad token");
      expect(result.error).not.toContain("\u0007");
      expect(result.error).not.toContain("\u001b");
      expect(result.error).not.toContain("x".repeat(300));
    }
  });

  it("treats a null environment as not found", async () => {
    globalThis.fetch = mockFetchJson({ data: { environment: null } });
    const result = await validateRailwayCredentials("rw_tok", "env-missing");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("not found");
  });

  it("fails closed on a non-JSON 200 response (no environmentId path)", async () => {
    globalThis.fetch = mock(async (): Promise<Response> => {
      return new Response("<html>gateway error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as FetchFn;
    const result = await validateRailwayCredentials("rw_tok");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("non-JSON");
  });

  it("maps HTTP 401 to an invalid-token error", async () => {
    globalThis.fetch = mockFetchJson({}, 401);
    const result = await validateRailwayCredentials("rw_bad");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Invalid API token");
  });

  it("maps network failure to a reachability error", async () => {
    globalThis.fetch = mock(async (): Promise<Response> => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as FetchFn;
    const result = await validateRailwayCredentials("rw_tok");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Could not reach Railway API");
  });
});
