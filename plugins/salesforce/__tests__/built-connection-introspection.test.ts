/**
 * #3667 — Salesforce introspection is a capability OF the built connection
 * (`createFromConfig(...).listObjects` / `.profile`), bound to the `salesforce://`
 * creds that built it. This credential-form path is DORMANT for Atlas (the
 * datasource bridge skips salesforce → OAuth, ADR-0014; the OAuth path exposes
 * its own introspection via the LazyPluginLoader), but it serves the CLI's
 * `atlas init` salesforce:// url + future self-host wiring. Pins that the built
 * connection forwards its url to the profiler.
 */

import { describe, test, expect, mock } from "bun:test";

const listSpy = mock(async (_o: unknown) => [] as unknown[]);
const profileSpy = mock(async (_o: unknown) => ({ profiles: [], errors: [] }));
const realProfiler = await import("../src/profiler");
void mock.module("../src/profiler", () => ({
  ...realProfiler,
  listSalesforceObjects: listSpy,
  profileSalesforce: profileSpy,
}));

// Mock the jsforce-backed connection so createFromConfig doesn't open a session;
// keep parseSalesforceURL real so the url is validated as the plugin would.
const realConn = await import("../src/connection");
void mock.module("../src/connection", () => ({
  ...realConn,
  createSalesforceConnection: mock(() => ({
    query: mock(async () => ({ columns: [], rows: [] })),
    close: mock(async () => {}),
  })),
}));

const { salesforcePlugin } = await import("../src/index");

const SF_URL = "salesforce://user%40example.com:pass@login.salesforce.com?token=TOK";

describe("built connection introspection forwards the salesforce url (#3667)", () => {
  test("profile() forwards the configured salesforce:// url to profileSalesforce", async () => {
    profileSpy.mockClear();
    const plugin = salesforcePlugin({});
    const built = plugin.connection.createFromConfig!({ url: SF_URL }) as {
      profile: (o?: { selectedTables?: string[] }) => Promise<unknown>;
    };
    await built.profile({ selectedTables: ["Account"] });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    const args = profileSpy.mock.calls[0][0] as { url?: string; selectedTables?: string[] };
    expect(args.url).toBe(SF_URL);
    expect(args.selectedTables).toEqual(["Account"]);
  });

  test("listObjects() forwards the configured salesforce:// url to listSalesforceObjects", async () => {
    listSpy.mockClear();
    const plugin = salesforcePlugin({});
    const built = plugin.connection.createFromConfig!({ url: SF_URL }) as {
      listObjects: (o?: { schema?: string }) => Promise<unknown>;
    };
    await built.listObjects();
    expect(listSpy).toHaveBeenCalledTimes(1);
    const args = listSpy.mock.calls[0][0] as { url?: string };
    expect(args.url).toBe(SF_URL);
  });
});
