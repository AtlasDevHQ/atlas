/**
 * Orphan plugin-task reconcile (#2944).
 *
 * Two layers of coverage:
 *
 *   1. Unit tests with injected fakes (`reconcileOrphanTasks`) — exercise the
 *      orchestration (no-op gate, count, gated delete, drift signal) without a
 *      live DB. The headline case simulates the issue's acceptance scenario:
 *      "workspace_plugins DELETE commits but scheduled_tasks cleanup fails" →
 *      an orphan remains → the signal fires (count > 0 + log.warn).
 *
 *   2. A real-Postgres integration test (`describeIfPg`, skipped unless
 *      `TEST_DATABASE_URL` is set — it runs in the api-tests PG service
 *      container) — exercises the actual orphan-detection JOIN + NULL-org
 *      semantics against real Postgres, the part a mock query can't verify.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { Pool } from "pg";
import {
  countOrphanedPluginTasks,
  deleteOrphanedPluginTasks,
  isOrphanTaskReconcileEnabled,
  reconcileOrphanTasks,
  type OrphanReconcileQuery,
  type OrphanReconcileDeps,
  type ReconcileLogger,
} from "@atlas/api/lib/scheduler/orphan-task-reconcile";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A recording fake query routed by SQL substring. */
function fakeQuery(
  handler: (sql: string, params: unknown[] | undefined) => unknown[],
): { query: OrphanReconcileQuery; calls: Array<{ sql: string; params: unknown[] | undefined }> } {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const query = (async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    return handler(sql, params);
  }) as OrphanReconcileQuery;
  return { query, calls };
}

function recordingLogger(): {
  log: ReconcileLogger;
  warn: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
} {
  const warn = mock((_obj: Record<string, unknown>, _msg: string) => {});
  const debug = mock((_obj: Record<string, unknown>, _msg: string) => {});
  return { log: { warn, debug }, warn, debug };
}

const isCountSql = (sql: string) => /COUNT\(\*\)/.test(sql);
const isDeleteSql = (sql: string) => /DELETE\s+FROM\s+scheduled_tasks/.test(sql);

function deps(
  partial: Partial<OrphanReconcileDeps> & Pick<OrphanReconcileDeps, "query" | "log">,
): OrphanReconcileDeps {
  return {
    hasInternalDB: () => true,
    reconcileEnabled: () => false,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// countOrphanedPluginTasks — SQL shape + parsing
// ---------------------------------------------------------------------------

describe("countOrphanedPluginTasks", () => {
  test("runs a single read-only SELECT with the orphan predicate and returns parsed counts", async () => {
    const { query, calls } = fakeQuery((sql) => {
      expect(isCountSql(sql)).toBe(true);
      // Predicate: plugin-owned tasks with no matching live install.
      expect(sql).toContain("st.plugin_id IS NOT NULL");
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("wp.catalog_id = st.plugin_id");
      expect(sql).toContain("wp.workspace_id = st.org_id");
      // Read-only: never mutates.
      expect(sql).not.toMatch(/\b(DELETE|UPDATE|INSERT)\b/);
      return [{ orphaned_tasks: 3, orphaned_installs: 2 }];
    });

    const report = await countOrphanedPluginTasks(query);

    expect(report).toEqual({ orphanedTasks: 3, orphanedInstalls: 2 });
    expect(calls).toHaveLength(1);
  });

  test("defaults missing/empty result rows to zero", async () => {
    const { query } = fakeQuery(() => []);
    expect(await countOrphanedPluginTasks(query)).toEqual({
      orphanedTasks: 0,
      orphanedInstalls: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// deleteOrphanedPluginTasks — sweep predicate + NULL-org guard
// ---------------------------------------------------------------------------

describe("deleteOrphanedPluginTasks", () => {
  test("deletes via the same predicate plus an org_id NOT NULL guard, returns row count", async () => {
    const { query, calls } = fakeQuery((sql) => {
      expect(isDeleteSql(sql)).toBe(true);
      // The sweep must NOT touch NULL-org rows — the uninstall predicate
      // can't target them either.
      expect(sql).toContain("st.org_id IS NOT NULL");
      expect(sql).toContain("st.plugin_id IS NOT NULL");
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("RETURNING id");
      return [{ id: "t1" }, { id: "t2" }];
    });

    expect(await deleteOrphanedPluginTasks(query)).toBe(2);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// isOrphanTaskReconcileEnabled — env flag
// ---------------------------------------------------------------------------

describe("isOrphanTaskReconcileEnabled", () => {
  test("only true for the exact string 'true' (default off)", () => {
    const prev = process.env.ATLAS_ORPHAN_TASK_RECONCILE;
    try {
      delete process.env.ATLAS_ORPHAN_TASK_RECONCILE;
      expect(isOrphanTaskReconcileEnabled()).toBe(false);
      process.env.ATLAS_ORPHAN_TASK_RECONCILE = "1";
      expect(isOrphanTaskReconcileEnabled()).toBe(false);
      process.env.ATLAS_ORPHAN_TASK_RECONCILE = "TRUE";
      expect(isOrphanTaskReconcileEnabled()).toBe(false);
      process.env.ATLAS_ORPHAN_TASK_RECONCILE = "true";
      expect(isOrphanTaskReconcileEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ATLAS_ORPHAN_TASK_RECONCILE;
      else process.env.ATLAS_ORPHAN_TASK_RECONCILE = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// reconcileOrphanTasks — orchestration + the #2944 acceptance scenario
// ---------------------------------------------------------------------------

describe("reconcileOrphanTasks", () => {
  test("no-ops to a zero report when the internal DB is unconfigured (never queries)", async () => {
    const { query, calls } = fakeQuery(() => {
      throw new Error("must not query when internal DB is absent");
    });
    const { log, warn, debug } = recordingLogger();

    const result = await reconcileOrphanTasks(
      deps({ hasInternalDB: () => false, query, log }),
    );

    expect(result).toEqual({
      orphanedTasks: 0,
      orphanedInstalls: 0,
      reconcileEnabled: false,
      deleted: 0,
    });
    expect(calls).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  test("ACCEPTANCE: partial-failure uninstall leaves an orphan → signal fires (measure-only)", async () => {
    // Simulates "workspace_plugins DELETE committed but scheduled_tasks
    // cleanup failed": the install row is gone, so the plugin's task is now
    // an orphan and the count query surfaces it.
    const { query, calls } = fakeQuery((sql) => {
      if (isCountSql(sql)) return [{ orphaned_tasks: 1, orphaned_installs: 1 }];
      throw new Error(`unexpected query: ${sql}`);
    });
    const { log, warn, debug } = recordingLogger();

    const result = await reconcileOrphanTasks(
      deps({ query, reconcileEnabled: () => false, log }),
    );

    // The signal: the count rides the result (→ span attribute) ...
    expect(result.orphanedTasks).toBe(1);
    expect(result.orphanedInstalls).toBe(1);
    // ... measure-only, so nothing is deleted and no DELETE is issued ...
    expect(result.reconcileEnabled).toBe(false);
    expect(result.deleted).toBe(0);
    expect(calls.some((c) => isDeleteSql(c.sql))).toBe(false);
    // ... and the structured drift log fires (the stdout-scraper signal).
    expect(warn).toHaveBeenCalledTimes(1);
    const [obj, msg] = warn.mock.calls[0]!;
    expect(obj).toMatchObject({
      orphanedTasks: 1,
      reconcileEnabled: false,
      deleted: 0,
      event: "plugin_task.orphan_detected",
    });
    expect(msg).toContain("clean manually");
    expect(debug).not.toHaveBeenCalled();
  });

  test("sweeps the orphan when ATLAS_ORPHAN_TASK_RECONCILE is on", async () => {
    let deleteCalled = false;
    const { query } = fakeQuery((sql) => {
      if (isCountSql(sql)) return [{ orphaned_tasks: 2, orphaned_installs: 1 }];
      if (isDeleteSql(sql)) {
        deleteCalled = true;
        return [{ id: "a" }, { id: "b" }];
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { log, warn } = recordingLogger();

    const result = await reconcileOrphanTasks(
      deps({ query, reconcileEnabled: () => true, log }),
    );

    expect(deleteCalled).toBe(true);
    expect(result.deleted).toBe(2);
    expect(result.reconcileEnabled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toContain("reconciled");
  });

  test("does not issue a DELETE when enabled but there are no orphans", async () => {
    const { query, calls } = fakeQuery((sql) => {
      if (isCountSql(sql)) return [{ orphaned_tasks: 0, orphaned_installs: 0 }];
      throw new Error(`unexpected query: ${sql}`);
    });
    const { log, warn, debug } = recordingLogger();

    const result = await reconcileOrphanTasks(
      deps({ query, reconcileEnabled: () => true, log }),
    );

    expect(result.deleted).toBe(0);
    expect(calls.some((c) => isDeleteSql(c.sql))).toBe(false);
    // Clean scan → debug, not warn (no false drift alarm).
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Real-Postgres integration — the orphan JOIN + NULL-org semantics
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 30_000;

describeIfPg("orphan-task-reconcile (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `orphan_reconcile_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // Adapter matching `OrphanReconcileQuery` so the production count/delete
  // SQL runs verbatim against the seeded minimal tables.
  const query: OrphanReconcileQuery = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => {
    const result = await pool.query(sql, params);
    return result.rows as T[];
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`orphan-reconcile: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    // Minimal columns the orphan JOIN touches (migration 0044 shape):
    //   scheduled_tasks.plugin_id  == workspace_plugins.catalog_id
    //   scheduled_tasks.org_id     == workspace_plugins.workspace_id
    await pool.query(
      `CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, plugin_id TEXT, org_id TEXT)`,
    );
    await pool.query(
      `CREATE TABLE workspace_plugins (catalog_id TEXT NOT NULL, workspace_id TEXT NOT NULL)`,
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  test(
    "counts orphans (incl. NULL-org), sweeps only org-scoped orphans, leaves live/user/NULL-org tasks",
    async () => {
      // One live install: plugin p-live in workspace o1.
      await pool.query(
        `INSERT INTO workspace_plugins (catalog_id, workspace_id) VALUES ('p-live', 'o1')`,
      );
      await pool.query(
        `INSERT INTO scheduled_tasks (id, plugin_id, org_id) VALUES
           ('t-orphan',  'p-dead', 'o1'),   -- orphan: install for p-dead/o1 is gone
           ('t-live',    'p-live', 'o1'),   -- not an orphan: matches the live install
           ('t-user',    NULL,     'o1'),   -- user task: plugin_id NULL, never an orphan
           ('t-nullorg', 'p-dead', NULL)    -- orphan, but NULL org → counted, not swept`,
      );

      // Count surfaces both orphans (the org-scoped one + the NULL-org one).
      const before = await countOrphanedPluginTasks(query);
      expect(before.orphanedTasks).toBe(2);
      expect(before.orphanedInstalls).toBe(2);

      // Sweep removes only the org-scoped orphan.
      const deleted = await deleteOrphanedPluginTasks(query);
      expect(deleted).toBe(1);

      const remaining = await pool.query<{ id: string }>(
        `SELECT id FROM scheduled_tasks ORDER BY id`,
      );
      expect(remaining.rows.map((r) => r.id)).toEqual([
        "t-live",
        "t-nullorg",
        "t-user",
      ]);

      // The NULL-org orphan is still reported (it just isn't auto-deleted).
      const after = await countOrphanedPluginTasks(query);
      expect(after.orphanedTasks).toBe(1);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
