/**
 * TwentyClient unit tests — covers happy path, 4xx error mapping,
 * 5xx behavior, bearer-auth header construction, and the
 * first-source-preservation logic (parameterized on existing-Person state).
 *
 * All HTTP traffic is mocked via a fetch impl override — there are NO
 * live calls to crm.useatlas.dev or any other Twenty instance.
 */
import { describe, test, expect } from "bun:test";
import {
  upsertPerson,
  getPersonMetadata,
  TwentyClientError,
  type TwentyClientConfig,
  type TwentyPerson,
} from "../src/client";

// ─────────────────────────────────────────────────────────────────────
//  Fetch helpers
// ─────────────────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface ScriptedResponse {
  status: number;
  body: unknown;
}

function makeScriptedFetch(responses: ScriptedResponse[]): {
  fetch: typeof globalThis.fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k] = v;
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? String(init.body) : undefined,
    });
    if (i >= responses.length) {
      throw new Error(
        `scripted fetch out of responses (call ${i + 1} of ${responses.length}) — url=${url}`,
      );
    }
    const r = responses[i++];
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

function baseConfig(overrides?: Partial<TwentyClientConfig>): TwentyClientConfig {
  return {
    apiKey: "twenty_test_apikey_xyz",
    baseUrl: "https://crm.test.local",
    fetchImpl: undefined,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  upsertPerson — first-source preservation matrix
// ─────────────────────────────────────────────────────────────────────

describe("upsertPerson — Person absent", () => {
  test("POSTs new Person with both atlasFirstSource and atlasLastSource set to eventSource", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } }, // GET — nothing found
      {
        status: 200,
        body: {
          data: {
            createPerson: {
              id: "person_123",
              emails: { primaryEmail: "user@test.com" },
              atlasFirstSource: "DEMO",
              atlasLastSource: "DEMO",
            } as TwentyPerson,
          },
        },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    const result = await upsertPerson(config, {
      email: "user@test.com",
      eventSource: "DEMO",
      customFields: { atlasIp: "1.2.3.4" },
    });

    expect(result.id).toBe("person_123");
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/rest/people?filter");
    // Twenty's bracket-nested filter syntax — verified against Twenty REST docs.
    expect(calls[0].url).toContain("filter[emails.primaryEmail][eq]=");
    expect(calls[0].url).toContain(encodeURIComponent("user@test.com"));

    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe("https://crm.test.local/rest/people");
    const body = JSON.parse(calls[1].body ?? "{}");
    // Custom fields live INLINE on the Person — no `customFields` wrapper.
    expect(body.emails).toEqual({ primaryEmail: "user@test.com" });
    expect(body.atlasIp).toBe("1.2.3.4");
    expect(body.atlasFirstSource).toBe("DEMO");
    expect(body.atlasLastSource).toBe("DEMO");
    expect(body.customFields).toBeUndefined();
  });
});

describe("upsertPerson — Person exists with atlasFirstSource set", () => {
  test("PATCHes only atlasLastSource — atlasFirstSource is sticky", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [
              {
                id: "person_existing",
                emails: { primaryEmail: "user@test.com" },
                atlasFirstSource: "SALES_FORM",
                atlasLastSource: "SALES_FORM",
              },
            ],
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            updatePerson: {
              id: "person_existing",
              atlasFirstSource: "SALES_FORM",
              atlasLastSource: "DEMO",
            },
          },
        },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    const result = await upsertPerson(config, {
      email: "user@test.com",
      eventSource: "DEMO",
    });

    expect(result.id).toBe("person_existing");
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].url).toBe(
      "https://crm.test.local/rest/people/person_existing",
    );
    const body = JSON.parse(calls[1].body ?? "{}");
    expect(body.atlasLastSource).toBe("DEMO");
    // CRITICAL: payload must NOT include atlasFirstSource at all
    expect(body.atlasFirstSource).toBeUndefined();
  });

  test("PATCH includes name when provided (input.name merges into every write path)", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [
              {
                id: "person_existing",
                emails: { primaryEmail: "user@test.com" },
                atlasFirstSource: "DEMO",
              },
            ],
          },
        },
      },
      { status: 200, body: { data: { updatePerson: { id: "person_existing" } } } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    await upsertPerson(config, {
      email: "user@test.com",
      eventSource: "SIGNUP",
      name: { firstName: "Alice", lastName: "Smith" },
    });

    const body = JSON.parse(calls[1].body ?? "{}");
    expect(body.name).toEqual({ firstName: "Alice", lastName: "Smith" });
    expect(body.atlasLastSource).toBe("SIGNUP");
  });
});

describe("upsertPerson — Person exists but atlasFirstSource is absent", () => {
  test("PATCHes both fields — treats this dispatch as the first stamped touch", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [
              {
                id: "person_unstamped",
                emails: { primaryEmail: "user@test.com" },
              },
            ],
          },
        },
      },
      {
        status: 200,
        body: { data: { updatePerson: { id: "person_unstamped" } } },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    await upsertPerson(config, {
      email: "user@test.com",
      eventSource: "DEMO",
    });

    expect(calls[1].method).toBe("PATCH");
    const body = JSON.parse(calls[1].body ?? "{}");
    expect(body.atlasFirstSource).toBe("DEMO");
    expect(body.atlasLastSource).toBe("DEMO");
  });

  test("treats empty-string atlasFirstSource as absent", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [
              {
                id: "person_empty",
                emails: { primaryEmail: "user@test.com" },
                atlasFirstSource: "",
              },
            ],
          },
        },
      },
      { status: 200, body: { data: { updatePerson: { id: "person_empty" } } } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    await upsertPerson(config, {
      email: "user@test.com",
      eventSource: "SIGNUP",
    });

    const body = JSON.parse(calls[1].body ?? "{}");
    expect(body.atlasFirstSource).toBe("SIGNUP");
    expect(body.atlasLastSource).toBe("SIGNUP");
  });

  test("PATCH includes name on the both-fields branch too", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [
              {
                id: "person_unstamped",
                emails: { primaryEmail: "user@test.com" },
              },
            ],
          },
        },
      },
      { status: 200, body: { data: { updatePerson: { id: "person_unstamped" } } } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    await upsertPerson(config, {
      email: "user@test.com",
      eventSource: "DEMO",
      name: { firstName: "Bob" },
    });

    const body = JSON.parse(calls[1].body ?? "{}");
    expect(body.name).toEqual({ firstName: "Bob" });
    expect(body.atlasFirstSource).toBe("DEMO");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Malformed-200 fail-loud (regression for R-2)
// ─────────────────────────────────────────────────────────────────────

describe("upsertPerson — malformed 200 from findPersonByEmail", () => {
  test("throws TwentyClientError when data.people is null", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: { data: { people: null } } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.operation).toBe("findPersonByEmail");
      expect(e.message).toContain("unexpected response shape");
    }
  });

  test("throws TwentyClientError when data is absent entirely", async () => {
    const { fetch } = makeScriptedFetch([{ status: 200, body: {} }]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      expect((err as TwentyClientError).operation).toBe("findPersonByEmail");
    }
  });

  test("empty array IS valid — POSTs a new Person", async () => {
    // Sanity: empty array is a documented well-formed shape — must NOT throw.
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } },
      { status: 200, body: { data: { createPerson: { id: "new" } } } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("POST");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Bearer auth header
// ─────────────────────────────────────────────────────────────────────

describe("upsertPerson — auth header", () => {
  test("sends Authorization: Bearer <apiKey>", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } },
      { status: 200, body: { data: { createPerson: { id: "x" } } } },
    ]);
    const config = baseConfig({
      apiKey: "twenty_secret_abc",
      fetchImpl: fetch,
    });

    await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
    expect(calls[0].headers.Authorization).toBe("Bearer twenty_secret_abc");
    expect(calls[1].headers.Authorization).toBe("Bearer twenty_secret_abc");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  test("does not include the apiKey in thrown error messages", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 401, body: { messages: ["Unauthorized"] } },
    ]);
    const config = baseConfig({
      apiKey: "twenty_secret_should_not_leak",
      fetchImpl: fetch,
    });

    try {
      await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const msg = (err as TwentyClientError).message;
      expect(msg).not.toContain("twenty_secret_should_not_leak");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  4xx + 5xx error mapping (operation discriminator)
// ─────────────────────────────────────────────────────────────────────

describe("upsertPerson — error mapping", () => {
  test("maps 401 to TwentyClientError with status=401 + operation=findPersonByEmail", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 401, body: { messages: ["Invalid API key"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.status).toBe(401);
      expect(e.operation).toBe("findPersonByEmail");
      expect(e.message).toContain("Invalid API key");
    }
  });

  test("maps 422 on createPerson to TwentyClientError with upstream code + operation=createPerson", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } },
      {
        status: 422,
        body: {
          messages: ["atlasFirstSource is unknown"],
          code: "FIELD_NOT_FOUND",
        },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.status).toBe(422);
      expect(e.upstreamCode).toBe("FIELD_NOT_FOUND");
      expect(e.operation).toBe("createPerson");
      expect(e.message).toContain("atlasFirstSource");
    }
  });

  test("maps 500 to TwentyClientError with status=500", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 500, body: { messages: ["internal error"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      expect((err as TwentyClientError).status).toBe(500);
    }
  });

  test("PATCH error includes operation=updatePerson", async () => {
    const { fetch } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [{ id: "p1", atlasFirstSource: "DEMO" }],
          },
        },
      },
      { status: 422, body: { messages: ["bad patch"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await upsertPerson(config, { email: "u@t.com", eventSource: "SIGNUP" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      expect((err as TwentyClientError).operation).toBe("updatePerson");
    }
  });

  test("handles non-JSON error body without crashing", async () => {
    const fetchImpl = (async () =>
      new Response("<html>503 Bad Gateway</html>", {
        status: 503,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof globalThis.fetch;
    const config = baseConfig({ fetchImpl });

    try {
      await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.status).toBe(503);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  test("transport failure (rejected fetch) surfaces as Error (not TwentyClientError)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const config = baseConfig({ fetchImpl });

    try {
      await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("ECONNREFUSED");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  URL composition
// ─────────────────────────────────────────────────────────────────────

describe("upsertPerson — URL composition", () => {
  test("strips trailing slashes on baseUrl (no regex backtracking)", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } },
      { status: 200, body: { data: { createPerson: { id: "x" } } } },
    ]);
    const config = baseConfig({
      baseUrl: "https://crm.test.local///",
      fetchImpl: fetch,
    });

    await upsertPerson(config, { email: "u@t.com", eventSource: "DEMO" });
    expect(calls[0].url).toMatch(/^https:\/\/crm\.test\.local\/rest\/people\?/);
    expect(calls[1].url).toBe("https://crm.test.local/rest/people");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  getPersonMetadata (GraphQL)
// ─────────────────────────────────────────────────────────────────────

describe("getPersonMetadata", () => {
  test("POSTs the GraphQL probe to /metadata and returns the fields list", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            objects: {
              edges: [
                {
                  node: {
                    fields: {
                      edges: [
                        { node: { name: "id" } },
                        { node: { name: "atlasFirstSource" } },
                        { node: { name: "atlasLastSource" } },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    const meta = await getPersonMetadata(config);
    expect(meta.fields.map((f) => f.name)).toContain("atlasFirstSource");
    expect(meta.fields.map((f) => f.name)).toContain("atlasLastSource");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://crm.test.local/metadata");
    // GraphQL body
    const body = JSON.parse(calls[0].body ?? "{}");
    expect(typeof body.query).toBe("string");
    expect(body.query).toContain("objects");
    expect(body.query).toContain("nameSingular");
    expect(body.query).toContain("person");
  });

  test("returns empty fields list when the object isn't present", async () => {
    const { fetch } = makeScriptedFetch([
      {
        status: 200,
        body: { data: { objects: { edges: [] } } },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    const meta = await getPersonMetadata(config);
    expect(meta.fields).toEqual([]);
  });

  test("throws TwentyClientError when GraphQL returns errors[] in a 2xx body", async () => {
    const { fetch } = makeScriptedFetch([
      {
        status: 200,
        body: { errors: [{ message: "Permission denied" }] },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await getPersonMetadata(config);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.operation).toBe("getPersonMetadata");
      expect(e.message).toContain("Permission denied");
    }
  });

  test("surfaces 401 as TwentyClientError with operation=getPersonMetadata", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 401, body: { messages: ["bad key"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await getPersonMetadata(config);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.status).toBe(401);
      expect(e.operation).toBe("getPersonMetadata");
    }
  });

  test("surfaces 404 as TwentyClientError (caller treats as misconfiguration)", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 404, body: { messages: ["not found"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await getPersonMetadata(config);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      expect((err as TwentyClientError).status).toBe(404);
    }
  });
});
