/**
 * Unit tests for the SaaS scoping of the three semantic-amendment queries
 * (#4487): `getPendingAmendmentCount`, `getPendingAmendments`, and
 * `reviewSemanticAmendment`.
 *
 * Security invariant: NULL-org ("global scope") amendment rows are the
 * intended shared scope on self-hosted, but on SaaS they must NEVER surface
 * in — or be reviewable from — any tenant workspace. These tests assert the
 * SQL shape flips with deploy mode:
 *   - self-hosted (or unloaded config): `(org_id = $1 OR org_id IS NULL)`
 *   - saas:                              `org_id = $1` only, and the org-less
 *                                        path is refused before any query.
 *
 * Deploy mode is resolved through `isSaasModeForGuard()` (fail-closed), which
 * reads the cached config — we drive it here via `_setConfigForTest`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";

// `hasInternalDB()` reads DATABASE_URL at call time; set it before the module
// under test is imported so the query paths (not the no-DB short-circuits) run.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/atlas_test";

import {
  getPendingAmendmentCount,
  getPendingAmendments,
  reviewSemanticAmendment,
  _resetPool,
  _resetCircuitBreaker,
} from "../internal";
import type { ResolvedConfig } from "../../config";
import { _setConfigForTest, _resetConfig } from "../../config";

interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[] = [];

function makeStubPool() {
  return {
    query: async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      // reviewSemanticAmendment reads rows[0]; return an empty result set.
      return { rows: [] };
    },
    async end() {},
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    on() {},
  };
}

/** Fully-typed `ResolvedConfig` so a `deployMode` typo can't compile silently. */
function configWithDeployMode(deployMode: "saas" | "self-hosted"): ResolvedConfig {
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "managed",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode,
  };
}

/** Drive `isSaasModeForGuard()` by seeding the cached deploy mode. */
function setDeployMode(mode: "saas" | "self-hosted") {
  _setConfigForTest(configWithDeployMode(mode));
}

beforeEach(() => {
  captured = [];
  _resetCircuitBreaker();
  _resetPool(makeStubPool() as unknown as Parameters<typeof _resetPool>[0], null);
});

afterEach(() => {
  _resetConfig();
});

afterAll(() => {
  _resetPool(null, null);
  _resetConfig();
  _resetCircuitBreaker();
  mock.restore();
});

describe("semantic amendment queries — self-hosted scoping (unchanged)", () => {
  it("getPendingAmendmentCount includes the OR org_id IS NULL arm for an org", async () => {
    setDeployMode("self-hosted");
    await getPendingAmendmentCount("org-a");

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    expect(sql).toContain("(org_id = $1 OR org_id IS NULL)");
    expect(params).toEqual(["org-a"]);
  });

  it("getPendingAmendments includes the OR org_id IS NULL arm for an org", async () => {
    setDeployMode("self-hosted");
    await getPendingAmendments("org-a");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("(org_id = $1 OR org_id IS NULL)");
  });

  it("reviewSemanticAmendment includes the OR org_id IS NULL arm for an org", async () => {
    setDeployMode("self-hosted");
    await reviewSemanticAmendment("amd-1", "org-a", "approved", "admin");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("(org_id = $4 OR org_id IS NULL)");
  });

  it("null-org (global admin) path still targets org_id IS NULL rows", async () => {
    setDeployMode("self-hosted");
    await getPendingAmendments(null);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("org_id IS NULL");
  });
});

describe("semantic amendment queries — SaaS scoping (#4487)", () => {
  it("getPendingAmendmentCount drops the OR org_id IS NULL arm for a workspace", async () => {
    setDeployMode("saas");
    await getPendingAmendmentCount("org-a");

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    expect(sql).toContain("org_id = $1");
    expect(sql).not.toContain("org_id IS NULL");
    expect(params).toEqual(["org-a"]);
  });

  it("getPendingAmendments drops the OR org_id IS NULL arm for a workspace", async () => {
    setDeployMode("saas");
    await getPendingAmendments("org-a");

    expect(captured).toHaveLength(1);
    const { sql } = captured[0]!;
    expect(sql).toContain("org_id = $1");
    expect(sql).not.toContain("org_id IS NULL");
  });

  it("reviewSemanticAmendment drops the OR org_id IS NULL arm for a workspace", async () => {
    setDeployMode("saas");
    await reviewSemanticAmendment("amd-1", "org-a", "approved", "admin");

    expect(captured).toHaveLength(1);
    const { sql } = captured[0]!;
    expect(sql).toContain("org_id = $4");
    expect(sql).not.toContain("org_id IS NULL");
  });

  it("refuses the org-less path without touching the DB (count → 0)", async () => {
    setDeployMode("saas");
    const count = await getPendingAmendmentCount(null);

    expect(count).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it("refuses the org-less path without touching the DB (list → [])", async () => {
    setDeployMode("saas");
    const rows = await getPendingAmendments(null);

    expect(rows).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it("refuses the org-less path without touching the DB (review → null)", async () => {
    setDeployMode("saas");
    const reviewed = await reviewSemanticAmendment("amd-1", null, "approved", "admin");

    expect(reviewed).toBeNull();
    expect(captured).toHaveLength(0);
  });
});
