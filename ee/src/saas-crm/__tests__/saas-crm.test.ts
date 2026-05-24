/**
 * SaasCrm layer tests — boot verification + dispatch + end-to-end Live wiring.
 *
 * Exercises the EE-side Layer (`SaasCrmLive`) with a mocked fetch impl,
 * isolating from both the plugin's HTTP wrapper (covered in
 * `plugins/twenty/__tests__/`) and from Twenty itself. There are NO
 * live calls to crm.useatlas.dev.
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

// ── Now we can import the layer + its helpers ───────────────────────
const { verifyCustomFields, dispatchLead, SaasCrmLive } = await import("../index");
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

// ── verifyCustomFields ──────────────────────────────────────────────

describe("verifyCustomFields", () => {
  beforeEach(() => {
    enterpriseEnabled = true;
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

  test("returns ok=false when atlasLastSource is missing", async () => {
    const fetchImpl = (async () =>
      metadataResponse(["id", "atlasFirstSource"])) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      expect(result).toEqual({ ok: false });
    });
  });

  test("returns ok='transient' on 5xx (transient upstream failure)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: ["oops"] }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      if (result.ok !== "transient") throw new Error("expected transient");
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  test("returns ok='transient' on network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      if (result.ok !== "transient") throw new Error("expected transient");
      expect(result.reason).toContain("ECONNREFUSED");
    });
  });

  // CX-2 — deterministic misconfigurations are NOT transient.

  test("returns ok=false on 401 (bad API key — deterministic misconfiguration)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: ["Unauthorized"] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      const result = await verifyCustomFields({
        apiKey: "wrong-key",
        baseUrl: "https://crm.test.local",
      });
      expect(result).toEqual({ ok: false });
    });
  });

  test("returns ok=false on 403 (deterministic misconfiguration)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: ["Forbidden"] }), {
        status: 403,
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

  test("returns ok=false on 404 (wrong base URL — deterministic misconfiguration)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: ["Not Found"] }), {
        status: 404,
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

// ── dispatchLead — fire-and-forget contract ─────────────────────────

describe("dispatchLead", () => {
  test("happy path — normalizes and upserts; does not throw", async () => {
    let fetchCount = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      fetchCount++;
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: { createPerson: { id: "person_xyz" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      await dispatchLead(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        { source: "demo", email: "user@test.com", ip: "1.2.3.4" },
      );
      expect(fetchCount).toBe(2);
    });
  });

  test("never throws when Twenty returns a 5xx", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: ["Internal Server Error"] }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      await expect(
        dispatchLead(
          { apiKey: "k", baseUrl: "https://crm.test.local" },
          { source: "demo", email: "user@test.com" },
        ),
      ).resolves.toBeUndefined();
    });
  });

  test("never throws on network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      await expect(
        dispatchLead(
          { apiKey: "k", baseUrl: "https://crm.test.local" },
          { source: "demo", email: "user@test.com" },
        ),
      ).resolves.toBeUndefined();
    });
  });

  test("never throws on malformed-200 from findPersonByEmail", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { people: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    await withFetch(fetchImpl, async () => {
      await expect(
        dispatchLead(
          { apiKey: "k", baseUrl: "https://crm.test.local" },
          { source: "demo", email: "user@test.com" },
        ),
      ).resolves.toBeUndefined();
    });
  });
});

// ── SaasCrmLive boot end-to-end ─────────────────────────────────────

describe("SaasCrmLive boot — enterprise disabled", () => {
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
  });
});

describe("SaasCrmLive boot — enterprise enabled + creds + both fields present (R-6)", () => {
  test("yields available=true AND dispatches via TwentyClient on subsequent upsertLead", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    let metadataCalls = 0;
    let dispatchCalls = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/metadata")) {
        metadataCalls++;
        return metadataResponse(["id", "atlasFirstSource", "atlasLastSource"]);
      }
      dispatchCalls++;
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: { createPerson: { id: "person_xyz" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          const wasAvailable = crm.available;
          yield* crm.upsertLead({
            source: "demo",
            email: "verified@happy.test",
          });
          return wasAvailable;
        });
        return Effect.runPromise(program.pipe(Effect.provide(SaasCrmLive)));
      });

      expect(result).toBe(true);
      expect(metadataCalls).toBe(1);
      // Dispatch: 1 GET (find) + 1 POST (create)
      expect(dispatchCalls).toBe(2);
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });
});

describe("SaasCrmLive boot — missing required field flips available to false (R-5)", () => {
  test("yields available=false when atlasFirstSource is missing", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    let dispatchCalls = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/metadata")) {
        // Only atlasLastSource present — atlasFirstSource missing
        return metadataResponse(["id", "atlasLastSource"]);
      }
      dispatchCalls++;
      return new Response(JSON.stringify({}), { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          // Should be a no-op since available=false
          yield* crm.upsertLead({
            source: "demo",
            email: "missingfield@x.test",
          });
          return crm.available;
        });
        return Effect.runPromise(program.pipe(Effect.provide(SaasCrmLive)));
      });

      expect(result).toBe(false);
      // No dispatch calls should have happened (Noop upsertLead bound).
      expect(dispatchCalls).toBe(0);
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });
});

describe("SaasCrmLive boot — transient metadata failure leaves available=true (R-7)", () => {
  test("yields available=true when the metadata probe rejects with a network error", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    let metadataCalls = 0;
    let dispatchCalls = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/metadata")) {
        metadataCalls++;
        throw new Error("ECONNRESET");
      }
      dispatchCalls++;
      if (url.includes("/rest/people?filter")) {
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: { createPerson: { id: "p1" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await withFetch(fetchImpl, async () => {
        const program = Effect.gen(function* () {
          const crm = yield* SaasCrm;
          yield* crm.upsertLead({ source: "demo", email: "transient@x.test" });
          return crm.available;
        });
        return Effect.runPromise(program.pipe(Effect.provide(SaasCrmLive)));
      });

      expect(result).toBe(true);
      expect(metadataCalls).toBe(1);
      expect(dispatchCalls).toBeGreaterThan(0);
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });
});

describe("SaasCrmLive boot — 401 metadata response flips to permanent (CX-2)", () => {
  test("yields available=false on 401 and does NOT dispatch", async () => {
    enterpriseEnabled = true;
    process.env.TWENTY_API_KEY = "test-key";
    process.env.TWENTY_BASE_URL = "https://crm.test.local";

    let dispatchCalls = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/metadata")) {
        return new Response(JSON.stringify({ messages: ["Unauthorized"] }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      dispatchCalls++;
      return new Response(JSON.stringify({}), { status: 500 });
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
      expect(dispatchCalls).toBe(0);
    } finally {
      delete process.env.TWENTY_API_KEY;
      delete process.env.TWENTY_BASE_URL;
    }
  });
});
