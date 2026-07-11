import { describe, test, expect } from "bun:test";
import {
  CORE_DIALECT_SPECIALISTS,
  CORE_DIALECT_SPECIALIST_DBTYPES,
  composeDialectSpecialists,
  dialectDisplayName,
  resolveDialectSpecialist,
  type PluginDialectModule,
} from "@atlas/api/lib/dialect-specialist";

// #4515 — the dialect-specialist registry: engine-specific SQL expertise as
// composable prompt modules keyed by dbType, shaped like the answer-styles
// registry. Core ships Postgres/MySQL/ClickHouse; plugins ship a module by
// dbType with no core change; unknown engines compose cleanly as nothing.

describe("dialectDisplayName", () => {
  test("known engines use their canonical spelling", () => {
    expect(dialectDisplayName("postgres")).toBe("PostgreSQL");
    expect(dialectDisplayName("mysql")).toBe("MySQL");
    expect(dialectDisplayName("clickhouse")).toBe("ClickHouse");
  });

  test("unknown engine falls back to a capitalized name", () => {
    expect(dialectDisplayName("sparksql")).toBe("Sparksql");
  });
});

describe("CORE_DIALECT_SPECIALISTS", () => {
  test("ships the initial Postgres / MySQL / ClickHouse modules", () => {
    expect(CORE_DIALECT_SPECIALIST_DBTYPES).toEqual([
      "postgres",
      "mysql",
      "clickhouse",
    ]);
    for (const dbType of CORE_DIALECT_SPECIALIST_DBTYPES) {
      expect(CORE_DIALECT_SPECIALISTS[dbType]?.trim().length).toBeGreaterThan(0);
    }
  });

  test("MySQL module keeps its sargability-aware guidance (no '(preferred)', half-open ranges, projection carve-out)", () => {
    const mysql = CORE_DIALECT_SPECIALISTS.mysql;
    expect(mysql).not.toContain("(preferred)");
    expect(mysql).toContain("col >= '2024-01-01' AND col < '2025-01-01'");
    expect(mysql).toContain("DATE_FORMAT");
    expect(mysql).toMatch(/projecting or grouping/i);
  });

  test("ClickHouse module carries engine-specific coaching", () => {
    const ch = CORE_DIALECT_SPECIALISTS.clickhouse;
    expect(ch).toContain("toStartOfMonth");
    expect(ch).toContain("countIf");
  });

  test("module bodies carry no heading — compose generates it", () => {
    for (const dbType of CORE_DIALECT_SPECIALIST_DBTYPES) {
      expect(CORE_DIALECT_SPECIALISTS[dbType]).not.toContain("## SQL Dialect:");
    }
  });
});

describe("resolveDialectSpecialist", () => {
  test("resolves the core module for a known dbType", () => {
    const resolved = resolveDialectSpecialist("clickhouse");
    expect(resolved?.source).toBe("core");
    expect(resolved?.dbType).toBe("clickhouse");
    expect(resolved?.module).toBe(CORE_DIALECT_SPECIALISTS.clickhouse);
  });

  test("unknown dbType resolves to undefined (composes as no module)", () => {
    expect(resolveDialectSpecialist("sparksql")).toBeUndefined();
  });

  test("a plugin can ship a module for a new dbType without a core change", () => {
    const plugins: PluginDialectModule[] = [
      { dbType: "sparksql", module: "Use Spark SQL date_trunc semantics." },
    ];
    const resolved = resolveDialectSpecialist("sparksql", plugins);
    expect(resolved?.source).toBe("plugin");
    expect(resolved?.module).toContain("Spark SQL");
  });

  test("a plugin module wins over the core module for the same dbType", () => {
    const plugins: PluginDialectModule[] = [
      { dbType: "clickhouse", module: "Plugin-shipped ClickHouse guidance." },
    ];
    const resolved = resolveDialectSpecialist("clickhouse", plugins);
    expect(resolved?.source).toBe("plugin");
    expect(resolved?.module).toBe("Plugin-shipped ClickHouse guidance.");
  });

  test("a blank plugin module does not shadow the core module", () => {
    const plugins: PluginDialectModule[] = [{ dbType: "mysql", module: "   " }];
    const resolved = resolveDialectSpecialist("mysql", plugins);
    expect(resolved?.source).toBe("core");
  });
});

describe("composeDialectSpecialists", () => {
  test("empty groups compose to an empty string", () => {
    expect(composeDialectSpecialists([])).toBe("");
  });

  test("single group renders a heading-prefixed module, no group attribution", () => {
    const out = composeDialectSpecialists([{ group: "default", dbType: "mysql" }]);
    expect(out).toContain("## SQL Dialect: MySQL");
    expect(out).toContain(CORE_DIALECT_SPECIALISTS.mysql);
    // Single group ⇒ no "— group" attribution suffix.
    expect(out).not.toContain("— group");
  });

  test("a group on an unknown engine composes cleanly as no module", () => {
    expect(composeDialectSpecialists([{ group: "g1", dbType: "sparksql" }])).toBe("");
  });

  test("cross-group sweep composes several modules, each attributed to its group", () => {
    const out = composeDialectSpecialists([
      { group: "us-prod", dbType: "postgres" },
      { group: "eu-analytics", dbType: "clickhouse" },
    ]);
    expect(out).toContain("## SQL Dialect: PostgreSQL — group `us-prod`");
    expect(out).toContain("## SQL Dialect: ClickHouse — group `eu-analytics`");
  });

  test("two groups sharing an engine fold to one module attributed to both", () => {
    const out = composeDialectSpecialists([
      { group: "a", dbType: "postgres" },
      { group: "b", dbType: "postgres" },
    ]);
    // Module appears once, attributed to both groups.
    expect(out.match(/## SQL Dialect: PostgreSQL/g)?.length).toBe(1);
    expect(out).toContain("## SQL Dialect: PostgreSQL — groups `a`, `b`");
  });

  test("mixed known + unknown engines: known composes, unknown is skipped", () => {
    const out = composeDialectSpecialists([
      { group: "warehouse", dbType: "mysql" },
      { group: "lake", dbType: "sparksql" },
    ]);
    expect(out).toContain("## SQL Dialect: MySQL — group `warehouse`");
    expect(out).not.toContain("sparksql");
    expect(out).not.toContain("Sparksql");
  });

  test("plugin module composes for its engine under a cross-group sweep", () => {
    const plugins: PluginDialectModule[] = [
      { dbType: "bigquery", module: "Use SAFE_DIVIDE for BigQuery division." },
    ];
    const out = composeDialectSpecialists(
      [
        { group: "warehouse", dbType: "postgres" },
        { group: "bq", dbType: "bigquery" },
      ],
      plugins,
    );
    expect(out).toContain("## SQL Dialect: BigQuery — group `bq`");
    expect(out).toContain("Use SAFE_DIVIDE for BigQuery division.");
  });
});
