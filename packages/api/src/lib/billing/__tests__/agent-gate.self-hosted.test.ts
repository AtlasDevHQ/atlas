/**
 * Self-hosted passthrough test for the agent billing gate (#3419/#3420
 * acceptance criterion: "Self-hosted mode (no billing) is a no-op
 * passthrough").
 *
 * Unlike `agent-gate.test.ts` (which mocks the three underlying checks
 * to pin the gate's composition), this file runs the REAL
 * `checkWorkspaceStatus` / `checkAbuseStatus` / `checkPlanLimits`
 * against a self-hosted environment: no internal DB
 * (`hasInternalDB() === false`) and no `ATLAS_DEPLOY_MODE=saas`. Every
 * check must short-circuit to allowed — even with an orgId bound — so
 * chat-platform and scheduler runs on self-hosted deployments are
 * never gated.
 */

import { describe, it, expect, mock } from "bun:test";

// Pin a non-SaaS deploy mode BEFORE the gate module graph loads, so the
// abuse check's isSaasDeployment() read can't be flipped by external CI
// env state. `??=` hoist per docs/development/testing.md (never `=`).
process.env.ATLAS_DEPLOY_MODE ??= "self-hosted";

// Self-hosted: no internal DB. Stub list mirrors `lib/__tests__/workspace.test.ts`.
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  getWorkspaceStatus: async () => null,
  getWorkspaceDetails: async () => null,
  internalQuery: async () => [],
  internalExecute: () => {},
  getInternalDB: () => ({}),
  closeInternalDB: async () => {},
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  encryptSecret: (url: string) => url,
  decryptSecret: (url: string) => url,
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

const { checkAgentBillingGate } = await import("@atlas/api/lib/billing/agent-gate");

describe("checkAgentBillingGate — self-hosted (no internal DB, non-SaaS)", () => {
  it("is a no-op passthrough even when an orgId is bound", async () => {
    const result = await checkAgentBillingGate("org-self-hosted");
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error("expected allow");
    expect(result.warning).toBeUndefined();
  });

  it("is a no-op passthrough when no orgId is bound (CLI tooling, anonymous)", async () => {
    const result = await checkAgentBillingGate(undefined);
    expect(result.allowed).toBe(true);
  });
});
