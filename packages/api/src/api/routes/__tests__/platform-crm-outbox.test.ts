/**
 * Platform CRM outbox route integration tests (#2735).
 *
 * Covers list / detail / retry / mark-dead end-to-end via a mounted
 * Hono test app. The Hono → Effect bridge is stubbed to inject the
 * SaasCrm Tag (toggleable for the self-hosted 404 branch) plus a
 * per-test stub for `internalQuery`, so the route is exercised
 * without touching a real Postgres.
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

mock.module("@atlas/api/lib/db/internal", () => {
  const internalQuery = async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    return queryStub(sql, params);
  };
  return {
    hasInternalDB: () => hasDB,
    internalQuery,
    queryEffect: (sql: string, params?: unknown[]) =>
      Effect.tryPromise({
        try: () => internalQuery(sql, params),
        catch: (err) =>
          err instanceof Error ? err : new Error(String(err)),
      }),
    getInternalDB: () => null,
    internalExecute: async () => undefined,
  };
});

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
  id: "00000000-0000-4000-8000-000000000001",
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
      id: "00000000-0000-4000-8000-000000000001",
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

  test("list truncation boundary: 200-char input passes through verbatim", async () => {
    // Pin the cap value documented in the wire-type comment and the
    // route's `LAST_ERROR_LIST_TRUNCATION` constant. A regression that
    // moves the cap to 100 would still pass the prior `<= 201` test.
    const exact = "y".repeat(200);
    queryStub = async () => [{ ...SAMPLE_ROW, last_error: exact }];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox",
    );
    const body = (await res.json()) as { rows: { lastError: string }[] };
    expect(body.rows[0]?.lastError).toBe(exact);
    expect(body.rows[0]?.lastError?.endsWith("…")).toBe(false);
  });

  test("list truncation boundary: 201-char input is clipped to 200 + ellipsis", async () => {
    const over = "z".repeat(201);
    queryStub = async () => [{ ...SAMPLE_ROW, last_error: over }];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox",
    );
    const body = (await res.json()) as { rows: { lastError: string }[] };
    expect(body.rows[0]?.lastError).toBe("z".repeat(200) + "…");
  });

  test("list 422 on malformed since=", async () => {
    // The `ListQuerySchema` enforces RFC-3339 with explicit timezone.
    // A naïve local string or unparseable input now 422s via
    // `validationHook` instead of silently falling through, fixing
    // the timezone-window-shift bug Codex P2 flagged.
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox?since=not-a-date",
    );
    expect(res.status).toBe(422);
    expect(queryCalls).toHaveLength(0);
  });

  test("list 422 on naïve (no-timezone) since=", async () => {
    // Naïve "2026-05-26T10:00" is a fingerprint of the
    // `datetime-local` HTML input — accepting it would re-introduce
    // the operator-zone window shift. Schema requires `offset: true`.
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox?since=2026-05-26T10:00:00",
    );
    expect(res.status).toBe(422);
  });

  test("list 422 on out-of-range limit=", async () => {
    // Schema bounds: limit ∈ [1, LIST_LIMIT_MAX=500].
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox?limit=99999",
    );
    expect(res.status).toBe(422);
  });

  test("list applies default limit when limit= absent", async () => {
    queryStub = async () => [];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox",
    );
    expect(res.status).toBe(200);
    expect(queryCalls[0]?.params?.[3]).toBe(100);
  });

  test("list 422 on invalid status= value", async () => {
    // `z.enum(OUTBOX_STATUSES)` rejects values outside the canonical
    // tuple. Surfaces a 422 instead of silently falling through to an
    // unfiltered list.
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox?status=nonsense",
    );
    expect(res.status).toBe(422);
  });

  test("list maps Date-instance timestamps from the pg driver", async () => {
    // The pg driver returns `created_at` as a `Date` object on the
    // SqlClient-less path; SqlClient returns a string. The route's
    // `isoOr` helper handles both. Pin the Date branch — a regression
    // that drops it (`return v.toISOString()` only) would crash on the
    // raw-pool fallback.
    queryStub = async () => [
      {
        ...SAMPLE_ROW,
        created_at: new Date("2026-05-26T10:00:00.000Z"),
        processed_at: new Date("2026-05-26T10:01:00.000Z"),
      },
    ];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { createdAt: string; processedAt: string | null }[];
    };
    expect(body.rows[0]?.createdAt).toBe("2026-05-26T10:00:00.000Z");
    expect(body.rows[0]?.processedAt).toBe("2026-05-26T10:01:00.000Z");
  });

});

describe("GET /api/v1/platform/crm-outbox/:id", () => {
  test("200 detail returns full payload + untruncated last_error", async () => {
    const longErr = "y".repeat(500);
    queryStub = async () => [{ ...SAMPLE_DETAIL, last_error: longErr }];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      payload: unknown;
      fullLastError: string;
      lastError: string;
    };
    expect(body.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(body.payload).toEqual({
      source: "demo",
      email: "user@example.com",
    });
    // Detail endpoint MUST surface the full string on BOTH fields so a
    // UI consumer that reads `.lastError` doesn't get a half-string
    // mid-stack-trace. The dual-field shape exists only for list-side
    // wire compatibility.
    expect(body.fullLastError).toBe(longErr);
    expect(body.lastError).toBe(longErr);
  });

  test("404 detail when the row is not found", async () => {
    queryStub = async () => [];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000002",
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
        return [{ ...SAMPLE_ROW, status: "pending", last_error: null }];
      }
      probeCalls++;
      return [
        {
          id: "00000000-0000-4000-8000-000000000001",
          event_type: "demo",
          status: "dead",
          attempts: 3,
          last_error: "twenty 5xx",
        },
      ];
    };
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/retry",
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
    // attempts must survive the retry — the deterministic backoff in
    // `lib/lead-outbox/backoff.ts` keys on it.
    expect(body.row.attempts).toBe(3);

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      actionType: "crm_outbox.retry",
      targetType: "crm_outbox",
      targetId: "00000000-0000-4000-8000-000000000001",
      scope: "platform",
      metadata: {
        outboxId: "00000000-0000-4000-8000-000000000001",
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
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000002/retry",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(auditCalls).toHaveLength(0);
  });

  test("400 retry on a pending row (only `dead` is allowed)", async () => {
    queryStub = async () => [
      {
        id: "00000000-0000-4000-8000-000000000001",
        event_type: "demo",
        status: "pending",
        attempts: 1,
        last_error: null,
      },
    ];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/retry",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_state");
    expect(queryCalls.filter((q) => q.sql.includes("UPDATE"))).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("404 retry when SaasCrm.available === false", async () => {
    saasAvailable = false;
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/retry",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(auditCalls).toHaveLength(0);
  });

  test("400 race_lost retry — probe sees dead, UPDATE matches zero rows", async () => {
    // Probe returns the row in `dead`, but a concurrent retry won the
    // conditional UPDATE first → UPDATE returns []. Loser's intent
    // MUST surface as a `status: "failure"` audit row so the
    // forensic trail captures both attempts.
    queryStub = async (sql) => {
      if (sql.includes("UPDATE crm_outbox")) return [];
      return [
        {
          id: "00000000-0000-4000-8000-000000000001",
          event_type: "demo",
          status: "dead",
          attempts: 3,
          last_error: "twenty 5xx",
        },
      ];
    };
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/retry",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("race_lost");
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      actionType: "crm_outbox.retry",
      targetType: "crm_outbox",
      targetId: "00000000-0000-4000-8000-000000000001",
      scope: "platform",
      status: "failure",
      metadata: {
        outboxId: "00000000-0000-4000-8000-000000000001",
        previousStatus: "dead",
        previousAttempts: 3,
        raceLost: true,
      },
    });
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
          id: "00000000-0000-4000-8000-000000000001",
          event_type: "signup",
          status: "pending",
          attempts: 0,
          last_error: null,
        },
      ];
    };
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { row: { status: string } };
    expect(body.row.status).toBe("dead");

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      actionType: "crm_outbox.mark_dead",
      targetType: "crm_outbox",
      targetId: "00000000-0000-4000-8000-000000000001",
      scope: "platform",
      metadata: {
        outboxId: "00000000-0000-4000-8000-000000000001",
        eventType: "signup",
        previousStatus: "pending",
        previousAttempts: 0,
        previousLastError: null,
      },
    });
  });

  test("400 mark-dead on an in_flight row — not durable (Codex P1)", async () => {
    // The flusher's terminal commit (`MARK_DONE_SQL` /
    // `MARK_TRANSIENT_FAIL_SQL`) is gated on `id` only — a manual
    // dead write during dispatch would be silently overwritten when
    // the dispatcher returns. The route MUST reject so the contract
    // ("mark dead stops retries") is durable.
    queryStub = async () => [
      {
        id: "00000000-0000-4000-8000-000000000001",
        event_type: "demo",
        status: "in_flight",
        attempts: 2,
        last_error: null,
      },
    ];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_state");
    expect(body.message).toContain("in_flight");
    expect(queryCalls.filter((q) => q.sql.includes("UPDATE"))).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("400 mark-dead on a row already dead", async () => {
    queryStub = async () => [
      {
        id: "00000000-0000-4000-8000-000000000001",
        event_type: "demo",
        status: "dead",
        attempts: 6,
        last_error: "exhausted",
      },
    ];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/mark-dead",
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
        id: "00000000-0000-4000-8000-000000000001",
        event_type: "demo",
        status: "done",
        attempts: 1,
        last_error: null,
      },
    ];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    expect(auditCalls).toHaveLength(0);
  });

  test("404 mark-dead when the row is not found", async () => {
    queryStub = async () => [];
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000002/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  test("404 mark-dead when SaasCrm.available === false", async () => {
    saasAvailable = false;
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  test("400 race_lost mark-dead — probe sees pending, UPDATE matches zero rows", async () => {
    // Probe returns `pending` but the flusher's claim (a concurrent
    // claim sweep flipping to in_flight) won the conditional UPDATE
    // before the operator's write landed. Failure audit must still
    // capture the operator's intent.
    queryStub = async (sql) => {
      if (sql.includes("UPDATE crm_outbox")) return [];
      return [
        {
          id: "00000000-0000-4000-8000-000000000001",
          event_type: "demo",
          status: "pending",
          attempts: 0,
          last_error: null,
        },
      ];
    };
    const res = await app.request(
      "http://localhost/api/v1/platform/crm-outbox/00000000-0000-4000-8000-000000000001/mark-dead",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("race_lost");
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      actionType: "crm_outbox.mark_dead",
      status: "failure",
      metadata: {
        outboxId: "00000000-0000-4000-8000-000000000001",
        previousStatus: "pending",
        raceLost: true,
      },
    });
  });
});
