/**
 * Unit tests for the SaaS scoping of the org-scoped semantic-amendment
 * queries (#4487): `getPendingAmendmentCount`, `getPendingAmendments`, and
 * the decide-seam claim helpers `claimPendingAmendment` /
 * `rejectPendingAmendment` (#4506) — plus the SQL shape of the seam's
 * conditional transitions (claim-on-pending, stamp-on-claim,
 * release-on-claim), which are the races' DB-level protection.
 *
 * Security invariant: NULL-org ("global scope") amendment rows are the
 * intended shared scope on self-hosted, but on SaaS they must NEVER surface
 * in — or be reviewable from — any tenant workspace. These tests assert the
 * SQL shape flips with deploy mode:
 *   - self-hosted (or unloaded config): `(org_id = $N OR org_id IS NULL)`
 *   - saas:                              `org_id = $N` only, and the org-less
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
  claimPendingAmendment,
  stampClaimedAmendmentApproved,
  releaseClaimedAmendment,
  rejectPendingAmendment,
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

  it("claimPendingAmendment includes the OR org_id IS NULL arm for an org", async () => {
    setDeployMode("self-hosted");
    await claimPendingAmendment("amd-1", "org-a", "admin");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("(org_id = $3 OR org_id IS NULL)");
    expect(captured[0]!.params).toEqual(["admin", "amd-1", "org-a"]);
  });

  it("rejectPendingAmendment includes the OR org_id IS NULL arm for an org", async () => {
    setDeployMode("self-hosted");
    await rejectPendingAmendment("amd-1", "org-a", "admin");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("(org_id = $3 OR org_id IS NULL)");
  });

  it("null-org (global admin) path still targets org_id IS NULL rows", async () => {
    setDeployMode("self-hosted");
    await getPendingAmendments(null);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("org_id IS NULL");
  });
});

describe("decide-seam conditional transitions (#4506) — the DB-level race protection", () => {
  // These pin the WHERE shapes that make the seam's guarantees hold under
  // concurrency: exactly one claim wins (conditional on `pending`), a reject
  // can never stamp an applied change (same conditional), and stamp/release
  // only act on a held claim (`applying`).

  it("claim is conditional on pending (or a stale claim) and moves the row to 'applying'", async () => {
    setDeployMode("self-hosted");
    await claimPendingAmendment("amd-1", "org-a", "admin");

    const { sql } = captured[0]!;
    expect(sql).toContain("SET status = 'applying'");
    expect(sql).toContain("status = 'pending' OR (status = 'applying'");
    expect(sql).toContain("type = 'semantic_amendment'");
    // A retried approve starts clean: the claim clears the previous failure.
    expect(sql).toContain("last_apply_error = NULL");
  });

  it("reject is conditional on pending — never flips an approved or freshly-claimed row", async () => {
    setDeployMode("self-hosted");
    await rejectPendingAmendment("amd-1", "org-a", "admin");

    const { sql } = captured[0]!;
    expect(sql).toContain("SET status = 'rejected'");
    expect(sql).toContain("status = 'pending' OR (status = 'applying'");
    expect(sql).not.toContain("status = 'approved'");
  });

  it("stamp-approved is conditional on the held claim ('applying'), never on pending", async () => {
    setDeployMode("self-hosted");
    await stampClaimedAmendmentApproved("amd-1");

    const { sql, params } = captured[0]!;
    expect(sql).toContain("SET status = 'approved'");
    expect(sql).toContain("status = 'applying'");
    expect(sql).not.toContain("status = 'pending'");
    expect(params).toEqual(["amd-1"]);
  });

  it("release compensates a held claim back to pending with the visible reason", async () => {
    setDeployMode("self-hosted");
    await releaseClaimedAmendment("amd-1", "snapshot failed");

    const { sql, params } = captured[0]!;
    expect(sql).toContain("SET status = 'pending'");
    expect(sql).toContain("last_apply_error = $2");
    expect(sql).toContain("status = 'applying'");
    expect(params).toEqual(["amd-1", "snapshot failed"]);
  });

  it("pending reads resurface stale 'applying' claims so a crash can't strand a row", async () => {
    setDeployMode("self-hosted");
    await getPendingAmendments("org-a");

    expect(captured[0]!.sql).toContain("status = 'pending' OR (status = 'applying'");
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

  it("claimPendingAmendment drops the OR org_id IS NULL arm for a workspace", async () => {
    setDeployMode("saas");
    await claimPendingAmendment("amd-1", "org-a", "admin");

    expect(captured).toHaveLength(1);
    const { sql } = captured[0]!;
    expect(sql).toContain("org_id = $3");
    expect(sql).not.toContain("org_id IS NULL");
  });

  it("rejectPendingAmendment drops the OR org_id IS NULL arm for a workspace", async () => {
    setDeployMode("saas");
    await rejectPendingAmendment("amd-1", "org-a", "admin");

    expect(captured).toHaveLength(1);
    const { sql } = captured[0]!;
    expect(sql).toContain("org_id = $3");
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

  it("refuses the org-less path without touching the DB (claim → null)", async () => {
    setDeployMode("saas");
    const claimed = await claimPendingAmendment("amd-1", null, "admin");

    expect(claimed).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("refuses the org-less path without touching the DB (reject → false)", async () => {
    setDeployMode("saas");
    const rejected = await rejectPendingAmendment("amd-1", null, "admin");

    expect(rejected).toBe(false);
    expect(captured).toHaveLength(0);
  });
});
