/**
 * Injection-read scoping for approved learned patterns (#4534).
 *
 * `getApprovedPatterns` is the read path that feeds approved patterns into every
 * agent turn's system prompt (pattern cache → org-knowledge-section). It had two
 * isolation gaps its sibling amendment-read path (`amendmentOrgScope`, #4487) did
 * not — both fixed here and pinned by the SQL shape (the injection tests mock
 * `getApprovedPatterns` wholesale, so only a query-layer test can catch these):
 *
 *   1. type filter — the query MUST restrict to `type = 'query_pattern'` so a
 *      `semantic_amendment` row (sentinel `pattern_sql`, same table, reaches
 *      `status = 'approved'` on approval) can never be injected as a "previously
 *      successful query pattern". Mirrors `getPromoteDecayCandidates`.
 *   2. SaaS NULL-org guard (#4487) — on SaaS the `OR org_id IS NULL` arm is
 *      dropped so a NULL-org ("global scope") approved pattern can never surface
 *      in a tenant's agent context (cross-tenant leak). On self-hosted the arm
 *      stays: the single workspace's legacy global scope remains readable.
 *
 * Deploy mode resolves through `isSaasModeForGuard()` (fail-closed) off the
 * cached config — driven here via `_setConfigForTest`, exactly like
 * `semantic-amendment-saas-scoping.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";

// `hasInternalDB()` reads DATABASE_URL at call time; set it before the module
// under test is imported so the query path (not the no-DB short-circuit) runs.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/atlas_test";

import { getApprovedPatterns, _resetPool, _resetCircuitBreaker } from "../internal";
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

describe("getApprovedPatterns — type filter (#4534)", () => {
  it("restricts to query_pattern rows, so an amendment row can never be injected", async () => {
    setDeployMode("self-hosted");
    await getApprovedPatterns("org-a");

    expect(captured).toHaveLength(1);
    const { sql } = captured[0]!;
    expect(sql).toContain("type = 'query_pattern'");
    // Belt-and-braces: the query must not read amendment rows at all.
    expect(sql).not.toContain("semantic_amendment");
  });

  it("keeps the type filter on the org-less (global) path too", async () => {
    setDeployMode("self-hosted");
    await getApprovedPatterns(null);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("type = 'query_pattern'");
  });

  it("keeps the type filter when a connection group is scoped", async () => {
    setDeployMode("self-hosted");
    await getApprovedPatterns("org-a", "us-prod");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("type = 'query_pattern'");
  });
});

describe("getApprovedPatterns — SaaS NULL-org guard (#4487, #4534)", () => {
  it("drops the OR org_id IS NULL arm for a tenant on SaaS", async () => {
    setDeployMode("saas");
    await getApprovedPatterns("org-a");

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    expect(sql).toContain("org_id = $1");
    // The `org_id IS NULL` arm is the leak vector — it must be gone on SaaS.
    // (The group clause `connection_group_id IS NULL` is unaffected: this
    // substring is specifically the org arm.)
    expect(sql).not.toContain("org_id IS NULL");
    expect(params).toEqual(["org-a"]);
  });

  it("keeps the OR org_id IS NULL arm for a tenant on self-hosted (legacy global scope)", async () => {
    setDeployMode("self-hosted");
    await getApprovedPatterns("org-a");

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    expect(sql).toContain("(org_id = $1 OR org_id IS NULL)");
    expect(params).toEqual(["org-a"]);
  });

  it("withholds entirely for an org-less read on SaaS (no global tenant), touching no DB", async () => {
    setDeployMode("saas");
    const rows = await getApprovedPatterns(null);

    expect(rows).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it("still targets org_id IS NULL for an org-less read on self-hosted (global admin view)", async () => {
    setDeployMode("self-hosted");
    await getApprovedPatterns(null);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("org_id IS NULL");
  });

  it("threads the group placeholder after the org placeholder on SaaS (bind order pinned)", async () => {
    setDeployMode("saas");
    await getApprovedPatterns("org-a", "us-prod");

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    // Org arm binds $1, the group arm binds $2 — a transposed bind order would
    // silently scope by the wrong value.
    expect(sql).toContain("org_id = $1");
    expect(sql).not.toContain("org_id IS NULL");
    expect(sql).toContain("(connection_group_id = $2 OR connection_group_id IS NULL)");
    expect(params).toEqual(["org-a", "us-prod"]);
  });
});
