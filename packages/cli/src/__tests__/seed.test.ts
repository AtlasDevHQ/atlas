/**
 * Tests for `atlas-operator seed` — covers the prompts + workspace SQL functions
 * and the arg-parsing helpers (parseConnectionsArg, parsePromptLibrary).
 * Mocks the DB pool so the assertions can pin specific SQL/args without
 * standing up Postgres.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  seedPrompts,
  seedWorkspaceGroup,
  parsePromptLibrary,
  parseConnectionsArg,
  handleSeed,
  type ResolvedConnectionSpec,
  type SemanticEntityRow,
} from "../commands/operator/seed";
import type { TenantPgClient } from "../../lib/tenant-db";

// --- Mock pool ---

interface MockQuery {
  sql: string;
  params: unknown[];
}

function createMockClient(
  responses: Array<{ rows: Array<Record<string, unknown>>; rowCount?: number }>,
): { client: TenantPgClient; queries: MockQuery[] } {
  const queries: MockQuery[] = [];
  let next = 0;
  const client: TenantPgClient = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const r = responses[next++] ?? { rows: [], rowCount: 0 };
      return { rows: r.rows as never[], rowCount: r.rowCount ?? r.rows.length };
    },
  };
  return { client, queries };
}

// --- parsePromptLibrary ---

describe("parsePromptLibrary", () => {
  it("parses a valid YAML library", () => {
    const lib = parsePromptLibrary(`
collection:
  name: Atlas Internal
  industry: atlas-internal
  description: Curated prompts
categories:
  - name: Revenue
    prompts:
      - How many users signed up last week?
      - What was MRR last month?
`);
    expect(lib.collection.name).toBe("Atlas Internal");
    expect(lib.categories[0]!.prompts).toHaveLength(2);
  });

  it("rejects a library with no collection.industry", () => {
    expect(() =>
      parsePromptLibrary(`
collection:
  name: x
categories:
  - name: a
    prompts: [p]
`),
    ).toThrow("collection.industry");
  });

  it("rejects a library with empty categories", () => {
    expect(() =>
      parsePromptLibrary(`
collection:
  name: x
  industry: y
  description: z
categories: []
`),
    ).toThrow("categories array is empty");
  });

  it("rejects an empty/whitespace library file with a clear message", () => {
    // js-yaml v5 throws on empty input where v4 returned undefined; the guard
    // surfaces a file-attributed message instead of a raw YAMLException.
    expect(() => parsePromptLibrary("")).toThrow("library.yml: file is empty");
    expect(() => parsePromptLibrary("   \n  ")).toThrow("library.yml: file is empty");
  });
});

// --- seedPrompts ---

describe("seedPrompts", () => {
  it("clears, inserts collection + items, then pins ATLAS_DEMO_INDUSTRY in one transaction", async () => {
    const { client, queries } = createMockClient([
      { rows: [] }, // BEGIN
      { rows: [{ id: "org_x" }] }, // resolve
      { rows: [], rowCount: 1 }, // DELETE prior
      { rows: [{ id: "coll_1" }] }, // INSERT collection
      { rows: [], rowCount: 1 }, // INSERT item 1
      { rows: [], rowCount: 1 }, // INSERT item 2
      { rows: [], rowCount: 1 }, // INSERT settings
      { rows: [] }, // COMMIT
    ]);

    const result = await seedPrompts(client, {
      workspace: "atlas",
      library: {
        collection: { name: "Lib", industry: "atlas-internal", description: "d" },
        categories: [{ name: "A", prompts: ["q1", "q2"] }],
      },
    });

    expect(result).toEqual({
      orgId: "org_x",
      collectionId: "coll_1",
      itemsInserted: 2,
    });
    expect(queries[0]!.sql).toBe("BEGIN");
    expect(queries[queries.length - 1]!.sql).toBe("COMMIT");

    const delPrior = queries.find((q) => q.sql.startsWith("DELETE FROM prompt_collections"));
    expect(delPrior).toBeDefined();
    expect(delPrior!.params).toEqual(["org_x", "Lib"]);

    const insColl = queries.find((q) => q.sql.includes("INSERT INTO prompt_collections"));
    expect(insColl).toBeDefined();
    expect(insColl!.sql).toContain("status");
    expect(insColl!.params).toEqual(["org_x", "Lib", "atlas-internal", "d"]);

    const insItems = queries.filter((q) => q.sql.includes("INSERT INTO prompt_items"));
    expect(insItems).toHaveLength(2);
    // sort_order monotonic across categories
    expect(insItems[0]!.params).toEqual(["coll_1", "q1", "A", 0]);
    expect(insItems[1]!.params).toEqual(["coll_1", "q2", "A", 1]);

    const insSetting = queries.find((q) => q.sql.includes("INSERT INTO settings"));
    expect(insSetting).toBeDefined();
    expect(insSetting!.sql).toContain("ON CONFLICT (key, org_id) WHERE org_id IS NOT NULL");
    expect(insSetting!.params).toEqual(["atlas-internal", "org_x"]);
  });

  it("rolls back when the resolve query fails", async () => {
    const { client, queries } = createMockClient([
      { rows: [] }, // BEGIN
      { rows: [] }, // resolve — empty
      { rows: [] }, // ROLLBACK
    ]);
    await expect(
      seedPrompts(client, {
        workspace: "ghost",
        library: {
          collection: { name: "x", industry: "y", description: "z" },
          categories: [{ name: "a", prompts: ["p"] }],
        },
      }),
    ).rejects.toThrow("No organization with slug='ghost' found.");
    expect(queries[queries.length - 1]!.sql).toBe("ROLLBACK");
  });
});

// --- parseConnectionsArg ---

describe("parseConnectionsArg", () => {
  it("parses a multi-entry spec with exactly one primary", () => {
    const parsed = parseConnectionsArg(
      "us-prod=US_DB_URL:postgres:primary,eu-prod=EU_DB_URL:postgres",
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: "us-prod",
      urlEnv: "US_DB_URL",
      type: "postgres",
      isPrimary: true,
    });
    expect(parsed[1]).toMatchObject({
      id: "eu-prod",
      urlEnv: "EU_DB_URL",
      type: "postgres",
      isPrimary: false,
    });
  });

  it("rejects when no entry is marked :primary", () => {
    expect(() =>
      parseConnectionsArg("us-prod=US_DB_URL:postgres,eu-prod=EU_DB_URL:postgres"),
    ).toThrow("requires exactly one entry marked :primary");
  });

  it("rejects when more than one entry is marked :primary", () => {
    expect(() =>
      parseConnectionsArg(
        "us-prod=US_DB_URL:postgres:primary,eu-prod=EU_DB_URL:postgres:primary",
      ),
    ).toThrow("requires exactly one entry marked :primary");
  });

  it("rejects malformed entries", () => {
    expect(() => parseConnectionsArg("only-id")).toThrow(
      "must be id=urlEnv:type",
    );
    expect(() => parseConnectionsArg("a=ENV_ONLY_NO_TYPE")).toThrow(
      "must include both urlEnv and type",
    );
    expect(() => parseConnectionsArg("a=ENV:type:secondary")).toThrow(
      "unknown marker",
    );
  });
});

// --- seedWorkspaceGroup ---

describe("seedWorkspaceGroup", () => {
  // Post-#2744 the seeder writes `workspace_plugins (pillar='datasource')`
  // with `group_id` stashed in JSONB `config`. There is no longer a
  // separate `connection_groups` row, no `primary_connection_id` UPDATE,
  // and no top-level `url_key_version` column — encryption travels inside
  // the JSONB payload. The positional mock queue tracks the new query
  // sequence:
  //   BEGIN
  //   resolveWorkspaceId
  //   DELETE wp 'default'
  //   DELETE se (NULL or 'g_default')
  //   DELETE se for this group
  //   DELETE wp for these install_ids
  //   per connection: SELECT plugin_catalog → INSERT wp
  //   per entity:     INSERT semantic_entities
  //   COMMIT (or ROLLBACK on failure)
  function makeResolved(): ResolvedConnectionSpec[] {
    return [
      {
        id: "us-prod",
        urlEnv: "US_DB",
        type: "postgres",
        isPrimary: true,
        encryptedUrl: "enc:v1:iv:tag:ciphertext-us",
      },
      {
        id: "eu-prod",
        urlEnv: "EU_DB",
        type: "postgres",
        isPrimary: false,
        encryptedUrl: "enc:v1:iv:tag:ciphertext-eu",
      },
    ];
  }

  it("clears demo + prior installs, upserts workspace_plugins per connection, inserts entities", async () => {
    const entities: SemanticEntityRow[] = [
      { entityType: "entity", name: "users", yaml: "table: users" },
      { entityType: "metric", name: "active_users", yaml: "name: active_users" },
    ];
    const { client, queries } = createMockClient([
      { rows: [] },                                         // BEGIN
      { rows: [{ id: "org_y" }] },                          // resolveWorkspaceId
      { rows: [], rowCount: 1 },                            // DELETE wp 'default'
      { rows: [], rowCount: 5 },                            // DELETE se NULL/g_default
      { rows: [], rowCount: 0 },                            // DELETE se for g_prod (none prior)
      { rows: [], rowCount: 0 },                            // DELETE wp prior installs
      { rows: [{ id: "cat_postgres" }] },                   // SELECT plugin_catalog for us-prod
      { rows: [], rowCount: 1 },                            // INSERT wp us-prod
      { rows: [{ id: "cat_postgres" }] },                   // SELECT plugin_catalog for eu-prod
      { rows: [], rowCount: 1 },                            // INSERT wp eu-prod
      { rows: [], rowCount: 1 },                            // INSERT se 'users'
      { rows: [], rowCount: 1 },                            // INSERT se 'active_users'
      { rows: [] },                                         // COMMIT
    ]);

    const result = await seedWorkspaceGroup(client, {
      workspace: "atlas",
      groupId: "g_prod",
      groupName: "prod",
      connections: makeResolved(),
      keyVersion: 1,
      semanticEntities: entities,
    });

    expect(result).toEqual({
      orgId: "org_y",
      connectionsInserted: 2,
      entitiesInserted: 2,
    });

    // Transaction
    expect(queries[0]!.sql).toBe("BEGIN");
    expect(queries[queries.length - 1]!.sql).toBe("COMMIT");

    // No legacy connection_groups writes at all post-cutover.
    const insGroup = queries.find((q) => q.sql.includes("INSERT INTO connection_groups"));
    expect(insGroup).toBeUndefined();
    const updPrimary = queries.find((q) =>
      q.sql.includes("UPDATE connection_groups SET primary_connection_id"),
    );
    expect(updPrimary).toBeUndefined();

    // Two catalog lookups (one per connection) — slug = c.type = 'postgres'.
    const catLookups = queries.filter((q) => q.sql.includes("FROM plugin_catalog"));
    expect(catLookups).toHaveLength(2);
    for (const q of catLookups) {
      expect(q.params).toEqual(["postgres"]);
    }

    // workspace_plugins inserts in declaration order. Params:
    //   [rowId, workspaceId, catalogId, installId, configJson]
    const insWp = queries.filter((q) => q.sql.includes("INSERT INTO workspace_plugins"));
    expect(insWp).toHaveLength(2);

    const usParams = insWp[0]!.params as unknown[];
    expect(usParams[0]).toBe("cn_org_y_us-prod");
    expect(usParams[1]).toBe("org_y");
    expect(usParams[2]).toBe("cat_postgres");
    expect(usParams[3]).toBe("us-prod");
    const usConfig = JSON.parse(usParams[4] as string) as Record<string, unknown>;
    expect(usConfig).toMatchObject({
      url: "enc:v1:iv:tag:ciphertext-us",
      db_type: "postgres",
      group_id: "g_prod",
    });

    expect((insWp[1]!.params as unknown[])[3]).toBe("eu-prod");
    const euConfig = JSON.parse((insWp[1]!.params as unknown[])[4] as string) as Record<string, unknown>;
    expect(euConfig.group_id).toBe("g_prod");
    expect(euConfig.url).toBe("enc:v1:iv:tag:ciphertext-eu");

    // Semantic entities still write `connection_group_id` (the entities
    // table didn't change in #2744 — only the connections side did).
    const insEntities = queries.filter((q) => q.sql.includes("INSERT INTO semantic_entities"));
    expect(insEntities).toHaveLength(2);
    expect(insEntities[0]!.params).toEqual([
      "org_y",
      "entity",
      "users",
      "table: users",
      "g_prod",
    ]);
  });

  it("rolls back when no primary is declared (defense-in-depth — parseConnectionsArg also rejects this)", async () => {
    const { client, queries } = createMockClient([
      { rows: [] },                          // BEGIN
      { rows: [{ id: "org_y" }] },           // resolveWorkspaceId
      { rows: [], rowCount: 0 },             // DELETE wp 'default'
      { rows: [], rowCount: 0 },             // DELETE se NULL/g_default
      { rows: [], rowCount: 0 },             // DELETE se for g_prod
      { rows: [], rowCount: 0 },             // DELETE wp prior installs
      { rows: [{ id: "cat_postgres" }] },    // SELECT plugin_catalog for us-prod
      { rows: [], rowCount: 1 },             // INSERT wp us-prod (no primary marker)
      { rows: [] },                          // ROLLBACK
    ]);
    const conns = makeResolved().map((c) => ({ ...c, isPrimary: false }));
    await expect(
      seedWorkspaceGroup(client, {
        workspace: "atlas",
        groupId: "g_prod",
        groupName: "prod",
        connections: conns.slice(0, 1),
        keyVersion: 1,
      }),
    ).rejects.toThrow("no primary connection declared");
    expect(queries[queries.length - 1]!.sql).toBe("ROLLBACK");
  });
});

// --- handleSeed arg-parsing ---

const errors: string[] = [];
const logs: string[] = [];
const origConsoleError = console.error;
const origConsoleLog = console.log;
const origExit = process.exit;

let exitCode: number | null = null;

beforeEach(() => {
  errors.length = 0;
  logs.length = 0;
  exitCode = null;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__process_exit__:${exitCode}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  console.error = origConsoleError;
  console.log = origConsoleLog;
  process.exit = origExit;
});

describe("handleSeed", () => {
  it("exits 1 with usage when subcommand is unknown", async () => {
    let caught: Error | null = null;
    try {
      await handleSeed(["seed"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((line) => line.includes("Usage: atlas-operator seed"))).toBe(true);
  });

  it("exits 1 when `seed workspace` is missing --connections", async () => {
    let caught: Error | null = null;
    try {
      await handleSeed([
        "seed",
        "workspace",
        "--workspace",
        "atlas",
        "--group",
        "prod",
      ]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((line) => line.includes("--connections"))).toBe(true);
  });
});
