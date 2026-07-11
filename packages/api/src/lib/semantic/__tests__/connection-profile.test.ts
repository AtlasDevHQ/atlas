/**
 * Connection profile-tier store (#4509).
 *
 * Pins the SQL contract of the baseline + LLM-profile upserts and the row→shape
 * reads (so both tiers converge on ONE (org, install_id) row and freshness is
 * readable), plus the pure `describeProfileFreshness` helper that feeds the
 * briefing's "profiled N days ago" marker. Mocks `db/internal` so no live DB is
 * needed — the repo's `internalQuery`-spy pattern (see `profile-status.test.ts`).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { TableProfile } from "@useatlas/types";

let mockHasDB = true;
const dbCalls: Array<{ sql: string; params: unknown[] }> = [];
let nextRows: Record<string, unknown>[] = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: async (sql: string, params: unknown[]) => {
    dbCalls.push({ sql, params });
    return nextRows;
  },
  internalExecute: () => {},
  getInternalDB: () => ({}),
}));

const {
  upsertBaselineProfile,
  recordBaselineError,
  recordLlmProfileRun,
  getConnectionProfileState,
  getBaselineProfiles,
  listConnectionProfileStates,
  describeProfileFreshness,
} = await import("../connection-profile");

function fakeProfile(name: string): TableProfile {
  return {
    table_name: name,
    object_type: "table",
    row_count: 1,
    columns: [],
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: {},
  } as unknown as TableProfile;
}

beforeEach(() => {
  mockHasDB = true;
  dbCalls.length = 0;
  nextRows = [];
});

describe("upsertBaselineProfile", () => {
  it("writes the baseline tier keyed on the COALESCE sentinel, stamping now() and clearing the error", async () => {
    await upsertBaselineProfile({
      orgId: "org_1",
      installId: "cn_prod",
      connectionGroupId: "g_prod",
      dbType: "postgres",
      profiles: [fakeProfile("orders"), fakeProfile("customers")],
    });

    expect(dbCalls).toHaveLength(1);
    const { sql, params } = dbCalls[0];
    expect(sql).toContain("INSERT INTO connection_profile_state");
    // Natural key = the same expression the raw-SQL unique index in 0171 uses.
    expect(sql).toContain("ON CONFLICT (COALESCE(org_id, '__self_hosted__'), install_id)");
    expect(sql).toContain("baseline_profiled_at = now()");
    expect(sql).toContain("baseline_error = NULL");
    // Touches ONLY the baseline tier on conflict (leaves the LLM tier alone).
    expect(sql).not.toContain("llm_profiled_at");
    expect(params[0]).toBe("org_1");
    expect(params[1]).toBe("cn_prod");
    expect(params[2]).toBe("g_prod");
    expect(params[3]).toBe("postgres");
    expect(JSON.parse(params[4] as string)).toHaveLength(2);
    expect(params[5]).toBe(2); // denormalised table count
  });

  it("normalizes an empty-string group to null", async () => {
    await upsertBaselineProfile({
      orgId: "org_1",
      installId: "cn",
      connectionGroupId: "",
      dbType: "mysql",
      profiles: [],
    });
    expect(dbCalls[0].params[2]).toBeNull();
  });

  it("throws when no internal DB is configured", async () => {
    mockHasDB = false;
    await expect(
      upsertBaselineProfile({ orgId: "o", installId: "c", dbType: "postgres", profiles: [] }),
    ).rejects.toThrow(/Internal DB required/);
  });
});

describe("recordBaselineError", () => {
  it("records the visible failure reason without touching baseline_profiled_at or the payload", async () => {
    await recordBaselineError({
      orgId: "org_1",
      installId: "cn",
      dbType: "postgres",
      error: "permission denied for schema public",
    });
    const { sql, params } = dbCalls[0];
    expect(sql).toContain("baseline_error = EXCLUDED.baseline_error");
    expect(sql).not.toContain("baseline_profiled_at");
    expect(sql).not.toContain("baseline_profiles");
    expect(params[4]).toBe("permission denied for schema public");
  });
});

describe("recordLlmProfileRun", () => {
  it("stamps llm_profiled_at now() + scope, touching ONLY the LLM tier", async () => {
    await recordLlmProfileRun({
      orgId: "org_1",
      installId: "cn",
      connectionGroupId: "g",
      scope: { tables: ["orders"] },
    });
    const { sql, params } = dbCalls[0];
    expect(sql).toContain("INSERT INTO connection_profile_state");
    expect(sql).toContain("llm_profiled_at = now()");
    expect(sql).toContain("ON CONFLICT (COALESCE(org_id, '__self_hosted__'), install_id)");
    // The LLM run must PRESERVE (not clobber) a baseline-established group when
    // the caller threads none — the COALESCE keeps a null EXCLUDED from nulling it.
    expect(sql).toContain("COALESCE(EXCLUDED.connection_group_id, connection_profile_state.connection_group_id)");
    // The LLM tier upsert must not clobber the baseline tier.
    expect(sql).not.toContain("baseline_profiled_at");
    expect(JSON.parse(params[3] as string)).toEqual({ tables: ["orders"] });
  });

  it("is a no-op (no DB call) when no internal DB is configured", async () => {
    mockHasDB = false;
    await recordLlmProfileRun({ orgId: "o", installId: "c", scope: { tables: [] } });
    expect(dbCalls).toHaveLength(0);
  });
});

describe("getConnectionProfileState", () => {
  it("maps a row with both tiers, ISO-normalising the timestamps", async () => {
    nextRows = [
      {
        install_id: "cn",
        org_id: "org_1",
        connection_group_id: "g",
        db_type: "postgres",
        baseline_table_count: 3,
        baseline_profiled_at: new Date("2026-07-01T00:00:00.000Z"),
        baseline_error: null,
        llm_profiled_at: new Date("2026-07-05T00:00:00.000Z"),
        llm_profile_scope: { tables: ["orders", "customers"] },
      },
    ];
    const state = await getConnectionProfileState("org_1", "cn");
    expect(state).toEqual({
      installId: "cn",
      orgId: "org_1",
      connectionGroupId: "g",
      dbType: "postgres",
      baseline: { profiledAt: "2026-07-01T00:00:00.000Z", tableCount: 3 },
      baselineError: null,
      llm: { profiledAt: "2026-07-05T00:00:00.000Z", scope: { tables: ["orders", "customers"] } },
    });
    // Sentinel-keyed read so a legacy NULL-owner row resolves.
    expect(dbCalls[0].sql).toContain("COALESCE(org_id, '__self_hosted__')");
  });

  it("returns null baseline/llm tiers for a never-profiled row", async () => {
    nextRows = [
      {
        install_id: "cn",
        org_id: null,
        connection_group_id: null,
        db_type: null,
        baseline_table_count: null,
        baseline_profiled_at: null,
        baseline_error: null,
        llm_profiled_at: null,
        llm_profile_scope: null,
      },
    ];
    const state = await getConnectionProfileState(null, "cn");
    expect(state?.baseline).toBeNull();
    expect(state?.baselineError).toBeNull();
    expect(state?.llm).toBeNull();
  });

  it("surfaces a first-ever baseline failure (error set, no successful profile) — not 'never profiled'", async () => {
    // recordBaselineError writes baseline_error WITHOUT stamping
    // baseline_profiled_at, so the failure must be visible at the top level even
    // though `baseline` (success facts) is null.
    nextRows = [
      {
        install_id: "cn",
        org_id: "org_1",
        connection_group_id: "g",
        db_type: "postgres",
        baseline_table_count: null,
        baseline_profiled_at: null,
        baseline_error: "permission denied for schema public",
        llm_profiled_at: null,
        llm_profile_scope: null,
      },
    ];
    const state = await getConnectionProfileState("org_1", "cn");
    expect(state?.baseline).toBeNull();
    expect(state?.baselineError).toBe("permission denied for schema public");
  });

  it("returns null when no row exists", async () => {
    nextRows = [];
    expect(await getConnectionProfileState("org_1", "missing")).toBeNull();
  });

  it("tolerates a malformed llm scope (returns scope=null, keeps freshness)", async () => {
    nextRows = [
      {
        install_id: "cn",
        org_id: "org_1",
        connection_group_id: null,
        db_type: "postgres",
        baseline_table_count: 0,
        baseline_profiled_at: null,
        baseline_error: null,
        llm_profiled_at: "2026-07-05T00:00:00.000Z",
        llm_profile_scope: "junk",
      },
    ];
    const state = await getConnectionProfileState("org_1", "cn");
    expect(state?.llm).toEqual({ profiledAt: "2026-07-05T00:00:00.000Z", scope: null });
  });

  it("returns null when no internal DB is configured", async () => {
    mockHasDB = false;
    expect(await getConnectionProfileState("org_1", "cn")).toBeNull();
    expect(dbCalls).toHaveLength(0);
  });
});

describe("getBaselineProfiles", () => {
  it("returns the stored TableProfile[] payload — the coverage view's data source", async () => {
    nextRows = [{ baseline_profiles: [fakeProfile("orders")] }];
    const profiles = await getBaselineProfiles("org_1", "cn");
    expect(profiles).toHaveLength(1);
    expect(profiles?.[0].table_name).toBe("orders");
  });

  it("returns null for an unprofiled / malformed payload", async () => {
    nextRows = [{ baseline_profiles: null }];
    expect(await getBaselineProfiles("org_1", "cn")).toBeNull();
  });
});

describe("listConnectionProfileStates", () => {
  it("scopes to the workspace and maps every row", async () => {
    nextRows = [
      {
        install_id: "a",
        org_id: "org_1",
        connection_group_id: null,
        db_type: "postgres",
        baseline_table_count: 1,
        baseline_profiled_at: "2026-07-01T00:00:00.000Z",
        baseline_error: null,
        llm_profiled_at: null,
        llm_profile_scope: null,
      },
    ];
    const states = await listConnectionProfileStates("org_1");
    expect(states).toHaveLength(1);
    expect(dbCalls[0].sql).toContain("COALESCE(org_id, '__self_hosted__')");
    expect(dbCalls[0].params[0]).toBe("org_1");
  });

  it("returns [] with no internal DB", async () => {
    mockHasDB = false;
    expect(await listConnectionProfileStates("org_1")).toEqual([]);
  });
});

describe("describeProfileFreshness", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");

  it("labels a profile from today", () => {
    expect(describeProfileFreshness("2026-07-11T01:00:00.000Z", now)).toEqual({
      days: 0,
      label: "profiled today",
    });
  });

  it("labels one day ago in the singular", () => {
    expect(describeProfileFreshness("2026-07-10T01:00:00.000Z", now)).toEqual({
      days: 1,
      label: "profiled 1 day ago",
    });
  });

  it("labels N days ago", () => {
    expect(describeProfileFreshness("2026-07-01T12:00:00.000Z", now)).toEqual({
      days: 10,
      label: "profiled 10 days ago",
    });
  });

  it("clamps a future timestamp to today (never negative)", () => {
    expect(describeProfileFreshness("2026-07-20T00:00:00.000Z", now)?.days).toBe(0);
  });

  it("returns null for an absent or malformed timestamp", () => {
    expect(describeProfileFreshness(null, now)).toBeNull();
    expect(describeProfileFreshness("not-a-date", now)).toBeNull();
  });
});
