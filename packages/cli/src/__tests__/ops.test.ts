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
  WIPE_TRUNCATE_SQL,
  WIPE_EXCLUDED_TABLES,
  wipeTenantPublicTables,
  checkWipeGate,
  resolveWipeUrl,
  handleOps,
} from "../commands/ops";
import type { TenantPgClient } from "../../lib/tenant-db";

// --- WIPE_TRUNCATE_SQL is the contract; verify expected shape ---

describe("WIPE_TRUNCATE_SQL", () => {
  it("excludes the migration bookkeeping tables", () => {
    for (const t of WIPE_EXCLUDED_TABLES) {
      expect(WIPE_TRUNCATE_SQL).toContain(`'${t}'`);
    }
  });

  it("uses RESTART IDENTITY CASCADE", () => {
    expect(WIPE_TRUNCATE_SQL).toContain("RESTART IDENTITY CASCADE");
  });

  it("scopes to schemaname = 'public'", () => {
    expect(WIPE_TRUNCATE_SQL).toContain("schemaname = 'public'");
  });
});

// --- wipeTenantPublicTables ---

describe("wipeTenantPublicTables", () => {
  it("issues the pinned TRUNCATE SQL exactly once", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: TenantPgClient = {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    await wipeTenantPublicTables(client);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(WIPE_TRUNCATE_SQL);
    expect(calls[0]!.params).toEqual([]);
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
