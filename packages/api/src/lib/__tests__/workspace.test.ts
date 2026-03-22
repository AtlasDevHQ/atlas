/**
 * Tests for workspace status enforcement.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

let mockHasInternalDB = true;
let mockWorkspaceStatus: string | null = "active";
let mockGetWorkspaceStatusShouldThrow = false;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getWorkspaceStatus: async () => {
    if (mockGetWorkspaceStatusShouldThrow) throw new Error("connection refused");
    return mockWorkspaceStatus;
  },
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
  getWorkspaceDetails: async () => null,
  updateWorkspaceStatus: async () => true,
  updateWorkspacePlanTier: async () => true,
  cascadeWorkspaceDelete: async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0 }),
  getWorkspaceHealthSummary: async () => null,
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
    mockGetWorkspaceStatusShouldThrow = false;
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
  });

  it("blocks deleted workspaces with 404", async () => {
    mockWorkspaceStatus = "deleted";
    const result = await checkWorkspaceStatus("org-1");
    expect(result.allowed).toBe(false);
    expect(result.httpStatus).toBe(404);
    expect(result.errorCode).toBe("workspace_deleted");
  });

  it("allows when workspace status is null (pre-migration)", async () => {
    mockWorkspaceStatus = null;
    const result = await checkWorkspaceStatus("org-1");
    expect(result.allowed).toBe(true);
  });

  it("blocks on DB error (fail-closed)", async () => {
    mockGetWorkspaceStatusShouldThrow = true;
    const result = await checkWorkspaceStatus("org-1");
    expect(result.allowed).toBe(false);
    expect(result.httpStatus).toBe(503);
    expect(result.errorCode).toBe("workspace_check_failed");
  });
});
