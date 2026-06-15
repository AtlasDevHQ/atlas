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
 * Imports the plugin factories directly (relative path, the same CLI → plugin
 * convention) — instantiating each in adapter-only mode does not load a driver,
 * so no optional peer dep is needed.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { clickhousePlugin } from "../../../../../../plugins/clickhouse/src/index";
import { snowflakePlugin } from "../../../../../../plugins/snowflake/src/index";
import { bigqueryPlugin } from "../../../../../../plugins/bigquery/src/index";
import { duckdbPlugin } from "../../../../../../plugins/duckdb/src/index";
import { salesforcePlugin } from "../../../../../../plugins/salesforce/src/index";
import { elasticsearchPlugin } from "../../../../../../plugins/elasticsearch/src/index";

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

// Every datasource plugin, instantiated in adapter-only mode (no static config).
const PLUGIN_FACTORIES: ReadonlyArray<readonly [string, () => { connection: Record<string, unknown> }]> = [
  ["clickhouse", () => clickhousePlugin({})],
  ["snowflake", () => snowflakePlugin({})],
  ["bigquery", () => bigqueryPlugin({})],
  ["duckdb", () => duckdbPlugin({})],
  ["salesforce", () => salesforcePlugin({})],
  ["elasticsearch", () => elasticsearchPlugin({})],
];

describe("one profiler home per datasource type (#3670 enforcement)", () => {
  for (const [name, make] of PLUGIN_FACTORIES) {
    it(`${name}: introspection rides the BUILT connection, not a connection-namespace export`, () => {
      const conn = make().connection;
      // No SECOND home: the connection namespace must not re-export profiler
      // functions. Introspection is a capability of the built connection only.
      expect(conn.listObjects).toBeUndefined();
      expect(conn.profile).toBeUndefined();
      // The ONE home: createFromConfig builds the connection that carries the
      // bound listObjects/profile (asserted per-plugin in their built-connection
      // introspection tests, and end-to-end by universal-profiling-enforcement).
      expect(typeof conn.createFromConfig).toBe("function");
    });
  }

  it("the parallel CLI profiler home (packages/cli/lib/profilers/) is gone", () => {
    const dir = path.join(repoRoot(), "packages", "cli", "lib", "profilers");
    expect(fs.existsSync(dir)).toBe(false);
  });
});
