import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// `mock.module` is global and persists across tests in the same file, so the
// trio (internalQuery, hasInternalDB, logger) must mock every named export
// the hook touches. Partial mocks of `db/internal` cause SyntaxError across
// the rest of the suite.

let inserts: Array<{ sql: string; params: unknown[] }> = [];
let internalDbAvailable = true;
let throwOnNextQuery: Error | null = null;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => internalDbAvailable,
  internalQuery: async (sql: string, params: unknown[]) => {
    if (throwOnNextQuery) {
      const err = throwOnNextQuery;
      throwOnNextQuery = null;
      throw err;
    }
    inserts.push({ sql, params });
    return [];
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

mock.module("@atlas/api/lib/audit/error-scrub", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (cause: unknown) =>
    cause instanceof Error ? cause : new Error(String(cause)),
}));

// Imported AFTER mocks so the hook resolves them via mock.module.
import { onVerificationCreated } from "@atlas/api/lib/auth/trusted-device-hook";

function makeHeaders(init: Record<string, string>): Headers {
  return new Headers(init);
}

beforeEach(() => {
  inserts = [];
  internalDbAvailable = true;
  throwOnNextQuery = null;
});

describe("onVerificationCreated", () => {
  it("inserts a trusted_device row for trust-device-* identifiers", async () => {
    await onVerificationCreated(
      {
        identifier: "trust-device-abc123",
        value: "user_42",
      },
      {
        headers: makeHeaders({
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
          "x-forwarded-for": "203.0.113.7",
        }),
      },
    );

    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toMatch(/INSERT INTO trusted_device/);
    expect(inserts[0].sql).toMatch(/ON CONFLICT \(identifier\) DO NOTHING/);
    const [identifier, userId, ua, ip, label] = inserts[0].params as string[];
    expect(identifier).toBe("trust-device-abc123");
    expect(userId).toBe("user_42");
    expect(ua).toMatch(/Mac OS X/);
    expect(ip).toBe("203.0.113.7");
    expect(label).toBe("Mac · Safari");
  });

  it("ignores non-trust-device identifiers", async () => {
    await onVerificationCreated(
      { identifier: "email-verify-xxx", value: "user_1" },
      { headers: makeHeaders({ "user-agent": "irrelevant" }) },
    );
    await onVerificationCreated(
      { identifier: "two-factor-cookie-xxx", value: "user_1" },
      { headers: makeHeaders({ "user-agent": "irrelevant" }) },
    );
    expect(inserts).toHaveLength(0);
  });

  it("falls through gracefully when headers are missing", async () => {
    await onVerificationCreated(
      { identifier: "trust-device-no-headers", value: "user_99" },
      { headers: undefined },
    );

    expect(inserts).toHaveLength(1);
    const [identifier, userId, ua, ip, label] = inserts[0].params as Array<
      string | null
    >;
    expect(identifier).toBe("trust-device-no-headers");
    expect(userId).toBe("user_99");
    expect(ua).toBeNull();
    expect(ip).toBeNull();
    expect(label).toBeNull();
  });

  it("uses the first chained x-forwarded-for entry", async () => {
    await onVerificationCreated(
      { identifier: "trust-device-chain", value: "user_3" },
      {
        headers: makeHeaders({
          "x-forwarded-for": "198.51.100.1, 10.0.0.5, 172.16.0.1",
        }),
      },
    );

    expect(inserts).toHaveLength(1);
    expect((inserts[0].params as string[])[3]).toBe("198.51.100.1");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    await onVerificationCreated(
      { identifier: "trust-device-real-ip", value: "user_5" },
      { headers: makeHeaders({ "x-real-ip": "192.0.2.55" }) },
    );

    expect(inserts).toHaveLength(1);
    expect((inserts[0].params as string[])[3]).toBe("192.0.2.55");
  });

  it("skips the row when value (userId) is missing", async () => {
    await onVerificationCreated(
      { identifier: "trust-device-novalue", value: undefined },
      { headers: makeHeaders({}) },
    );

    expect(inserts).toHaveLength(0);
  });

  it("skips when no internal DB is configured", async () => {
    internalDbAvailable = false;
    await onVerificationCreated(
      { identifier: "trust-device-no-db", value: "user_1" },
      { headers: makeHeaders({}) },
    );

    expect(inserts).toHaveLength(0);
  });

  it("never throws — auth flow must not fail on metadata write errors", async () => {
    throwOnNextQuery = new Error("boom: simulated DB failure");

    await expect(
      onVerificationCreated(
        { identifier: "trust-device-explode", value: "user_x" },
        { headers: makeHeaders({}) },
      ),
    ).resolves.toBeUndefined();

    // Insert was attempted (and failed) — no row recorded.
    expect(inserts).toHaveLength(0);
  });

  it("skips when the record is null/undefined", async () => {
    await onVerificationCreated(null, { headers: makeHeaders({}) });
    await onVerificationCreated(undefined, undefined);
    expect(inserts).toHaveLength(0);
  });
});
