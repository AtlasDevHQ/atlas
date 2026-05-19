/**
 * Tests for `atlas ops` — the wipe path is destructive and gated by both
 * ATLAS_WIPE_OK=1 and --confirm, so the test surface focuses on:
 *   1. The double-confirm gate refuses to run when either gate is missing.
 *   2. The TRUNCATE SQL matches the pinned literal exactly — drift here
 *      would silently truncate the wrong tables.
 *   3. The handler chooses --database-url over env vars.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  WIPE_LIST_TABLES_SQL,
  WIPE_EXCLUDED_TABLES,
  wipeTenantPublicTables,
  quoteIdent,
  checkWipeGate,
  resolveWipeUrl,
  handleOps,
} from "../commands/ops";
import type { TenantPgClient } from "../../lib/tenant-db";

// --- WIPE_LIST_TABLES_SQL is the contract; verify expected shape ---

describe("WIPE_LIST_TABLES_SQL", () => {
  it("excludes exactly the migration bookkeeping tables in NOT IN clause", () => {
    // Extract the NOT IN list and assert set-equality with the constant.
    const match = WIPE_LIST_TABLES_SQL.match(/NOT IN \(([^)]+)\)/);
    expect(match).not.toBeNull();
    const found = match![1]!
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
    expect(found.sort()).toEqual([...WIPE_EXCLUDED_TABLES].sort());
  });

  it("scopes to schemaname = 'public'", () => {
    expect(WIPE_LIST_TABLES_SQL).toContain("schemaname = 'public'");
  });
});

// --- quoteIdent ---

describe("quoteIdent", () => {
  it("wraps simple identifiers in double quotes", () => {
    expect(quoteIdent("users")).toBe('"users"');
  });

  it("doubles embedded double quotes (defense in depth — pg_tables names shouldn't contain quotes)", () => {
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
  });
});

// --- wipeTenantPublicTables ---

describe("wipeTenantPublicTables", () => {
  it("lists public tables, then TRUNCATEs them with RESTART IDENTITY CASCADE", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: TenantPgClient = {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (sql === WIPE_LIST_TABLES_SQL) {
          return {
            rows: [{ tablename: "users" }, { tablename: "orders" }] as never[],
            rowCount: 2,
          };
        }
        return { rows: [] as never[], rowCount: 0 };
      },
    };
    const result = await wipeTenantPublicTables(client);
    expect(result.tablesTruncated).toEqual(["users", "orders"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toBe(WIPE_LIST_TABLES_SQL);
    expect(calls[1]!.sql).toBe(
      'TRUNCATE public."users", public."orders" RESTART IDENTITY CASCADE',
    );
  });

  it("returns an empty list and skips TRUNCATE when no tables match (avoids wrong-DB silent success)", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: TenantPgClient = {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    const result = await wipeTenantPublicTables(client);
    expect(result.tablesTruncated).toEqual([]);
    // Only the listing query ran — no TRUNCATE issued.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(WIPE_LIST_TABLES_SQL);
  });
});

// --- checkWipeGate ---

describe("checkWipeGate", () => {
  it("rejects when ATLAS_WIPE_OK is missing", () => {
    expect(checkWipeGate(["--confirm"], {} as NodeJS.ProcessEnv)).toContain(
      "ATLAS_WIPE_OK=1",
    );
  });

  it("rejects when --confirm is missing", () => {
    expect(
      checkWipeGate([], { ATLAS_WIPE_OK: "1" } as NodeJS.ProcessEnv),
    ).toContain("--confirm");
  });

  it("rejects when ATLAS_WIPE_OK is some truthy-but-not-1 value", () => {
    // Belt-and-braces: shell exporting `ATLAS_WIPE_OK=true` shouldn't slip past.
    expect(
      checkWipeGate(["--confirm"], { ATLAS_WIPE_OK: "true" } as NodeJS.ProcessEnv),
    ).toContain("ATLAS_WIPE_OK=1");
  });

  it("passes when both gates are present", () => {
    expect(
      checkWipeGate(
        ["--confirm"],
        { ATLAS_WIPE_OK: "1" } as NodeJS.ProcessEnv,
      ),
    ).toBeNull();
  });
});

// --- resolveWipeUrl ---

describe("resolveWipeUrl", () => {
  it("returns --database-url when set", () => {
    expect(
      resolveWipeUrl(
        ["--database-url", "postgresql://x/y"],
        { ATLAS_TEAM_PG_URL: "postgresql://team" } as NodeJS.ProcessEnv,
      ),
    ).toBe("postgresql://x/y");
  });

  it("falls back to ATLAS_TEAM_PG_URL, then DATABASE_URL", () => {
    expect(
      resolveWipeUrl([], { ATLAS_TEAM_PG_URL: "postgresql://team" } as NodeJS.ProcessEnv),
    ).toBe("postgresql://team");
    expect(
      resolveWipeUrl([], { DATABASE_URL: "postgresql://db" } as NodeJS.ProcessEnv),
    ).toBe("postgresql://db");
  });

  it("prefers ATLAS_TEAM_PG_URL over DATABASE_URL when both are set", () => {
    // Pinning precedence — flipping the `||` operands would silently wipe
    // the dev DB when an operator only intended ATLAS_TEAM_PG_URL.
    expect(
      resolveWipeUrl([], {
        ATLAS_TEAM_PG_URL: "postgresql://team",
        DATABASE_URL: "postgresql://db",
      } as NodeJS.ProcessEnv),
    ).toBe("postgresql://team");
  });

  it("returns null when nothing is set", () => {
    expect(resolveWipeUrl([], {} as NodeJS.ProcessEnv)).toBeNull();
  });
});

// --- handleOps arg-parsing ---

const errors: string[] = [];
const origConsoleError = console.error;
const origExit = process.exit;
let exitCode: number | null = null;

beforeEach(() => {
  errors.length = 0;
  exitCode = null;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__process_exit__:${exitCode}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  console.error = origConsoleError;
  process.exit = origExit;
});

describe("handleOps", () => {
  it("exits 1 with usage when subcommand is unknown", async () => {
    let caught: Error | null = null;
    try {
      await handleOps(["ops"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((line) => line.includes("Usage: atlas ops"))).toBe(true);
  });

  it("exits 1 when `ops wipe` runs without ATLAS_WIPE_OK", async () => {
    const orig = process.env.ATLAS_WIPE_OK;
    delete process.env.ATLAS_WIPE_OK;
    let caught: Error | null = null;
    try {
      await handleOps(["ops", "wipe", "--confirm"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    } finally {
      if (orig !== undefined) process.env.ATLAS_WIPE_OK = orig;
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((line) => line.includes("ATLAS_WIPE_OK=1"))).toBe(true);
  });

  it("exits 1 when `ops wipe` runs without --confirm", async () => {
    const orig = process.env.ATLAS_WIPE_OK;
    process.env.ATLAS_WIPE_OK = "1";
    let caught: Error | null = null;
    try {
      await handleOps(["ops", "wipe"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    } finally {
      if (orig === undefined) delete process.env.ATLAS_WIPE_OK;
      else process.env.ATLAS_WIPE_OK = orig;
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((line) => line.includes("--confirm"))).toBe(true);
  });
});
