/**
 * Tests for /api/v1/admin/me/trusted-devices.
 *
 * Three concerns:
 *   1. Auth — unauthenticated 401, non-managed mode 404, managed user OK.
 *   2. List shape — joins with verification, drops expired rows, marks
 *      `isCurrent` against the request cookie.
 *   3. Revoke — atomic across both tables, IDOR-safe, ROLLBACK on partial
 *      failure, 404 when neither table had a matching row.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Auth mock ──────────────────────────────────────────────────────────────

type FakeAuth =
  | { kind: "anonymous" }
  | { kind: "unauthenticated"; status: 401 | 429; error: string }
  | { kind: "managed"; userId: string }
  | { kind: "byot" }
  | { kind: "throw" };

let fakeAuth: FakeAuth = { kind: "anonymous" };

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: async () => {
    if (fakeAuth.kind === "throw") throw new Error("auth boom");
    if (fakeAuth.kind === "unauthenticated") {
      return {
        authenticated: false,
        status: fakeAuth.status,
        error: fakeAuth.error,
      };
    }
    if (fakeAuth.kind === "managed") {
      return {
        authenticated: true,
        mode: "managed" as const,
        user: {
          id: fakeAuth.userId,
          mode: "managed",
          label: `${fakeAuth.userId}@test.dev`,
          role: "member",
          activeOrganizationId: null,
          claims: {},
        },
      };
    }
    if (fakeAuth.kind === "byot") {
      return {
        authenticated: true,
        mode: "byot" as const,
        user: {
          id: "byot-user",
          mode: "byot",
          label: "byot",
          role: "member",
          activeOrganizationId: null,
          claims: {},
        },
      };
    }
    return { authenticated: false, status: 401 as const, error: "anonymous" };
  },
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed" as const,
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  };
});

mock.module("@atlas/api/lib/audit/error-scrub", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (cause: unknown) =>
    cause instanceof Error ? cause : new Error(String(cause)),
}));

// ── DB mocks ───────────────────────────────────────────────────────────────

interface FakeRow {
  identifier: string;
  user_id: string;
  device_label: string | null;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  expires_at: string;
}

let trustedDevices: FakeRow[] = [];
// Verification rows, keyed on identifier. Mirrors what Better Auth writes.
let verifications: Array<{ identifier: string; value: string; expiresAt: string }> = [];

let dbAvailable = true;
let queryShouldFail = false;
// Per-test transaction failure injection: which query(s) inside the
// connect() flow should reject. Keys: "verification" | "trusted_device".
const txFail: { stage: "verification" | "trusted_device" | null } = { stage: null };

const txLog: string[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => dbAvailable,
  internalQuery: async (sql: string, params: unknown[]) => {
    if (queryShouldFail) throw new Error("simulated query failure");
    if (sql.includes("FROM trusted_device td")) {
      const userId = params?.[0] as string;
      const now = Date.now();
      return trustedDevices
        .filter((r) => r.user_id === userId)
        .map((r) => {
          const v = verifications.find((x) => x.identifier === r.identifier);
          if (!v) return null;
          if (new Date(v.expiresAt).getTime() <= now) return null;
          return {
            identifier: r.identifier,
            device_label: r.device_label,
            user_agent: r.user_agent,
            ip_address: r.ip_address,
            created_at: r.created_at,
            expires_at: v.expiresAt,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
    }
    return [];
  },
  getInternalDB: () => ({
    query: async () => ({ rows: [] }),
    connect: async () => {
      let started = false;
      let rolledBack = false;
      return {
        query: async (sql: string, params?: unknown[]) => {
          txLog.push(sql.split(/\s+/).slice(0, 3).join(" "));
          if (sql === "BEGIN") {
            started = true;
            return { rows: [] };
          }
          if (sql === "COMMIT") return { rows: [] };
          if (sql === "ROLLBACK") {
            rolledBack = true;
            return { rows: [] };
          }
          if (!started) throw new Error("query without BEGIN");

          if (sql.startsWith("DELETE FROM verification")) {
            if (txFail.stage === "verification") throw new Error("verification delete failed");
            const [identifier, userId] = params as string[];
            const before = verifications.length;
            verifications = verifications.filter(
              (v) => !(v.identifier === identifier && v.value === userId),
            );
            return { rows: [], rowCount: before - verifications.length };
          }
          if (sql.startsWith("DELETE FROM trusted_device")) {
            if (txFail.stage === "trusted_device") throw new Error("trusted_device delete failed");
            const [identifier, userId] = params as string[];
            const before = trustedDevices.length;
            trustedDevices = trustedDevices.filter(
              (r) => !(r.identifier === identifier && r.user_id === userId),
            );
            return { rows: [], rowCount: before - trustedDevices.length };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
        release: () => {
          // Track rollback observability so the never-leak assertion in tests
          // still has signal even if the implementation skips ROLLBACK.
          void rolledBack;
        },
      };
    },
    end: async () => {},
    on: () => {},
  }),
  // Effect-typed exports referenced by the route module's import surface.
  queryEffect: () => {
    throw new Error("queryEffect not used in this route");
  },
}));

// admin-auth's authErrorCode is a tiny pure helper — re-export the real one
// (no mock) so error codes match the production wire format.

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import {
  registerTrustedDeviceRoutes,
  extractTrustDeviceIdentifier,
} from "../me-trusted-devices";

function buildApp() {
  const app = new OpenAPIHono();
  app.use(
    createMiddleware(async (c, next) => {
      c.set("requestId", "test-req-id");
      await next();
    }),
  );
  registerTrustedDeviceRoutes(app, (c) => c.get("requestId") as string);
  return app;
}

beforeEach(() => {
  fakeAuth = { kind: "anonymous" };
  trustedDevices = [];
  verifications = [];
  dbAvailable = true;
  queryShouldFail = false;
  txFail.stage = null;
  txLog.length = 0;
});

// ---------------------------------------------------------------------------
// extractTrustDeviceIdentifier — pure helper
// ---------------------------------------------------------------------------

describe("extractTrustDeviceIdentifier", () => {
  it("returns null for missing cookie header", () => {
    expect(extractTrustDeviceIdentifier(null)).toBeNull();
    expect(extractTrustDeviceIdentifier("")).toBeNull();
  });

  it("extracts the identifier after the '!' from a signed cookie", () => {
    const header = "better-auth.trust_device=hmacgoeshere!trust-device-abc123; other=foo";
    expect(extractTrustDeviceIdentifier(header)).toBe("trust-device-abc123");
  });

  it("strips the __Secure- prefix", () => {
    const header = "__Secure-better-auth.trust_device=hmac!trust-device-prod";
    expect(extractTrustDeviceIdentifier(header)).toBe("trust-device-prod");
  });

  it("handles a custom cookiePrefix", () => {
    const header = "atlas.trust_device=hmac!trust-device-custom";
    expect(extractTrustDeviceIdentifier(header)).toBe("trust-device-custom");
  });

  it("ignores cookies whose name suffix differs", () => {
    const header = "better-auth.session_token=abc; other.trust_device_x=hmac!fake";
    expect(extractTrustDeviceIdentifier(header)).toBeNull();
  });

  it("rejects values without the trust-device- prefix on the identifier", () => {
    const header = "better-auth.trust_device=hmac!something-else";
    expect(extractTrustDeviceIdentifier(header)).toBeNull();
  });

  it("handles URL-encoded cookie values", () => {
    const raw = encodeURIComponent("hmac+slash!trust-device-decoded");
    const header = `better-auth.trust_device=${raw}`;
    expect(extractTrustDeviceIdentifier(header)).toBe("trust-device-decoded");
  });
});

// ---------------------------------------------------------------------------
// GET /me/trusted-devices
// ---------------------------------------------------------------------------

describe("GET /me/trusted-devices", () => {
  it("returns 401 when unauthenticated", async () => {
    fakeAuth = { kind: "unauthenticated", status: 401, error: "no session" };
    const app = buildApp();
    const res = await app.request("/me/trusted-devices");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the caller is not in managed mode", async () => {
    fakeAuth = { kind: "byot" };
    const app = buildApp();
    const res = await app.request("/me/trusted-devices");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_available");
  });

  it("returns the calling user's active grants", async () => {
    fakeAuth = { kind: "managed", userId: "user_a" };
    const future = new Date(Date.now() + 86_400_000).toISOString();
    trustedDevices = [
      {
        identifier: "trust-device-mac",
        user_id: "user_a",
        device_label: "Mac · Safari",
        user_agent: "Mozilla/5.0 (Macintosh)",
        ip_address: "203.0.113.1",
        created_at: new Date().toISOString(),
        expires_at: future,
      },
      {
        identifier: "trust-device-other-user",
        user_id: "user_b",
        device_label: "Win · Chrome",
        user_agent: null,
        ip_address: null,
        created_at: new Date().toISOString(),
        expires_at: future,
      },
    ];
    verifications = [
      { identifier: "trust-device-mac", value: "user_a", expiresAt: future },
      { identifier: "trust-device-other-user", value: "user_b", expiresAt: future },
    ];

    const app = buildApp();
    const res = await app.request("/me/trusted-devices");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devices: Array<{ identifier: string; deviceLabel: string | null; isCurrent: boolean }>;
    };
    // IDOR — other user's row must not appear.
    expect(body.devices.map((d) => d.identifier)).toEqual(["trust-device-mac"]);
    expect(body.devices[0].deviceLabel).toBe("Mac · Safari");
    expect(body.devices[0].isCurrent).toBe(false);
  });

  it("marks isCurrent=true for the row matching the request's trust cookie", async () => {
    fakeAuth = { kind: "managed", userId: "user_a" };
    const future = new Date(Date.now() + 86_400_000).toISOString();
    trustedDevices = [
      {
        identifier: "trust-device-current",
        user_id: "user_a",
        device_label: "iPhone · Safari",
        user_agent: null,
        ip_address: null,
        created_at: new Date().toISOString(),
        expires_at: future,
      },
    ];
    verifications = [
      { identifier: "trust-device-current", value: "user_a", expiresAt: future },
    ];

    const app = buildApp();
    const res = await app.request("/me/trusted-devices", {
      headers: { cookie: "better-auth.trust_device=hmac!trust-device-current" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: Array<{ isCurrent: boolean }> };
    expect(body.devices[0].isCurrent).toBe(true);
  });

  it("returns 500 on unexpected query failure", async () => {
    fakeAuth = { kind: "managed", userId: "user_a" };
    queryShouldFail = true;
    const app = buildApp();
    const res = await app.request("/me/trusted-devices");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBe("test-req-id");
  });

  it("returns empty list when internal DB is unavailable", async () => {
    fakeAuth = { kind: "managed", userId: "user_a" };
    dbAvailable = false;
    const app = buildApp();
    const res = await app.request("/me/trusted-devices");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: unknown[] };
    expect(body.devices).toEqual([]);
  });

  it("returns 500 when the auth subsystem itself throws", async () => {
    fakeAuth = { kind: "throw" };
    const app = buildApp();
    const res = await app.request("/me/trusted-devices");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("auth_error");
  });
});

// ---------------------------------------------------------------------------
// DELETE /me/trusted-devices/:identifier
// ---------------------------------------------------------------------------

describe("DELETE /me/trusted-devices/:identifier", () => {
  it("returns 401 when unauthenticated", async () => {
    fakeAuth = { kind: "unauthenticated", status: 401, error: "no session" };
    const app = buildApp();
    const res = await app.request("/me/trusted-devices/trust-device-x", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("revokes a valid grant atomically", async () => {
    fakeAuth = { kind: "managed", userId: "user_a" };
    const future = new Date(Date.now() + 86_400_000).toISOString();
    trustedDevices = [
      {
        identifier: "trust-device-a",
        user_id: "user_a",
        device_label: null,
        user_agent: null,
        ip_address: null,
        created_at: new Date().toISOString(),
        expires_at: future,
      },
    ];
    verifications = [{ identifier: "trust-device-a", value: "user_a", expiresAt: future }];

    const app = buildApp();
    const res = await app.request("/me/trusted-devices/trust-device-a", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // Both tables drained, transaction committed (not rolled back).
    expect(trustedDevices).toHaveLength(0);
    expect(verifications).toHaveLength(0);
    expect(txLog).toContain("BEGIN");
    expect(txLog).toContain("COMMIT");
    expect(txLog).not.toContain("ROLLBACK");
  });

  it("refuses to revoke another user's grant (IDOR)", async () => {
    fakeAuth = { kind: "managed", userId: "user_a" };
    const future = new Date(Date.now() + 86_400_000).toISOString();
    trustedDevices = [
      {
        identifier: "trust-device-victim",
        user_id: "user_b",
        device_label: null,
        user_agent: null,
        ip_address: null,
        created_at: new Date().toISOString(),
        expires_at: future,
      },
    ];
    verifications = [
      { identifier: "trust-device-victim", value: "user_b", expiresAt: future },
    ];

    const app = buildApp();
    const res = await app.request("/me/trusted-devices/trust-device-victim", { method: "DELETE" });
    expect(res.status).toBe(404);

    // Victim's rows untouched.
    expect(trustedDevices).toHaveLength(1);
    expect(verifications).toHaveLength(1);
  });

  it("returns 404 for an unknown identifier", async () => {
    fakeAuth = { kind: "managed", userId: "user_a" };
    const app = buildApp();
    const res = await app.request("/me/trusted-devices/trust-device-ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rolls back when the trusted_device delete fails after verification delete", async () => {
    fakeAuth = { kind: "managed", userId: "user_a" };
    const future = new Date(Date.now() + 86_400_000).toISOString();
    trustedDevices = [
      {
        identifier: "trust-device-rollback",
        user_id: "user_a",
        device_label: null,
        user_agent: null,
        ip_address: null,
        created_at: new Date().toISOString(),
        expires_at: future,
      },
    ];
    verifications = [
      { identifier: "trust-device-rollback", value: "user_a", expiresAt: future },
    ];

    txFail.stage = "trusted_device";
    const app = buildApp();
    const res = await app.request("/me/trusted-devices/trust-device-rollback", { method: "DELETE" });
    expect(res.status).toBe(500);
    expect(txLog).toContain("BEGIN");
    expect(txLog).toContain("ROLLBACK");
    expect(txLog).not.toContain("COMMIT");
  });
});
