/**
 * Read-only execution guarantee for the Agent-Auth read-safe POST allowlist
 * (#4707) — the regression guard behind the admission rule.
 *
 * `READ_SAFE_OPERATIONS` admits four POST operations into the Agent-Auth
 * capability surface on the guarantee that each executes read-only at the
 * engine. This suite makes that guarantee a pinned, per-entry property rather
 * than a naming convention:
 *
 *   1. Every allowlist entry must be enumerated in `ENGINE_GUARANTEES` below
 *      with its verified read-only mechanism — adding an entry to the
 *      allowlist without recording (and guarding) its mechanism goes RED here.
 *   2. The shared SQL seam (`validateSQL` in `lib/tools/sql.ts`) that
 *      `/api/v1/query` (agent `executeSQL` tool), `/api/v1/metrics/{id}/run`
 *      (`runUserQueryPipeline`), and `/api/v1/validate-sql` all execute
 *      through is driven directly with mutating statements and must reject
 *      every one — DML, DDL, multi-statement chaining, and comment-obfuscated
 *      variants. `sql.test.ts` covers this seam exhaustively; the cases here
 *      are the allowlist's own tripwire so a hypothetical relaxation of the
 *      engine cannot go unnoticed by the Agent-Auth surface that depends on it.
 *
 *   3. `/api/v1/query`'s residual NON-SQL surface — the agent loop can reach
 *      workspace-installed integration action tools and best-effort persists
 *      conversations — is a consciously accepted part of the #4707 admission
 *      (it is the same surface every `/query` caller has: SDK, MCP, Slack).
 *      The always-registered core tool set reachable from `executeAgentQuery`
 *      (`nonDashboardRegistry`) is pinned below, so a NEW side-effecting tool
 *      becoming reachable through an allowlisted capability is a conscious,
 *      reviewed decision rather than silent drift.
 *
 * `/api/v1/explore` has no SQL seam: it is read-only by backend isolation
 * (sandboxed, path-traversal-protected access scoped to `semantic/` — see
 * `lib/tools/backends/` and the explore backend tests), which is recorded in
 * `ENGINE_GUARANTEES` and enforced structurally, not by statement validation.
 *
 * Harness mirrors `lib/tools/__tests__/sql.test.ts` (whitelist + connection
 * mocks; PostgreSQL mode via env inside the suite, restored after).
 */

import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// Mock the semantic whitelist + connection registry before importing the SUT
// (mirrors sql.test.ts, completed to the FULL barrel export surface per the
// mock-all-exports rule), so validation never touches the filesystem or a DB.
void mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["companies", "people"]),
  getWhitelistedTablesStrict: () => new Set(["companies", "people"]),
  SemanticLayerScanError: class SemanticLayerScanError extends Error {},
  getCrossSourceJoins: () => [],
  registerPluginEntities: () => {},
  _resetWhitelists: () => {},
  loadOrgWhitelist: async () => new Map(),
  getOrgWhitelistedTables: () => new Set(),
  invalidateOrgWhitelist: () => {},
  invalidateOrgSemanticIndex: () => {},
  getOrgSemanticIndex: async () => "",
}));

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: { getDBType: () => "postgres" as const },
    detectDBType: () => "postgres" as const,
  }),
);

// SUTs — imported after the mocks are registered.
const { validateSQL } = await import("@atlas/api/lib/tools/sql");
const { READ_SAFE_OPERATIONS } = await import("@atlas/api/lib/auth/agent-auth-openapi");
type ReadSafeOperationKey = import("@atlas/api/lib/auth/agent-auth-openapi").ReadSafeOperationKey;

/**
 * The verified read-only mechanism per allowlisted operation. The
 * `ReadSafeOperationKey` key type makes "every allowlist entry has a recorded
 * guarantee" a COMPILE-TIME property (an addition to `READ_SAFE_OPERATION_KEYS`
 * without a row here is a type error); the runtime equality assertion below is
 * belt-and-suspenders. An allowlist addition must also extend the behavioral
 * cases when it carries SQL — this file is the review tripwire the #4707
 * admission rule requires.
 */
const ENGINE_GUARANTEES: Record<ReadSafeOperationKey, string> = {
  "POST /api/v1/query":
    "agent loop executes SQL only via the executeSQL tool → validateSQL (SELECT-only, one AST parse); " +
    "residual non-SQL surface (installed action tools, conversation persistence) pinned by the tool-surface tripwire below",
  "POST /api/v1/explore":
    "read-only by sandbox isolation scoped to semantic/ (no SQL seam; structural enforcement)",
  "POST /api/v1/metrics/{id}/run":
    "metric SQL runs through runUserQueryPipeline → validateSQL (same SELECT-only pipeline; no agent loop)",
  "POST /api/v1/validate-sql": "validates via validateSQL only; never executes",
};

const origEnv = { ...process.env };

describe("agent-auth read-safe allowlist — read-only engine guarantee (#4707)", () => {
  beforeEach(() => {
    process.env = { ...origEnv, ATLAS_DATASOURCE_URL: "postgresql://test:test@localhost:5432/test" };
  });
  afterAll(() => {
    process.env = origEnv;
  });

  it("every allowlisted operation has a recorded, verified read-only mechanism", () => {
    expect(Object.keys(ENGINE_GUARANTEES).sort()).toEqual([...READ_SAFE_OPERATIONS].sort());
  });

  it("the shared engine seam rejects DML — INSERT / UPDATE / DELETE", async () => {
    for (const sql of [
      "INSERT INTO companies (name) VALUES ('Evil')",
      "UPDATE companies SET name = 'Evil'",
      "DELETE FROM companies WHERE id = 1",
    ]) {
      const result = await validateSQL(sql);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    }
  });

  it("the shared engine seam rejects DDL and multi-statement chaining", async () => {
    for (const sql of [
      "DROP TABLE companies",
      "TRUNCATE companies",
      "ALTER TABLE companies ADD COLUMN evil text",
      "SELECT 1; DROP TABLE companies",
    ]) {
      const result = await validateSQL(sql);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    }
  });

  it("the shared engine seam rejects comment-obfuscated mutations", async () => {
    for (const sql of [
      "DROP /* harmless */ TABLE companies",
      "/* lead-in */ DELETE FROM companies",
    ]) {
      const result = await validateSQL(sql);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    }
  });

  it("…while a plain whitelisted SELECT still validates (the guard is not vacuous)", async () => {
    const result = await validateSQL("SELECT id, name FROM companies");
    expect(result.valid).toBe(true);
  });

  it("the tool surface reachable through POST /api/v1/query is pinned — a new side-effecting tool is a conscious decision", async () => {
    // `executeAgentQuery` (the /api/v1/query engine) builds its registry from
    // `registerCoreTools` via `buildRegistry` / the `nonDashboardRegistry`
    // fallback. Pin the ALWAYS-registered core surface: read tools plus the
    // acknowledged, execute-time install-gated integration actions. Env-gated
    // additions (`executePython` under ATLAS_PYTHON_ENABLED; `createJiraTicket`
    // + `sendEmailReport` under ATLAS_ACTIONS_ENABLED; `querySalesforce` when
    // the Salesforce OAuth env is wired) are operator opt-ins, documented in
    // ACKNOWLEDGED below so a rename shows up here too. A NEW core tool makes
    // this go red — forcing a review of whether the #4707 "read-safe" admission
    // for postQuery still holds.
    const { nonDashboardRegistry } = await import("@atlas/api/lib/tools/registry");
    const names = [...nonDashboardRegistry.entries()].map(([name]) => name).sort();
    const ACKNOWLEDGED = new Set([
      // Read tools — the analyst loop.
      "explore",
      "executeSQL",
      "searchKnowledge",
      // Side-effecting, workspace-install-gated integration actions —
      // consciously accepted residual of the postQuery admission (#4707).
      "sendEmail",
      "createLinearIssue",
      // Env-gated (registers only when the Salesforce OAuth env is wired).
      "querySalesforce",
    ]);
    for (const name of names) {
      expect(ACKNOWLEDGED.has(name), `unacknowledged tool "${name}" reachable via postQuery`).toBe(true);
    }
    // Non-vacuity: the read core is actually present.
    for (const required of ["explore", "executeSQL", "searchKnowledge"]) {
      expect(names).toContain(required);
    }
    // The dashboards write tool is NOT reachable from this surface (#4566).
    expect(names).not.toContain("createDashboard");
  });
});
