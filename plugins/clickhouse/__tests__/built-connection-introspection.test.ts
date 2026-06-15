/**
 * #3667 — ClickHouse introspection is a capability OF the built connection
 * (`createFromConfig(...).listObjects` / `.profile`), bound to the `clickhouse://`
 * creds that built it, so the host's unified resolver (and the CLI) consume it
 * WITHOUT a second namespace seam. Pins that the built connection forwards its
 * url to the profiler and applies the config `database` as the default schema
 * scope when the caller passes none.
 */

import { describe, test, expect, mock } from "bun:test";

const listSpy = mock(async (_o: unknown) => [] as unknown[]);
const profileSpy = mock(async (_o: unknown) => ({ profiles: [], errors: [] }));
const realProfiler = await import("../src/profiler");
mock.module("../src/profiler", () => ({
  ...realProfiler,
  listClickHouseObjects: listSpy,
  profileClickHouse: profileSpy,
}));

// Mock the HTTP-transport connection so createFromConfig doesn't open a client;
// keep the rest of the connection module (extractHost / rewriteClickHouseUrl) real.
const realConn = await import("../src/connection");
mock.module("../src/connection", () => ({
  ...realConn,
  createClickHouseConnection: mock(() => ({
    query: mock(async () => ({ columns: [], rows: [] })),
    close: mock(async () => {}),
  })),
}));

const { clickhousePlugin } = await import("../src/index");

const CH_URL = "clickhouse://localhost:8123/analytics";

describe("built connection introspection forwards a profilable url (#3667)", () => {
  test("profile() forwards the configured clickhouse:// url to profileClickHouse", async () => {
    profileSpy.mockClear();
    const plugin = clickhousePlugin({});
    const built = plugin.connection.createFromConfig!({ url: CH_URL, database: "analytics" }) as {
      profile: (o?: { selectedTables?: string[] }) => Promise<unknown>;
    };
    await built.profile({ selectedTables: ["events"] });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    const args = profileSpy.mock.calls[0][0] as { url?: string; schema?: string; selectedTables?: string[] };
    expect(args.url).toBe(CH_URL);
    expect(args.selectedTables).toEqual(["events"]);
    // No `schema` in the options → defaults to the config `database` scope.
    expect(args.schema).toBe("analytics");
  });

  test("listObjects() forwards the url and defaults schema to the config database", async () => {
    listSpy.mockClear();
    const plugin = clickhousePlugin({});
    const built = plugin.connection.createFromConfig!({ url: CH_URL, database: "analytics" }) as {
      listObjects: (o?: { schema?: string }) => Promise<unknown>;
    };
    await built.listObjects();
    expect(listSpy).toHaveBeenCalledTimes(1);
    const args = listSpy.mock.calls[0][0] as { url?: string; schema?: string };
    expect(args.url).toBe(CH_URL);
    expect(args.schema).toBe("analytics");
  });

  test("an explicit schema option overrides the config database default", async () => {
    profileSpy.mockClear();
    const plugin = clickhousePlugin({});
    const built = plugin.connection.createFromConfig!({ url: CH_URL, database: "analytics" }) as {
      profile: (o?: { schema?: string }) => Promise<unknown>;
    };
    await built.profile({ schema: "staging" });
    const args = profileSpy.mock.calls[0][0] as { schema?: string };
    expect(args.schema).toBe("staging");
  });
});
