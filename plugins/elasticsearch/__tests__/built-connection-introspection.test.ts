/**
 * #3667 / #2850 — the BUILT connection's relocated introspection
 * (`createFromConfig(...).listObjects` / `.profile`) must thread the TENANT's
 * decrypted connection config into the profiler, never fall back to operator
 * `ATLAS_ES_*` env. The host binds the decrypted config at `createFromConfig`
 * (see mcp-profile-plugin.test.ts); this pins the plugin half — that the config
 * createFromConfig received is forwarded verbatim to the profiler, where
 * `configForOptions` sets `allowAmbientAwsCreds: false` on the tenant path.
 *
 * The host-shim that used to thread `config` was deleted in #3667; this is the
 * only coverage that the relocated wiring still carries the tenant creds.
 */

import { describe, test, expect, mock } from "bun:test";

// Spy on the profiler module so we can assert WHAT the built connection forwards
// without standing up a real Elasticsearch. `...real` keeps every other export
// (index.ts re-exports several) intact so the plugin module loads normally.
const listSpy = mock(async (_o: unknown) => [] as unknown[]);
const profileSpy = mock(async (_o: unknown) => ({ profiles: [], errors: [] }));
const realProfiler = await import("../src/profiler");
void mock.module("../src/profiler", () => ({
  ...realProfiler,
  listElasticsearchObjects: listSpy,
  profileElasticsearchObjects: profileSpy,
}));

const { elasticsearchPlugin } = await import("../src/index");

const TENANT_CONFIG = { url: "elasticsearch://es.tenant:9200?ssl=false", apiKey: "VnVhQ2ZHY0JDZGJrU=tenant-key" };

describe("built connection introspection forwards tenant config (#3667/#2850)", () => {
  test("profile() forwards the createFromConfig config to profileElasticsearchObjects", async () => {
    profileSpy.mockClear();
    const plugin = elasticsearchPlugin({});
    const built = plugin.connection.createFromConfig!(TENANT_CONFIG) as {
      profile: (o?: { selectedTables?: string[] }) => Promise<unknown>;
    };
    await built.profile({ selectedTables: ["idx"] });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    const args = profileSpy.mock.calls[0][0] as { config?: unknown; selectedTables?: string[] };
    // The tenant's own creds (apiKey) ride through — never operator ATLAS_ES_* env.
    expect(args.config).toEqual(TENANT_CONFIG);
    expect(args.selectedTables).toEqual(["idx"]);
  });

  test("listObjects() forwards the createFromConfig config to listElasticsearchObjects", async () => {
    listSpy.mockClear();
    const plugin = elasticsearchPlugin({});
    const built = plugin.connection.createFromConfig!(TENANT_CONFIG) as {
      listObjects: (o?: { schema?: string }) => Promise<unknown>;
    };
    await built.listObjects();
    expect(listSpy).toHaveBeenCalledTimes(1);
    const args = listSpy.mock.calls[0][0] as { config?: unknown };
    expect(args.config).toEqual(TENANT_CONFIG);
  });
});
