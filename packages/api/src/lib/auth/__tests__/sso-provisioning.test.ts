/**
 * Tests for SSO domain-based auto-provisioning with member limit enforcement.
 *
 * Mocks: internal DB, billing enforcement, enterprise gate, logger.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
// All named exports mocked per CLAUDE.md ("mock every named export").
// ---------------------------------------------------------------------------

let mockEnterpriseEnabled = true;
let mockHasInternalDB = true;

mock.module("@atlas/ee/index", () => ({
  isEnterpriseEnabled: () => mockEnterpriseEnabled,
  getEnterpriseLicenseKey: () => undefined,
  EnterpriseError: class extends Error { override name = "EnterpriseError"; },
  requireEnterprise: () => {},
  requireEnterpriseEffect: () => {},
  resolveDeployMode: () => "self-hosted",
  EEError: class extends Error {},
}));

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);

const mockDbQuery: Mock<(sql: string, params?: unknown[]) => Promise<void>> = mock(
  () => Promise.resolve(),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mockInternalQuery,
  internalExecute: mock(() => {}),
  getInternalDB: () => ({ query: mockDbQuery }),
  closeInternalDB: async () => {},
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  encryptUrl: (url: string) => url,
  decryptUrl: (url: string) => url,
  getEncryptionKey: () => null,
  isPlaintextUrl: () => true,
  _resetEncryptionKeyCache: () => {},
  getApprovedPatterns: async () => [],
  upsertSuggestion: async () => "created" as const,
  getSuggestionsByTables: async () => [],
  getPopularSuggestions: async () => [],
  incrementSuggestionClick: () => {},
  deleteSuggestion: async () => false,
  getAuditLogQueries: async () => [],
  getWorkspaceStatus: async () => "active",
  getWorkspaceDetails: async () => null,
  updateWorkspaceStatus: async () => true,
  updateWorkspacePlanTier: async () => true,
  cascadeWorkspaceDelete: async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0, settings: 0 }),
  getWorkspaceHealthSummary: async () => null,
  getWorkspaceRegion: async () => null,
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  incrementPatternCount: () => {},
  getAutoApproveThreshold: () => 3,
  getAutoApproveTypes: () => new Set(),
  makeInternalDBLive: () => {},
  createInternalDBTestLayer: () => {},
  updateWorkspaceByot: async () => {},
  setWorkspaceStripeCustomerId: async () => {},
  setWorkspaceTrialEndsAt: async () => {},
  InternalDB: {},
}));

const mockCheckResourceLimit: Mock<(orgId: string | undefined, resource: string, count: number) => Promise<{ allowed: boolean; errorMessage?: string; limit?: number }>> = mock(
  () => Promise.resolve({ allowed: true }),
);

mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkResourceLimit: mockCheckResourceLimit,
  checkPlanLimits: async () => ({ allowed: true }),
  getCachedWorkspace: async () => null,
  invalidatePlanCache: () => {},
  buildMetricStatus: () => ({ metric: "tokens", currentUsage: 0, limit: 2_000_000, usagePercent: 0, status: "ok" }),
  severityOf: () => 0,
}));

const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogInfo: Mock<(...args: unknown[]) => void> = mock(() => {});

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
  getLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [],
  setLogLevel: () => false,
}));

// Import the function under test AFTER mocks are set up
const { _autoProvisionSsoMember } = await import("../server");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate internalQuery responses based on the SQL pattern. */
function setupQueryResponses(opts: {
  ssoProvider?: { org_id: string };
  existingMember?: boolean;
  memberCount?: number;
}) {
  mockInternalQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("sso_providers")) {
      return opts.ssoProvider ? [opts.ssoProvider] : [];
    }
    if (sql.includes("member") && sql.includes("userId")) {
      return opts.existingMember ? [{ id: "existing-member" }] : [];
    }
    if (sql.includes("COUNT(*)")) {
      return [{ count: opts.memberCount ?? 0 }];
    }
    return [];
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("_autoProvisionSsoMember", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
    mockDbQuery.mockReset();
    mockCheckResourceLimit.mockReset();
    mockLogWarn.mockReset();
    mockLogInfo.mockReset();
    mockCheckResourceLimit.mockImplementation(async () => ({ allowed: true }));
    mockDbQuery.mockImplementation(async () => {});
  });

  it("adds user to org when domain matches and under member limit", async () => {
    setupQueryResponses({ ssoProvider: { org_id: "org-1" }, memberCount: 3 });

    await _autoProvisionSsoMember({ id: "user-1", email: "alice@acme.com" });

    expect(mockCheckResourceLimit).toHaveBeenCalledWith("org-1", "seats", 3);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const insertCall = mockDbQuery.mock.calls[0];
    expect(insertCall[0]).toContain("INSERT INTO member");
    expect(insertCall[1]).toEqual(["org-1", "user-1"]);
    // Should log success
    expect(mockLogInfo).toHaveBeenCalled();
    expect(mockLogInfo.mock.calls[0][0]).toMatchObject({ userId: "user-1", orgId: "org-1" });
  });

  it("skips provisioning when org is at member limit", async () => {
    setupQueryResponses({ ssoProvider: { org_id: "org-1" }, memberCount: 10 });
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      errorMessage: "Your starter plan allows up to 10 seats. Upgrade to add more.",
      limit: 10,
    }));

    await _autoProvisionSsoMember({ id: "user-2", email: "bob@acme.com" });

    expect(mockCheckResourceLimit).toHaveBeenCalledWith("org-1", "seats", 10);
    expect(mockDbQuery).not.toHaveBeenCalled();
    // Should log warning with limit details
    expect(mockLogWarn).toHaveBeenCalled();
    expect(mockLogWarn.mock.calls[0][0]).toMatchObject({ orgId: "org-1", limit: 10 });
  });

  it("does not block user signup when limit reached — function resolves without throwing", async () => {
    setupQueryResponses({ ssoProvider: { org_id: "org-1" }, memberCount: 5 });
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      errorMessage: "Limit reached",
      limit: 5,
    }));

    await expect(_autoProvisionSsoMember({ id: "user-3", email: "carol@acme.com" })).resolves.toBeUndefined();
  });

  it("fails open when checkResourceLimit throws", async () => {
    setupQueryResponses({ ssoProvider: { org_id: "org-1" }, memberCount: 5 });
    mockCheckResourceLimit.mockImplementation(async () => {
      throw new Error("billing service unavailable");
    });

    await _autoProvisionSsoMember({ id: "user-4", email: "dave@acme.com" });

    // Should still insert the member (fail open)
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    // Should log warning about the failure
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it("fails open when checkResourceLimit returns limit=0 (infra error)", async () => {
    setupQueryResponses({ ssoProvider: { org_id: "org-1" }, memberCount: 5 });
    mockCheckResourceLimit.mockImplementation(async () => ({
      allowed: false,
      errorMessage: "Unable to verify plan limits. Please try again.",
      limit: 0,
    }));

    await _autoProvisionSsoMember({ id: "user-9", email: "iris@acme.com" });

    // limit=0 is the infra-error sentinel — should still insert (fail open)
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    // Should log warning about infra error
    expect(mockLogWarn).toHaveBeenCalled();
    expect(mockLogWarn.mock.calls[0][0]).toMatchObject({ userId: "user-9", orgId: "org-1" });
  });

  it("skips when no SSO provider matches the domain", async () => {
    setupQueryResponses({ ssoProvider: undefined });

    await _autoProvisionSsoMember({ id: "user-5", email: "eve@unknown.com" });

    expect(mockCheckResourceLimit).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("skips when user is already a member", async () => {
    setupQueryResponses({ ssoProvider: { org_id: "org-1" }, existingMember: true });

    await _autoProvisionSsoMember({ id: "user-6", email: "frank@acme.com" });

    expect(mockCheckResourceLimit).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("skips when enterprise is not enabled", async () => {
    mockEnterpriseEnabled = false;

    await _autoProvisionSsoMember({ id: "user-7", email: "grace@acme.com" });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("skips when user has no email", async () => {
    await _autoProvisionSsoMember({ id: "user-8", email: null });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("skips when no internal DB (self-hosted without managed auth)", async () => {
    mockHasInternalDB = false;

    await _autoProvisionSsoMember({ id: "user-11", email: "kate@acme.com" });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("skips when email has no domain part", async () => {
    await _autoProvisionSsoMember({ id: "user-12", email: "nodomain" });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("catches INSERT failure without blocking signup (outer catch)", async () => {
    setupQueryResponses({ ssoProvider: { org_id: "org-1" }, memberCount: 1 });
    mockDbQuery.mockImplementation(async () => {
      throw new Error("connection reset");
    });

    await expect(
      _autoProvisionSsoMember({ id: "user-10", email: "jack@acme.com" }),
    ).resolves.toBeUndefined();

    // Should log warning with email context
    expect(mockLogWarn).toHaveBeenCalled();
    expect(mockLogWarn.mock.calls[0][0]).toMatchObject({ userId: "user-10", email: "jack@acme.com" });
  });
});
