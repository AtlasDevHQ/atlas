/**
 * Tests for admin compliance API endpoints — F-32 audit emission.
 *
 * Covers the two write routes under /api/v1/admin/compliance:
 *   - PUT    /classifications/{id}    (compliance.pii_config_update)
 *   - DELETE /classifications/{id}    (compliance.pii_config_delete)
 *
 * PII-config changes are the same forensic class as F-26 (audit-about-audit):
 * an admin who shrinks masking strategy from `full` to `redact` on a Social
 * Security Number column has silently relaxed the workspace's PII posture,
 * and without these rows there's no trail.
 *
 * Tests the adminCompliance sub-router directly so we can drive the EE
 * compliance service via mocks without booting every adjacent admin
 * dependency. Pattern mirrors admin-audit-retention.test.ts.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect, Layer } from "effect";

import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";

// Force enterprise on so `ConditionalEELayer` in
// `lib/effect/enterprise-layer.ts` lazy-imports the mocked
// `@atlas/ee/layers` aggregator below (otherwise the no-op default
// fires and the masking + reports tests would hit the fail-closed
// EnterpriseError path instead of the mocked Live impls).
process.env.ATLAS_ENTERPRISE_ENABLED = "true";

// ── Auth + DB stubs ────────────────────────────────────────────────

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        mode: "managed",
        label: "admin@example.com",
        role: "admin",
        activeOrganizationId: "org-1",
        claims: { twoFactorEnabled: true },
      },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: () => Promise.resolve([]),
  internalExecute: mock(() => {}),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

// ── Audit logger mock — capture every emission ────────────────────

interface CapturedAuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  metadata?: Record<string, unknown>;
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
}

const mockLogAdminAction: Mock<(entry: CapturedAuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: REAL_ADMIN_ACTIONS,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: () => undefined,
}));

// ── EE compliance mock — driven per test ──────────────────────────
// Errors live in core post-#2566; both EE compliance modules re-export
// for back-compat, so existing references resolve the same class.

const { ComplianceError: RealComplianceError, ReportError: RealReportError } =
  await import("@atlas/api/lib/compliance/errors");

interface PIIClassification {
  id: string;
  orgId: string;
  connectionId: string;
  tableName: string;
  columnName: string;
  category: string;
  confidence: string;
  maskingStrategy: string;
  dismissed: boolean;
  reviewed: boolean;
  createdAt: string;
  updatedAt: string;
}

let _mockGetClassification: PIIClassification | null = null;
let mockUpdateResult: PIIClassification | null = null;
let mockUpdateError: Error | null = null;
let mockDeleteError: Error | null = null;
const mockInvalidate: Mock<(orgId: string) => void> = mock(() => {});

// Mock the core errors module so route's `instanceof` (via domainError)
// matches the test's `RealComplianceError` / `RealReportError`. Since
// both are already real classes from `@atlas/api/lib/compliance/errors`,
// re-exporting through the mock keeps semantics identical and gives a
// single place to swap if the test wants to inject a fake class later.
mock.module("@atlas/api/lib/compliance/errors", () => ({
  ComplianceError: RealComplianceError,
  ReportError: RealReportError,
}));

// Bind both Tags via the EE aggregator mock — post-#2566 the route
// reaches the masking + report functions through `yield* MaskingPolicy`
// / `yield* ComplianceReports`. `EnterpriseLayer` lazy-imports this
// module, so the test's mocked aggregator wins over the no-op default.
mock.module("@atlas/ee/layers", () => ({
  EELayer: Layer.unwrapEffect(
    Effect.sync(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
      type MaskingContext = import("@atlas/api/lib/effect/services").MaskingContext;
      const maskingLayer = Layer.succeed(services.MaskingPolicy, {
        // Preserve reference identity — see services.ts:NoopMaskingPolicyLayer.
        applyMasking: (ctx: MaskingContext) => Effect.succeed(ctx.rows),
        listPIIClassifications: () => Effect.succeed([]),
        updatePIIClassification: () => {
          if (mockUpdateError) return Effect.fail(mockUpdateError);
          return Effect.succeed(mockUpdateResult as never);
        },
        deletePIIClassification: () => {
          if (mockDeleteError) return Effect.fail(mockDeleteError);
          return Effect.succeed(undefined as never);
        },
        invalidateClassificationCache: mockInvalidate,
      } as never);
      const reportsLayer = Layer.succeed(services.ComplianceReports, {
        generateDataAccessReport: () =>
          Effect.succeed({ rows: [], summary: { totalQueries: 0, uniqueUsers: 0, uniqueTables: 0, piiTablesAccessed: 0 }, filters: { startDate: "", endDate: "" }, generatedAt: "" } as never),
        generateUserActivityReport: () =>
          Effect.succeed({ rows: [], summary: { totalUsers: 0, activeUsers: 0, totalQueries: 0 }, filters: { startDate: "", endDate: "" }, generatedAt: "" } as never),
        dataAccessReportToCSV: () => "",
        userActivityReportToCSV: () => "",
      } as never);
      return Layer.merge(maskingLayer, reportsLayer);
    }),
  ),
}));

// Keep legacy `@atlas/ee/compliance/*` module mocks as no-op stubs for
// any transitive EE re-export that still resolves them. Production code
// no longer hits these paths post-#2566.
mock.module("@atlas/ee/compliance/masking", () => ({
  ComplianceError: RealComplianceError,
}));

mock.module("@atlas/ee/compliance/reports", () => ({
  ReportError: RealReportError,
}));

// ── Import sub-router AFTER mocks ─────────────────────────────────

const { adminCompliance } = await import("../routes/admin-compliance");

// ── Helpers ───────────────────────────────────────────────────────

async function request(
  method: string,
  path = "/classifications/cls_1",
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-key" },
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  return adminCompliance.request(`http://localhost${path}`, init);
}

function makeClassification(
  overrides: Partial<PIIClassification> = {},
): PIIClassification {
  return {
    id: "cls_1",
    orgId: "org-1",
    connectionId: "default",
    tableName: "users",
    columnName: "email",
    category: "email",
    confidence: "high",
    maskingStrategy: "full",
    dismissed: false,
    reviewed: false,
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

function resetMocks(): void {
  _mockGetClassification = null;
  mockUpdateResult = null;
  mockUpdateError = null;
  mockDeleteError = null;
  mockLogAdminAction.mockClear();
  mockInvalidate.mockClear();
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        mode: "managed",
        label: "admin@example.com",
        role: "admin",
        activeOrganizationId: "org-1",
        claims: { twoFactorEnabled: true },
      },
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────

describe("admin compliance — F-32 audit emission", () => {
  beforeEach(resetMocks);

  it("PUT /classifications/:id emits compliance.pii_config_update on success", async () => {
    mockUpdateResult = makeClassification({
      id: "cls_1",
      maskingStrategy: "redact",
      reviewed: true,
    });
    const res = await request("PUT", "/classifications/cls_1", {
      maskingStrategy: "redact",
      reviewed: true,
    });
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("compliance.pii_config_update");
    expect(entry.targetType).toBe("compliance");
    expect(entry.targetId).toBe("cls_1");
    expect(entry.metadata?.maskingStrategy).toBe("redact");
    expect(entry.metadata?.reviewed).toBe(true);
  });

  it("PUT /classifications/:id captures only the fields the admin intended to change", async () => {
    // Bodies that omit fields leave them untouched on the row. Metadata
    // should reflect the intent (what the admin sent), not echo a full
    // post-update snapshot — otherwise compliance queries can't tell a
    // dismiss from a masking-strategy change without extra joins.
    mockUpdateResult = makeClassification({ id: "cls_9", dismissed: true });
    await request("PUT", "/classifications/cls_9", { dismissed: true });
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.metadata?.dismissed).toBe(true);
    expect(entry.metadata).not.toHaveProperty("category");
    expect(entry.metadata).not.toHaveProperty("maskingStrategy");
    expect(entry.metadata).not.toHaveProperty("reviewed");
  });

  it("DELETE /classifications/:id emits compliance.pii_config_delete on success", async () => {
    const res = await request("DELETE", "/classifications/cls_1");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("compliance.pii_config_delete");
    expect(entry.targetType).toBe("compliance");
    expect(entry.targetId).toBe("cls_1");
  });

  it("PUT /classifications/:id does not emit audit when update throws", async () => {
    // ComplianceError "not_found" is a probe signal, not a mutation — no
    // classification was actually updated, so no audit row. Same as the
    // residency retry "reject before write" semantics.
    mockUpdateError = new RealComplianceError({
      message: "Classification cls_missing not found.",
      code: "not_found",
    });
    const res = await request("PUT", "/classifications/cls_missing", {
      dismissed: true,
    });
    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("DELETE /classifications/:id does not emit audit when delete throws not_found", async () => {
    mockDeleteError = new RealComplianceError({
      message: "Classification cls_missing not found.",
      code: "not_found",
    });
    const res = await request("DELETE", "/classifications/cls_missing");
    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("GET /classifications does not emit an audit row (read endpoint)", async () => {
    const res = await request("GET", "/classifications");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("GET /reports/data-access does not emit an audit row (read endpoint)", async () => {
    const res = await request("GET", "/reports/data-access?startDate=2026-01-01&endDate=2026-04-01");
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
