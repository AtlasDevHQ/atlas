import { describe, expect, test } from "bun:test";
import type { TableProfile, ColumnProfile } from "../atlas";
import {
  inferForeignKeys,
  detectAbandonedTables,
  detectEnumInconsistency,
  detectDenormalizedTables,
  analyzeTableProfiles,
  pluralize,
  singularize,
} from "../atlas";

// --- Helpers for building synthetic profiles ---

function makeColumn(overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    name: "col",
    type: "text",
    nullable: false,
    unique_count: null,
    null_count: null,
    sample_values: [],
    is_primary_key: false,
    is_foreign_key: false,
    fk_target_table: null,
    fk_target_column: null,
    is_enum_like: false,
    profiler_notes: [],
    ...overrides,
  };
}

function makeProfile(overrides: Partial<TableProfile> = {}): TableProfile {
  return {
    table_name: "test_table",
    object_type: "table" as const,
    row_count: 100,
    columns: [makeColumn({ name: "id", is_primary_key: true })],
    primary_key_columns: ["id"],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    ...overrides,
  };
}

// --- pluralize() ---

describe("pluralize", () => {
  test("regular plurals", () => {
    expect(pluralize("scan")).toBe("scans");
    expect(pluralize("asset")).toBe("assets");
    expect(pluralize("vulnerability")).toBe("vulnerabilities");
    expect(pluralize("index")).toBe("indexes");
  });

  test("irregular plurals", () => {
    expect(pluralize("person")).toBe("people");
    expect(pluralize("child")).toBe("children");
  });
});

// --- singularize() ---

describe("singularize", () => {
  test("-ies to -y", () => {
    expect(singularize("vulnerabilities")).toBe("vulnerability");
    expect(singularize("companies")).toBe("company");
  });

  test("-ses/-xes/-zes removal", () => {
    expect(singularize("indexes")).toBe("index");
    expect(singularize("processes")).toBe("process");
    expect(singularize("boxes")).toBe("box");
  });

  test("regular -s removal", () => {
    expect(singularize("agents")).toBe("agent");
    expect(singularize("scans")).toBe("scan");
  });

  test("no-op for words ending in -us/-is/-ss", () => {
    expect(singularize("status")).toBe("status");
    expect(singularize("analysis")).toBe("analysis");
    expect(singularize("address")).toBe("address");
  });

  test("irregular plurals from the map", () => {
    expect(singularize("people")).toBe("person");
    expect(singularize("children")).toBe("child");
    expect(singularize("data")).toBe("datum");
  });
});

// --- inferForeignKeys ---

describe("inferForeignKeys", () => {
  test("infers FK from *_id column matching a table name", () => {
    const assets = makeProfile({
      table_name: "assets",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const scanResults = makeProfile({
      table_name: "scan_results",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "asset_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
      foreign_keys: [],
    });

    const profiles = [assets, scanResults];

    inferForeignKeys(profiles);

    expect(scanResults.inferred_foreign_keys).toHaveLength(1);
    expect(scanResults.inferred_foreign_keys[0]).toEqual({
      from_column: "asset_id",
      to_table: "assets",
      to_column: "id",
      source: "inferred",
    });
  });

  test("skips columns that already have constraint FKs", () => {
    const orgs = makeProfile({
      table_name: "organizations",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const users = makeProfile({
      table_name: "users",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "organization_id", type: "integer", is_foreign_key: true }),
      ],
      primary_key_columns: ["id"],
      foreign_keys: [
        { from_column: "organization_id", to_table: "organizations", to_column: "id", source: "constraint" },
      ],
    });

    const profiles = [orgs, users];

    inferForeignKeys(profiles);

    expect(users.inferred_foreign_keys).toHaveLength(0);
  });

  test("does not use views as FK targets", () => {
    const viewProfile = makeProfile({
      table_name: "assets",
      object_type: "view",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const scanResults = makeProfile({
      table_name: "scan_results",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "asset_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
      foreign_keys: [],
    });

    const profiles = [viewProfile, scanResults];

    inferForeignKeys(profiles);

    // Views are excluded as FK targets, so no inference should happen
    expect(scanResults.inferred_foreign_keys).toHaveLength(0);
  });

  test("does not infer when target table does not exist", () => {
    const scanResults = makeProfile({
      table_name: "scan_results",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "nonexistent_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });

    const profiles = [scanResults];

    inferForeignKeys(profiles);

    expect(scanResults.inferred_foreign_keys).toHaveLength(0);
  });

  test("does not infer when target table has no PK named 'id'", () => {
    const configs = makeProfile({
      table_name: "configs",
      columns: [makeColumn({ name: "config_key", is_primary_key: true })],
      primary_key_columns: ["config_key"],
    });
    const settings = makeProfile({
      table_name: "settings",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "config_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });

    const profiles = [configs, settings];

    inferForeignKeys(profiles);

    // "config" doesn't match "configs" directly but singularize("configs") = "config"
    // However configs has PK "config_key" not "id", so no inference
    expect(settings.inferred_foreign_keys).toHaveLength(0);
  });

  test("matches plural table name from singular prefix", () => {
    const scans = makeProfile({
      table_name: "scans",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const results = makeProfile({
      table_name: "scan_results",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "scan_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });

    const profiles = [scans, results];

    inferForeignKeys(profiles);

    expect(results.inferred_foreign_keys).toHaveLength(1);
    expect(results.inferred_foreign_keys[0].to_table).toBe("scans");
  });

  test("adds column-level profiler_notes", () => {
    const agents = makeProfile({
      table_name: "agents",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const heartbeats = makeProfile({
      table_name: "agent_heartbeats",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "agent_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });

    const profiles = [agents, heartbeats];

    inferForeignKeys(profiles);

    const agentIdCol = heartbeats.columns.find((c) => c.name === "agent_id")!;
    expect(agentIdCol.profiler_notes).toHaveLength(1);
    expect(agentIdCol.profiler_notes[0]).toContain("Likely FK to agents.id");
  });

  test("does not infer for PK columns ending in _id", () => {
    const items = makeProfile({
      table_name: "items",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const itemLinks = makeProfile({
      table_name: "item_links",
      columns: [
        makeColumn({ name: "item_id", is_primary_key: true }),
      ],
      primary_key_columns: ["item_id"],
    });

    const profiles = [items, itemLinks];

    inferForeignKeys(profiles);

    expect(itemLinks.inferred_foreign_keys).toHaveLength(0);
  });

  test("skips non-matching prefix like org_id when no 'org' table exists", () => {
    const organizations = makeProfile({
      table_name: "organizations",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const legacy = makeProfile({
      table_name: "legacy_risk_scores",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "org_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });

    const profiles = [organizations, legacy];

    inferForeignKeys(profiles);

    // "org" doesn't match "organizations" — pluralize("org") = "orgs", singularize("org") = "org"
    expect(legacy.inferred_foreign_keys).toHaveLength(0);
  });

  test("skips user_ref_id when no 'user_ref' table exists", () => {
    const users = makeProfile({
      table_name: "users",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const archive = makeProfile({
      table_name: "user_sessions_archive",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "user_ref_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });

    const profiles = [users, archive];

    inferForeignKeys(profiles);

    // "user_ref" doesn't match "users"
    expect(archive.inferred_foreign_keys).toHaveLength(0);
  });
});

// --- detectAbandonedTables ---

describe("detectAbandonedTables", () => {
  test("flags tables matching legacy/temp name patterns", () => {
    const patterns = [
      "old_scan_results_v2",
      "temp_asset_import_2024",
      "legacy_risk_scores",
      "feature_flags_legacy",
      "notifications_backup",
      "user_sessions_archive",
    ];

    for (const name of patterns) {
      const profile = makeProfile({ table_name: name });
      const profiles = [profile];
  
      detectAbandonedTables(profiles);
      expect(profile.table_flags.possibly_abandoned).toBe(true);
    }
  });

  test("does not flag normal table names", () => {
    const normal = ["users", "scan_results", "organizations", "invoices"];

    for (const name of normal) {
      const profile = makeProfile({ table_name: name });
      const profiles = [profile];

      detectAbandonedTables(profiles);
      expect(profile.table_flags.possibly_abandoned).toBe(false);
    }
  });

  test("skips views even with abandoned-looking names", () => {
    const profile = makeProfile({
      table_name: "legacy_risk_scores",
      object_type: "view",
    });
    const profiles = [profile];

    detectAbandonedTables(profiles);

    expect(profile.table_flags.possibly_abandoned).toBe(false);
  });

  test("does not flag if table has inbound FKs", () => {
    const legacy = makeProfile({ table_name: "legacy_risk_scores" });
    const other = makeProfile({
      table_name: "other",
      foreign_keys: [
        { from_column: "score_id", to_table: "legacy_risk_scores", to_column: "id", source: "constraint" },
      ],
    });

    const profiles = [legacy, other];

    detectAbandonedTables(profiles);

    expect(legacy.table_flags.possibly_abandoned).toBe(false);
  });

  test("does not flag if table has inbound inferred FKs", () => {
    const legacy = makeProfile({ table_name: "legacy_risk_scores" });
    const other = makeProfile({
      table_name: "other",
      inferred_foreign_keys: [
        { from_column: "legacy_risk_score_id", to_table: "legacy_risk_scores", to_column: "id", source: "inferred" },
      ],
    });

    const profiles = [legacy, other];

    detectAbandonedTables(profiles);

    expect(legacy.table_flags.possibly_abandoned).toBe(false);
  });

  test("adds table-level profiler note", () => {
    const profile = makeProfile({ table_name: "old_scan_results_v2" });
    const profiles = [profile];

    detectAbandonedTables(profiles);

    expect(profile.profiler_notes.length).toBeGreaterThan(0);
    expect(profile.profiler_notes[0]).toContain("Possibly abandoned");
  });
});

// --- detectEnumInconsistency ---

describe("detectEnumInconsistency", () => {
  test("detects case-inconsistent enum values", () => {
    const profile = makeProfile({
      table_name: "organizations",
      columns: [
        makeColumn({
          name: "industry",
          is_enum_like: true,
          sample_values: ["Technology", "tech", "Tech", "TECHNOLOGY", "Healthcare", "healthcare"],
        }),
      ],
    });

    const profiles = [profile];

    detectEnumInconsistency(profiles);

    const col = profile.columns[0];
    expect(col.profiler_notes.length).toBeGreaterThan(0);
    expect(col.profiler_notes[0]).toContain("Case-inconsistent");
  });

  test("skips clean enum columns", () => {
    const profile = makeProfile({
      table_name: "roles",
      columns: [
        makeColumn({
          name: "role_name",
          is_enum_like: true,
          sample_values: ["admin", "analyst", "viewer"],
        }),
      ],
    });

    const profiles = [profile];

    detectEnumInconsistency(profiles);

    const col = profile.columns[0];
    expect(col.profiler_notes.filter((n) => n.startsWith("Case-inconsistent"))).toHaveLength(0);
  });

  test("only checks enum-like columns", () => {
    const profile = makeProfile({
      table_name: "test",
      columns: [
        makeColumn({
          name: "regular_col",
          is_enum_like: false,
          sample_values: ["Foo", "foo", "FOO"],
        }),
      ],
    });

    const profiles = [profile];

    detectEnumInconsistency(profiles);

    const col = profile.columns[0];
    expect(col.profiler_notes.filter((n) => n.startsWith("Case-inconsistent"))).toHaveLength(0);
  });

  test("includes conflicting values in the note", () => {
    const profile = makeProfile({
      table_name: "findings",
      columns: [
        makeColumn({
          name: "status",
          is_enum_like: true,
          sample_values: ["pass", "Pass", "PASS", "fail"],
        }),
      ],
    });

    const profiles = [profile];

    detectEnumInconsistency(profiles);

    const col = profile.columns[0];
    const note = col.profiler_notes.find((n) => n.startsWith("Case-inconsistent"))!;
    expect(note).toContain("pass");
    expect(note).toContain("Pass");
    expect(note).toContain("PASS");
  });
});

// --- detectDenormalizedTables ---

describe("detectDenormalizedTables", () => {
  test("flags tables matching denormalized name patterns", () => {
    const patterns = [
      "scan_results_denormalized",
      "executive_dashboard_cache",
      "monthly_vulnerability_summary",
      "daily_scan_stats",
    ];

    for (const name of patterns) {
      const profile = makeProfile({ table_name: name });
      const profiles = [profile];
  
      detectDenormalizedTables(profiles);
      expect(profile.table_flags.possibly_denormalized).toBe(true);
    }
  });

  test("does not flag normal table names", () => {
    const normal = ["scan_results", "dashboards", "vulnerabilities"];

    for (const name of normal) {
      const profile = makeProfile({ table_name: name });
      const profiles = [profile];

      detectDenormalizedTables(profiles);
      expect(profile.table_flags.possibly_denormalized).toBe(false);
    }
  });

  test("skips views even with denormalized-looking names", () => {
    const profile = makeProfile({
      table_name: "daily_scan_stats",
      object_type: "view",
    });
    const profiles = [profile];

    detectDenormalizedTables(profiles);

    expect(profile.table_flags.possibly_denormalized).toBe(false);
  });

  test("sets table flag and adds profiler note", () => {
    const profile = makeProfile({ table_name: "daily_scan_stats" });
    const profiles = [profile];

    detectDenormalizedTables(profiles);

    expect(profile.table_flags.possibly_denormalized).toBe(true);
    expect(profile.profiler_notes.length).toBeGreaterThan(0);
    expect(profile.profiler_notes[0]).toContain("denormalized");
  });

  test("matches _rollup suffix", () => {
    const profile = makeProfile({ table_name: "weekly_scan_rollup" });
    const profiles = [profile];

    detectDenormalizedTables(profiles);
    expect(profile.table_flags.possibly_denormalized).toBe(true);
  });
});

// --- analyzeTableProfiles (orchestrator) ---

describe("analyzeTableProfiles", () => {
  test("initializes all profiles and runs all detectors", () => {
    const agents = makeProfile({
      table_name: "agents",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });
    const heartbeats = makeProfile({
      table_name: "agent_heartbeats",
      columns: [
        makeColumn({ name: "id", is_primary_key: true }),
        makeColumn({ name: "agent_id", type: "integer" }),
      ],
      primary_key_columns: ["id"],
    });
    const legacy = makeProfile({
      table_name: "old_scan_results_v2",
      columns: [makeColumn({ name: "id", is_primary_key: true })],
      primary_key_columns: ["id"],
    });

    analyzeTableProfiles([agents, heartbeats, legacy]);

    // FK inference worked
    expect(heartbeats.inferred_foreign_keys).toHaveLength(1);
    // Abandoned detection worked
    expect(legacy.table_flags.possibly_abandoned).toBe(true);
    // Arrays initialized
    expect(agents.profiler_notes).toEqual([]);
    expect(agents.table_flags).toBeDefined();
  });
});
