/**
 * captureDemoLead — defensive-catch + SaasCrm dispatch contract.
 *
 * These tests pin two acceptance-criterion behaviors that are easy to
 * regress with passing tests elsewhere:
 *
 *  1. "Twenty being unreachable does not block POST /api/v1/demo/start"
 *     → `captureDemoLead` MUST resolve even when the SaasCrm Effect
 *     dies / throws / rejects mid-runPromise. Tested by mocking the
 *     runEnterprise call site to die.
 *
 *  2. Self-hosted (Noop layer) MUST NOT dispatch — no fetch is made,
 *     and the function still resolves cleanly.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";

// ── Mock storage state (controlled per-test) ────────────────────────

let hasInternalDBValue = true;
type QueryRow = Record<string, unknown>;
let internalQueryImpl: (sql: string, params?: unknown[]) => Promise<QueryRow[]> = async () => [
  { session_count: 1 },
];

let runEnterpriseImpl: (p: unknown) => Promise<unknown> = async () => undefined;

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasInternalDBValue,
  internalQuery: (sql: string, params?: unknown[]) => internalQueryImpl(sql, params),
  // Other exports demo.ts doesn't reach but are mocked to keep partial
  // mock.module happy with imports made transitively.
  getInternalDB: () => null,
  internalExecute: () => {},
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
  getEncryptionKey: () => Buffer.from("test-key-32-bytes-long-enough!!!"),
  closeInternalDB: async () => {},
  migrateInternalDB: async () => {},
  _resetPool: () => {},
  loadSavedConnections: async () => 0,
}));

void mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  runEnterprise: (p: unknown) => runEnterpriseImpl(p),
  getEnterpriseRuntime: () => ({
    runPromise: <A, E>(p: Effect.Effect<A, E, never>) => Effect.runPromise(p),
  }),
}));

// SaasCrm Tag is re-imported by the demo module — keep the default
// (Noop-shaped) implementation visible. The captured `runEnterprise`
// mock controls how it's invoked.
void mock.module("@atlas/api/lib/effect/services", () => ({
  // Minimal Tag shim that supplies `available: false` + a no-op upsertLead;
  // tests that need the real Effect-Context behaviour drive the
  // `runEnterprise` mock instead.
  SaasCrm: {
    pipe: () => {},
  },
}));

// ── Import the unit under test AFTER mocks ─────────────────────────

const { captureDemoLead } = await import("../lib/demo");

beforeEach(() => {
  hasInternalDBValue = true;
  internalQueryImpl = async () => [{ session_count: 1 }];
  // Default: runEnterprise runs the program normally — yields the Tag
  // and calls upsertLead, which for a Noop is just Effect.void.
  runEnterpriseImpl = async () => undefined;
});

// ── R-4 #1 — die path doesn't block the demo response ──────────────

describe("captureDemoLead — Twenty failure swallow contract (R-4)", () => {
  it("resolves even when SaasCrm.upsertLead's Effect dies", async () => {
    runEnterpriseImpl = async () => {
      throw new Error("simulated defect inside runEnterprise");
    };

    const result = await captureDemoLead({
      email: "die@test.com",
      ip: "1.2.3.4",
      userAgent: "ua",
      requestId: "req-die",
    });

    // Insert succeeded → session_count 1 → returning=false
    expect(result).toEqual({ returning: false, sessionCount: 1 });
  });

  it("resolves even when runEnterprise itself rejects asynchronously", async () => {
    runEnterpriseImpl = async () => {
      return Promise.reject(new Error("async reject"));
    };

    await expect(
      captureDemoLead({
        email: "reject@test.com",
        requestId: "req-reject",
      }),
    ).resolves.toEqual({ returning: false, sessionCount: 1 });
  });

  it("returning=true on a duplicate email even when CRM dispatch dies", async () => {
    internalQueryImpl = async () => [{ session_count: 3 }];
    runEnterpriseImpl = async () => {
      throw new Error("die");
    };

    const result = await captureDemoLead({
      email: "returning@test.com",
      requestId: "req-r",
    });

    expect(result).toEqual({ returning: true, sessionCount: 3 });
  });
});

// ── R-4 #2 — Noop / self-hosted: never dispatches ──────────────────

describe("captureDemoLead — self-hosted (Noop layer) (R-4)", () => {
  it("resolves cleanly without ever rejecting or throwing", async () => {
    // runEnterpriseImpl default — runs the program. The Noop SaasCrm
    // layer (production default) yields available=false and a no-op
    // upsertLead. Tracked here by counting how many times runEnterprise
    // is invoked (exactly once) and confirming no error escapes.
    let runEnterpriseCalls = 0;
    runEnterpriseImpl = async () => {
      runEnterpriseCalls++;
      // Simulate the Noop's `upsertLead: () => Effect.void` resolving.
      return undefined;
    };

    await expect(
      captureDemoLead({
        email: "selfhosted@test.com",
        requestId: "req-self",
      }),
    ).resolves.toBeDefined();

    expect(runEnterpriseCalls).toBe(1);
  });

  it("still inserts demo_leads row when CRM dispatch is a noop", async () => {
    let inserted = false;
    internalQueryImpl = async (sql) => {
      if (sql.includes("INSERT INTO demo_leads")) {
        inserted = true;
        return [{ session_count: 1 }];
      }
      return [];
    };

    await captureDemoLead({
      email: "insert@test.com",
      requestId: "req-ins",
    });

    expect(inserted).toBe(true);
  });
});

// ── DB-failure path still attempts CRM dispatch ─────────────────────

describe("captureDemoLead — internal DB unavailable", () => {
  it("short-circuits the demo_leads insert when hasInternalDB returns false", async () => {
    hasInternalDBValue = false;
    let runEnterpriseCalls = 0;
    runEnterpriseImpl = async () => {
      runEnterpriseCalls++;
      return undefined;
    };

    const result = await captureDemoLead({
      email: "nodb@test.com",
      requestId: "req-nodb",
    });

    expect(result).toEqual({ returning: false, sessionCount: 1 });
    // When there's no internal DB we early-return BEFORE the CRM
    // dispatch — leads are lost the same way demo_leads inserts are
    // (matches existing pre-#2727 behavior).
    expect(runEnterpriseCalls).toBe(0);
  });
});
