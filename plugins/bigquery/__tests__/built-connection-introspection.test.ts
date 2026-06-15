/**
 * #3667 / #3664 — BigQuery is non-url-shaped (service-account multi-field). The
 * BUILT connection's relocated introspection (`createFromConfig(...).listObjects`
 * / `.profile`) must thread the TENANT's decrypted config (service_account_json
 * → credentials, project_id → projectId) into the profiler, so profiling
 * authenticates with the tenant's own creds — never ADC / operator env. The host
 * binds the decrypted config at `createFromConfig`; this pins the plugin half:
 * the config createFromConfig received is forwarded verbatim to the profiler.
 */

import { describe, test, expect, mock } from "bun:test";

// @google-cloud/bigquery is an optional peer dep — mock it so createFromConfig's
// client build doesn't throw (mirrors bigquery.test.ts).
mock.module("@google-cloud/bigquery", () => ({
  BigQuery: mock(() => ({ query: mock(async () => [[]]), dataset: mock(() => ({})) })),
}));

const listSpy = mock(async (_o: unknown) => [] as unknown[]);
const profileSpy = mock(async (_o: unknown) => ({ profiles: [], errors: [] }));
const realProfiler = await import("../src/profiler");
mock.module("../src/profiler", () => ({
  ...realProfiler,
  listBigQueryObjects: listSpy,
  profileBigQuery: profileSpy,
}));

const { bigqueryPlugin } = await import("../src/index");

const TENANT_CONFIG = {
  projectId: "tenant-project",
  dataset: "analytics",
  service_account_json: '{"project_id":"tenant-project","client_email":"x@y.iam"}',
};

describe("built connection introspection forwards tenant config (#3667/#3664)", () => {
  test("profile() forwards the createFromConfig config to profileBigQuery (no synthetic url)", async () => {
    profileSpy.mockClear();
    const plugin = bigqueryPlugin({ projectId: "config-project" });
    const built = plugin.connection.createFromConfig!(TENANT_CONFIG) as {
      profile: (o?: { schema?: string }) => Promise<unknown>;
    };
    await built.profile();
    expect(profileSpy).toHaveBeenCalledTimes(1);
    const args = profileSpy.mock.calls[0][0] as { config?: unknown; url?: string; schema?: string };
    // Tenant config flows through; the seam carries NO url (the #3664 synthetic
    // url is gone — creds come from the config, not a connection string).
    expect(args.config).toEqual(TENANT_CONFIG);
    expect(args.url).toBe("");
    // The dataset routing hint defaults from the parsed config.
    expect(args.schema).toBe("analytics");
  });

  test("listObjects() forwards the createFromConfig config to listBigQueryObjects", async () => {
    listSpy.mockClear();
    const plugin = bigqueryPlugin({ projectId: "config-project" });
    const built = plugin.connection.createFromConfig!(TENANT_CONFIG) as {
      listObjects: (o?: { schema?: string }) => Promise<unknown>;
    };
    await built.listObjects();
    expect(listSpy).toHaveBeenCalledTimes(1);
    const args = listSpy.mock.calls[0][0] as { config?: unknown };
    expect(args.config).toEqual(TENANT_CONFIG);
  });
});
