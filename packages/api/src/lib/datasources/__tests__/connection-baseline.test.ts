/**
 * Baseline-profile orchestration (#4509) — the connection-creation hook seam.
 *
 * Pins, at the highest seam that stays DB-free:
 *   • the on-create hook's decision for BOTH dbType classes — a profilable type
 *     schedules a baseline; a REST/OpenAPI (unsupported) type does not;
 *   • `runBaselineProfile` — resolve → profile → store, with a failure recorded
 *     as a VISIBLE baseline_error (never silent) and the connection always closed;
 *   • `ensureConnectionBaseline` — lazy backfill runs only when no baseline
 *     exists (one connection on demand, never a bulk sweep).
 *
 * `db/internal` is mocked (the `internalQuery`-spy pattern) so the store's SQL is
 * captured without a live DB; the connection + capability resolvers are injected
 * so no live connection or plugin registry is needed.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { ProfileCapability, ResolveLiveConnectionResult } from "../mcp-lifecycle";

let mockHasDB = true;
const dbCalls: Array<{ sql: string; params: unknown[] }> = [];
let selectRows: Record<string, unknown>[][] = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: async (sql: string, params: unknown[]) => {
    dbCalls.push({ sql, params });
    if (/^\s*SELECT/i.test(sql)) return selectRows.shift() ?? [];
    return [];
  },
  internalExecute: () => {},
  getInternalDB: () => ({}),
}));

const {
  planConnectionBaseline,
  runBaselineProfile,
  ensureConnectionBaseline,
  profileConnectionOnCreate,
} = await import("../connection-baseline");

const native: ProfileCapability = { kind: "native", dbType: "postgres" };
const plugin: ProfileCapability = { kind: "plugin", dbType: "elasticsearch" };
const unsupported: ProfileCapability = {
  kind: "unsupported",
  dbType: "openapi-generic",
  message: "REST/OpenAPI cannot be profiled.",
};

function fakeConnection(overrides: Partial<{ profiles: unknown[]; errors: unknown[]; throwOnProfile: Error }> = {}) {
  const closed = { count: 0 };
  const conn = {
    dbType: "postgres" as const,
    connectionGroupId: "g_resolved" as string | null,
    query: async () => ({ columns: [], rows: [] }),
    listObjects: async () => [],
    profile: async () => {
      if (overrides.throwOnProfile) throw overrides.throwOnProfile;
      return { profiles: overrides.profiles ?? [], errors: overrides.errors ?? [] };
    },
    close: async () => {
      closed.count += 1;
    },
  };
  return { conn, closed };
}

function okResolver(conn: ReturnType<typeof fakeConnection>["conn"]) {
  return async (): Promise<ResolveLiveConnectionResult> =>
    ({ kind: "ok", connection: conn, defaultSchema: undefined }) as unknown as ResolveLiveConnectionResult;
}

beforeEach(() => {
  mockHasDB = true;
  dbCalls.length = 0;
  selectRows = [];
});

describe("planConnectionBaseline — both dbType classes", () => {
  it("marks a native (postgres/mysql) type profilable", async () => {
    const plan = await planConnectionBaseline("postgres", { resolveCapability: async () => native });
    expect(plan).toEqual({ profilable: true, capabilityKind: "native" });
  });

  it("marks a plugin datasource (elasticsearch) profilable", async () => {
    const plan = await planConnectionBaseline("elasticsearch", { resolveCapability: async () => plugin });
    expect(plan.profilable).toBe(true);
  });

  it("marks a REST/OpenAPI (unsupported) type NOT profilable", async () => {
    const plan = await planConnectionBaseline("openapi-generic", { resolveCapability: async () => unsupported });
    expect(plan).toEqual({ profilable: false, capabilityKind: "unsupported" });
  });
});

describe("profileConnectionOnCreate — the on-create hook seam", () => {
  it("schedules a background baseline for a profilable connection", async () => {
    const runBaseline = mock(async () => {});
    const decision = await profileConnectionOnCreate(
      { orgId: "org_1", installId: "cn_pg", connectionGroupId: "g", dbType: "postgres" },
      { resolveCapability: async () => native, runBaseline, claimSlot: async () => true },
    );
    expect(decision).toEqual({ action: "scheduled" });
    expect(runBaseline).toHaveBeenCalledTimes(1);
    expect(runBaseline).toHaveBeenCalledWith({
      orgId: "org_1",
      installId: "cn_pg",
      connectionGroupId: "g",
      dbType: "postgres",
    });
  });

  it("skips scheduling when the in-flight claim is lost (a peer is already profiling)", async () => {
    // The claim collapses ALL profile initiators to one: if a concurrent lazy
    // backfill already holds the claim, the on-create hook does NOT double-profile.
    const runBaseline = mock(async () => {});
    const decision = await profileConnectionOnCreate(
      { orgId: "org_1", installId: "cn_pg", dbType: "postgres" },
      { resolveCapability: async () => native, runBaseline, claimSlot: async () => false },
    );
    expect(decision).toEqual({ action: "skipped", reason: "already-profiling" });
    expect(runBaseline).not.toHaveBeenCalled();
  });

  it("does NOT profile a REST/OpenAPI datasource", async () => {
    const runBaseline = mock(async () => {});
    const decision = await profileConnectionOnCreate(
      { orgId: "org_1", installId: "cn_rest", dbType: "openapi-generic" },
      { resolveCapability: async () => unsupported, runBaseline },
    );
    expect(decision).toEqual({ action: "skipped", reason: "not-profilable" });
    expect(runBaseline).not.toHaveBeenCalled();
  });

  it("skips (no throw) when there is no internal DB", async () => {
    mockHasDB = false;
    const runBaseline = mock(async () => {});
    const decision = await profileConnectionOnCreate(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      { resolveCapability: async () => native, runBaseline },
    );
    expect(decision).toEqual({ action: "skipped", reason: "no-internal-db" });
    expect(runBaseline).not.toHaveBeenCalled();
  });

  it("never throws — a capability-lookup error degrades to a skip", async () => {
    const decision = await profileConnectionOnCreate(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      {
        resolveCapability: async () => {
          throw new Error("registry down");
        },
      },
    );
    expect(decision).toEqual({ action: "skipped", reason: "error" });
  });
});

describe("runBaselineProfile", () => {
  it("stores the profiler payload and closes the connection", async () => {
    const { conn, closed } = fakeConnection({ profiles: [{ table_name: "orders" }] });
    await runBaselineProfile(
      { orgId: "org_1", installId: "cn", connectionGroupId: "g", dbType: "postgres" },
      { resolveConnection: okResolver(conn) },
    );
    const insert = dbCalls.find((c) => c.sql.includes("INSERT INTO connection_profile_state"));
    expect(insert).toBeDefined();
    expect(insert?.sql).toContain("baseline_profiled_at = now()");
    expect(insert?.params[1]).toBe("cn");
    expect(closed.count).toBe(1);
  });

  it("records a VISIBLE baseline_error when profiling throws, still closing the connection", async () => {
    const { conn, closed } = fakeConnection({ throwOnProfile: new Error("permission denied") });
    await runBaselineProfile(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      { resolveConnection: okResolver(conn) },
    );
    const errWrite = dbCalls.find((c) => c.sql.includes("baseline_error = EXCLUDED.baseline_error"));
    expect(errWrite).toBeDefined();
    expect(errWrite?.params[4]).toBe("permission denied");
    expect(closed.count).toBe(1);
  });

  it("records a baseline_error when the connection cannot be resolved", async () => {
    await runBaselineProfile(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      { resolveConnection: async () => ({ kind: "not_found" }) },
    );
    const errWrite = dbCalls.find((c) => c.sql.includes("baseline_error = EXCLUDED.baseline_error"));
    expect(errWrite).toBeDefined();
    expect(String(errWrite?.params[4])).toContain("could not resolve a live connection");
  });

  it("SCRUBS a DSN out of a driver error before storing it (never leaks a credential)", async () => {
    // The stored baseline_error is agent-readable via the briefing/coverage — a
    // raw pg error can echo the connection string. This guards the scrub so a
    // refactor dropping errorMessage() fails here rather than leaking silently.
    const { conn } = fakeConnection({
      throwOnProfile: new Error("connect to postgres://admin:s3cr3t@db.internal:5432/prod failed"),
    });
    await runBaselineProfile(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      { resolveConnection: okResolver(conn) },
    );
    const errWrite = dbCalls.find((c) => c.sql.includes("baseline_error = EXCLUDED.baseline_error"));
    const stored = String(errWrite?.params[4]);
    expect(stored).not.toContain("s3cr3t");
    expect(stored).toContain("postgres://***@db.internal");
  });

  it("does NOT throw when the resolver itself throws — records the (scrubbed) failure instead", async () => {
    // The default resolveLiveConnection throws on some OAuth/reconnect paths;
    // runBaselineProfile must stay total so ensureConnectionBaseline (awaited off
    // a briefing render) can't reject.
    let threw = false;
    await runBaselineProfile(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      {
        resolveConnection: async () => {
          throw new Error("token expired");
        },
      },
    ).catch(() => {
      threw = true;
    });
    expect(threw).toBe(false);
    const errWrite = dbCalls.find((c) => c.sql.includes("baseline_error = EXCLUDED.baseline_error"));
    expect(errWrite).toBeDefined();
    expect(String(errWrite?.params[4])).toContain("token expired");
  });

  it("is a no-op with no internal DB", async () => {
    mockHasDB = false;
    const { conn } = fakeConnection();
    let resolved = false;
    await runBaselineProfile(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      {
        resolveConnection: async () => {
          resolved = true;
          return okResolver(conn)();
        },
      },
    );
    expect(resolved).toBe(false);
    expect(dbCalls).toHaveLength(0);
  });
});

describe("ensureConnectionBaseline — lazy backfill", () => {
  it("does NOT re-profile a connection that already has a baseline", async () => {
    // First (and only) getConnectionProfileState read returns a baselined row.
    selectRows = [
      [
        {
          install_id: "cn",
          org_id: "org_1",
          connection_group_id: "g",
          db_type: "postgres",
          baseline_table_count: 2,
          baseline_profiled_at: "2026-07-01T00:00:00.000Z",
          baseline_error: null,
          llm_profiled_at: null,
          llm_profile_scope: null,
        },
      ],
    ];
    let resolved = false;
    const state = await ensureConnectionBaseline(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      {
        resolveConnection: async () => {
          resolved = true;
          return { kind: "not_found" };
        },
      },
    );
    expect(resolved).toBe(false); // no live-connection work
    expect(dbCalls.every((c) => !c.sql.includes("INSERT INTO"))).toBe(true);
    expect(state?.baseline?.tableCount).toBe(2);
  });

  it("profiles on first need when no baseline exists, then returns the fresh state", async () => {
    const { conn } = fakeConnection({ profiles: [{ table_name: "orders" }] });
    // 1st read: no baseline → run; 2nd read (post-run): the populated row.
    selectRows = [
      [],
      [
        {
          install_id: "cn",
          org_id: "org_1",
          connection_group_id: "g",
          db_type: "postgres",
          baseline_table_count: 1,
          baseline_profiled_at: "2026-07-11T00:00:00.000Z",
          baseline_error: null,
          llm_profiled_at: null,
          llm_profile_scope: null,
        },
      ],
    ];
    const state = await ensureConnectionBaseline(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      { resolveConnection: okResolver(conn), claimSlot: async () => true },
    );
    expect(dbCalls.some((c) => c.sql.includes("INSERT INTO connection_profile_state"))).toBe(true);
    expect(state?.baseline?.tableCount).toBe(1);
  });

  it("does NOT run a profile when the in-flight claim is lost (a peer attempt is already running)", async () => {
    // The atomic claim (migration 0174) is what stops the coverage view's 4s poll
    // from launching overlapping profiles: a lost claim means someone else holds a
    // fresh one, so this call returns the current state WITHOUT re-profiling.
    let resolved = false;
    selectRows = [[]]; // 1st read: no baseline yet
    const state = await ensureConnectionBaseline(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      {
        resolveConnection: async () => {
          resolved = true;
          return { kind: "not_found" };
        },
        claimSlot: async () => false, // claim lost — another attempt in flight
      },
    );
    expect(resolved).toBe(false); // no live-connection work
    expect(dbCalls.every((c) => !c.sql.includes("INSERT INTO"))).toBe(true);
    expect(state).toBeNull(); // returns the (unbaselined) existing state
  });

  it("re-attempts when the last baseline only FAILED (error row, no success facts)", async () => {
    // An error-only row (baseline_error set, no baseline_profiled_at) is NOT a
    // successful baseline, so a fixed connection recovers on the next need.
    const { conn } = fakeConnection({ profiles: [{ table_name: "orders" }] });
    let resolved = false;
    selectRows = [
      [
        {
          install_id: "cn",
          org_id: "org_1",
          connection_group_id: "g",
          db_type: "postgres",
          baseline_table_count: null,
          baseline_profiled_at: null,
          baseline_error: "permission denied",
          llm_profiled_at: null,
          llm_profile_scope: null,
        },
      ],
      [], // post-run read (irrelevant to this assertion)
    ];
    await ensureConnectionBaseline(
      { orgId: "org_1", installId: "cn", dbType: "postgres" },
      {
        resolveConnection: async () => {
          resolved = true;
          return okResolver(conn)();
        },
        claimSlot: async () => true,
      },
    );
    expect(resolved).toBe(true); // retried
    expect(dbCalls.some((c) => c.sql.includes("INSERT INTO connection_profile_state"))).toBe(true);
  });
});
