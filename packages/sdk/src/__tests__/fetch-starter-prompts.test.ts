import { describe, test, expect, afterAll, afterEach, mock } from "bun:test";
import { fetchStarterPrompts, type FetchStarterPromptsConfig } from "../fetch-starter-prompts";

type FetchCall = [input: string | URL | Request, init?: RequestInit];

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const originalWarn = console.warn;
function installWarnSpy() {
  const spy = mock((..._args: unknown[]) => {});
  console.warn = spy as typeof console.warn;
  return spy;
}
afterEach(() => {
  console.warn = originalWarn;
});

function installFetchResponse(response: Response) {
  const calls: FetchCall[] = [];
  const mockFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push([input, init]);
    return response.clone();
  });
  globalThis.fetch = Object.assign(mockFn, { preconnect: () => {} }) as unknown as typeof fetch;
  return calls;
}

function installFetchError(error: Error) {
  const mockFn = mock(async () => {
    throw error;
  });
  globalThis.fetch = Object.assign(mockFn, { preconnect: () => {} }) as unknown as typeof fetch;
}

const BASE_CONFIG: FetchStarterPromptsConfig = {
  apiUrl: "https://api.example.com",
  credentials: "same-origin",
  headers: {},
};

describe("fetchStarterPrompts — happy path", () => {
  test("returns the prompts array from a 200 JSON body", async () => {
    installFetchResponse(
      new Response(
        JSON.stringify({
          prompts: [
            { id: "library:1", text: "Top customers?", provenance: "library" },
            { id: "favorite:2", text: "Revenue MoM", provenance: "favorite" },
          ],
          total: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchStarterPrompts(BASE_CONFIG);

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("library:1");
    expect(result[1]?.provenance).toBe("favorite");
  });

  test("forwards limit query parameter when provided", async () => {
    const calls = installFetchResponse(
      new Response(JSON.stringify({ prompts: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchStarterPrompts({ ...BASE_CONFIG, limit: 8 });

    expect(String(calls[0]?.[0])).toBe("https://api.example.com/api/v1/starter-prompts?limit=8");
  });

  test("uses the documented default limit of 6 when none is supplied", async () => {
    const calls = installFetchResponse(
      new Response(JSON.stringify({ prompts: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchStarterPrompts(BASE_CONFIG);

    expect(String(calls[0]?.[0])).toContain("limit=6");
  });

  test("defaults headers to {} when omitted", async () => {
    const calls = installFetchResponse(
      new Response(JSON.stringify({ prompts: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchStarterPrompts({
      apiUrl: "https://api.example.com",
      credentials: "same-origin",
    });

    expect(calls[0]?.[1]?.headers).toEqual({});
  });

  test("forwards credentials and headers to fetch", async () => {
    const calls = installFetchResponse(
      new Response(JSON.stringify({ prompts: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchStarterPrompts({
      apiUrl: "https://api.example.com",
      credentials: "include",
      headers: { Authorization: "Bearer abc" },
    });

    const init = calls[0]?.[1];
    expect(init?.credentials).toBe("include");
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer abc");
  });

  test("forwards the abort signal to fetch", async () => {
    const calls = installFetchResponse(
      new Response(JSON.stringify({ prompts: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const controller = new AbortController();

    await fetchStarterPrompts({ ...BASE_CONFIG, signal: controller.signal });

    expect(calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

describe("fetchStarterPrompts — malformed happy-path bodies", () => {
  test("returns [] when prompts field is missing", async () => {
    installFetchResponse(
      new Response(JSON.stringify({ total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchStarterPrompts(BASE_CONFIG);
    expect(result).toEqual([]);
  });

  test("returns [] when prompts is not an array", async () => {
    installFetchResponse(
      new Response(JSON.stringify({ prompts: "whoops" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchStarterPrompts(BASE_CONFIG);
    expect(result).toEqual([]);
  });

  test("returns [] and warns when a 200 response has a malformed JSON body", async () => {
    installFetchResponse(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const warn = installWarnSpy();

    const result = await fetchStarterPrompts(BASE_CONFIG);

    expect(result).toEqual([]);
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toMatch(/200/);
    expect(message).toMatch(/not valid JSON/);
  });
});

describe("fetchStarterPrompts — 5xx soft-fail", () => {
  test("returns [] on 500 and logs the requestId for ops correlation", async () => {
    installFetchResponse(
      new Response(JSON.stringify({ error: "boom", requestId: "req-500" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const warn = installWarnSpy();

    const result = await fetchStarterPrompts(BASE_CONFIG);

    expect(result).toEqual([]);
    expect(warn.mock.calls.length).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/req-500/);
  });

  test("returns [] on 503 Service Unavailable with non-JSON proxy body", async () => {
    installFetchResponse(
      new Response("<html>proxy error</html>", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    const result = await fetchStarterPrompts(BASE_CONFIG);
    expect(result).toEqual([]);
  });
});

describe("fetchStarterPrompts — 4xx throws", () => {
  test("throws on 401 with status and requestId in a single message", async () => {
    installFetchResponse(
      new Response(JSON.stringify({ error: "unauthorized", requestId: "req-abc" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const err = await fetchStarterPrompts(BASE_CONFIG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).toMatch(/req-abc/);
  });

  test("throws on 403 without requestId when body is not JSON", async () => {
    installFetchResponse(
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );

    const err = await fetchStarterPrompts(BASE_CONFIG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Starter prompts 403 Forbidden");
  });

  test("throws on 429 rate limit", async () => {
    installFetchResponse(
      new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchStarterPrompts(BASE_CONFIG)).rejects.toThrow(/429/);
  });

  test("falls back to '(no status text)' when statusText is empty", async () => {
    installFetchResponse(new Response("x", { status: 418 }));

    const err = await fetchStarterPrompts(BASE_CONFIG).catch((e: unknown) => e);
    expect((err as Error).message).toContain("(no status text)");
  });

  test("ignores requestId when body is JSON but not an object (e.g. 'null')", async () => {
    installFetchResponse(
      new Response("null", {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const err = await fetchStarterPrompts(BASE_CONFIG).catch((e: unknown) => e);
    expect((err as Error).message).toBe("Starter prompts 400 Bad Request");
  });
});

describe("fetchStarterPrompts — network failure", () => {
  test("throws with wrapped cause when fetch itself rejects", async () => {
    const networkError = new TypeError("Failed to fetch");
    installFetchError(networkError);
    const warn = installWarnSpy();

    const err = await fetchStarterPrompts(BASE_CONFIG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Failed to fetch/);
    expect((err as Error).cause).toBe(networkError);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("does not warn when the caller aborts (AbortError)", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    installFetchError(abortError);
    const warn = installWarnSpy();
    const controller = new AbortController();
    controller.abort();

    const err = await fetchStarterPrompts({
      ...BASE_CONFIG,
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).cause).toBe(abortError);
    expect(warn.mock.calls.length).toBe(0);
  });
});
