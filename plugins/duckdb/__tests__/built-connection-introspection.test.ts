/**
 * #3667 — DuckDB introspection is a capability OF the built connection
 * (`createFromConfig(...).listObjects` / `.profile`), bound to the path/url that
 * built it, so the host's unified resolver (and the CLI) consume it WITHOUT a
 * second namespace seam. Pins that the built connection forwards a profilable
 * `duckdb://` url to the profiler — reconstructing one from a bare `path`.
 */

import { describe, test, expect, mock } from "bun:test";

const listSpy = mock(async (_o: unknown) => [] as unknown[]);
const profileSpy = mock(async (_o: unknown) => ({ profiles: [], errors: [] }));
const realProfiler = await import("../src/profiler");
mock.module("../src/profiler", () => ({
  ...realProfiler,
  listDuckDBObjects: listSpy,
  profileDuckDB: profileSpy,
}));

// Mock the native DuckDB connection so createFromConfig doesn't load the addon.
const realConn = await import("../src/connection");
mock.module("../src/connection", () => ({
  ...realConn,
  createDuckDBConnection: mock(() => ({
    query: mock(async () => ({ columns: [], rows: [] })),
    close: mock(async () => {}),
  })),
}));

const { duckdbPlugin } = await import("../src/index");

describe("built connection introspection forwards a profilable url (#3667)", () => {
  test("profile() forwards the configured duckdb:// url to profileDuckDB", async () => {
    profileSpy.mockClear();
    const plugin = duckdbPlugin({});
    const built = plugin.connection.createFromConfig!({ url: "duckdb://analytics.duckdb" }) as {
      profile: (o?: { selectedTables?: string[] }) => Promise<unknown>;
    };
    await built.profile({ selectedTables: ["events"] });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    const args = profileSpy.mock.calls[0][0] as { url?: string; selectedTables?: string[] };
    expect(args.url).toBe("duckdb://analytics.duckdb");
    expect(args.selectedTables).toEqual(["events"]);
  });

  test("listObjects() reconstructs a duckdb:// url from a bare path", async () => {
    listSpy.mockClear();
    const plugin = duckdbPlugin({});
    const built = plugin.connection.createFromConfig!({ path: "/tmp/a.duckdb" }) as {
      listObjects: (o?: { schema?: string }) => Promise<unknown>;
    };
    await built.listObjects();
    expect(listSpy).toHaveBeenCalledTimes(1);
    const args = listSpy.mock.calls[0][0] as { url?: string };
    expect(args.url).toBe("duckdb:///tmp/a.duckdb");
  });
});
