/**
 * SaasCrm layer tests — boot verification + dispatch behavior.
 *
 * These tests exercise the EE-side Layer (`SaasCrmLive`) directly with
 * a mocked fetch impl, isolating from both the plugin's HTTP wrapper
 * (covered separately in `plugins/twenty/__tests__/`) and from Twenty
 * itself. There are NO live calls to crm.useatlas.dev.
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
const { verifyCustomFields, dispatchLead } = await import("../index");

describe("verifyCustomFields", () => {
  beforeEach(() => {
    enterpriseEnabled = true;
  });

  test("returns ok=true when both required custom fields are present", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: {
            fields: [
              { name: "id" },
              { name: "atlasFirstSource" },
              { name: "atlasLastSource" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      expect(result).toEqual({ ok: true });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("returns ok=false when atlasFirstSource is missing", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: { fields: [{ name: "id" }, { name: "atlasLastSource" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      expect(result).toEqual({ ok: false });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("returns ok=false when atlasLastSource is missing", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: { fields: [{ name: "id" }, { name: "atlasFirstSource" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      expect(result).toEqual({ ok: false });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("returns ok='transient' when metadata endpoint errors", async () => {
    const fetchImpl = (async () =>
      new Response("oops", { status: 503 })) as unknown as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      if (result.ok !== "transient") {
        throw new Error("expected transient");
      }
      expect(result.reason.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("returns ok='transient' on network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const result = await verifyCustomFields({
        apiKey: "k",
        baseUrl: "https://crm.test.local",
      });
      if (result.ok !== "transient") {
        throw new Error("expected transient");
      }
      expect(result.reason).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("dispatchLead", () => {
  test("happy path — normalizes and upserts; does not throw", async () => {
    let fetchCount = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      fetchCount++;
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/rest/people?filter=")) {
        // GET — not found
        return new Response(JSON.stringify({ data: { people: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // POST createPerson
      return new Response(
        JSON.stringify({ data: { createPerson: { id: "person_xyz" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await dispatchLead(
        { apiKey: "k", baseUrl: "https://crm.test.local" },
        {
          source: "demo",
          email: "user@test.com",
          ip: "1.2.3.4",
        },
      );
      expect(fetchCount).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("never throws when Twenty returns a 5xx", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: ["Internal Server Error"] }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      // Should resolve, not reject. That contract is the whole point of
      // the SaasCrm layer.
      await expect(
        dispatchLead(
          { apiKey: "k", baseUrl: "https://crm.test.local" },
          { source: "demo", email: "user@test.com" },
        ),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("never throws on network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await expect(
        dispatchLead(
          { apiKey: "k", baseUrl: "https://crm.test.local" },
          { source: "demo", email: "user@test.com" },
        ),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("SaasCrmLive boot — enterprise disabled", () => {
  test("yields available=false and no-op upsertLead when enterprise is OFF", async () => {
    enterpriseEnabled = false;
    // Re-import the layer fresh — Layer.effect captures the gate read on construction.
    delete require.cache?.[require.resolve("../index")];
    const { SaasCrmLive } = await import("../index");
    const { SaasCrm } = await import("@atlas/api/lib/effect/services");

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
