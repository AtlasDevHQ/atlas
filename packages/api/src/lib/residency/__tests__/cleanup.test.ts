/**
 * Tests for region-migration Phase 4 source-data cleanup (#4458).
 *
 * Two halves:
 *
 * 1. **Scope tripwire** — the deletion scope must derive from the
 *    bundle-scope registry (#4460), never a hand-maintained list. These
 *    assertions pin `CLEANUP_TABLE_RULES` to `EXPORTED_TABLES ∪ STAYS_TABLES`
 *    exactly (so a new table added to the registry fails HERE until it gets a
 *    cleanup rule), forbid any `platform` table from entering the scope, and
 *    validate every rule's column/table references against the live Drizzle
 *    schema — a typo'd column name fails structurally, not at 3am in prod.
 *
 * 2. **Sweep behavior** — due/not-due selection, transactional
 *    all-or-nothing (partial failure rolls back the stamp → retried next
 *    sweep), idempotent re-runs, the cutover guard, and the region-identity
 *    guard. The real-SQL execution path is covered by
 *    `migrate-roundtrip-pg.test.ts` against actual Postgres.
 */

import { describe, it, expect, beforeEach, mock, afterAll } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@atlas/api/lib/db/schema";

// ── Mocks ────────────────────────────────────────────────────────────

let mockHasInternalDB = true;
let mockApiRegion: string | null = null;

/** Rows returned by internalQuery, keyed by SQL substring. */
let mockInternalQueryResults: Record<string, unknown[]> = {};
/** When set, internalQuery rejects for SQL containing the pattern. */
let mockInternalQueryReject: { pattern: string; error: Error } | null = null;

interface ClientResponder {
  pattern: string;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  error?: Error;
  /** How many matching calls reject (undefined = every match). */
  times?: number;
}
let clientResponders: ClientResponder[] = [];
const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
let releasedCount = 0;
/** Arguments passed to client.release() — pins the poisoned-client destroy. */
const releaseArgs: Array<Error | undefined> = [];

function clientQuery(
  sql: string,
  params?: unknown[],
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  clientQueries.push({ sql, params: params ?? [] });
  for (const responder of clientResponders) {
    if (!sql.includes(responder.pattern)) continue;
    if (responder.error) {
      if (responder.times === undefined) return Promise.reject(responder.error);
      if (responder.times > 0) {
        responder.times--;
        return Promise.reject(responder.error);
      }
      continue;
    }
    return Promise.resolve({
      rows: responder.rows ?? [],
      rowCount: responder.rowCount ?? responder.rows?.length ?? 0,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: clientQuery,
    connect: async () => ({
      query: clientQuery,
      release: (err?: Error) => {
        releasedCount++;
        releaseArgs.push(err);
      },
    }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: (sql: string, _params: unknown[]) => {
    if (mockInternalQueryReject && sql.includes(mockInternalQueryReject.pattern)) {
      return Promise.reject(mockInternalQueryReject.error);
    }
    for (const [key, value] of Object.entries(mockInternalQueryResults)) {
      if (sql.includes(key)) return Promise.resolve(value);
    }
    return Promise.resolve([]);
  },
  internalExecute: () => {},
  getWorkspaceRegion: () => Promise.resolve(null),
  setWorkspaceRegion: () => Promise.resolve({ assigned: true }),
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

void mock.module("@atlas/api/lib/residency/misrouting", () => ({
  getApiRegion: () => mockApiRegion,
  getMisroutedCount: () => 0,
  _resetMisroutedCount: () => {},
  _resetRegionCache: () => {},
  isStrictRoutingEnabled: () => false,
  detectMisrouting: async () => ({ misrouted: false }),
}));

import {
  CLEANUP_TABLE_RULES,
  buildCleanupStatements,
  cleanupMigrationSourceData,
  runSourceCleanupSweep,
  SOURCE_CLEANUP_SWEEP_INTERVAL_MS,
  type CleanupRule,
} from "../cleanup";
import {
  BUNDLE_TABLE_DECISIONS,
  EXPORTED_TABLES,
  STAYS_TABLES,
} from "../bundle-scope";

// String-indexed view: the registry's literal-keyed type (via `satisfies`)
// rejects arbitrary-string indexing, which is exactly what this suite does.
const ruleFor: Readonly<Record<string, CleanupRule | undefined>> = CLEANUP_TABLE_RULES;

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  mockHasInternalDB = true;
  mockApiRegion = null;
  mockInternalQueryResults = {};
  mockInternalQueryReject = null;
  clientResponders = [];
  clientQueries.length = 0;
  releasedCount = 0;
  releaseArgs.length = 0;
});

// ── Fixtures ─────────────────────────────────────────────────────────

const DUE_MIGRATION = {
  id: "mig-1",
  workspace_id: "org-1",
  source_region: "us-east",
  completed_at: "2026-07-01T00:00:00Z",
};

/** Make getCleanupDueMigrations return the given raw rows. */
function setDue(rows: Array<typeof DUE_MIGRATION>): void {
  mockInternalQueryResults["FROM region_migrations"] = rows;
}

/** Standard eligible-row + moved-away-org responders for the transaction. */
function setEligible(overrides?: {
  status?: string;
  source_cleaned_at?: string | null;
  orgRegion?: string | null;
}): void {
  clientResponders.push(
    {
      // Both the eligibility re-check and the org guard SELECT carry
      // FOR UPDATE — key on the table name, not the lock clause.
      pattern: "FROM region_migrations WHERE id",
      rows: [
        {
          status: overrides?.status ?? "completed",
          source_cleaned_at: overrides?.source_cleaned_at ?? null,
        },
      ],
    },
    {
      pattern: "FROM organization",
      rows:
        overrides?.orgRegion === null
          ? []
          : [{ region: overrides?.orgRegion ?? "eu-west" }],
    },
  );
}

const deleteStatements = () =>
  clientQueries.filter((q) => q.sql.startsWith("DELETE FROM "));

// ── Drizzle schema view ──────────────────────────────────────────────

const schemaTables = Object.values(schema).flatMap((v) =>
  is(v, PgTable) ? [getTableConfig(v)] : [],
);
const columnsOf = (table: string): string[] => {
  const cfg = schemaTables.find((t) => t.name === table);
  return cfg ? cfg.columns.map((c) => c.name) : [];
};

const PLATFORM_TABLES = Object.entries(BUNDLE_TABLE_DECISIONS)
  .filter(([, v]) => v.decision === "platform")
  .map(([k]) => k);

// ═════════════════════════════════════════════════════════════════════
// 1. Scope tripwire — cleanup scope is the bundle-scope registry
// ═════════════════════════════════════════════════════════════════════

describe("cleanup scope tripwire (#4458 ↔ #4460 lockstep)", () => {
  it("rules cover exactly EXPORTED_TABLES ∪ STAYS_TABLES", () => {
    const expected = [...EXPORTED_TABLES, ...STAYS_TABLES].toSorted();
    expect(
      Object.keys(CLEANUP_TABLE_RULES).toSorted(),
      "CLEANUP_TABLE_RULES must match the bundle-scope registry's exported+stays " +
        "set exactly. A new table added to BUNDLE_TABLE_DECISIONS needs a cleanup " +
        "rule here (or 'platform' classification there) in the same PR.",
    ).toEqual(expected);
  });

  it("no platform table ever enters the cleanup scope", () => {
    expect(PLATFORM_TABLES.length).toBeGreaterThan(0);
    for (const table of PLATFORM_TABLES) {
      expect(table in CLEANUP_TABLE_RULES, `platform table '${table}' must not have a cleanup rule`).toBe(false);
    }
    for (const stmt of buildCleanupStatements()) {
      expect(PLATFORM_TABLES).not.toContain(stmt.table);
      for (const table of PLATFORM_TABLES) {
        expect(
          stmt.sql.includes(` ${table} `) || stmt.sql.includes(`FROM ${table} `),
          `cleanup statement for '${stmt.table}' references platform table '${table}': ${stmt.sql}`,
        ).toBe(false);
      }
    }
  });

  it("every 'column' rule names a real column on the real table", () => {
    for (const [table, rule] of Object.entries(CLEANUP_TABLE_RULES)) {
      if (rule.kind !== "column") continue;
      expect(
        columnsOf(table),
        `cleanup rule for '${table}' names column '${rule.column}' which does not exist in db/schema.ts`,
      ).toContain(rule.column);
    }
  });

  it("every 'parent' rule is structurally valid and its parent is column-scoped", () => {
    for (const [table, rule] of Object.entries(CLEANUP_TABLE_RULES)) {
      if (rule.kind !== "parent") continue;
      expect(columnsOf(table), `'${table}' lacks fk column '${rule.fkColumn}'`).toContain(rule.fkColumn);
      expect(columnsOf(rule.parentTable), `parent '${rule.parentTable}' lacks 'id'`).toContain("id");
      expect(
        columnsOf(rule.parentTable),
        `parent '${rule.parentTable}' lacks scope column '${rule.parentColumn}'`,
      ).toContain(rule.parentColumn);
      const parentRule = ruleFor[rule.parentTable];
      expect(
        parentRule?.kind,
        `parent '${rule.parentTable}' of '${table}' must itself be column-scoped so the whole chain is deleted`,
      ).toBe("column");
    }
  });

  it("'none' rules are a pinned exemption limited to tables with no org dimension", () => {
    const noneTables = Object.entries(CLEANUP_TABLE_RULES)
      .filter(([, r]) => r.kind === "none")
      .map(([t]) => t)
      .toSorted();
    // Pinned: widening this set is a deliberate residency decision, not a default.
    expect(noneTables).toEqual(["backup_config", "backups"]);
    for (const table of noneTables) {
      const cols = columnsOf(table);
      expect(cols.length).toBeGreaterThan(0);
      expect(cols).not.toContain("org_id");
      expect(cols).not.toContain("workspace_id");
    }
  });

  it("chat_cache scopes by the Slack-installation JSONB expression (no org column)", () => {
    // Pinned per the bundle-scope registry's chat_cache rationale: no
    // org_id column exists; Slack installation rows carry the org id in the
    // JSONB value, so cleanup must scope by that expression.
    expect(CLEANUP_TABLE_RULES.chat_cache).toEqual({
      kind: "expression",
      predicate: "value->>'orgId' = $1",
    });
    // Non-vacuous: prove the table exists in the schema, THEN that it has no
    // org column (columnsOf returns [] for a dropped/renamed table).
    expect(columnsOf("chat_cache").length).toBeGreaterThan(0);
    expect(columnsOf("chat_cache")).not.toContain("org_id");
  });

  it("orders parent/expression-scoped deletes before the direct-column phase", () => {
    const statements = buildCleanupStatements();
    const kindOf = (table: string) => ruleFor[table]?.kind;
    const firstColumnIdx = statements.findIndex((s) => kindOf(s.table) === "column");
    const lastNonColumnIdx = statements.findLastIndex((s) => kindOf(s.table) !== "column");
    // Load-bearing for slack_threads: it has no FK cascade from
    // conversations, so its subquery must run while the parent rows exist.
    expect(lastNonColumnIdx).toBeLessThan(firstColumnIdx);
    expect(statements.some((s) => s.table === "slack_threads")).toBe(true);
  });

  it("emits exactly one parameterized DELETE per scopable rule", () => {
    const statements = buildCleanupStatements();
    const scopable = Object.values(CLEANUP_TABLE_RULES).filter((r) => r.kind !== "none");
    expect(statements).toHaveLength(scopable.length);
    for (const stmt of statements) {
      expect(stmt.sql.startsWith(`DELETE FROM ${stmt.table} WHERE `)).toBe(true);
      expect(stmt.sql).toContain("$1");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Sweep behavior
// ═════════════════════════════════════════════════════════════════════

describe("runSourceCleanupSweep", () => {
  it("returns zeros without an internal DB", async () => {
    mockHasInternalDB = false;
    expect(await runSourceCleanupSweep()).toEqual({ due: 0, cleaned: 0, skipped: 0, blocked: 0 });
  });

  it("returns zeros when nothing is due", async () => {
    setDue([]);
    expect(await runSourceCleanupSweep()).toEqual({ due: 0, cleaned: 0, skipped: 0, blocked: 0 });
    expect(clientQueries).toHaveLength(0);
  });

  it("cleans a due migration: every scoped DELETE runs, then the stamp, in one transaction", async () => {
    setDue([DUE_MIGRATION]);
    setEligible();

    const result = await runSourceCleanupSweep();
    expect(result).toEqual({ due: 1, cleaned: 1, skipped: 0, blocked: 0 });

    const deletes = deleteStatements();
    expect(deletes).toHaveLength(buildCleanupStatements().length);
    for (const del of deletes) {
      expect(del.params).toEqual(["org-1"]);
    }

    // Transaction shape: BEGIN … deletes … stamp … COMMIT, then a clean
    // (argument-less) release back to the pool.
    const sqls = clientQueries.map((q) => q.sql);
    expect(sqls[0]).toBe("BEGIN");
    const stampIdx = sqls.findIndex((s) => s.includes("SET source_cleaned_at = NOW()"));
    expect(stampIdx).toBeGreaterThan(-1);
    expect(sqls.indexOf("COMMIT")).toBeGreaterThan(stampIdx);
    expect(sqls).not.toContain("ROLLBACK");
    expect(releasedCount).toBe(1);
    expect(releaseArgs).toEqual([undefined]);

    // The lock waits are bounded so a wedged organization row surfaces as a
    // tick failure instead of hanging the fiber forever.
    expect(sqls.some((s) => s.includes("SET LOCAL lock_timeout"))).toBe(true);

    // Both guard reads take row locks: the eligibility re-check (concurrent
    // sweeps) and the organization read (concurrent cutover). Dropping
    // either FOR UPDATE reopens a race on a destructive path.
    expect(
      sqls.some((s) => s.includes("FROM region_migrations WHERE id = $1 FOR UPDATE")),
    ).toBe(true);
    expect(
      sqls.some((s) => s.includes("FROM organization WHERE id = $1 FOR UPDATE")),
    ).toBe(true);
  });

  it("destroys the connection when ROLLBACK itself fails (never pool an aborted transaction)", async () => {
    setDue([DUE_MIGRATION]);
    setEligible();
    clientResponders.unshift(
      { pattern: "DELETE FROM conversations", error: new Error("connection reset") },
      { pattern: "ROLLBACK", error: new Error("socket closed") },
    );

    await expect(runSourceCleanupSweep()).rejects.toThrow(/every attempt failed/);
    expect(releasedCount).toBe(1);
    expect(releaseArgs[0]).toBeInstanceOf(Error);
  });

  it("skips an already-resolved row without deleting (concurrent-instance idempotency)", async () => {
    setDue([DUE_MIGRATION]);
    setEligible({ source_cleaned_at: "2026-07-10T00:00:00Z" });

    const result = await runSourceCleanupSweep();
    expect(result).toEqual({ due: 1, cleaned: 0, skipped: 1, blocked: 0 });
    expect(deleteStatements()).toHaveLength(0);
    expect(clientQueries.map((q) => q.sql)).toContain("ROLLBACK");
  });

  it("cutover guard: refuses to delete when the workspace is homed in the source region, and resolves the row", async () => {
    setDue([DUE_MIGRATION]);
    setEligible({ orgRegion: "us-east" }); // org.region === source_region

    const result = await runSourceCleanupSweep();
    expect(result).toEqual({ due: 1, cleaned: 0, skipped: 1, blocked: 0 });
    expect(deleteStatements()).toHaveLength(0);
    // Permanently resolved (stamped + committed) so it never comes due again.
    const sqls = clientQueries.map((q) => q.sql);
    const stampIdx = sqls.findIndex((s) => s.includes("SET source_cleaned_at = NOW()"));
    expect(stampIdx).toBeGreaterThan(-1);
    expect(sqls.indexOf("COMMIT")).toBeGreaterThan(stampIdx);
  });

  it("proceeds when the organization row is missing (workspace deleted — residue removal is the goal)", async () => {
    setDue([DUE_MIGRATION]);
    setEligible({ orgRegion: null });

    const result = await runSourceCleanupSweep();
    expect(result).toEqual({ due: 1, cleaned: 1, skipped: 0, blocked: 0 });
    expect(deleteStatements()).toHaveLength(buildCleanupStatements().length);
  });

  it("region-identity guard: blocks another region's migration (still due, nothing deleted, no throw)", async () => {
    mockApiRegion = "eu-west";
    setDue([DUE_MIGRATION]); // source_region us-east

    const result = await runSourceCleanupSweep();
    // Blocked, not skipped: the row is NOT resolved and stays due — a
    // persistent non-zero blocked count is the operator signal for a
    // region-identity misconfiguration. All-blocked does not throw (nothing
    // failed; this instance had no rows of its own to clean).
    expect(result).toEqual({ due: 1, cleaned: 0, skipped: 0, blocked: 1 });
    expect(clientQueries).toHaveLength(0); // never even opened a transaction
  });

  it("fails closed when organization.region is NULL: no deletes, no stamp, row stays due", async () => {
    setDue([DUE_MIGRATION]);
    setEligible({ orgRegion: undefined });
    // Override the organization responder: row exists with region NULL.
    clientResponders.pop();
    clientResponders.push({ pattern: "FROM organization", rows: [{ region: null }] });

    const result = await runSourceCleanupSweep();
    expect(result).toEqual({ due: 1, cleaned: 0, skipped: 0, blocked: 1 });
    expect(deleteStatements()).toHaveLength(0);
    const sqls = clientQueries.map((q) => q.sql);
    expect(sqls).toContain("ROLLBACK");
    // Crucially NOT stamped — ambiguity must stay visible, not be resolved.
    expect(sqls.some((s) => s.includes("SET source_cleaned_at = NOW()"))).toBe(false);
  });

  it("propagates a failure of the due query itself (span must record ERROR, not a quiet zero)", async () => {
    mockInternalQueryReject = {
      pattern: "FROM region_migrations",
      error: new Error("connection refused"),
    };
    await expect(runSourceCleanupSweep()).rejects.toThrow("connection refused");
  });

  it("rolls back the whole cleanup on a mid-delete failure — no stamp, retried next sweep", async () => {
    setDue([DUE_MIGRATION]);
    setEligible();
    clientResponders.unshift({
      pattern: "DELETE FROM knowledge_documents",
      error: new Error("connection reset"),
    });

    // Single due migration and it failed outright → the sweep throws so the
    // fiber's span records ERROR (mirrors failStaleMigrations).
    await expect(runSourceCleanupSweep()).rejects.toThrow(
      /every attempt failed/,
    );
    const sqls = clientQueries.map((q) => q.sql);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls.some((s) => s.includes("SET source_cleaned_at = NOW()"))).toBe(false);
    expect(releasedCount).toBe(1);
  });

  it("partial failure stays non-throwing: the healthy migration is cleaned, the failed one left unstamped", async () => {
    setDue([
      DUE_MIGRATION,
      { ...DUE_MIGRATION, id: "mig-2", workspace_id: "org-2" },
    ]);
    setEligible();
    clientResponders.unshift({
      pattern: "DELETE FROM conversations",
      error: new Error("transient"),
      times: 1, // only the first migration's delete fails
    });

    const result = await runSourceCleanupSweep();
    expect(result).toEqual({ due: 2, cleaned: 1, skipped: 0, blocked: 0 });

    // Exactly ONE stamp executed (mig-2's), and mig-1's transaction rolled
    // back before it — a bug that stamps the failed row would show two.
    const stamps = clientQueries.filter((q) =>
      q.sql.includes("SET source_cleaned_at = NOW()"),
    );
    expect(stamps).toHaveLength(1);
    expect(stamps[0].params).toEqual(["mig-2"]);
    const sqls = clientQueries.map((q) => q.sql);
    expect(sqls.indexOf("ROLLBACK")).toBeLessThan(
      sqls.findIndex((s) => s.includes("SET source_cleaned_at = NOW()")),
    );
  });
});

describe("cleanupMigrationSourceData", () => {
  it("reports already_resolved for a row that is no longer completed", async () => {
    setEligible({ status: "failed" });
    const result = await cleanupMigrationSourceData({
      id: "mig-1",
      workspaceId: "org-1",
      sourceRegion: "us-east",
    });
    expect(result).toEqual({ outcome: "already_resolved" });
    expect(deleteStatements()).toHaveLength(0);
  });

  it("reports the deleted-row total for the audit event (rowCount-bearing client)", async () => {
    setEligible();
    clientResponders.unshift(
      { pattern: "DELETE FROM conversations", rowCount: 3 },
      { pattern: "DELETE FROM audit_log", rowCount: 2 },
    );
    const result = await cleanupMigrationSourceData({
      id: "mig-1",
      workspaceId: "org-1",
      sourceRegion: "us-east",
    });
    expect(result).toEqual({ outcome: "cleaned", deletedRows: 5 });
  });

  it("never touches migration status or region_updated (cutover-guard columns)", async () => {
    setEligible();
    await cleanupMigrationSourceData({
      id: "mig-1",
      workspaceId: "org-1",
      sourceRegion: "us-east",
    });
    for (const q of clientQueries) {
      if (!q.sql.includes("UPDATE region_migrations")) continue;
      expect(q.sql).not.toContain("status");
      expect(q.sql).not.toContain("region_updated");
      expect(q.sql).toContain("source_cleaned_at");
    }
  });
});

describe("fiber wiring constants", () => {
  it("the sweep interval is comfortably inside the 7-day grace period", () => {
    expect(SOURCE_CLEANUP_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(SOURCE_CLEANUP_SWEEP_INTERVAL_MS).toBeLessThan(7 * 24 * 60 * 60 * 1000);
  });
});
