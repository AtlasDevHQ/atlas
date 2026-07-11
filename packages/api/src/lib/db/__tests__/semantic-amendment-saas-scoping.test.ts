/**
 * SaaS scoping + one-workspace-owner invariant for semantic amendments
 * (#4487, #4510).
 *
 * Reader scoping (#4487): NULL-org ("global scope") amendment rows are the
 * intended shared scope on self-hosted, but on SaaS they must NEVER surface
 * in — or be reviewable from — any tenant workspace. The SQL shape flips with
 * deploy mode:
 *   - self-hosted (or unloaded config): `(org_id = $1 OR org_id IS NULL)`
 *   - saas:                              `org_id = $1` only, and the org-less
 *                                        path is refused before any query.
 *
 * #4510 consolidates that conditional into ONE shared helper,
 * `amendmentOrgScope`, that every reader (count, list, review) MUST use — pinned
 * here by a reader-enumeration test — and ratchets the insert seam so no code
 * path can mint a NULL-owner row anew on SaaS (the one-workspace-owner
 * invariant; legacy NULL-owner rows stay readable on self-hosted).
 *
 * Deploy mode is resolved through `isSaasModeForGuard()` (fail-closed), which
 * reads the cached config — we drive it here via `_setConfigForTest`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `hasInternalDB()` reads DATABASE_URL at call time; set it before the module
// under test is imported so the query paths (not the no-DB short-circuits) run.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/atlas_test";

import {
  getPendingAmendmentCount,
  getPendingAmendments,
  reviewSemanticAmendment,
  insertSemanticAmendment,
  amendmentOrgScope,
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
      // insertSemanticAmendment's INSERT reads back the new row's id; the reader
      // SELECT/UPDATEs and the insert-time conflict SELECT read an empty set.
      if (sql.includes("INSERT INTO learned_patterns")) return { rows: [{ id: "new-row-id" }] };
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

describe("amendmentOrgScope helper — direct (#4510)", () => {
  it("self-hosted + workspace keeps the legacy NULL-owner arm", () => {
    setDeployMode("self-hosted");
    expect(amendmentOrgScope("org-a", "$1")).toEqual({
      withhold: false,
      clause: "(org_id = $1 OR org_id IS NULL)",
    });
  });

  it("SaaS + workspace drops the NULL-owner arm", () => {
    setDeployMode("saas");
    expect(amendmentOrgScope("org-a", "$1")).toEqual({ withhold: false, clause: "org_id = $1" });
  });

  it("self-hosted + org-less is the global-admin NULL-owner view", () => {
    setDeployMode("self-hosted");
    expect(amendmentOrgScope(null, "$1")).toEqual({ withhold: false, clause: "org_id IS NULL" });
  });

  it("SaaS + org-less withholds (there is no global tenant)", () => {
    setDeployMode("saas");
    expect(amendmentOrgScope(null, "$1")).toEqual({ withhold: true });
  });

  it("threads an arbitrary placeholder position into the clause", () => {
    setDeployMode("self-hosted");
    expect(amendmentOrgScope("org-a", "$4")).toEqual({
      withhold: false,
      clause: "(org_id = $4 OR org_id IS NULL)",
    });
  });

  it("treats an empty-string org as org-less (falsy), same as null", () => {
    // Documents the truthiness boundary: on SaaS an empty owner withholds; on
    // self-hosted it falls into the global-admin NULL-owner view (never a
    // silently-scoped-to-"" workspace).
    setDeployMode("saas");
    expect(amendmentOrgScope("", "$1")).toEqual({ withhold: true });
    setDeployMode("self-hosted");
    expect(amendmentOrgScope("", "$1")).toEqual({ withhold: false, clause: "org_id IS NULL" });
  });
});

describe("one-workspace-owner invariant — insert seam (#4510)", () => {
  const insertBase = {
    orgId: null as string | null,
    description: "[add_dimension] orders: adds region",
    sourceEntity: "orders",
    confidence: 0.5,
    connectionGroupId: null as string | null,
    amendmentPayload: {
      amendmentType: "add_dimension",
      amendment: { name: "region", type: "string" },
    } as Record<string, unknown>,
  };

  function insertedRow() {
    return captured.find((c) => c.sql.includes("INSERT INTO learned_patterns"));
  }

  it("refuses a NULL-owner amendment on SaaS, without touching the DB", async () => {
    setDeployMode("saas");
    await expect(insertSemanticAmendment({ ...insertBase, orgId: null })).rejects.toThrow(
      /requires a workspace owner on SaaS/,
    );
    expect(captured).toHaveLength(0);
  });

  it("refuses an undefined owner on SaaS too (falsy, same guard)", async () => {
    setDeployMode("saas");
    await expect(insertSemanticAmendment({ ...insertBase, orgId: undefined })).rejects.toThrow(
      /requires a workspace owner on SaaS/,
    );
    expect(captured).toHaveLength(0);
  });

  it("stamps the workspace owner on SaaS when an org is supplied", async () => {
    setDeployMode("saas");
    const res = await insertSemanticAmendment({ ...insertBase, orgId: "org-a" });
    expect(res.outcome).toBe("inserted");
    const insert = insertedRow();
    expect(insert).toBeDefined();
    // org_id is the first bound parameter of the INSERT.
    expect(insert!.params[0]).toBe("org-a");
  });

  it("tolerates a NULL owner on self-hosted (legacy global scope, still writable)", async () => {
    setDeployMode("self-hosted");
    const res = await insertSemanticAmendment({ ...insertBase, orgId: null });
    expect(res.outcome).toBe("inserted");
    const insert = insertedRow();
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBeNull();
  });
});

describe("shared org-scope helper — reader/inserter enumeration (#4510)", () => {
  const source = readFileSync(join(import.meta.dir, "..", "internal.ts"), "utf8");

  // The canonical amendment readers. Adding a new tenant-scoped amendment reader
  // means adding it here AND routing its org filter through amendmentOrgScope —
  // the discovery test below fails if either is skipped.
  const AMENDMENT_READERS = [
    "getPendingAmendmentCount",
    "getPendingAmendments",
    "reviewSemanticAmendment",
  ];

  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /**
   * Every top-level function, each body sliced to the next top-level `function`
   * declaration. Good enough for marker attribution in this flat DB-helper
   * module (no nested named function declarations), and robust to reformatting —
   * we never brace-balance (template `${…}` braces would defeat that).
   */
  function topLevelFunctions(): Array<{ name: string; body: string }> {
    const marks = [
      ...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm),
    ].map((m) => ({ name: m[1], start: m.index ?? 0 }));
    return marks.map((mk, i) => ({
      name: mk.name,
      body: source.slice(mk.start, i + 1 < marks.length ? marks[i + 1].start : source.length),
    }));
  }

  function bodyOf(name: string): string {
    const fn = topLevelFunctions().find((f) => f.name === name);
    if (!fn) throw new Error(`function ${name} not found in internal.ts`);
    return fn.body;
  }

  it("every amendment reader derives its org filter from amendmentOrgScope", () => {
    for (const name of AMENDMENT_READERS) {
      expect(bodyOf(name)).toContain("amendmentOrgScope(");
    }
  });

  it("no amendment reader inlines a raw org_id scope clause (bypassing the helper)", () => {
    for (const name of AMENDMENT_READERS) {
      // Strip comments — a doc comment may *mention* the clause it delegates to
      // `amendmentOrgScope`; only inlined SQL counts as a bypass.
      const code = stripComments(bodyOf(name));
      expect(code).not.toContain("org_id IS NULL");
      expect(code).not.toMatch(/org_id\s*=\s*\$\d/);
    }
  });

  it("pins the reader set — discovery tolerant of predicate order/whitespace/alias", () => {
    // A reader SELECT/UPDATEs pending amendments: an equality `type =
    // 'semantic_amendment'` predicate AND a `status = 'pending'` *filter* (in a
    // WHERE/AND position — not a `SET status = 'pending'` write). Matched
    // independently and comment-stripped, tolerant of a table alias (`lp.`),
    // extra whitespace, reordered predicates, or a line break, so a paraphrased
    // new reader is still discovered and must be added to AMENDMENT_READERS +
    // route through the helper. Intentionally excludes: findConflictingAmendment
    // (`status IN (...)`, scoped NULL-safe by `IS NOT DISTINCT FROM` — an
    // identity dedup, not a tenant read), revertAmendmentToPending (which SETs
    // status='pending' but filters `status = 'approved'`), and the learned-
    // pattern decay query (`type != 'semantic_amendment'`).
    const discovered = topLevelFunctions()
      .filter((f) => {
        const code = stripComments(f.body);
        return (
          /(?:\w+\.)?type\s*=\s*'semantic_amendment'/.test(code) &&
          /(?:WHERE|AND)\s+(?:\w+\.)?status\s*=\s*'pending'/.test(code)
        );
      })
      .map((f) => f.name);
    expect(discovered.sort()).toEqual([...AMENDMENT_READERS].sort());
  });

  it("pins the single insert seam — only insertSemanticAmendment writes amendment rows", () => {
    // AC #3's one-workspace-owner guard lives at the single insert choke point.
    // Pin that it stays single: the only function that INSERTs a
    // `'semantic_amendment'`-typed learned_patterns row is insertSemanticAmendment.
    // A new raw inserter added here would evade the guard and could mint a
    // NULL-owner row anew on SaaS.
    const inserters = topLevelFunctions()
      .filter(
        (f) =>
          /INSERT INTO learned_patterns/.test(f.body) &&
          /'semantic_amendment'/.test(stripComments(f.body)),
      )
      .map((f) => f.name);
    expect(inserters).toEqual(["insertSemanticAmendment"]);
  });
});
