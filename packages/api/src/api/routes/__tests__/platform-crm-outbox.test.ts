/**
 * Platform CRM outbox route integration tests (#2735, 1.6.0 slice 9).
 *
 * Covers list / detail / retry / mark-dead end-to-end via a mounted Hono
 * test app. The Hono → Effect bridge is stubbed to inject the SaasCrm
 * Tag (toggleable for the self-hosted 404 branch) plus a per-test stub
 * for `internalQuery`, so the route is exercised without touching a
 * real Postgres.
 *
 * Acceptance coverage:
 *  - 404 when SaasCrm.available === false (self-hosted)
 *  - 200 list + filters
 *  - 200 detail + 404 row-not-found
 *  - 200 retry on a dead row (audit row written, attempts preserved)
 *  - 400 retry on a non-dead row
 *  - 200 mark-dead on pending/in_flight (audit row written)
 *  - 400 mark-dead on a row already in a terminal state
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Effect, Layer } from "effect";
import type { SaasCrmShape } from "@atlas/api/lib/effect/services";

// ── Mockable state ──────────────────────────────────────────────────

let saasAvailable = true;
let hasDB = true;
type Stub = (
  sql: string,
  params: unknown[] | undefined,
) => Promise<Record<string, unknown>[]>;
let queryStub: Stub = async () => [];
let queryCalls: { sql: string; params: unknown[] | undefined }[] = [];

interface CapturedAudit {
  actionType: string;
  targetType: string;
  targetId: string;
  scope?: string;
  metadata?: Record<string, unknown>;
}
let auditCalls: CapturedAudit[] = [];

// ── Mock side modules BEFORE importing the route ────────────────────

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasDB,
  internalQuery: async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    return queryStub(sql, params);
  },
  // Re-exported by transitive consumers; provide no-op shapes so they
  // can't crash a sibling import.
  getInternalDB: () => null,
  internalExecute: async () => undefined,
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: {
    crm_outbox: {
      retry: "crm_outbox.retry",
      markDead: "crm_outbox.mark_dead",
    },
  },
  logAdminAction: (entry: CapturedAudit) => {
    auditCalls.push(entry);
  },
  logAdminActionAwait: async (entry: CapturedAudit) => {
    auditCalls.push(entry);
  },
}));

// Bypass the platform-admin auth + MFA middleware so we exercise the
// handler logic, not auth plumbing. Same passthrough pattern used by
// `integrations-catalog.test.ts`.
import { createMiddleware } from "hono/factory";
const passthrough = createMiddleware(async (_c, next) => {
  await next();
});

mock.module("./routes/middleware", () => ({
  adminAuth: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
}));
mock.module("../middleware", () => ({
  adminAuth: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
}));
mock.module("@atlas/api/api/routes/middleware", () => ({
  adminAuth: passthrough,
  platformAdminAuth: passthrough,
  requestContext: passthrough,
  standardAuth: passthrough,
  withRequestId: passthrough,
}));
mock.module("../admin-mfa-required", () => ({
  mfaRequired: passthrough,
}));
mock.module("./routes/admin-mfa-required", () => ({
  mfaRequired: passthrough,
}));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  getClientIP: () => "198.51.100.7",
  checkRateLimit: () => ({ allowed: true }),
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
  authenticateRequest: async () => ({
    authenticated: true,
    user: {
      id: "test-platform-admin",
      mode: "managed",
      label: "platform@test.com",
      role: "platform_admin",
      activeOrganizationId: "test-org",
    },
    mode: "managed",
  }),
  _setValidatorOverrides: () => {},
  _setSSOEnforcementOverride: () => {},
  _setAuditEnforcementBlockOverride: () => {},
}));

// Stub the Hono → Effect bridge to inject test layers (same pattern as
// contact.test.ts). The real `runEffect` boots OTel and the managed
// runtime; we don't want either in a unit test.
mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: async (
    _c: unknown,
    program: Effect.Effect<unknown, unknown, unknown>,
    _opts?: unknown,
  ) => {
    const services = await import("@atlas/api/lib/effect/services");
    const saasStub: SaasCrmShape = saasAvailable
      ? {
          available: true,
          upsertLead: () => Effect.void,
          dispatcher: async () => ({ kind: "ok" as const }),
        }
      : {
          available: false,
          upsertLead: () => Effect.void,
        };
    const layer = Layer.mergeAll(
      services.createRequestContextTestLayer({
        requestId: "test-req-id",
      }),
      Layer.succeed(services.SaasCrm, saasStub),
    );
    return Effect.runPromise(
      (program as Effect.Effect<unknown, unknown, never>).pipe(
        Effect.provide(layer),
      ),
    );
  },
}));

// ── Import the route AFTER all mocks ────────────────────────────────

const { platformCrmOutbox } = await import("../platform-crm-outbox");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/platform/crm-outbox", platformCrmOutbox);

// ── Fixture rows ────────────────────────────────────────────────────

const SAMPLE_ROW = {
  id: "row-1",
  created_at: "2026-05-26T10:00:00.000Z",
  event_type: "demo",
  status: "dead",
  attempts: 3,
  last_error: "twenty 5xx",
  twenty_person_id: null,
  twenty_note_id: null,
  processed_at: "2026-05-26T10:01:00.000Z",
  retry_after: null,
  claimed_at: null,
};

const SAMPLE_DETAIL = {
  ...SAMPLE_ROW,
  payload: { source: "demo", email: "user@example.com" },
};

// ── Helpers ─────────────────────────────────────────────────────────

beforeEach(() => {
  saasAvailable = true;
  hasDB = true;
  queryStub = async () => [];
  queryCalls = [];
  auditCalls = [];
});

afterEach(() => {
  queryCalls = [];
  auditCalls = [];
});

// ── Tests ───────────────────────────────────────────────────────────

describe("GET /api/v1/platform/crm-outbox", () => {
  test("404 when SaasCrm.available === false (self-hosted)", async () => {
    saasAvailable = false;
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_available");
    expect(queryCalls).toHaveLength(0);
  });

  test("404 when internal DB is not configured", async () => {
    hasDB = false;
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_available");
  });

  test("200 list with no filters returns mapped rows", async () => {
    queryStub = async () => [SAMPLE_ROW];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: "row-1",
      eventType: "demo",
      status: "dead",
      attempts: 3,
      lastError: "twenty 5xx",
    });
    // Filter args should all be null when none supplied.
    expect(queryCalls[0]?.params?.slice(0, 3)).toEqual([null, null, null]);
  });

  test("200 list passes status + event_type + since to the SQL", async () => {
    queryStub = async () => [];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox?status=dead&event_type=demo&since=2026-05-01T00:00:00Z&limit=10",
    );
    expect(res.status).toBe(200);
    expect(queryCalls[0]?.params).toEqual([
      "dead",
      "demo",
      "2026-05-01T00:00:00.000Z",
      10,
    ]);
  });

  test("list truncates the inline last_error past 200 chars", async () => {
    const longErr = "x".repeat(500);
    queryStub = async () => [{ ...SAMPLE_ROW, last_error: longErr }];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox",
    );
    const body = (await res.json()) as { rows: { lastError: string }[] };
    expect(body.rows[0]?.lastError?.length).toBeLessThanOrEqual(201);
    expect(body.rows[0]?.lastError?.endsWith("…")).toBe(true);
  });

  test("list rejects an invalid status value (treated as no filter)", async () => {
    queryStub = async () => [];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox?status=nonsense",
    );
    expect(res.status).toBe(200);
    expect(queryCalls[0]?.params?.[0]).toBeNull();
  });
});

describe("GET /api/v1/platform/crm-outbox/:id", () => {
  test("200 detail returns full payload + untruncated last_error", async () => {
    const longErr = "y".repeat(500);
    queryStub = async () => [{ ...SAMPLE_DETAIL, last_error: longErr }];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/row-1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      payload: unknown;
      fullLastError: string;
      lastError: string;
    };
    expect(body.id).toBe("row-1");
    expect(body.payload).toEqual({
      source: "demo",
      email: "user@example.com",
    });
    expect(body.fullLastError).toBe(longErr);
    expect(body.lastError?.length).toBeLessThanOrEqual(201);
  });

  test("404 detail when the row is not found", async () => {
    queryStub = async () => [];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/missing",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("POST /api/v1/platform/crm-outbox/:id/retry", () => {
  test("200 retry on a dead row writes the audit row", async () => {
    let probeCalls = 0;
    let updateCalls = 0;
    queryStub = async (sql) => {
      if (sql.includes("UPDATE crm_outbox")) {
        updateCalls++;
        // RETURNING clause — the row after the UPDATE.
        return [{ ...SAMPLE_ROW, status: "pending", last_error: null }];
      }
      probeCalls++;
      return [
        {
          id: "row-1",
          event_type: "demo",
          status: "dead",
          attempts: 3,
          last_error: "twenty 5xx",
        },
      ];
    };
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/row-1/retry",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(probeCalls).toBe(1);
    expect(updateCalls).toBe(1);

    const body = (await res.json()) as {
      message: string;
      row: { status: string; attempts: number };
    };
    expect(body.row.status).toBe("pending");
    // attempts is preserved (no reset) — the issue's load-bearing AC.
    expect(body.row.attempts).toBe(3);

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      actionType: "crm_outbox.retry",
      targetType: "crm_outbox",
      targetId: "row-1",
      scope: "platform",
      metadata: {
        outboxId: "row-1",
        eventType: "demo",
        previousStatus: "dead",
        previousAttempts: 3,
        previousLastError: "twenty 5xx",
      },
    });
  });

  test("404 retry when the row is not found", async () => {
    queryStub = async () => [];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/missing/retry",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(auditCalls).toHaveLength(0);
  });

  test("400 retry on a pending row (only `dead` is allowed)", async () => {
    queryStub = async () => [
      {
        id: "row-1",
        event_type: "demo",
        status: "pending",
        attempts: 1,
        last_error: null,
      },
    ];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/row-1/retry",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_state");
    // No UPDATE attempted, no audit row written.
    expect(queryCalls.filter((q) => q.sql.includes("UPDATE"))).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("404 retry when SaasCrm.available === false", async () => {
    saasAvailable = false;
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/row-1/retry",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(auditCalls).toHaveLength(0);
  });
});

describe("POST /api/v1/platform/crm-outbox/:id/mark-dead", () => {
  test("200 mark-dead on a pending row writes the audit row", async () => {
    queryStub = async (sql) => {
      if (sql.includes("UPDATE crm_outbox")) {
        return [
          {
            ...SAMPLE_ROW,
            status: "dead",
            last_error: "manually marked dead by platform admin",
          },
        ];
      }
      return [
        {
          id: "row-1",
          event_type: "signup",
          status: "pending",
          attempts: 0,
          last_error: null,
        },
      ];
    };
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/row-1/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { row: { status: string } };
    expect(body.row.status).toBe("dead");

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      actionType: "crm_outbox.mark_dead",
      targetType: "crm_outbox",
      targetId: "row-1",
      scope: "platform",
      metadata: {
        outboxId: "row-1",
        eventType: "signup",
        previousStatus: "pending",
        previousAttempts: 0,
        previousLastError: null,
      },
    });
  });

  test("200 mark-dead on an in_flight row", async () => {
    queryStub = async (sql) => {
      if (sql.includes("UPDATE crm_outbox")) {
        return [{ ...SAMPLE_ROW, status: "dead" }];
      }
      return [
        {
          id: "row-1",
          event_type: "demo",
          status: "in_flight",
          attempts: 2,
          last_error: null,
        },
      ];
    };
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/row-1/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(auditCalls[0]?.metadata?.previousStatus).toBe("in_flight");
  });

  test("400 mark-dead on a row already dead", async () => {
    queryStub = async () => [
      {
        id: "row-1",
        event_type: "demo",
        status: "dead",
        attempts: 6,
        last_error: "exhausted",
      },
    ];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/row-1/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_state");
    expect(auditCalls).toHaveLength(0);
  });

  test("400 mark-dead on a row already done", async () => {
    queryStub = async () => [
      {
        id: "row-1",
        event_type: "demo",
        status: "done",
        attempts: 1,
        last_error: null,
      },
    ];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/row-1/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    expect(auditCalls).toHaveLength(0);
  });

  test("404 mark-dead when the row is not found", async () => {
    queryStub = async () => [];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/missing/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  test("404 mark-dead when SaasCrm.available === false", async () => {
    saasAvailable = false;
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/row-1/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});
