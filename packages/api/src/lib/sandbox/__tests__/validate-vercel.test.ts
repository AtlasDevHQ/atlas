/**
 * Vercel credential validation tests (#3370). The vercel branch of
 * `validateCredentials` makes two sequential calls — team lookup, then a
 * project-access check (the sandbox runtime needs the full
 * token/teamId/projectId triple, so project access must fail at connect
 * time, not at the org's first explore call). These tests mock
 * `globalThis.fetch` with a per-call response queue and assert the dispatch
 * contract: required fields, both probe outcomes, and status mapping.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { validateCredentials } from "../validate";

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch;

interface QueuedResponse {
  body: unknown;
  status?: number;
}

/** Fetch mock that pops responses in call order and records request URLs. */
function mockFetchQueue(responses: QueuedResponse[]): { fetch: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const queue = [...responses];
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    urls.push((typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url));
    const next = queue.shift();
    if (!next) throw new Error("fetch called more times than queued responses");
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
  return { fetch: fetchMock, urls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const FULL_CREDS = { accessToken: "vc_tok", teamId: "team_1", projectId: "prj_1" };

describe("validateCredentials — vercel dispatch", () => {
  it("rejects a missing projectId without any network call (#3370)", async () => {
    let called = false;
    globalThis.fetch = mock(async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as FetchFn;

    const result = await validateCredentials("vercel", {
      accessToken: "vc_tok",
      teamId: "team_1",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Project ID is required");
    expect(called).toBe(false);
  });

  it("validates team then project and returns the team name", async () => {
    const { fetch: fetchMock, urls } = mockFetchQueue([
      { body: { name: "Acme Team" } }, // team lookup
      { body: { id: "prj_1" } }, // project check
    ]);
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("vercel", FULL_CREDS);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.displayName).toBe("Acme Team");

    expect(urls.length).toBe(2);
    expect(urls[0]).toBe("https://api.vercel.com/v2/teams/team_1");
    expect(urls[1]).toBe("https://api.vercel.com/v9/projects/prj_1?teamId=team_1");
  });

  it("maps a project 404 to 'Project not found' even when the team check passes", async () => {
    const { fetch: fetchMock } = mockFetchQueue([
      { body: { name: "Acme Team" } },
      { body: {}, status: 404 },
    ]);
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("vercel", FULL_CREDS);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Project not found");
  });

  it("maps a project 403 to a token-scope error", async () => {
    const { fetch: fetchMock } = mockFetchQueue([
      { body: { name: "Acme Team" } },
      { body: {}, status: 403 },
    ]);
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("vercel", FULL_CREDS);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("cannot access this project");
  });

  it("still fails fast on a bad token at the team check (no project call)", async () => {
    const { fetch: fetchMock, urls } = mockFetchQueue([{ body: {}, status: 401 }]);
    globalThis.fetch = fetchMock;

    const result = await validateCredentials("vercel", FULL_CREDS);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Invalid access token");
    expect(urls.length).toBe(1);
  });
});
