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

/**
 * Shape mirrors Twenty's REST OpenAPI 3.1.1 spec at `/rest/open-api/core`:
 * `components.schemas.Person.properties` is an object keyed by field name.
 * The verifier only reads property keys, so values are placeholders.
 *
 * `emails` and `name` (standard Twenty Person fields) are auto-included
 * so callers only specify the custom-field set under test. Production
 * Twenty always exposes these in OpenAPI, and the boot-time guard in
 * `verifyCustomFields` requires `emails` — explicitly opt out by passing
 * `{ includeStandard: false }` when testing the missing-standard branch.
 */
function metadataResponse(
  fieldNames: string[],
  options: { includeStandard?: boolean } = {},
): Response {
  const { includeStandard = true } = options;
  const properties: Record<string, { type: string }> = {};
  if (includeStandard) {
    properties.emails = { type: "object" };
    properties.name = { type: "object" };
  }
  for (const name of fieldNames) properties[name] = { type: "string" };
  return new Response(
    JSON.stringify({
      openapi: "3.1.1",
      components: { schemas: { Person: { properties } } },
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

  test("returns ok=true + present set when all required fields are present", async () => {
    const fetchImpl = (async () =>
      metadataResponse([
        "id",
        "atlasFirstSource",
        "atlasLastSource",
        "atlasStripeCustomerId",
        "atlasIp",
      ])) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
        source: "env",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.present.has("atlasFirstSource")).toBe(true);
        expect(result.present.has("atlasLastSource")).toBe(true);
        expect(result.present.has("atlasStripeCustomerId")).toBe(true);
        expect(result.present.has("atlasIp")).toBe(true);
      }
    });
  });

  test("returns ok=true even when optional atlasIp is absent (only required fields gate availability)", async () => {
    const fetchImpl = (async () =>
      metadataResponse([
        "id",
        "atlasFirstSource",
        "atlasLastSource",
        "atlasStripeCustomerId",
      ])) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
        source: "env",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.present.has("atlasIp")).toBe(false);
      }
    });
  });

  test("returns ok=false when atlasFirstSource is missing", async () => {
    const fetchImpl = (async () =>
      metadataResponse(["id", "atlasLastSource", "atlasStripeCustomerId"])) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
        source: "env",
      });
      expect(result).toEqual({ ok: false });
    });
  });

  // Defensive guard from PR #2860 review: if Twenty's OpenAPI ever stops
  // exposing `emails` as a flat property (e.g. $ref/allOf composition that
  // doesn't flatten into Person.properties), the boot probe must fail
  // closed rather than construct an allowlist that would silently strip
  // every lead's email from POST bodies.
  test("returns ok=false when standard `emails` field is missing from the probed schema", async () => {
    const fetchImpl = (async () =>
      metadataResponse(
        ["id", "atlasFirstSource", "atlasLastSource", "atlasStripeCustomerId"],
        { includeStandard: false },
      )) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
        source: "env",
      });
      expect(result).toEqual({ ok: false });
    });
  });

  test("returns ok=false on network failure (fail closed — no more silent transient)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
        source: "env",
      });
      expect(result).toEqual({ ok: false });
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
        source: "env",
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
      if (url.endsWith("/rest/open-api/core")) {
        metadataCalls++;
        return metadataResponse([
          "id",
          "atlasFirstSource",
          "atlasLastSource",
          "atlasStripeCustomerId",
        ]);
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
      metadataResponse([
        "id",
        "atlasFirstSource",
        "atlasLastSource",
        "atlasStripeCustomerId",
      ])) as unknown as typeof globalThis.fetch;

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
      if (url.endsWith("/rest/open-api/core")) {
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

describe("SaasCrmLive boot — missing atlasStripeCustomerId flips available to false (#2737)", () => {
  beforeEach(resetStubs);

  test("yields available=false when atlasStripeCustomerId is missing (boot-time guard)", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/rest/open-api/core")) {
        // Old schema — source fields present but the conversion stamp
        // field is missing. The verification must catch it on boot so
        // every conversion event doesn't dead-letter on a 422.
        return metadataResponse(["id", "atlasFirstSource", "atlasLastSource"]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          yield* crm.stampConversion({
            email: "convert@x.test",
            stripeCustomerId: "cus_x",
          });
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

describe("SaasCrmLive boot — stampConversion enqueues with eventType=stamp-conversion (#2737)", () => {
  beforeEach(resetStubs);

  test("enqueues a stamp-conversion row carrying the conversion payload", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/rest/open-api/core")) {
        return metadataResponse([
          "id",
          "atlasFirstSource",
          "atlasLastSource",
          "atlasStripeCustomerId",
        ]);
      }
      throw new Error(`Unexpected fetch during enqueue: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    try {
      const wasAvailable = await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          yield* crm.stampConversion({
            email: "convert@happy.test",
            stripeCustomerId: "cus_abc123",
          });
          return crm.available;
        });
        return Effect.runPromise(program.pipe(Effect.provide(SaasCrmLive)));
      });

      expect(wasAvailable).toBe(true);
      expect(enqueueCount).toBe(1);
      expect(lastEnqueueArgs?.sql).toMatch(/INSERT INTO crm_outbox/i);
      // event_type is the stamp-conversion sentinel — distinct from the
      // payload's `source` discriminator so an operator can quickly
      // bucket outbox rows by funnel stage.
      expect(lastEnqueueArgs?.params[0]).toBe("stamp-conversion");
      // Payload is the canonical conversion variant.
      const payload = JSON.parse(String(lastEnqueueArgs?.params[1]));
      expect(payload.source).toBe("conversion");
      expect(payload.email).toBe("convert@happy.test");
      expect(payload.stripeCustomerId).toBe("cus_abc123");
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });

  test("stampConversion is a no-op when enterprise is disabled (Noop layer active)", async () => {
    enterpriseEnabled = false;
    delete process.env.TWENTY_API_KEY;
    delete process.env.TWENTY_BASE_URL;

    const program = Effect.gen(function* () {
      const crm = yield* SaasCrm;
      yield* crm.stampConversion({
        email: "x@y.com",
        stripeCustomerId: "cus_noop",
      });
      return crm.available;
    });

    const available = await Effect.runPromise(
      program.pipe(Effect.provide(SaasCrmLive)),
    );
    expect(available).toBe(false);
    expect(enqueueCount).toBe(0);
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
      if (url.endsWith("/rest/open-api/core")) {
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

// ── SaasCrmLive.dispatcher — #2850 leak-prevention regression pin ────
//
// The flusher fetches the dispatcher closure via the SaasCrm Tag and
// calls it per outbox row. Pre-#2850 this closure re-read
// `twenty_integrations` on every invocation; post-#2850 it must use the
// boot-resolved env client config ONLY (the cross-tenant `findLatest…`
// helper was deleted). These tests pin two structural invariants:
//
//   1. The dispatcher routes with the env-baked apiKey (the value of
//      `process.env.TWENTY_API_KEY` at Layer boot — not at dispatch
//      time, which is the whole point of removing per-row resolution).
//   2. Mutating `process.env.TWENTY_API_KEY` AFTER boot does NOT change
//      what the dispatcher sends — env is frozen at boot. A future
//      regression that reintroduced runtime env-reads would flip this
//      assertion.
//
// Together these prevent both leak directions: no per-row DB read can
// silently re-enter the dispatcher, and no late env mutation can swap
// credentials out from under in-flight outbox rows.

describe("SaasCrmLive.dispatcher — env-only config baked at boot (#2850)", () => {
  beforeEach(resetStubs);

  test("dispatcher sends the boot-resolved env apiKey on the Authorization header", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "boot-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    const seenAuthHeaders: string[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const headers = new Headers(init?.headers ?? {});
      const auth = headers.get("authorization");
      if (auth) seenAuthHeaders.push(auth);
      if (url.endsWith("/rest/open-api/core")) {
        return metadataResponse([
          "id",
          "atlasFirstSource",
          "atlasLastSource",
          "atlasStripeCustomerId",
        ]);
      }
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: { createPerson: { id: "person_via_dispatcher" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          if (!crm.available) throw new Error("expected available=true");
          // `dispatcher` is a plain Promise-returning function on the
          // Tag (the flusher calls it from non-Effect code). Bridge
          // back into Effect with Effect.promise so we can await its
          // result inside the generator.
          return yield* Effect.promise(() =>
            crm.dispatcher(
              {
                id: "row-dispatcher-test",
                eventType: "demo",
                payload: { source: "demo", email: "dispatcher@test.local" },
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
        });
        const outcome = await Effect.runPromise(
          program.pipe(Effect.provide(SaasCrmLive)),
        );
        expect(outcome).toEqual({ kind: "ok" });
      });
      // Boot's metadata probe AND the per-row people query both use
      // the env-resolved key. Any future regression that swapped
      // credentials mid-flight would show different auth headers here.
      expect(seenAuthHeaders.length).toBeGreaterThan(0);
      for (const h of seenAuthHeaders) {
        expect(h).toBe("Bearer boot-key");
      }
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });

  test("post-boot env mutation does NOT change the dispatcher's apiKey", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "boot-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    const seenAuthHeaders: string[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const headers = new Headers(init?.headers ?? {});
      const auth = headers.get("authorization");
      if (auth) seenAuthHeaders.push(auth);
      if (url.endsWith("/rest/open-api/core")) {
        return metadataResponse([
          "id",
          "atlasFirstSource",
          "atlasLastSource",
          "atlasStripeCustomerId",
        ]);
      }
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: { createPerson: { id: "person_post_mutation" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          if (!crm.available) throw new Error("expected available=true");

          // Mutate the env AFTER boot. The boot-baked config must not
          // pick this up. If the dispatcher ever starts reading env at
          // call time again, this assertion will fail.
          process.env.TWENTY_API_KEY = "swapped-out-key";

          yield* Effect.promise(() =>
            crm.dispatcher(
              {
                id: "row-after-mutation",
                eventType: "demo",
                payload: { source: "demo", email: "mutate@test.local" },
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
        });
        await Effect.runPromise(program.pipe(Effect.provide(SaasCrmLive)));
      });

      // All requests — boot probe AND post-mutation dispatch — must
      // use the boot key. None should leak the swapped-out value.
      for (const h of seenAuthHeaders) {
        expect(h).toBe("Bearer boot-key");
        expect(h).not.toBe("Bearer swapped-out-key");
      }
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });

  // ── 1.6.0 incident regression test (#2860) ────────────────────────
  //
  // Pre-fix: the boot probe (broken GraphQL) silently fell through to
  // "assume custom fields present", the dispatcher unconditionally sent
  // `atlasIp` on every demo row, and Twenty 400'd the entire upsert on
  // the unknown property — every demo / sales-form lead dead-lettered.
  //
  // This test pins the end-to-end fix: boot probe returns a Person
  // schema lacking `atlasIp`, dispatch a demo row carrying an IP, and
  // assert (a) `emails.primaryEmail` survives the allowlist filter and
  // (b) `atlasIp` is dropped from the POST body. Wires probe → boot →
  // dispatcher → filter end-to-end; the gap that would have caught the
  // original incident if it had existed.
  test("dispatcher drops atlasIp from POST body when probe doesn't list it (#2860 incident regression)", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "boot-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    const capturedPosts: { url: string; body: string }[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/rest/open-api/core")) {
        // Workspace operator skipped creating the `atlasIp` column.
        // Required fields + standard `emails` / `name` are present.
        return metadataResponse([
          "id",
          "emails",
          "name",
          "atlasFirstSource",
          "atlasLastSource",
          "atlasStripeCustomerId",
        ]);
      }
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Create-person path. Capture body for assertion.
      if (init?.method === "POST" && url.endsWith("/rest/people")) {
        capturedPosts.push({ url, body: String(init.body ?? "") });
        return new Response(
          JSON.stringify({ data: { createPerson: { id: "person_incident" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          if (!crm.available) throw new Error("expected available=true");
          return yield* Effect.promise(() =>
            crm.dispatcher(
              {
                id: "row-incident-2860",
                eventType: "demo",
                payload: {
                  source: "demo",
                  email: "incident@test.local",
                  // Pre-fix: this IP would land in the POST body and
                  // Twenty would 400 because the workspace doesn't have
                  // `atlasIp` as a custom field.
                  ip: "1.2.3.4",
                },
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
        });
        const outcome = await Effect.runPromise(
          program.pipe(Effect.provide(SaasCrmLive)),
        );
        expect(outcome).toEqual({ kind: "ok" });
      });

      // Exactly one POST to /rest/people landed (the create path —
      // findPersonByEmail returned empty).
      expect(capturedPosts.length).toBe(1);
      const body = JSON.parse(capturedPosts[0].body) as Record<string, unknown>;

      // The allowlist did NOT strip the lead's email — `emails` is in
      // the probed schema and survives the filter. Without this, every
      // dispatch would create an email-less Person (or Twenty would 422).
      expect(body.emails).toEqual({ primaryEmail: "incident@test.local" });
      expect(body.atlasFirstSource).toBe("DEMO");
      expect(body.atlasLastSource).toBe("DEMO");

      // The allowlist DID strip `atlasIp` — the workspace schema didn't
      // declare it, so the dispatcher must not send it. This is the
      // single load-bearing assertion the original incident violated.
      expect("atlasIp" in body).toBe(false);
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

  test("conversion variant — POSTs Person with CONVERSION source + atlasStripeCustomerId (#2737)", async () => {
    // End-to-end via dispatchOutboxRow: normalizer routes the conversion
    // payload through the existing upsertPerson code path, and the
    // POST body must carry atlasFirstSource / atlasLastSource /
    // atlasStripeCustomerId inline.
    const captured: { url: string; body: string }[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = init?.body ? String(init.body) : "";
      captured.push({ url, body });
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: { createPerson: { id: "person_convert" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const persisted: { person?: string; note?: string } = {};
    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-conv",
          eventType: "stamp-conversion",
          payload: {
            source: "conversion",
            email: "convert@test.local",
            stripeCustomerId: "cus_pay_42",
          },
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
    expect(persisted.person).toBe("person_convert");
    // No note for conversion — createNote must NOT have been called.
    expect(persisted.note).toBeUndefined();
    // Two HTTP calls: findPersonByEmail (GET) + createPerson (POST).
    expect(captured).toHaveLength(2);
    const postBody = JSON.parse(captured[1].body);
    expect(postBody.atlasFirstSource).toBe("CONVERSION");
    expect(postBody.atlasLastSource).toBe("CONVERSION");
    expect(postBody.atlasStripeCustomerId).toBe("cus_pay_42");
  });

  test("conversion variant — existing Person preserves atlasFirstSource, PATCHes lastSource + stripeCustomerId (#2737)", async () => {
    // The sticky-firstSource rule lives in upsertPerson; the conversion
    // path inherits it for free. This test pins that behavior end-to-
    // end through dispatchOutboxRow so a future refactor that splits
    // out a dedicated stamp dispatcher can't silently lose it.
    const captured: { url: string; body: string; method: string }[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = init?.body ? String(init.body) : "";
      const method = init?.method ?? "GET";
      captured.push({ url, body, method });
      if (url.includes("/rest/people?filter")) {
        return new Response(
          JSON.stringify({
            data: {
              people: [
                {
                  id: "person_demo",
                  emails: { primaryEmail: "convert@test.local" },
                  atlasFirstSource: "DEMO",
                  atlasLastSource: "DEMO",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: { updatePerson: { id: "person_demo" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-conv-existing",
          eventType: "stamp-conversion",
          payload: {
            source: "conversion",
            email: "convert@test.local",
            stripeCustomerId: "cus_pay_99",
          },
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

    expect(outcome).toEqual({ kind: "ok" });
    expect(captured).toHaveLength(2);
    expect(captured[1].method).toBe("PATCH");
    const patchBody = JSON.parse(captured[1].body);
    // Sticky — atlasFirstSource must NOT be in the PATCH body.
    expect(patchBody.atlasFirstSource).toBeUndefined();
    expect(patchBody.atlasLastSource).toBe("CONVERSION");
    expect(patchBody.atlasStripeCustomerId).toBe("cus_pay_99");
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

  test("idempotent replay — conversion variant also skips upsertPerson when twenty_person_id is already set (#2737)", async () => {
    // PR review gap: the demo-variant replay test above covers the
    // pre-existing path, but adding the conversion variant means a
    // replayed `stamp-conversion` row should also short-circuit. Pin
    // that the dispatcher's idempotency is variant-agnostic — a future
    // refactor that split the dispatcher per-eventType would otherwise
    // silently re-dispatch a paid customer's stamp on every flush.
    let fetchCount = 0;
    const fetchImpl = (async (): Promise<Response> => {
      fetchCount++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const persisted: { person?: string; note?: string } = {};
    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-conv-replay",
          eventType: "stamp-conversion",
          payload: {
            source: "conversion",
            email: "paying@example.com",
            stripeCustomerId: "cus_already_stamped",
          },
          attempts: 2,
          twentyPersonId: "person_already_stamped",
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

  test("sales-form happy path — upsertPerson then createNote (then noteTarget link), persists both ids", async () => {
    // End-to-end happy path for a fresh sales-form lead.
    // Expected fetch sequence on a brand-new prospect:
    //   1. GET /rest/people?filter…           — find-by-email returns []
    //   2. POST /rest/people                  — create person
    //   3. POST /rest/notes                   — create note
    //   4. POST /rest/noteTargets             — link note to person
    const fetchSeq: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      fetchSeq.push(`${method} ${url.replace("https://crm.test.local", "")}`);

      if (method === "GET" && url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/rest/people")) {
        return new Response(
          JSON.stringify({ data: { createPerson: { id: "person_sales_1" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "POST" && url.endsWith("/rest/notes")) {
        return new Response(
          JSON.stringify({ data: { createNote: { id: "note_sales_1" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "POST" && url.endsWith("/rest/noteTargets")) {
        return new Response(
          JSON.stringify({ data: { createNoteTarget: { id: "nt_1" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const persisted: { person?: string; note?: string } = {};
    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-sales-happy",
          eventType: "sales-form",
          payload: {
            source: "sales-form",
            email: "sales@test.local",
            name: "Alice Example",
            company: "Acme Co",
            planInterest: "Business",
            message: "We need ten seats.",
          },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async (id: string) => { persisted.person = id; },
          setTwentyNoteId: async (id: string) => { persisted.note = id; },
        },
      ),
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(persisted.person).toBe("person_sales_1");
    expect(persisted.note).toBe("note_sales_1");
    // Strict-sequence assertion — proves the sub-steps fire in the right
    // order (no parallel createNote before personId is known).
    expect(fetchSeq).toHaveLength(4);
    expect(fetchSeq[2]).toBe("POST /rest/notes");
    expect(fetchSeq[3]).toBe("POST /rest/noteTargets");
  });

  test("sales-form idempotent replay (person already done) — skips upsertPerson, calls createNote with the persisted personId", async () => {
    // Models the partial-success crash path from #2729: sub-step 1
    // succeeded on a prior claim, persisted twenty_person_id, then the
    // pod died before sub-step 2 ran. On replay the dispatcher must NOT
    // re-call upsertPerson (would duplicate noise on Twenty) but MUST
    // still create the note against the persisted personId.
    let upsertCalled = false;
    let noteTargetBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      if (url.includes("/rest/people")) {
        upsertCalled = true;
        throw new Error("upsertPerson must NOT be called on replay");
      }
      if (method === "POST" && url.endsWith("/rest/notes")) {
        return new Response(
          JSON.stringify({ data: { createNote: { id: "note_replay" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "POST" && url.endsWith("/rest/noteTargets")) {
        noteTargetBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ data: { createNoteTarget: { id: "nt_replay" } } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const persisted: { person?: string; note?: string } = {};
    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-sales-replay",
          eventType: "sales-form",
          payload: {
            source: "sales-form",
            email: "replay@test.local",
            name: "Bob Replay",
            company: "Acme",
            planInterest: "Pro",
            message: "Following up.",
          },
          attempts: 2,
          twentyPersonId: "person_from_prior_claim",
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async (id: string) => { persisted.person = id; },
          setTwentyNoteId: async (id: string) => { persisted.note = id; },
        },
      ),
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(upsertCalled).toBe(false);
    expect(persisted.person).toBeUndefined(); // not re-persisted on replay
    expect(persisted.note).toBe("note_replay");
    // noteTarget MUST link to the persisted personId, not anything fresh.
    // Cast through unknown so bun's `toEqual` overload doesn't narrow on
    // the captured `null` initializer (Record<string, unknown> | null).
    expect(noteTargetBody as unknown as Record<string, string>).toEqual({
      noteId: "note_replay",
      targetPersonId: "person_from_prior_claim",
    });
  });

  test("sales-form fully idempotent (both ids set) — no fetches, returns ok", async () => {
    // Both sub-steps already completed on a prior claim. The next claim
    // (e.g. the flusher recovered an in_flight row mid-status-stamp)
    // must short-circuit completely.
    let fetchCount = 0;
    const fetchImpl = (async (): Promise<Response> => {
      fetchCount++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-sales-done",
          eventType: "sales-form",
          payload: {
            source: "sales-form",
            email: "done@test.local",
            name: "X",
            company: "Y",
            planInterest: "Pro",
            message: "Hi",
          },
          attempts: 3,
          twentyPersonId: "p_done",
          twentyNoteId: "n_done",
        },
        {
          setTwentyPersonId: async () => { throw new Error("must not be called"); },
          setTwentyNoteId: async () => { throw new Error("must not be called"); },
        },
      ),
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(fetchCount).toBe(0);
  });

  test("signup happy path — upsertPerson stamps SIGNUP, NO createNote", async () => {
    // End-to-end happy path for a brand-new Better Auth signup. The
    // upsertPerson POST body MUST stamp both atlasFirstSource and
    // atlasLastSource = "SIGNUP" so the new Twenty Person carries the
    // sticky first-touch. The dispatcher MUST NOT fire any /rest/notes
    // call — the signup variant carries no message, so the normalizer
    // returns a `note`-less NormalizedLead.
    const fetchSeq: string[] = [];
    let createPersonBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      fetchSeq.push(`${method} ${url.replace("https://crm.test.local", "")}`);

      if (method === "GET" && url.includes("/rest/people?filter")) {
        // New email — no existing Person, so both source fields stamp.
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/rest/people")) {
        createPersonBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({ data: { createPerson: { id: "person_signup_1" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch on signup happy path: ${method} ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const persisted: { person?: string; note?: string } = {};
    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-signup-happy",
          eventType: "signup",
          payload: {
            source: "signup",
            email: "signup@test.local",
            name: "Alice Example",
          },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async (id: string) => { persisted.person = id; },
          setTwentyNoteId: async (id: string) => { persisted.note = id; },
        },
      ),
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(persisted.person).toBe("person_signup_1");
    // Critical: NO note was created.
    expect(persisted.note).toBeUndefined();
    expect(fetchSeq).toHaveLength(2);
    expect(fetchSeq[0]).toContain("GET /rest/people?filter");
    expect(fetchSeq[1]).toBe("POST /rest/people");
    // Sticky first-touch contract: brand-new email gets BOTH source
    // fields stamped to SIGNUP.
    expect(createPersonBody).not.toBeNull();
    const created = createPersonBody as unknown as Record<string, unknown>;
    expect(created.atlasFirstSource).toBe("SIGNUP");
    expect(created.atlasLastSource).toBe("SIGNUP");
    // Name is split at the normalizer seam.
    expect(created.name).toEqual({
      firstName: "Alice",
      lastName: "Example",
    });
  });

  test("signup preserves sticky atlasFirstSource on an email that previously demoed", async () => {
    // AC: an email that previously demoed must keep atlasFirstSource="DEMO"
    // and only flip atlasLastSource to "SIGNUP". Pins the first-source
    // preservation contract that lives inside TwentyClient.upsertPerson
    // end-to-end through dispatchOutboxRow.
    let patchBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/rest/people?filter")) {
        // Existing Person with sticky atlasFirstSource set by an earlier demo.
        return new Response(
          JSON.stringify({
            data: {
              people: [
                { id: "person_returning", atlasFirstSource: "DEMO", atlasLastSource: "DEMO" },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "PATCH" && url.includes("/rest/people/")) {
        patchBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({ data: { updatePerson: { id: "person_returning" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch on signup-returning path: ${method} ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const persisted: { person?: string; note?: string } = {};
    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-signup-returning",
          eventType: "signup",
          payload: {
            source: "signup",
            email: "returning@test.local",
            name: "Bob Returning",
          },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async (id: string) => { persisted.person = id; },
          setTwentyNoteId: async (id: string) => { persisted.note = id; },
        },
      ),
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(persisted.person).toBe("person_returning");
    expect(persisted.note).toBeUndefined();
    expect(patchBody).not.toBeNull();
    const patched = patchBody as unknown as Record<string, unknown>;
    // Critical: atlasFirstSource is NOT in the PATCH payload — sticky.
    expect(patched.atlasFirstSource).toBeUndefined();
    // Only atlasLastSource is updated.
    expect(patched.atlasLastSource).toBe("SIGNUP");
  });

  test("sales-form: createNote 4xx is dead-lettered with operation=createNote in the message", async () => {
    // upsertPerson succeeds; createNote returns 422. The row must
    // dead-letter so the operator sees the malformed note payload.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/rest/people")) {
        return new Response(
          JSON.stringify({ data: { createPerson: { id: "person_4xx" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "POST" && url.endsWith("/rest/notes")) {
        return new Response(JSON.stringify({ messages: ["title required"] }), {
          status: 422, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const persisted: { person?: string; note?: string } = {};
    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-sales-422",
          eventType: "sales-form",
          payload: {
            source: "sales-form",
            email: "fourtwo@test.local",
            name: "X",
            company: "Y",
            planInterest: "Pro",
            message: "Hi",
          },
          attempts: 1,
          twentyPersonId: null,
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async (id: string) => { persisted.person = id; },
          setTwentyNoteId: async (id: string) => { persisted.note = id; },
        },
      ),
    );

    expect(outcome.kind).toBe("permanent");
    if (outcome.kind === "permanent") {
      expect(outcome.message).toContain("createNote");
    }
    // personId is persisted before createNote runs — that's the
    // sub-step idempotency contract. On the next claim (well, on the
    // next manual operator retry after they fix the payload) the
    // dispatcher will skip upsertPerson.
    expect(persisted.person).toBe("person_4xx");
    expect(persisted.note).toBeUndefined();
  });

  test("sales-form: setTwentyPersonId throws after upsertPerson succeeds — transient, replay re-runs upsertPerson", async () => {
    // Models: sub-step 1 (upsertPerson) succeeds, sub-step 1's persist
    // callback (setTwentyPersonId) throws (e.g. pg pool exhausted while
    // stamping the row). The outcome MUST be transient with the
    // setTwentyPersonId-specific message so an operator can tell this
    // apart from `upsertPerson threw`. On replay, the dispatcher sees
    // `twentyPersonId === null` and re-runs upsertPerson, which is safe
    // because upsertPerson does find-by-email-first PATCH (no duplicate
    // Person on Twenty).
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/rest/people")) {
        return new Response(
          JSON.stringify({ data: { createPerson: { id: "person_persist_fail" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-sales-persist-fail",
          eventType: "sales-form",
          payload: {
            source: "sales-form",
            email: "persist@test.local",
            name: "Carla Persist",
            company: "Acme",
            planInterest: "Business",
            message: "Hi",
          },
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
      // Specifically NOT labelled as upsertPerson failure — that
      // matters for operator triage (the call itself succeeded).
      expect(outcome.message).not.toContain("upsertPerson threw");
    }
  });

  test("sales-form orphan-note retry: noteTarget 5xx returns transient AND replay re-issues both note POSTs (orphan note is real, not silently fixed)", async () => {
    // Pins the documented orphan-note trade-off: when /rest/noteTargets
    // fails after /rest/notes succeeded, the dispatcher returns
    // transient WITHOUT persisting twentyNoteId. Next claim re-runs the
    // full createNote (both POSTs) — duplicating the note in Twenty.
    // The orphan story is intentional (acceptable cost vs. dropping
    // the lead); this test proves it stays that way.
    const fetchSeq: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      fetchSeq.push(`${method} ${url.replace("https://crm.test.local", "")}`);
      if (method === "POST" && url.endsWith("/rest/notes")) {
        return new Response(
          JSON.stringify({ data: { createNote: { id: `note_attempt_${fetchSeq.length}` } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "POST" && url.endsWith("/rest/noteTargets")) {
        return new Response(JSON.stringify({ messages: ["upstream down"] }), {
          status: 503, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof globalThis.fetch;

    // Replay claim — `twentyPersonId` is populated, so upsertPerson is
    // skipped. Only the createNote sub-step runs.
    const persisted: { person?: string; note?: string } = {};
    const dispatch = () =>
      withFetch(fetchImpl, async () =>
        dispatchOutboxRow(
          { apiKey: "k", baseUrl: "https://crm.test.local" },
          {
            id: "row-orphan",
            eventType: "sales-form",
            payload: {
              source: "sales-form",
              email: "orphan@test.local",
              name: "X Y",
              company: "Acme",
              planInterest: "Pro",
              message: "Hi",
            },
            attempts: 1,
            twentyPersonId: "p_persisted",
            twentyNoteId: null,
          },
          {
            setTwentyPersonId: async (id: string) => { persisted.person = id; },
            setTwentyNoteId: async (id: string) => { persisted.note = id; },
          },
        ),
      );

    const outcome1 = await dispatch();
    expect(outcome1.kind).toBe("transient");
    expect(persisted.note).toBeUndefined(); // twentyNoteId NOT persisted on orphan
    // Sub-step 2 attempted both posts before classifying.
    expect(fetchSeq).toEqual([
      "POST /rest/notes",
      "POST /rest/noteTargets",
    ]);

    // Replay: dispatcher re-runs createNote (twentyNoteId still null).
    // The first note is now orphaned in Twenty under `note_attempt_1`.
    fetchSeq.length = 0;
    const outcome2 = await dispatch();
    expect(outcome2.kind).toBe("transient");
    expect(fetchSeq).toEqual([
      "POST /rest/notes",
      "POST /rest/noteTargets",
    ]);
  });

  test("sales-form: noteTarget 5xx surfaces orphanedNoteId on the TwentyClientError so the saas-crm dispatcher logs it for operator cleanup", async () => {
    // The orphan story above is operator-recoverable ONLY if the
    // operator can grep for the orphaned note id. The client carries
    // it on the error; classifyTwentyError emits a structured
    // `saas_crm.twenty_note_orphaned` log event with the id.
    let capturedNoteId: string | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/rest/notes")) {
        capturedNoteId = "note_will_orphan";
        return new Response(
          JSON.stringify({ data: { createNote: { id: capturedNoteId } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "POST" && url.endsWith("/rest/noteTargets")) {
        return new Response(JSON.stringify({ messages: ["link down"] }), {
          status: 503, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-orphan-id",
          eventType: "sales-form",
          payload: {
            source: "sales-form",
            email: "orphan-id@test.local",
            name: "X Y",
            company: "Acme",
            planInterest: "Pro",
            message: "Hi",
          },
          attempts: 1,
          twentyPersonId: "p_existing",
          twentyNoteId: null,
        },
        {
          setTwentyPersonId: async () => {},
          setTwentyNoteId: async () => {},
        },
      ),
    );

    // Transient (so flusher retries) but the orphaned note id is now
    // captured for operator follow-up via the structured log emitted
    // by classifyTwentyError. The outcome message includes the note id
    // so the row's stored failure_reason carries it forward too.
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.message).toContain("createNoteTarget");
      expect(outcome.message).toContain(capturedNoteId ?? "");
    }
  });

  test("sales-form: createNote 5xx is transient (retried by flusher)", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/rest/people")) {
        return new Response(JSON.stringify({ data: { createPerson: { id: "p_5xx" } } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/rest/notes")) {
        return new Response(JSON.stringify({ messages: ["upstream down"] }), {
          status: 503, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const outcome = await withFetch(fetchImpl, async () =>
      dispatchOutboxRow(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          id: "row-sales-5xx",
          eventType: "sales-form",
          payload: {
            source: "sales-form",
            email: "fivexx@test.local",
            name: "X",
            company: "Y",
            planInterest: "Pro",
            message: "Hi",
          },
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

