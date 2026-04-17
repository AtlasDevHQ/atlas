import { describe, test, expect, afterAll, mock } from "bun:test";
import { fetchStarterPrompts, type FetchStarterPromptsConfig } from "../fetch-starter-prompts";

type FetchCall = [input: string | URL | Request, init?: RequestInit];

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
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

  test("uses a default limit when none is supplied", async () => {
    const calls = installFetchResponse(
      new Response(JSON.stringify({ prompts: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchStarterPrompts(BASE_CONFIG);

    expect(String(calls[0]?.[0])).toContain("limit=");
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
});

describe("fetchStarterPrompts — 5xx soft-fail", () => {
  test("returns [] on 500 Internal Server Error", async () => {
    installFetchResponse(
      new Response(JSON.stringify({ error: "boom", requestId: "req-500" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchStarterPrompts(BASE_CONFIG);
    expect(result).toEqual([]);
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
  test("throws on 401 with requestId in the message", async () => {
    installFetchResponse(
      new Response(JSON.stringify({ error: "unauthorized", requestId: "req-abc" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchStarterPrompts(BASE_CONFIG)).rejects.toThrow(/401/);
    await expect(fetchStarterPrompts(BASE_CONFIG)).rejects.toThrow(/req-abc/);
  });

  test("throws on 403 without requestId when body is not JSON", async () => {
    installFetchResponse(
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );

    const promise = fetchStarterPrompts(BASE_CONFIG);
    await expect(promise).rejects.toThrow(/403/);
    await expect(fetchStarterPrompts(BASE_CONFIG)).rejects.not.toThrow(/requestId/);
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
});

describe("fetchStarterPrompts — network failure", () => {
  test("throws with wrapped cause when fetch itself rejects", async () => {
    const networkError = new TypeError("Failed to fetch");
    installFetchError(networkError);

    try {
      await fetchStarterPrompts(BASE_CONFIG);
      throw new Error("expected fetchStarterPrompts to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Failed to fetch/);
      expect((err as Error).cause).toBe(networkError);
    }
  });
});
