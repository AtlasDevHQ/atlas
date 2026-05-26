/**
 * SaasCrm layer tests — boot verification + outbox enqueue + dispatcher.
 *
 * Exercises the EE-side Layer (`SaasCrmLive`) with a mocked fetch impl
 * AND a stubbed `internalQuery` (so the outbox enqueue is observable
 * without a real Postgres). The dispatcher itself (`dispatchOutboxRow`)
 * is unit-tested directly — it's the call the flusher makes from
 * inside the Scheduler Layer.
 *
 * There are NO live calls to crm.useatlas.dev.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";

// ── Mock the enterprise gate BEFORE importing the layer ─────────────
let enterpriseEnabled = true;
mock.module("../../index", () => ({
  isEnterpriseEnabled: () => enterpriseEnabled,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ── Stub the internal DB so SaasCrmLive can observe enqueue ─────────
let internalDbAvailable = true;
let lastEnqueueArgs: { sql: string; params: unknown[] } | null = null;
let enqueueCount = 0;
let nextEnqueueId = "row-id-0";
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => internalDbAvailable,
  internalQuery: async (sql: string, params?: unknown[]) => {
    lastEnqueueArgs = { sql, params: params ?? [] };
    if (/^\s*INSERT INTO crm_outbox/i.test(sql)) {
      enqueueCount++;
      return [{ id: nextEnqueueId }];
    }
    return [];
  },
}));

// ── Now we can import the layer + its helpers ───────────────────────
const {
  verifyCustomFields,
  SaasCrmLive,
  dispatchOutboxRow,
  classifyTwentyError,
} = await import("../index");
const { SaasCrm } = await import("@atlas/api/lib/effect/services");

// ── Fixture helpers ─────────────────────────────────────────────────

function metadataResponse(fieldNames: string[]): Response {
  return new Response(
    JSON.stringify({
      data: {
        objects: {
          edges: [
            {
              node: {
                fields: {
                  edges: fieldNames.map((name) => ({ node: { name } })),
                },
              },
            },
          ],
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function withFetch<T>(impl: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = orig;
  });
}

function resetStubs(): void {
  internalDbAvailable = true;
  lastEnqueueArgs = null;
  enqueueCount = 0;
  nextEnqueueId = "row-id-0";
}

// ── verifyCustomFields ──────────────────────────────────────────────

describe("verifyCustomFields", () => {
  beforeEach(() => {
    enterpriseEnabled = true;
    resetStubs();
  });

  test("returns ok=true when both required custom fields are present", async () => {
    const fetchImpl = (async () =>
      metadataResponse(["id", "atlasFirstSource", "atlasLastSource"])) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      expect(result).toEqual({ ok: true });
    });
  });

  test("returns ok=false when atlasFirstSource is missing", async () => {
    const fetchImpl = (async () =>
      metadataResponse(["id", "atlasLastSource"])) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      expect(result).toEqual({ ok: false });
    });
  });

  test("returns ok=transient on network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      expect(result).toMatchObject({ ok: "transient" });
    });
  });

  test("returns ok=false on 401 (deterministic misconfig)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: ["Unauthorized"] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      expect(result).toEqual({ ok: false });
    });
  });
});

// ── SaasCrmLive boot end-to-end ─────────────────────────────────────

describe("SaasCrmLive boot — enterprise disabled", () => {
  beforeEach(resetStubs);

  test("yields available=false and no-op upsertLead when enterprise is OFF", async () => {
    enterpriseEnabled = false;
    delete process.env.TWENTY_API_KEY;
    delete process.env.TWENTY_BASE_URL;

    const program = Effect.gen(function* () {
      const crm = yield* SaasCrm;
      yield* crm.upsertLead({ source: "demo", email: "x@y.com" });
      return crm.available;
    });

    const available = await Effect.runPromise(
      program.pipe(Effect.provide(SaasCrmLive)),
    );
    expect(available).toBe(false);
    expect(enqueueCount).toBe(0);
  });
});

describe("SaasCrmLive boot — enterprise enabled + creds + both fields present + InternalDB available", () => {
  beforeEach(resetStubs);

  test("yields available=true AND enqueues to crm_outbox on upsertLead", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    let metadataCalls = 0;
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/metadata")) {
        metadataCalls++;
        return metadataResponse(["id", "atlasFirstSource", "atlasLastSource"]);
      }
      // No dispatch fetches expected — outbox holds the row for the flusher.
      throw new Error(`Unexpected fetch during enqueue: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          const wasAvailable = crm.available;
          yield* crm.upsertLead({
            source: "demo",
            email: "queue@happy.test",
          });
          return wasAvailable;
        });
        return Effect.runPromise(program.pipe(Effect.provide(SaasCrmLive)));
      });

      expect(result).toBe(true);
      expect(metadataCalls).toBe(1);
      expect(enqueueCount).toBe(1);
      // The INSERT carries event_type=source and the original payload as
      // jsonb. We don't assert exact ordering of params beyond presence.
      expect(lastEnqueueArgs?.sql).toMatch(/INSERT INTO crm_outbox/i);
      expect(lastEnqueueArgs?.params[0]).toBe("demo");
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });
});

describe("SaasCrmLive boot — InternalDB unavailable", () => {
  beforeEach(resetStubs);

  test("yields available=false when hasInternalDB() is false", async () => {
    enterpriseEnabled = true;
    internalDbAvailable = false;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    const fetchImpl = (async () =>
      metadataResponse(["id", "atlasFirstSource", "atlasLastSource"])) as unknown as typeof globalThis.fetch;

    try {
      const result = await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          yield* crm.upsertLead({ source: "demo", email: "nodb@x.test" });
          return crm.available;
        });
        return Effect.runPromise(program.pipe(Effect.provide(SaasCrmLive)));
      });

      expect(result).toBe(false);
      expect(enqueueCount).toBe(0);
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });
});

describe("SaasCrmLive boot — missing required field flips available to false", () => {
  beforeEach(resetStubs);

  test("yields available=false when atlasFirstSource is missing", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/metadata")) {
        return metadataResponse(["id", "atlasLastSource"]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          yield* crm.upsertLead({ source: "demo", email: "missing@x.test" });
          return crm.available;
        });
        return Effect.runPromise(program.pipe(Effect.provide(SaasCrmLive)));
      });

      expect(result).toBe(false);
      expect(enqueueCount).toBe(0);
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });
});

describe("SaasCrmLive boot — 401 metadata response flips to permanent", () => {
  beforeEach(resetStubs);

  test("yields available=false on 401 and does NOT enqueue", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/metadata")) {
        return new Response(JSON.stringify({ messages: ["Unauthorized"] }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          yield* crm.upsertLead({ source: "demo", email: "x@y.test" });
          return crm.available;
        });
        return Effect.runPromise(program.pipe(Effect.provide(SaasCrmLive)));
      });

      expect(result).toBe(false);
      expect(enqueueCount).toBe(0);
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });
});

// ── dispatchOutboxRow — the flusher's per-row entry point ───────────

describe("dispatchOutboxRow", () => {
  beforeEach(resetStubs);

  test("happy path — calls upsertPerson and persists twenty_person_id", async () => {
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: { createPerson: { id: "person_happy" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const persisted: { person?: string; note?: string } = {};
    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-1",
          eventType: "demo",
          payload: { source: "demo", email: "happy@test.local" },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async (id: string) => {
            persisted.person = id;
          },
          setTwentyNoteId: async (id: string) => {
            persisted.note = id;
          },
        },
      ),
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(persisted.person).toBe("person_happy");
    expect(persisted.note).toBeUndefined();
  });

  test("idempotent replay — skips upsertPerson when twenty_person_id is already set", async () => {
    let fetchCount = 0;
    const fetchImpl = (async (): Promise<Response> => {
      fetchCount++;
      // Should never be called — the row's existing twenty_person_id
      // means the dispatcher must short-circuit straight to done.
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const persisted: { person?: string; note?: string } = {};
    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-2",
          eventType: "demo",
          payload: { source: "demo", email: "replay@test.local" },
          attempts: 2,
          twentyPersonId: "person_already_done",
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async (id: string) => {
            persisted.person = id;
          },
          setTwentyNoteId: async (id: string) => {
            persisted.note = id;
          },
        },
      ),
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(fetchCount).toBe(0);
    expect(persisted.person).toBeUndefined();
  });

  test("5xx → transient outcome (retried by flusher)", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ messages: ["upstream boom"] }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-3",
          eventType: "demo",
          payload: { source: "demo", email: "transient@test.local" },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async () => {},
          setTwentyNoteId: async () => {},
        },
      ),
    );

    expect(outcome.kind).toBe("transient");
  });

  test("401 → permanent outcome (dead-lettered)", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ messages: ["Unauthorized"] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-4",
          eventType: "demo",
          payload: { source: "demo", email: "dead@test.local" },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async () => {},
          setTwentyNoteId: async () => {},
        },
      ),
    );

    expect(outcome.kind).toBe("permanent");
  });

  test("429 → transient (rate-limited)", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ messages: ["rate limited"] }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-5",
          eventType: "demo",
          payload: { source: "demo", email: "rate@test.local" },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async () => {},
          setTwentyNoteId: async () => {},
        },
      ),
    );

    expect(outcome.kind).toBe("transient");
  });

  test("network failure → transient", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-6",
          eventType: "demo",
          payload: { source: "demo", email: "net@test.local" },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async () => {},
          setTwentyNoteId: async () => {},
        },
      ),
    );

    expect(outcome.kind).toBe("transient");
  });

  test("upsertPerson returns 200 with no id → permanent (no silent done)", async () => {
    // Realistic regression: a misconfigured Twenty (or a future fast-path
    // refactor of upsertPerson) could return a 2xx with an empty body.
    // The row must dead-letter rather than be marked done with no link.
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // POST createPerson — 2xx but no id.
      return new Response(
        JSON.stringify({ data: { createPerson: {} } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-noid",
          eventType: "demo",
          payload: { source: "demo", email: "noid@test.local" },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async () => {
            throw new Error("setTwentyPersonId must NOT be called when id is missing");
          },
          setTwentyNoteId: async () => {},
        },
      ),
    );

    expect(outcome.kind).toBe("permanent");
    if (outcome.kind === "permanent") {
      expect(outcome.message).toContain("no id");
    }
  });

  test("persist.setTwentyPersonId fails after upsertPerson succeeds → transient with persist-failure label (NOT upsertPerson)", async () => {
    // Realistic regression: a pg pool blip between Twenty's 2xx and our
    // UPDATE writes the wrong story in last_error. Operators triaging
    // the row would chase a Twenty problem when the actual fault is
    // internal — the message MUST identify the persist step.
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: { createPerson: { id: "person_X" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-persist-blip",
          eventType: "demo",
          payload: { source: "demo", email: "blip@test.local" },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async () => {
            throw new Error("pg pool exhausted");
          },
          setTwentyNoteId: async () => {},
        },
      ),
    );

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.message).toContain("persist.setTwentyPersonId");
      expect(outcome.message).toContain("pg pool exhausted");
      expect(outcome.message).not.toContain("upsertPerson threw");
    }
  });

  test("429 with Retry-After header surfaces retryAfterMs on the transient outcome", async () => {
    // delta-seconds form per RFC 9110.
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // POST createPerson with Retry-After: 90.
      return new Response(JSON.stringify({ messages: ["rate limited"] }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "90" },
      });
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-rate",
          eventType: "demo",
          payload: { source: "demo", email: "rate@test.local" },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async () => {},
          setTwentyNoteId: async () => {},
        },
      ),
    );

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.retryAfterMs).toBe(90_000);
      expect(outcome.httpStatus).toBe(429);
    }
  });

  test("sales-form row dead-letters today via the normalizer (sales-form not yet accepted)", async () => {
    // The normalizer's discriminated union only accepts `demo` today;
    // a sales-form payload throws `Unknown lead source` BEFORE the
    // dispatcher's downstream sales-form branch runs. Either way the
    // row dead-letters with an operator-visible message. This test
    // pins both halves of the contract: (1) no fetch is attempted,
    // (2) the dead-letter message identifies the offending source.
    let fetchCalls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-sales",
          eventType: "sales-form",
          payload: { source: "sales-form", email: "sales@test.local" },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async () => {},
          setTwentyNoteId: async () => {},
        },
      ),
    );

    expect(fetchCalls).toBe(0);
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind === "permanent") {
      expect(outcome.message).toContain("sales-form");
    }
  });
});

// ── classifyTwentyError ─────────────────────────────────────────────

describe("classifyTwentyError", () => {
  test("non-TwentyClientError defaults to transient", () => {
    const out = classifyTwentyError(new Error("boom"), "upsertPerson");
    expect(out.kind).toBe("transient");
  });

  test("non-Error value defaults to transient", () => {
    const out = classifyTwentyError("string thrown", "upsertPerson");
    expect(out.kind).toBe("transient");
  });
});

