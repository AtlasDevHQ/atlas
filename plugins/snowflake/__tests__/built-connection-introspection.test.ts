/**
 * #3667 — Snowflake introspection is a capability OF the built connection
 * (`createFromConfig(...).listObjects` / `.profile`), bound to the `snowflake://`
 * creds that built it, so the host's unified resolver (and the CLI) consume it
 * WITHOUT a second namespace seam. Pins that the built connection forwards its
 * url to the profiler and passes an explicit schema option through.
 */

import { describe, test, expect, mock } from "bun:test";

const listSpy = mock(async (_o: unknown) => [] as unknown[]);
const profileSpy = mock(async (_o: unknown) => ({ profiles: [], errors: [] }));
const realProfiler = await import("../src/profiler");
mock.module("../src/profiler", () => ({
  ...realProfiler,
  listSnowflakeObjects: listSpy,
  profileSnowflake: profileSpy,
}));

// Mock the snowflake-sdk-backed connection so createFromConfig doesn't open a
// session; keep parseSnowflakeURL / extractAccount real so the url is validated
// exactly as the plugin would.
const realConn = await import("../src/connection");
mock.module("../src/connection", () => ({
  ...realConn,
  createSnowflakeConnection: mock(() => ({
    query: mock(async () => ({ columns: [], rows: [] })),
    close: mock(async () => {}),
  })),
}));

const { snowflakePlugin } = await import("../src/index");

const SF_URL = "snowflake://admin:s3cret@xy12345/mydb/public?warehouse=COMPUTE_WH";

describe("built connection introspection forwards a profilable url (#3667)", () => {
  test("profile() forwards the configured snowflake:// url to profileSnowflake", async () => {
    profileSpy.mockClear();
    const plugin = snowflakePlugin({});
    const built = plugin.connection.createFromConfig!({ url: SF_URL }) as {
      profile: (o?: { selectedTables?: string[] }) => Promise<unknown>;
    };
    await built.profile({ selectedTables: ["ORDERS"] });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    const args = profileSpy.mock.calls[0][0] as { url?: string; selectedTables?: string[] };
    expect(args.url).toBe(SF_URL);
    expect(args.selectedTables).toEqual(["ORDERS"]);
  });

  test("listObjects() forwards the url and passes an explicit schema through", async () => {
    listSpy.mockClear();
    const plugin = snowflakePlugin({});
    const built = plugin.connection.createFromConfig!({ url: SF_URL }) as {
      listObjects: (o?: { schema?: string }) => Promise<unknown>;
    };
    await built.listObjects({ schema: "PUBLIC" });
    expect(listSpy).toHaveBeenCalledTimes(1);
    const args = listSpy.mock.calls[0][0] as { url?: string; schema?: string };
    expect(args.url).toBe(SF_URL);
    expect(args.schema).toBe("PUBLIC");
  });
});
