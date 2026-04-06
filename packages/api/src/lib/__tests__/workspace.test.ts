/**
 * Tests for workspace status enforcement.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

let mockHasInternalDB = true;
let mockWorkspaceStatus: string | null = "active";
let mockGetCachedWorkspaceShouldThrow = false;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getWorkspaceStatus: async () => mockWorkspaceStatus,
  getWorkspaceDetails: async () => null,
  internalQuery: async () => [],
  internalExecute: () => {},
  getInternalDB: () => ({}),
  closeInternalDB: async () => {},
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  encryptUrl: (url: string) => url,
  decryptUrl: (url: string) => url,
  getEncryptionKey: () => null,
  isPlaintextUrl: (v: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v),
  _resetEncryptionKeyCache: () => {},
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  incrementPatternCount: () => {},
  getApprovedPatterns: async () => [],
  upsertSuggestion: async () => "created" as const,
  getSuggestionsByTables: async () => [],
  getPopularSuggestions: async () => [],
  incrementSuggestionClick: () => {},
  deleteSuggestion: async () => false,
  getAuditLogQueries: async () => [],
  updateWorkspaceStatus: async () => true,
  updateWorkspacePlanTier: async () => true,
  cascadeWorkspaceDelete: async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0, settings: 0 }),
  getWorkspaceHealthSummary: async () => null,
  getWorkspaceRegion: async () => null,
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
}));

mock.module("@atlas/api/lib/billing/enforcement", () => ({
  getCachedWorkspace: async (orgId: string) => {
    if (mockGetCachedWorkspaceShouldThrow) throw new Error("connection refused");
    if (mockWorkspaceStatus === null) return null;
    return { id: orgId, name: "Test Org", slug: "test-org", workspace_status: mockWorkspaceStatus, plan_tier: "team", byot: false, stripe_customer_id: null, trial_ends_at: null, suspended_at: null, deleted_at: null, region: null, region_assigned_at: null, createdAt: new Date().toISOString() };
  },
  checkPlanLimits: async () => ({ allowed: true }),
  invalidatePlanCache: () => {},
  buildMetricStatus: () => ({ metric: "queries", currentUsage: 0, limit: 1000, usagePercent: 0, status: "ok" }),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { checkWorkspaceStatus } = await import("@atlas/api/lib/workspace");

describe("checkWorkspaceStatus", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockWorkspaceStatus = "active";
    mockGetCachedWorkspaceShouldThrow = false;
  });

  it("allows when no orgId", async () => {
    const result = await checkWorkspaceStatus(undefined);
    expect(result.allowed).toBe(true);
  });

  it("allows when no internal DB", async () => {
    mockHasInternalDB = false;
    const result = await checkWorkspaceStatus("org-1");
    expect(result.allowed).toBe(true);
  });

  it("allows active workspaces", async () => {
    mockWorkspaceStatus = "active";
    const result = await checkWorkspaceStatus("org-1");
    expect(result.allowed).toBe(true);
    expect(result.status).toBe("active");
  });

  it("blocks suspended workspaces with 403", async () => {
    mockWorkspaceStatus = "suspended";
    const result = await checkWorkspaceStatus("org-1");
    expect(result.allowed).toBe(false);
    expect(result.httpStatus).toBe(403);
    expect(result.errorCode).toBe("workspace_suspended");
    expect(result.errorMessage).toContain("suspended");
    expect(result.errorMessage).toContain("payment method");
  });

  it("blocks deleted workspaces with 404", async () => {
    mockWorkspaceStatus = "deleted";
    const result = await checkWorkspaceStatus("org-1");
    expect(result.allowed).toBe(false);
    expect(result.httpStatus).toBe(404);
    expect(result.errorCode).toBe("workspace_deleted");
  });

  it("allows when workspace is null (pre-migration org)", async () => {
    mockWorkspaceStatus = null;
    const result = await checkWorkspaceStatus("org-1");
    expect(result.allowed).toBe(true);
  });

  it("blocks on DB error (fail-closed)", async () => {
    mockGetCachedWorkspaceShouldThrow = true;
    const result = await checkWorkspaceStatus("org-1");
    expect(result.allowed).toBe(false);
    expect(result.httpStatus).toBe(503);
    expect(result.errorCode).toBe("workspace_check_failed");
  });
});
