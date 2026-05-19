/**
 * Tests for `atlas seed` — covers the prompts + workspace SQL functions
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
} from "../commands/seed";
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

  it("clears demo + prior, creates group + connections + entities, sets primary", async () => {
    const entities: SemanticEntityRow[] = [
      { entityType: "entity", name: "users", yaml: "table: users" },
      { entityType: "metric", name: "active_users", yaml: "name: active_users" },
    ];
    const { client, queries } = createMockClient(
      // 1 BEGIN, 1 resolve, 5 DELETEs, 1 group INSERT, 2 conn INSERTs, 1 primary UPDATE, 2 entity INSERTs, 1 COMMIT
      [
        { rows: [] }, // BEGIN
        { rows: [{ id: "org_y" }] }, // resolve
        { rows: [], rowCount: 1 }, // delete demo connection
        { rows: [], rowCount: 5 }, // delete demo entities
        { rows: [], rowCount: 0 }, // delete prior entities (none)
        { rows: [], rowCount: 0 }, // delete prior connections
        { rows: [], rowCount: 0 }, // delete prior group
        { rows: [], rowCount: 1 }, // INSERT group
        { rows: [], rowCount: 1 }, // INSERT us-prod
        { rows: [], rowCount: 1 }, // INSERT eu-prod
        { rows: [], rowCount: 1 }, // UPDATE primary
        { rows: [], rowCount: 1 }, // INSERT entity users
        { rows: [], rowCount: 1 }, // INSERT metric active_users
        { rows: [] }, // COMMIT
      ],
    );

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

    // Group insert
    const insGroup = queries.find((q) => q.sql.includes("INSERT INTO connection_groups"));
    expect(insGroup).toBeDefined();
    expect(insGroup!.params).toEqual(["g_prod", "org_y", "prod"]);

    // Connection inserts in declaration order, both bound to g_prod
    const insConns = queries.filter((q) => q.sql.includes("INSERT INTO connections"));
    expect(insConns).toHaveLength(2);
    expect(insConns[0]!.params).toEqual([
      "us-prod",
      "enc:v1:iv:tag:ciphertext-us",
      1,
      "postgres",
      "us-prod (postgres)",
      "org_y",
      "g_prod",
    ]);
    expect(insConns[1]!.params[0]).toBe("eu-prod");

    // Primary update points at the :primary entry
    const updPrimary = queries.find((q) =>
      q.sql.startsWith("UPDATE connection_groups SET primary_connection_id"),
    );
    expect(updPrimary).toBeDefined();
    expect(updPrimary!.params).toEqual(["us-prod", "g_prod", "org_y"]);

    // Semantic entities inserted with the group id
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
      { rows: [] }, // BEGIN
      { rows: [{ id: "org_y" }] }, // resolve
      { rows: [], rowCount: 0 }, // delete demo connection
      { rows: [], rowCount: 0 }, // delete demo entities
      { rows: [], rowCount: 0 }, // delete prior entities
      { rows: [], rowCount: 0 }, // delete prior connections
      { rows: [], rowCount: 0 }, // delete prior group
      { rows: [], rowCount: 1 }, // INSERT group
      { rows: [], rowCount: 1 }, // INSERT us-prod (no primary marker)
      { rows: [] }, // ROLLBACK
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
    expect(errors.some((line) => line.includes("Usage: atlas seed"))).toBe(true);
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
