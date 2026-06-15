/**
 * STRUCTURAL ENFORCEMENT (#3670 / ADR-0017 §Amendment(#3667)) — ONE profiler
 * home per datasource type.
 *
 * The recurrence guard for the parallel-profiler-homes problem this milestone
 * closed: profiling for a datasource type has exactly ONE implementation, reached
 * identically by MCP, the in-product wizard, and the CLI — the BUILT connection's
 * introspection (`createFromConfig(...).listObjects` / `.profile`), bound to the
 * creds that built it. A new datasource can't reintroduce a second home — a
 * `connection`-namespace profiler export, or a `packages/cli/lib/profilers/` copy
 * — without going red here.
 *
 * Companion to `universal-profiling-enforcement.test.ts`, which asserts the
 * POSITIVE: every connectable type IS profilable via the one resolver
 * (`resolveLiveConnection`). This file asserts the NEGATIVES: no parallel homes.
 *
 * The plugin set is DISCOVERED from the filesystem (every `plugins/*` whose
 * package.json carries the `datasource` keyword), NOT a hand-maintained array —
 * so a NEW datasource plugin is auto-enrolled in this guard instead of silently
 * skipping it. Instantiating each in adapter-only mode (`factory({})`) does not
 * load a driver, so no optional peer dep is needed. The native pg/mysql plugins
 * (which profile in-core and expose `connection.create`, not `createFromConfig`)
 * are partitioned out — their profiler home is the resolver's native branch.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";

/** Walk up from this test to the monorepo root (has both `plugins/` and `packages/`). */
function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "plugins")) && fs.existsSync(path.join(dir, "packages"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`repo root not found from ${import.meta.dir}`);
}

interface DiscoveredPlugin {
  readonly name: string;
  readonly connection: Record<string, unknown>;
}

/**
 * Discover every datasource plugin from the filesystem and instantiate it in
 * adapter-only mode. A plugin is a datasource iff its package.json `keywords`
 * include `"datasource"`; its factory export is the `*Plugin` callable that is
 * NOT a `build*` (the createPlugin-wrapped, config-validating entry point).
 */
async function discoverDatasourcePlugins(): Promise<DiscoveredPlugin[]> {
  const pluginsDir = path.join(repoRoot(), "plugins");
  const dirs = fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const discovered: DiscoveredPlugin[] = [];
  for (const name of dirs) {
    const pkgPath = path.join(pluginsDir, name, "package.json");
    const indexPath = path.join(pluginsDir, name, "src", "index.ts");
    if (!fs.existsSync(pkgPath) || !fs.existsSync(indexPath)) continue;
    const keywords = (JSON.parse(fs.readFileSync(pkgPath, "utf8")).keywords ?? []) as string[];
    if (!keywords.includes("datasource")) continue;

    const mod = (await import(indexPath)) as Record<string, unknown>;
    const factory = Object.entries(mod).find(
      ([exportName, value]) =>
        typeof value === "function" && exportName.endsWith("Plugin") && !exportName.startsWith("build"),
    );
    if (!factory) throw new Error(`datasource plugin "${name}" exposes no *Plugin factory export`);

    // Native pg/mysql plugins require a `url` at config time (no adapter-only
    // mode) — their profiler home is the resolver's native in-core branch, not
    // `createFromConfig`, so they're intentionally out of scope here. A throw on
    // adapter-only instantiation partitions them out. The floor assertion below
    // guarantees the six plugin-managed datasources still instantiate, so this
    // catch can't silently swallow a regression in one of THEM.
    let built: { connection?: Record<string, unknown> };
    try {
      built = (factory[1] as (c: unknown) => unknown)({}) as { connection?: Record<string, unknown> };
    } catch {
      continue;
    }
    if (!built.connection || typeof built.connection !== "object") {
      throw new Error(`datasource plugin "${name}" built object has no connection namespace`);
    }
    discovered.push({ name, connection: built.connection });
  }
  return discovered;
}

const ALL_DATASOURCE_PLUGINS = await discoverDatasourcePlugins();

// The plugin-managed profiler-home set: datasource plugins that build a
// connection via `createFromConfig` (the ClickHouse/Snowflake/BigQuery/DuckDB/
// Salesforce/ES path). Native pg/mysql plugins (`connection.create`, profiled
// in-core) are NOT a `createFromConfig` home and are partitioned out here.
const CREATE_FROM_CONFIG_PLUGINS = ALL_DATASOURCE_PLUGINS.filter(
  (p) => typeof p.connection.createFromConfig === "function",
);

describe("one profiler home per datasource type (#3670 enforcement)", () => {
  it("discovers the known datasource plugins (discovery can't silently degrade to a vacuous pass)", () => {
    const names = ALL_DATASOURCE_PLUGINS.map((p) => p.name);
    // Floor on the known set so a broken glob / rename doesn't make every
    // assertion below vacuous. New datasource plugins push this higher.
    for (const known of ["bigquery", "clickhouse", "duckdb", "elasticsearch", "salesforce", "snowflake"]) {
      expect(names).toContain(known);
    }
    expect(CREATE_FROM_CONFIG_PLUGINS.length).toBeGreaterThanOrEqual(6);
  });

  for (const { name, connection } of CREATE_FROM_CONFIG_PLUGINS) {
    it(`${name}: introspection rides the BUILT connection, not a connection-namespace export`, () => {
      // No SECOND home: the connection namespace must not re-export profiler
      // functions. Introspection is a capability of the built connection only.
      expect(connection.listObjects).toBeUndefined();
      expect(connection.profile).toBeUndefined();
      // The ONE home: createFromConfig builds the connection that carries the
      // bound listObjects/profile (asserted per-plugin in their built-connection
      // introspection tests, and end-to-end by universal-profiling-enforcement).
      expect(typeof connection.createFromConfig).toBe("function");
    });
  }

  it("the parallel CLI profiler home (packages/cli/lib/profilers/) is gone", () => {
    const dir = path.join(repoRoot(), "packages", "cli", "lib", "profilers");
    expect(fs.existsSync(dir)).toBe(false);
  });
});
