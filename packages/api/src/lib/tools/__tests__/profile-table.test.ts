/**
 * Tests for the `profileTable` tool (#4197) — profiling rides the ONE profiler
 * home: `resolveProfilingConnection` → the live connection's bound `profile()`.
 *
 * Pins the guarantees the convergence bought:
 *  - the tool consumes the resolved live connection's introspection capability
 *    (works for plugin dbTypes — there is no native-only branch left to fail),
 *  - the executeSQL-mirroring gates (table whitelist, mode visibility) still
 *    run BEFORE any connection is resolved,
 *  - the caller-owned connection lifecycle: `close()` runs on success AND when
 *    profiling throws,
 *  - resolver outcomes (not_found / unsupported / reconnect_required) surface
 *    as actionable, secret-free tool errors.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { ProfilingResult } from "@useatlas/types";
import { createConnectionMock } from "../../../__mocks__/connection";

// ── Request context (mode + org identity), mutable per test ───────────
let mockRequestContext:
  | { user?: { activeOrganizationId?: string }; atlasMode?: "published" | "developer" }
  | undefined;

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ ...noopLog, child: () => noopLog }),
  getLogger: () => ({ ...noopLog, child: () => noopLog }),
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getRequestContext: () => mockRequestContext,
  redactPaths: [],
}));

// ── Semantic whitelist, mutable per test ──────────────────────────────
// Spread the real barrel so every export stays present (mock-all-exports
// discipline); override only the whitelist reads this tool consumes.
let whitelistedTables: Set<string>;
let orgWhitelistedTables: Set<string>;
const getOrgWhitelistedTablesSpy = mock(() => orgWhitelistedTables);
const realSemantic = await import("@atlas/api/lib/semantic");
void mock.module("@atlas/api/lib/semantic", () => ({
  ...realSemantic,
  getOrgWhitelistedTables: getOrgWhitelistedTablesSpy,
  getWhitelistedTables: () => whitelistedTables,
}));

// ── Mode-visibility gate, mutable per test ────────────────────────────
let connectionVisible: boolean;
const isConnectionVisibleInModeSpy = mock(async () => connectionVisible);
void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({ isConnectionVisibleInMode: isConnectionVisibleInModeSpy }),
);

// ── The one profiler home — controllable resolver + live connection ───
type ResolvedCtx =
  | { kind: "ok"; connection: FakeConnection; dbType: string; querySchema: string | undefined }
  | { kind: "not_found" }
  | { kind: "unsupported"; message: string }
  | { kind: "reconnect_required"; message: string };

interface FakeConnection {
  dbType: string;
  connectionGroupId: string | null;
  query: ReturnType<typeof mock>;
  listObjects: ReturnType<typeof mock>;
  profile: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
}

function fakeConnection(dbType: string, profileResult: ProfilingResult | (() => Promise<ProfilingResult>)): FakeConnection {
  return {
    dbType,
    connectionGroupId: null,
    query: mock(async () => ({ columns: [], rows: [] })),
    listObjects: mock(async () => []),
    profile: mock(typeof profileResult === "function" ? profileResult : async () => profileResult),
    close: mock(async () => {}),
  };
}

let resolvedCtx: ResolvedCtx;
const resolveProfilingConnectionSpy = mock(async () => resolvedCtx);
void mock.module("@atlas/api/lib/datasources/profiling-connection", () => ({
  resolveProfilingConnection: resolveProfilingConnectionSpy,
}));

// Import after mocks
const { profileTable } = await import("../profile-table");
import type { ProfileTableResult } from "../profile-table";

const run = (input: { table: string; columns?: string[]; connectionId?: string }) =>
  profileTable.execute!(input, {
    toolCallId: "test",
    messages: [],
    abortSignal: new AbortController().signal,
  }) as Promise<ProfileTableResult>;

/** One profiled table with two columns — the shape the unified profiler emits. */
function usersProfile(): ProfilingResult {
  return {
    profiles: [
      {
        table_name: "users",
        object_type: "table",
        row_count: 200,
        columns: [
          {
            name: "id",
            type: "uuid",
            nullable: false,
            unique_count: 200,
            null_count: 0,
            sample_values: ["a", "b"],
            is_primary_key: true,
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: false,
            profiler_notes: [],
          },
          {
            name: "status",
            type: "text",
            nullable: true,
            unique_count: 3,
            null_count: 50,
            sample_values: ["active", "churned", "trial"],
            is_primary_key: false,
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: true,
            profiler_notes: [],
          },
        ],
        primary_key_columns: ["id"],
        foreign_keys: [],
        inferred_foreign_keys: [],
        indexes: [],
        profiler_notes: [],
        table_flags: { possibly_abandoned: false, possibly_denormalized: false },
      },
    ],
    errors: [],
  };
}

beforeEach(() => {
  mockRequestContext = undefined;
  whitelistedTables = new Set(["users"]);
  orgWhitelistedTables = new Set(["users"]);
  connectionVisible = true;
  resolvedCtx = { kind: "not_found" };
  resolveProfilingConnectionSpy.mockClear();
  isConnectionVisibleInModeSpy.mockClear();
  getOrgWhitelistedTablesSpy.mockClear();
});

describe("profileTable — gates run before any connection is resolved", () => {
  it("rejects a non-whitelisted table without resolving a connection", async () => {
    const result = await run({ table: "secrets" });
    expect("error" in result && result.error).toContain("not in the semantic layer whitelist");
    expect(resolveProfilingConnectionSpy).not.toHaveBeenCalled();
  });

  it("rejects a mode-invisible connection (org context) without resolving", async () => {
    mockRequestContext = { user: { activeOrganizationId: "org_1" }, atlasMode: "published" };
    connectionVisible = false;
    const result = await run({ table: "users", connectionId: "conn_dev" });
    expect("error" in result && result.error).toContain("not available in published mode");
    expect(isConnectionVisibleInModeSpy).toHaveBeenCalledWith("org_1", "conn_dev", "published");
    expect(resolveProfilingConnectionSpy).not.toHaveBeenCalled();
  });

  it("uses the org whitelist (with mode) when an org identity is present", async () => {
    mockRequestContext = { user: { activeOrganizationId: "org_1" }, atlasMode: "developer" };
    orgWhitelistedTables = new Set();
    const result = await run({ table: "users" });
    expect("error" in result).toBe(true);
    expect(getOrgWhitelistedTablesSpy).toHaveBeenCalledWith("org_1", "default", "developer");
  });
});

describe("profileTable — profiles through the live connection's bound profile()", () => {
  it("maps the unified TableProfile to the tool output (plugin dbType — no native-only gate)", async () => {
    // A ClickHouse connection proves the tool has no pg/mysql branch left: the
    // resolved connection's capability is all it consumes.
    const connection = fakeConnection("clickhouse", usersProfile());
    resolvedCtx = { kind: "ok", connection, dbType: "clickhouse", querySchema: "analytics" };

    const result = await run({ table: "users" });
    expect(connection.profile).toHaveBeenCalledWith({ selectedTables: ["users"] });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.rowCount).toBe(200);
    expect(result.columns).toHaveLength(2);
    const status = result.columns[1];
    expect(status).toEqual({
      name: "status",
      sqlType: "text",
      nullable: true,
      nullRate: 0.25,
      distinctCount: 3,
      sampleValues: ["active", "churned", "trial"],
      isPrimaryKey: false,
      isForeignKey: false,
      isEnumLike: true,
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("filters the report to the requested columns", async () => {
    const connection = fakeConnection("postgres", usersProfile());
    resolvedCtx = { kind: "ok", connection, dbType: "postgres", querySchema: "public" };

    const result = await run({ table: "users", columns: ["status"] });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.columns.map((c) => c.name)).toEqual(["status"]);
  });

  it("null_count null (degraded column stats) maps to nullRate null, not 0", async () => {
    const profile = usersProfile();
    profile.profiles[0].columns[0].null_count = null;
    profile.profiles[0].columns[0].unique_count = null;
    const connection = fakeConnection("postgres", profile);
    resolvedCtx = { kind: "ok", connection, dbType: "postgres", querySchema: "public" };

    const result = await run({ table: "users", columns: ["id"] });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.columns[0].nullRate).toBeNull();
    expect(result.columns[0].distinctCount).toBeNull();
  });

  it("surfaces the profiler's per-table error when the table failed to profile", async () => {
    const connection = fakeConnection("postgres", {
      profiles: [],
      errors: [{ table: "users", error: "permission denied for relation users" }],
    });
    resolvedCtx = { kind: "ok", connection, dbType: "postgres", querySchema: "public" };

    const result = await run({ table: "users" });
    expect("error" in result && result.error).toContain("permission denied for relation users");
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("closes the connection even when profile() throws, and reports the failure", async () => {
    const connection = fakeConnection("snowflake", async () => {
      throw new Error("network unreachable");
    });
    resolvedCtx = { kind: "ok", connection, dbType: "snowflake", querySchema: undefined };

    const result = await run({ table: "users" });
    expect("error" in result && result.error).toContain("network unreachable");
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("a close() rejection never masks a successful profile (best-effort teardown)", async () => {
    const connection = fakeConnection("clickhouse", usersProfile());
    connection.close = mock(async () => {
      throw new Error("teardown failed");
    });
    resolvedCtx = { kind: "ok", connection, dbType: "clickhouse", querySchema: undefined };

    const result = await run({ table: "users" });
    if ("error" in result) throw new Error(`close() masked the result: ${result.error}`);
    expect(result.rowCount).toBe(200);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("no profile and no profiler error → actionable table-not-found error", async () => {
    const connection = fakeConnection("postgres", { profiles: [], errors: [] });
    resolvedCtx = { kind: "ok", connection, dbType: "postgres", querySchema: "public" };

    const result = await run({ table: "users" });
    expect("error" in result && result.error).toContain("table not found in the datasource");
  });

  it("falls back to the positional profile when the profiler reports a different table_name", async () => {
    const profile = usersProfile();
    profile.profiles[0].table_name = "public.users";
    const connection = fakeConnection("postgres", profile);
    resolvedCtx = { kind: "ok", connection, dbType: "postgres", querySchema: "public" };

    const result = await run({ table: "users" });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.rowCount).toBe(200);
  });
});

describe("profileTable — resolver outcomes surface as actionable errors", () => {
  it("not_found → connection-not-found error", async () => {
    resolvedCtx = { kind: "not_found" };
    const result = await run({ table: "users", connectionId: "ghost" });
    expect("error" in result && result.error).toContain('Connection "ghost" was not found');
  });

  it("unsupported → the resolver's actionable message", async () => {
    resolvedCtx = { kind: "unsupported", message: "no plugin builds a live connection" };
    const result = await run({ table: "users" });
    expect("error" in result && result.error).toBe("no plugin builds a live connection");
  });

  it("reconnect_required → the resolver's reconnect prompt", async () => {
    resolvedCtx = { kind: "reconnect_required", message: "reconnect it in Admin → Integrations" };
    const result = await run({ table: "users" });
    expect("error" in result && result.error).toBe("reconnect it in Admin → Integrations");
  });
});
