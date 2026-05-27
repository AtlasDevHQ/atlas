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
  stampStripeCustomerId,
  getPersonMetadata,
  getPersonRestSchema,
  createNote,
  listPeople,
  getPerson,
  searchPeople,
  listNotes,
  listCompanies,
  searchCompanies,
  deletePerson,
  deleteNote,
  deleteCompany,
  wipeWorkspace,
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
    expect(calls[0].url).toContain("/rest/people?filter=");
    // Twenty's documented filter syntax: `field[COMPARATOR]:value`
    // (per its OpenAPI spec's `components.parameters.filter` description).
    // The bracket-nested form `filter[field][op]=value` is silently
    // ignored by Twenty and returns the unfiltered list — guard against
    // a regression to that shape.
    expect(calls[0].url).toContain("filter=emails.primaryEmail[eq]:");
    expect(calls[0].url).not.toContain("filter[emails.primaryEmail][eq]=");
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
//  Broken filter / email-mismatch fail-loud (regression-guard for #2865)
//
//  Reproduces the catastrophic-collapse signature at the client layer:
//  if Twenty ever returns the unfiltered list (because our filter syntax
//  regressed or Twenty's filter validator loosens), `findPersonByEmail`
//  must refuse rather than merge to a different person's record. Pins
//  the contract without depending on api.twenty.com's filter-tolerance.
// ─────────────────────────────────────────────────────────────────────

describe("upsertPerson — broken filter / email mismatch", () => {
  test("throws TwentyClientError when returned Person's primaryEmail differs from queried email", async () => {
    // Simulates Twenty silently ignoring the filter and returning the
    // unfiltered list — `list[0]` belongs to someone else entirely.
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [
              {
                id: "person_someone_else",
                emails: { primaryEmail: "someone-else@elsewhere.com" },
                atlasFirstSource: "DEMO",
              },
            ],
          },
        },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await upsertPerson(config, {
        email: "queried@test.com",
        eventSource: "DEMO",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.operation).toBe("findPersonByEmail");
      expect(e.message).toContain("email mismatch");
      expect(e.message).toContain("queried@test.com");
      expect(e.message).toContain("someone-else@elsewhere.com");
    }

    // CRITICAL: no PATCH or POST may have followed the find. Only the
    // GET filter call should have happened.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");

    // Belt-and-suspenders: pin the Atlas-side filter format to Twenty's
    // documented `field[op]:value` form. If a future change reverts to
    // the bracket-nested `filter[field][op]=value` form (the #2865
    // regression shape), this assertion fails alongside the mismatch
    // guard — making the new test sufficient on its own to catch the
    // filter line regressing, independent of api.twenty.com's filter
    // validator hardening.
    expect(calls[0].url).toContain("filter=emails.primaryEmail[eq]:");
    expect(calls[0].url).not.toContain("filter[emails.primaryEmail][eq]=");
  });

  test("throws TwentyClientError when returned Person has no emails field at all", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [{ id: "person_no_email", atlasFirstSource: "DEMO" }],
          },
        },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await upsertPerson(config, {
        email: "queried@test.com",
        eventSource: "DEMO",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.operation).toBe("findPersonByEmail");
      expect(e.message).toContain("email mismatch");
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  test("case-insensitive match — queried Foo@Bar.com vs returned foo@bar.com proceeds to PATCH", async () => {
    // Twenty stores emails as-entered but matches case-insensitively per
    // its docs — guard that we don't reject a legitimately-matched Person
    // just because the case differs.
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [
              {
                id: "person_case_match",
                emails: { primaryEmail: "foo@bar.com" },
                atlasFirstSource: "DEMO",
              },
            ],
          },
        },
      },
      {
        status: 200,
        body: { data: { updatePerson: { id: "person_case_match" } } },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    const result = await upsertPerson(config, {
      email: "Foo@Bar.com",
      eventSource: "SIGNUP",
    });

    expect(result.id).toBe("person_case_match");
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].url).toBe(
      "https://crm.test.local/rest/people/person_case_match",
    );
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
            people: [
              {
                id: "p1",
                emails: { primaryEmail: "u@t.com" },
                atlasFirstSource: "DEMO",
              },
            ],
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

// ─────────────────────────────────────────────────────────────────────
//  createNote — happy path + error mapping
// ─────────────────────────────────────────────────────────────────────

describe("createNote — happy path", () => {
  test("POSTs /rest/notes with bodyV2.markdown, then POSTs /rest/noteTargets with noteId + targetPersonId, returns the noteId", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: { data: { createNote: { id: "note_abc" } } },
      },
      {
        status: 200,
        body: { data: { createNoteTarget: { id: "nt_def", noteId: "note_abc", targetPersonId: "person_xyz" } } },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    const result = await createNote(config, {
      personId: "person_xyz",
      title: "Talk to sales — Acme (Business)",
      body: "We need ten seats and SSO.",
    });

    expect(result.id).toBe("note_abc");
    expect(calls).toHaveLength(2);

    // First call — create note
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://crm.test.local/rest/notes");
    const noteBody = JSON.parse(calls[0].body ?? "{}");
    expect(noteBody.title).toBe("Talk to sales — Acme (Business)");
    // bodyV2.markdown is the canonical input shape — Twenty generates blocknote.
    expect(noteBody.bodyV2).toEqual({ markdown: "We need ten seats and SSO." });
    expect(noteBody.body).toBeUndefined();

    // Second call — link to person
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe("https://crm.test.local/rest/noteTargets");
    const linkBody = JSON.parse(calls[1].body ?? "{}");
    expect(linkBody).toEqual({ noteId: "note_abc", targetPersonId: "person_xyz" });
  });

  test("sends Authorization: Bearer <apiKey> on both calls", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { createNote: { id: "n1" } } } },
      { status: 200, body: { data: { createNoteTarget: { id: "nt1" } } } },
    ]);
    const config = baseConfig({
      apiKey: "twenty_secret_xyz",
      fetchImpl: fetch,
    });

    await createNote(config, {
      personId: "p1",
      title: "t",
      body: "b",
    });

    expect(calls[0].headers.Authorization).toBe("Bearer twenty_secret_xyz");
    expect(calls[1].headers.Authorization).toBe("Bearer twenty_secret_xyz");
  });
});

describe("createNote — error mapping", () => {
  test("maps 401 on createNote to TwentyClientError with operation=createNote", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 401, body: { messages: ["Unauthorized"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await createNote(config, { personId: "p", title: "t", body: "b" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.status).toBe(401);
      expect(e.operation).toBe("createNote");
      expect(e.message).toContain("Unauthorized");
    }
    // noteTarget link must NOT be attempted when note creation fails.
    expect(calls).toHaveLength(1);
  });

  test("maps 422 on createNote (e.g. missing required field) to TwentyClientError with upstream code", async () => {
    const { fetch } = makeScriptedFetch([
      {
        status: 422,
        body: { messages: ["title is required"], code: "FIELD_REQUIRED" },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await createNote(config, { personId: "p", title: "", body: "" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.status).toBe(422);
      expect(e.upstreamCode).toBe("FIELD_REQUIRED");
      expect(e.operation).toBe("createNote");
    }
  });

  test("maps 5xx on createNote to transient-friendly TwentyClientError", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 503, body: { messages: ["upstream down"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await createNote(config, { personId: "p", title: "t", body: "b" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      expect((err as TwentyClientError).status).toBe(503);
    }
  });

  test("createNote succeeds but noteTarget link fails → TwentyClientError with operation=createNoteTarget", async () => {
    // Realistic regression: the note is created but the link step fails.
    // The caller (dispatchOutboxRow) needs to see operation=createNoteTarget
    // so the retry policy classifies correctly. (The note is orphaned in
    // Twenty — operator cleans up; cost is acceptable vs. dropping the lead.)
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { createNote: { id: "orphan_note" } } } },
      { status: 500, body: { messages: ["link failed"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await createNote(config, { personId: "p", title: "t", body: "b" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.status).toBe(500);
      expect(e.operation).toBe("createNoteTarget");
    }
    expect(calls).toHaveLength(2);
  });

  test("createNote 200 with no id → TwentyClientError (no silent success)", async () => {
    // Defense against a future Twenty fast-path that returns 2xx + empty body.
    // Without the id we can't link the noteTarget, so this MUST fail loud
    // rather than return a meaningless result.
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { createNote: {} } } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await createNote(config, { personId: "p", title: "t", body: "b" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      expect((err as TwentyClientError).operation).toBe("createNote");
      expect((err as TwentyClientError).message).toContain("no id");
    }
    // No link attempt — we have no noteId.
    expect(calls).toHaveLength(1);
  });

  test("retry-after on 429 surfaces through TwentyClientError.retryAfterMs", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: ["rate limited"] }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "120" },
      })) as unknown as typeof globalThis.fetch;
    const config = baseConfig({ fetchImpl });

    try {
      await createNote(config, { personId: "p", title: "t", body: "b" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.status).toBe(429);
      expect(e.retryAfterMs).toBe(120_000);
    }
  });

  test("does not include the apiKey in thrown error messages", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 401, body: { messages: ["bad key"] } },
    ]);
    const config = baseConfig({
      apiKey: "twenty_secret_must_not_leak",
      fetchImpl: fetch,
    });

    try {
      await createNote(config, { personId: "p", title: "t", body: "b" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const msg = (err as TwentyClientError).message;
      expect(msg).not.toContain("twenty_secret_must_not_leak");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  stampStripeCustomerId — Stripe → Twenty conversion stamping (#2737)
// ─────────────────────────────────────────────────────────────────────

describe("stampStripeCustomerId — Person exists with atlasFirstSource set", () => {
  test("PATCHes atlasLastSource = CONVERSION + atlasStripeCustomerId — atlasFirstSource preserved", async () => {
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
                atlasLastSource: "DEMO",
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
              atlasFirstSource: "DEMO",
              atlasLastSource: "CONVERSION",
              atlasStripeCustomerId: "cus_abc123",
            },
          },
        },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    const result = await stampStripeCustomerId(config, {
      email: "user@test.com",
      stripeCustomerId: "cus_abc123",
    });

    expect(result.id).toBe("person_existing");
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].url).toBe(
      "https://crm.test.local/rest/people/person_existing",
    );
    const body = JSON.parse(calls[1].body ?? "{}");
    // atlasFirstSource is sticky — must NOT be in the payload.
    expect(body.atlasFirstSource).toBeUndefined();
    expect(body.atlasLastSource).toBe("CONVERSION");
    expect(body.atlasStripeCustomerId).toBe("cus_abc123");
  });
});

describe("stampStripeCustomerId — Person does not exist (paying customer never demoed)", () => {
  test("POSTs a new Person with atlasFirstSource = CONVERSION, atlasLastSource = CONVERSION, AND atlasStripeCustomerId", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } },
      {
        status: 200,
        body: {
          data: {
            createPerson: {
              id: "person_new",
              emails: { primaryEmail: "first.touch@test.com" },
              atlasFirstSource: "CONVERSION",
              atlasLastSource: "CONVERSION",
              atlasStripeCustomerId: "cus_xyz",
            } as TwentyPerson,
          },
        },
      },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    const result = await stampStripeCustomerId(config, {
      email: "first.touch@test.com",
      stripeCustomerId: "cus_xyz",
    });

    expect(result.id).toBe("person_new");
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe("https://crm.test.local/rest/people");
    const body = JSON.parse(calls[1].body ?? "{}");
    // Custom fields inline — no `customFields` wrapper.
    expect(body.emails).toEqual({ primaryEmail: "first.touch@test.com" });
    expect(body.atlasFirstSource).toBe("CONVERSION");
    expect(body.atlasLastSource).toBe("CONVERSION");
    expect(body.atlasStripeCustomerId).toBe("cus_xyz");
    expect(body.customFields).toBeUndefined();
  });
});

describe("stampStripeCustomerId — Person exists but atlasFirstSource absent", () => {
  test("PATCHes both source fields to CONVERSION + atlasStripeCustomerId", async () => {
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

    await stampStripeCustomerId(config, {
      email: "user@test.com",
      stripeCustomerId: "cus_first",
    });

    const body = JSON.parse(calls[1].body ?? "{}");
    expect(body.atlasFirstSource).toBe("CONVERSION");
    expect(body.atlasLastSource).toBe("CONVERSION");
    expect(body.atlasStripeCustomerId).toBe("cus_first");
  });
});

describe("stampStripeCustomerId — error mapping", () => {
  test("maps 4xx to TwentyClientError (caller treats permanent)", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 401, body: { messages: ["bad key"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await stampStripeCustomerId(config, {
        email: "u@t.com",
        stripeCustomerId: "cus_1",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      const e = err as TwentyClientError;
      expect(e.status).toBe(401);
      // The first sub-step that errors carries the operation discriminator.
      expect(e.operation).toBe("findPersonByEmail");
    }
  });

  test("5xx surfaces as TwentyClientError with status — outbox retries", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 503, body: { messages: ["upstream down"] } },
    ]);
    const config = baseConfig({ fetchImpl: fetch });

    try {
      await stampStripeCustomerId(config, {
        email: "u@t.com",
        stripeCustomerId: "cus_1",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      expect((err as TwentyClientError).status).toBe(503);
    }
  });

  test("does not include the apiKey in thrown error messages", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 401, body: { messages: ["bad key"] } },
    ]);
    const config = baseConfig({
      apiKey: "twenty_secret_stamp_must_not_leak",
      fetchImpl: fetch,
    });

    try {
      await stampStripeCustomerId(config, {
        email: "u@t.com",
        stripeCustomerId: "cus_1",
      });
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as TwentyClientError).message;
      expect(msg).not.toContain("twenty_secret_stamp_must_not_leak");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  getPersonRestSchema — REST OpenAPI probe
// ─────────────────────────────────────────────────────────────────────

function openApiResponse(fieldNames: string[]): { status: number; body: unknown } {
  const properties: Record<string, { type: string }> = {};
  for (const name of fieldNames) properties[name] = { type: "string" };
  return {
    status: 200,
    body: { openapi: "3.1.1", components: { schemas: { Person: { properties } } } },
  };
}

describe("getPersonRestSchema", () => {
  test("returns a Set of every Person property name", async () => {
    const { fetch } = makeScriptedFetch([
      openApiResponse(["id", "name", "atlasFirstSource", "atlasLastSource", "atlasIp"]),
    ]);
    const result = await getPersonRestSchema(baseConfig({ fetchImpl: fetch }));
    expect(result.fields.has("atlasFirstSource")).toBe(true);
    expect(result.fields.has("atlasIp")).toBe(true);
    expect(result.fields.has("nonexistent")).toBe(false);
  });

  test("hits /rest/open-api/core with a GET + bearer header", async () => {
    const { fetch, calls } = makeScriptedFetch([openApiResponse(["id"])]);
    await getPersonRestSchema(baseConfig({ fetchImpl: fetch }));
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://crm.test.local/rest/open-api/core");
    expect(calls[0].headers["Authorization"]).toBe("Bearer twenty_test_apikey_xyz");
  });

  test("throws TwentyClientError when Person schema is missing from the document", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: { openapi: "3.1.1", components: { schemas: {} } } },
    ]);
    try {
      await getPersonRestSchema(baseConfig({ fetchImpl: fetch }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      expect((err as TwentyClientError).operation).toBe("getPersonRestSchema");
    }
  });

  test("propagates 401 as TwentyClientError with status preserved", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 401, body: { messages: ["Unauthorized"] } },
    ]);
    try {
      await getPersonRestSchema(baseConfig({ fetchImpl: fetch }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TwentyClientError);
      expect((err as TwentyClientError).status).toBe(401);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  allowedPersonFields — write-path filter
// ─────────────────────────────────────────────────────────────────────

describe("upsertPerson with allowedPersonFields", () => {
  test("strips payload keys not in the allowlist before POST", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } }, // findPersonByEmail miss
      { status: 200, body: { data: { person: { id: "p1" } } } }, // createPerson ok
    ]);
    await upsertPerson(
      baseConfig({
        fetchImpl: fetch,
        // Workspace exposes only the required fields — atlasIp is NOT defined.
        allowedPersonFields: new Set([
          "emails",
          "name",
          "atlasFirstSource",
          "atlasLastSource",
        ]),
      }),
      {
        email: "alice@example.com",
        name: { firstName: "Alice" },
        eventSource: "DEMO",
        customFields: { atlasIp: "1.2.3.4", atlasStripeCustomerId: "cus_abc" },
      },
    );
    const post = calls[1];
    expect(post.method).toBe("POST");
    const body = JSON.parse(post.body ?? "{}") as Record<string, unknown>;
    expect(body.atlasFirstSource).toBe("DEMO");
    expect(body.atlasLastSource).toBe("DEMO");
    expect(body.name).toEqual({ firstName: "Alice" });
    expect(body.emails).toEqual({ primaryEmail: "alice@example.com" });
    // Dropped because not in allowlist:
    expect("atlasIp" in body).toBe(false);
    expect("atlasStripeCustomerId" in body).toBe(false);
  });

  test("sends every payload key when allowedPersonFields is unset (today's behaviour)", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } },
      { status: 200, body: { data: { person: { id: "p1" } } } },
    ]);
    await upsertPerson(baseConfig({ fetchImpl: fetch }), {
      email: "alice@example.com",
      eventSource: "DEMO",
      customFields: { atlasIp: "1.2.3.4" },
    });
    const body = JSON.parse(calls[1].body ?? "{}") as Record<string, unknown>;
    expect(body.atlasIp).toBe("1.2.3.4");
  });

  test("strips disallowed keys on the PATCH path too", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [{ id: "p1", atlasFirstSource: "DEMO", emails: { primaryEmail: "alice@example.com" } }],
          },
        },
      },
      { status: 200, body: { data: { updatePerson: { id: "p1" } } } },
    ]);
    await upsertPerson(
      baseConfig({
        fetchImpl: fetch,
        allowedPersonFields: new Set(["emails", "atlasFirstSource", "atlasLastSource"]),
      }),
      {
        email: "alice@example.com",
        eventSource: "SIGNUP",
        customFields: { atlasIp: "9.9.9.9" },
      },
    );
    const patch = calls[1];
    expect(patch.method).toBe("PATCH");
    const body = JSON.parse(patch.body ?? "{}") as Record<string, unknown>;
    expect(body.atlasLastSource).toBe("SIGNUP");
    expect("atlasIp" in body).toBe(false);
    // sticky first-source not in the payload since it already had one
    expect("atlasFirstSource" in body).toBe(false);
  });
});

describe("listPeople", () => {
  test("GETs /rest/people with optional limit + starting_after; returns the array", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            people: [
              { id: "p1", emails: { primaryEmail: "a@x.com" } },
              { id: "p2", emails: { primaryEmail: "b@x.com" } },
            ],
          },
        },
      },
    ]);
    const result = await listPeople(baseConfig({ fetchImpl: fetch }), {
      limit: 25,
      startingAfter: "cursor-abc",
    });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("p1");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/rest/people?");
    expect(calls[0].url).toContain("limit=25");
    expect(calls[0].url).toContain("starting_after=cursor-abc");
  });

  test("throws TwentyClientError with operation=listPeople on 4xx", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 401, body: { messages: ["unauthorized"] } },
    ]);
    await expect(listPeople(baseConfig({ fetchImpl: fetch }))).rejects.toMatchObject({
      _tag: "TwentyClientError",
      operation: "listPeople",
      status: 401,
    });
  });
});

describe("getPerson", () => {
  test("GETs /rest/people/{id}; returns the person", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: {
          data: {
            person: {
              id: "person_xyz",
              emails: { primaryEmail: "a@x.com" },
              atlasFirstSource: "DEMO",
            },
          },
        },
      },
    ]);
    const result = await getPerson(baseConfig({ fetchImpl: fetch }), "person_xyz");
    expect(result?.id).toBe("person_xyz");
    expect(result?.atlasFirstSource).toBe("DEMO");
    expect(calls[0].url).toBe("https://crm.test.local/rest/people/person_xyz");
  });

  test("returns the whole upstream Person — no field subsetting", async () => {
    const upstream = {
      id: "p1",
      emails: { primaryEmail: "x@y.com" },
      atlasFirstSource: "DEMO",
      atlasLastSource: "CONVERSION",
      atlasIp: "1.2.3.4",
      atlasStripeCustomerId: "cus_x",
      futureCustomField: "lives",
    };
    const { fetch } = makeScriptedFetch([
      { status: 200, body: { data: { person: upstream } } },
    ]);
    const result = await getPerson(baseConfig({ fetchImpl: fetch }), "p1");
    expect(result).toEqual(upstream);
  });

  test("returns undefined on 404", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 404, body: { messages: ["not found"] } },
    ]);
    const result = await getPerson(baseConfig({ fetchImpl: fetch }), "missing");
    expect(result).toBeUndefined();
  });

  test("throws TwentyClientError on non-404 4xx", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 401, body: { messages: ["unauthorized"] } },
    ]);
    await expect(
      getPerson(baseConfig({ fetchImpl: fetch }), "id"),
    ).rejects.toMatchObject({
      _tag: "TwentyClientError",
      operation: "getPerson",
      status: 401,
    });
  });

  test("fails loud when 2xx body lacks data.person — distinguishes drift from 404", async () => {
    const { fetch } = makeScriptedFetch([{ status: 200, body: { data: {} } }]);
    await expect(
      getPerson(baseConfig({ fetchImpl: fetch }), "id"),
    ).rejects.toMatchObject({
      _tag: "TwentyClientError",
      operation: "getPerson",
    });
  });
});

describe("searchPeople", () => {
  test("builds documented filter=field[op]:value syntax for email-only", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } },
    ]);
    await searchPeople(baseConfig({ fetchImpl: fetch }), { email: "find@example.com" });
    // Twenty silently ignores the bracket-nested form
    // `?filter[emails.primaryEmail][eq]=…` and returns the unfiltered list.
    expect(calls[0].url).toContain("filter=emails.primaryEmail[eq]:");
    expect(calls[0].url).not.toContain("filter[emails.primaryEmail][eq]=");
    expect(calls[0].url).toContain(encodeURIComponent("find@example.com"));
  });

  test("builds or() composite for nameLike + AND-joins multiple clauses", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { people: [] } } },
    ]);
    await searchPeople(baseConfig({ fetchImpl: fetch }), {
      email: "matt@example.com",
      nameLike: "Sywulak",
      limit: 50,
    });
    const url = calls[0].url;
    expect(url).toContain("filter=");
    // email clause present
    expect(url).toContain("emails.primaryEmail[eq]:");
    // nameLike → or() composite over firstName + lastName
    expect(url).toContain("or(");
    expect(url).toContain("name.firstName[like]:");
    expect(url).toContain("name.lastName[like]:");
    expect(url).toContain("limit=50");
    // never the broken nested form
    expect(url).not.toContain("filter[");
  });

  test("throws when no criteria supplied and never issues a request", async () => {
    const { fetch, calls } = makeScriptedFetch([]);
    await expect(searchPeople(baseConfig({ fetchImpl: fetch }), {})).rejects.toMatchObject({
      _tag: "TwentyClientError",
      operation: "searchPeople",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("listCompanies / searchCompanies / listNotes", () => {
  test("listCompanies GETs /rest/companies; returns array", async () => {
    const { fetch, calls } = makeScriptedFetch([
      {
        status: 200,
        body: { data: { companies: [{ id: "c1", name: "Acme" }] } },
      },
    ]);
    const result = await listCompanies(baseConfig({ fetchImpl: fetch }), { limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Acme");
    expect(calls[0].url).toContain("/rest/companies?");
    expect(calls[0].url).toContain("limit=10");
  });

  test("searchCompanies builds documented filter syntax for nameLike + domainLike", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { companies: [] } } },
    ]);
    await searchCompanies(baseConfig({ fetchImpl: fetch }), {
      nameLike: "Acme",
      domainLike: "acme.io",
    });
    const url = calls[0].url;
    expect(url).toContain("filter=");
    expect(url).toContain("name[like]:");
    expect(url).toContain("domainName.primaryLinkUrl[like]:");
    expect(url).not.toContain("filter[");
  });

  test("listNotes returns the array on a normal 200 response", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: { data: { notes: [{ id: "n1", title: "x" }] } } },
    ]);
    const result = await listNotes(baseConfig({ fetchImpl: fetch }));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("n1");
  });

  test("listNotes fails loud when data.notes is missing", async () => {
    const { fetch } = makeScriptedFetch([{ status: 200, body: { data: {} } }]);
    await expect(listNotes(baseConfig({ fetchImpl: fetch }))).rejects.toMatchObject({
      _tag: "TwentyClientError",
      operation: "listNotes",
    });
  });

  test("listCompanies fails loud when data.companies is missing", async () => {
    const { fetch } = makeScriptedFetch([{ status: 200, body: { data: {} } }]);
    await expect(listCompanies(baseConfig({ fetchImpl: fetch }))).rejects.toMatchObject({
      _tag: "TwentyClientError",
      operation: "listCompanies",
    });
  });

  test("searchCompanies fails loud when data.companies is missing", async () => {
    const { fetch } = makeScriptedFetch([{ status: 200, body: { data: {} } }]);
    await expect(
      searchCompanies(baseConfig({ fetchImpl: fetch }), { nameLike: "Acme" }),
    ).rejects.toMatchObject({
      _tag: "TwentyClientError",
      operation: "searchCompanies",
    });
  });
});

const deleteCases: Array<{
  readonly name: "deletePerson" | "deleteNote" | "deleteCompany";
  readonly fn: (
    cfg: TwentyClientConfig,
    id: string,
    opts?: { readonly softDelete?: boolean },
  ) => Promise<void>;
  readonly path: string;
}> = [
  { name: "deletePerson", fn: deletePerson, path: "people" },
  { name: "deleteNote", fn: deleteNote, path: "notes" },
  { name: "deleteCompany", fn: deleteCompany, path: "companies" },
];

describe("deletePerson / deleteNote / deleteCompany", () => {
  test("sends DELETE with ?soft_delete=false by default", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const config = baseConfig({ fetchImpl: fetch });
    await deletePerson(config, "p1");
    await deleteNote(config, "n1");
    await deleteCompany(config, "c1");

    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://crm.test.local/rest/people/p1?soft_delete=false");
    expect(calls[1].url).toBe("https://crm.test.local/rest/notes/n1?soft_delete=false");
    expect(calls[2].url).toBe("https://crm.test.local/rest/companies/c1?soft_delete=false");
    for (const call of calls) {
      expect(call.url).toMatch(/[?&]soft_delete=(true|false)\b/);
    }
  });

  test.each(deleteCases)(
    "$name honors softDelete:true override",
    async ({ fn, path }) => {
      const { fetch, calls } = makeScriptedFetch([{ status: 200, body: {} }]);
      await fn(baseConfig({ fetchImpl: fetch }), "id-1", { softDelete: true });
      expect(calls[0].url).toBe(`https://crm.test.local/rest/${path}/id-1?soft_delete=true`);
    },
  );

  test.each(deleteCases)("$name treats 404 as idempotent", async ({ fn }) => {
    const { fetch } = makeScriptedFetch([
      { status: 404, body: { messages: ["already gone"] } },
    ]);
    await expect(fn(baseConfig({ fetchImpl: fetch }), "id-1")).resolves.toBeUndefined();
  });

  test.each(deleteCases)(
    "$name throws TwentyClientError on non-404 4xx with operation set",
    async ({ fn, name }) => {
      const { fetch } = makeScriptedFetch([
        { status: 401, body: { messages: ["unauthorized"] } },
      ]);
      await expect(fn(baseConfig({ fetchImpl: fetch }), "id-1")).rejects.toMatchObject({
        _tag: "TwentyClientError",
        operation: name,
        status: 401,
      });
    },
  );
});

describe("wipeWorkspace", () => {
  test("defaults to dryRun:true and issues no DELETEs when called with no opts", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { notes: [{ id: "n1" }] } } },
      { status: 200, body: { data: { people: [] } } },
      { status: 200, body: { data: { companies: [] } } },
    ]);
    const result = await wipeWorkspace(baseConfig({ fetchImpl: fetch }));
    expect(result.dryRun).toBe(true);
    if (result.dryRun) {
      expect(result.notesSampled).toBe(1);
    }
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  test("dryRun:false drains notes → people → companies in order and reports deleted counts", async () => {
    const { fetch, calls } = makeScriptedFetch([
      // notes: page 1 returns 2, delete×2, page 2 empty
      { status: 200, body: { data: { notes: [{ id: "n1" }, { id: "n2" }] } } },
      { status: 200, body: {} }, // DELETE n1
      { status: 200, body: {} }, // DELETE n2
      { status: 200, body: { data: { notes: [] } } },
      // people: page 1 returns 1, delete×1, page 2 empty
      { status: 200, body: { data: { people: [{ id: "p1" }] } } },
      { status: 200, body: {} }, // DELETE p1
      { status: 200, body: { data: { people: [] } } },
      // companies: page 1 empty
      { status: 200, body: { data: { companies: [] } } },
    ]);
    const result = await wipeWorkspace(baseConfig({ fetchImpl: fetch }), {
      dryRun: false,
      pageLimit: 60,
    });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.notesDeleted).toBe(2);
      expect(result.peopleDeleted).toBe(1);
      expect(result.companiesDeleted).toBe(0);
      expect(result.truncated).toEqual({ notes: false, people: false, companies: false });
      expect(result.errors).toEqual([]);
    }

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes.length).toBe(3);
    for (const d of deletes) {
      expect(d.url).toMatch(/[?&]soft_delete=false\b/);
    }

    // Iteration-order assertion — the safety property of the wipe.
    const listUrls = calls.filter((c) => c.method === "GET").map((c) => c.url);
    const notesIdx = listUrls.findIndex((u) => u.includes("/rest/notes"));
    const peopleIdx = listUrls.findIndex((u) => u.includes("/rest/people"));
    const companiesIdx = listUrls.findIndex((u) => u.includes("/rest/companies"));
    expect(notesIdx).toBeGreaterThanOrEqual(0);
    expect(peopleIdx).toBeGreaterThan(notesIdx);
    expect(companiesIdx).toBeGreaterThan(peopleIdx);
  });

  test("dryRun=true counts one page per object type and issues no DELETEs", async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: { data: { notes: [{ id: "n1" }, { id: "n2" }] } } },
      { status: 200, body: { data: { people: [{ id: "p1" }] } } },
      { status: 200, body: { data: { companies: [] } } },
    ]);
    const result = await wipeWorkspace(baseConfig({ fetchImpl: fetch }), {
      dryRun: true,
      pageLimit: 60,
    });
    expect(result.dryRun).toBe(true);
    if (result.dryRun) {
      expect(result.notesSampled).toBe(2);
      expect(result.peopleSampled).toBe(1);
      expect(result.companiesSampled).toBe(0);
    }
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  test("sets truncated.notes=true when notes drain hits maxRecords", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: { data: { notes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }] } } },
      { status: 200, body: {} }, // DELETE n1
      { status: 200, body: {} }, // DELETE n2
      // people + companies still drain — maxRecords is per-object, not summed
      { status: 200, body: { data: { people: [] } } },
      { status: 200, body: { data: { companies: [] } } },
    ]);
    const result = await wipeWorkspace(baseConfig({ fetchImpl: fetch }), {
      dryRun: false,
      pageLimit: 60,
      maxRecords: 2,
    });
    if (!result.dryRun) {
      expect(result.notesDeleted).toBe(2);
      expect(result.truncated).toEqual({ notes: true, people: false, companies: false });
    }
  });

  test("maxRecords is per-object-type — people drain still gets full budget after notes saturates", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: { data: { notes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }] } } },
      { status: 200, body: {} }, // DELETE n1
      { status: 200, body: {} }, // DELETE n2
      // people drain: maxRecords=2 is independent — should see all 2 deleted (3rd truncated)
      { status: 200, body: { data: { people: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] } } },
      { status: 200, body: {} }, // DELETE p1
      { status: 200, body: {} }, // DELETE p2
      // companies drain still runs with fresh budget
      { status: 200, body: { data: { companies: [{ id: "c1" }] } } },
      { status: 200, body: {} }, // DELETE c1
      { status: 200, body: { data: { companies: [] } } },
    ]);
    const result = await wipeWorkspace(baseConfig({ fetchImpl: fetch }), {
      dryRun: false,
      pageLimit: 60,
      maxRecords: 2,
    });
    if (!result.dryRun) {
      expect(result.notesDeleted).toBe(2);
      expect(result.peopleDeleted).toBe(2);
      expect(result.companiesDeleted).toBe(1);
      expect(result.truncated.notes).toBe(true);
      expect(result.truncated.people).toBe(true);
      expect(result.truncated.companies).toBe(false);
    }
  });

  test("collects per-record delete failures and continues the wipe", async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: { data: { notes: [{ id: "n1" }, { id: "n2" }] } } },
      { status: 500, body: { messages: ["upstream blew up"] } }, // DELETE n1 fails
      { status: 200, body: {} }, // DELETE n2 succeeds
      { status: 200, body: { data: { notes: [] } } },
      { status: 200, body: { data: { people: [] } } },
      { status: 200, body: { data: { companies: [] } } },
    ]);
    const result = await wipeWorkspace(baseConfig({ fetchImpl: fetch }), {
      dryRun: false,
      pageLimit: 60,
    });
    if (!result.dryRun) {
      expect(result.notesDeleted).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        objectType: "note",
        id: "n1",
        status: 500,
      });
    }
  });
});
