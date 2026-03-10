import { describe, test, expect } from "bun:test";
import {
  generateMigrationSQL,
  generateColumnMigrations,
  runPluginMigrations,
  applyMigrations,
  ensureMigrationsTable,
  getAppliedMigrations,
  diffSchema,
  prefixTableName,
  type MigrateDB,
  type MigrationStatement,
} from "../migrate";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

interface QueryLog {
  sql: string;
  params?: unknown[];
}

function makeMockDB(opts?: {
  existingMigrations?: Array<{ plugin_id: string; table_name: string; sql_hash: string }>;
  existingTables?: string[];
  /** Map of table name → existing column names (for information_schema.columns queries) */
  existingColumns?: Record<string, string[]>;
  failOnCreate?: boolean;
}): MigrateDB & { queries: QueryLog[] } {
  const queries: QueryLog[] = [];
  const existingMigrations = [...(opts?.existingMigrations ?? [])];
  const existingTables = opts?.existingTables ?? [];
  const existingColumns = opts?.existingColumns ?? {};

  return {
    queries,
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });

      if (opts?.failOnCreate && sql.includes("CREATE TABLE") && !sql.includes("plugin_migrations")) {
        throw new Error("permission denied for schema public");
      }
      if (sql.includes("FROM plugin_migrations")) {
        return { rows: existingMigrations };
      }
      // Track migrations inserted via applyMigrations
      if (sql.includes("INSERT INTO plugin_migrations") && params) {
        existingMigrations.push({
          plugin_id: String(params[0]),
          table_name: String(params[1]),
          sql_hash: String(params[2]),
        });
        return { rows: [] };
      }
      if (sql.includes("FROM pg_tables")) {
        return { rows: existingTables.map((t) => ({ tablename: t })) };
      }
      if (sql.includes("information_schema.columns") && params?.[0]) {
        const tableName = String(params[0]);
        const cols = existingColumns[tableName] ?? [];
        return { rows: cols.map((c) => ({ column_name: c })) };
      }
      return { rows: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlugin(
  id: string,
  schema: Record<string, { fields: Record<string, unknown> }>,
) {
  return { id, schema };
}

// ---------------------------------------------------------------------------
// prefixTableName
// ---------------------------------------------------------------------------

describe("prefixTableName", () => {
  test("basic prefixing", () => {
    expect(prefixTableName("jira", "tickets")).toBe("plugin_jira_tickets");
  });

  test("replaces dashes with underscores", () => {
    expect(prefixTableName("my-plugin", "user-tokens")).toBe("plugin_my_plugin_user_tokens");
  });

  test("replaces dots with underscores", () => {
    expect(prefixTableName("com.example", "data")).toBe("plugin_com_example_data");
  });
});

// ---------------------------------------------------------------------------
// generateMigrationSQL
// ---------------------------------------------------------------------------

describe("generateMigrationSQL", () => {
  test("generates CREATE TABLE for string, number, boolean, date types", () => {
    const plugins = [
      makePlugin("test", {
        items: {
          fields: {
            name: { type: "string", required: true },
            count: { type: "number" },
            active: { type: "boolean" },
            due_date: { type: "date" },
          },
        },
      }),
    ];

    const stmts = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    expect(stmts).toHaveLength(1);

    const sql = stmts[0].sql;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "plugin_test_items"');
    expect(sql).toContain('"name" TEXT NOT NULL');
    expect(sql).toContain('"count" INTEGER');
    expect(sql).toContain('"active" BOOLEAN');
    expect(sql).toContain('"due_date" TIMESTAMPTZ');
    expect(sql).toContain('"id" UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(sql).toContain('"created_at" TIMESTAMPTZ DEFAULT now()');
    expect(sql).toContain('"updated_at" TIMESTAMPTZ DEFAULT now()');
  });

  test("handles UNIQUE constraint", () => {
    const plugins = [
      makePlugin("test", {
        users: {
          fields: {
            email: { type: "string", required: true, unique: true },
          },
        },
      }),
    ];

    const stmts = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    expect(stmts[0].sql).toContain('"email" TEXT NOT NULL UNIQUE');
  });

  test("handles DEFAULT values", () => {
    const plugins = [
      makePlugin("test", {
        settings: {
          fields: {
            label: { type: "string", defaultValue: "untitled" },
            priority: { type: "number", defaultValue: 0 },
            enabled: { type: "boolean", defaultValue: true },
          },
        },
      }),
    ];

    const stmts = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    const sql = stmts[0].sql;
    expect(sql).toContain("DEFAULT 'untitled'");
    expect(sql).toContain("DEFAULT 0");
    expect(sql).toContain("DEFAULT true");
  });

  test("handles FOREIGN KEY references", () => {
    const plugins = [
      makePlugin("test", {
        projects: { fields: { name: { type: "string" } } },
        tasks: {
          fields: {
            project_id: {
              type: "string",
              references: { model: "projects", field: "id" },
            },
          },
        },
      }),
    ];

    const stmts = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    const taskStmt = stmts.find((s) => s.tableName === "tasks");
    expect(taskStmt).toBeDefined();
    expect(taskStmt!.sql).toContain(
      'FOREIGN KEY ("project_id") REFERENCES "plugin_test_projects"("id")'
    );
  });

  test("escapes single quotes in default values", () => {
    const plugins = [
      makePlugin("test", {
        items: {
          fields: {
            label: { type: "string", defaultValue: "it's a test" },
          },
        },
      }),
    ];

    const stmts = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    expect(stmts[0].sql).toContain("DEFAULT 'it''s a test'");
  });

  test("skips plugins without schema", () => {
    const plugins = [{ id: "no-schema" }];
    const stmts = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    expect(stmts).toHaveLength(0);
  });

  test("generates multiple tables from one plugin", () => {
    const plugins = [
      makePlugin("crm", {
        contacts: { fields: { name: { type: "string" } } },
        deals: { fields: { value: { type: "number" } } },
      }),
    ];

    const stmts = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    expect(stmts).toHaveLength(2);
    expect(stmts.map((s) => s.prefixedName).sort()).toEqual([
      "plugin_crm_contacts",
      "plugin_crm_deals",
    ]);
  });

  test("generates statements from multiple plugins", () => {
    const plugins = [
      makePlugin("a", { items: { fields: { x: { type: "string" } } } }),
      makePlugin("b", { things: { fields: { y: { type: "number" } } } }),
    ];

    const stmts = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    expect(stmts).toHaveLength(2);
    expect(stmts[0].pluginId).toBe("a");
    expect(stmts[1].pluginId).toBe("b");
  });

  test("generates deterministic hash for same SQL", () => {
    const plugins = [
      makePlugin("test", { items: { fields: { x: { type: "string" } } } }),
    ];

    const stmts1 = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    const stmts2 = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    expect(stmts1[0].hash).toBe(stmts2[0].hash);
  });

  test("generates different hashes for different SQL", () => {
    const plugins1 = [makePlugin("test", { items: { fields: { x: { type: "string" } } } })];
    const plugins2 = [makePlugin("test", { items: { fields: { x: { type: "number" } } } })];

    const stmts1 = generateMigrationSQL(plugins1 as Parameters<typeof generateMigrationSQL>[0]);
    const stmts2 = generateMigrationSQL(plugins2 as Parameters<typeof generateMigrationSQL>[0]);
    expect(stmts1[0].hash).not.toBe(stmts2[0].hash);
  });

  test("throws on unknown field type", () => {
    const plugins = [makePlugin("test", { items: { fields: { data: { type: "json" } } } })];
    expect(() => generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]))
      .toThrow(/Unknown field type "json"/);
  });

  test("rejects field names with special characters", () => {
    const plugins = [makePlugin("test", {
      items: { fields: { 'foo"; DROP TABLE x; --': { type: "string" } } },
    })];
    expect(() => generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]))
      .toThrow(/Invalid identifier/);
  });

  test("rejects references.field with special characters", () => {
    const plugins = [makePlugin("test", {
      parent: { fields: { name: { type: "string" } } },
      child: {
        fields: {
          parent_id: {
            type: "string",
            references: { model: "parent", field: 'id"); DROP TABLE x; --' },
          },
        },
      },
    })];
    expect(() => generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]))
      .toThrow(/Invalid identifier/);
  });

  test("rejects NaN as default value", () => {
    const plugins = [makePlugin("test", {
      items: { fields: { count: { type: "number", defaultValue: NaN } } },
    })];
    expect(() => generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]))
      .toThrow(/Invalid numeric defaultValue/);
  });

  test("rejects Infinity as default value", () => {
    const plugins = [makePlugin("test", {
      items: { fields: { count: { type: "number", defaultValue: Infinity } } },
    })];
    expect(() => generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]))
      .toThrow(/Invalid numeric defaultValue/);
  });

  test("rejects unsupported defaultValue types", () => {
    const plugins = [makePlugin("test", {
      items: { fields: { data: { type: "string", defaultValue: { raw: "NOW()" } } } },
    })];
    expect(() => generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]))
      .toThrow(/Unsupported defaultValue type/);
  });

  test("generates table with only auto-columns when fields is empty", () => {
    const plugins = [makePlugin("test", { empty_table: { fields: {} } })];
    const stmts = generateMigrationSQL(plugins as Parameters<typeof generateMigrationSQL>[0]);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toContain('"id" UUID PRIMARY KEY');
    expect(stmts[0].sql).toContain('"created_at"');
    expect(stmts[0].sql).toContain('"updated_at"');
  });
});

// ---------------------------------------------------------------------------
// ensureMigrationsTable
// ---------------------------------------------------------------------------

describe("ensureMigrationsTable", () => {
  test("creates the plugin_migrations table", async () => {
    const db = makeMockDB();
    await ensureMigrationsTable(db);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain("CREATE TABLE IF NOT EXISTS plugin_migrations");
  });
});

// ---------------------------------------------------------------------------
// getAppliedMigrations
// ---------------------------------------------------------------------------

describe("getAppliedMigrations", () => {
  test("returns set of applied migration keys", async () => {
    const db = makeMockDB({
      existingMigrations: [
        { plugin_id: "test", table_name: "items", sql_hash: "abc123" },
      ],
    });
    const applied = await getAppliedMigrations(db);
    expect(applied.has("test:items:abc123")).toBe(true);
    expect(applied.size).toBe(1);
  });

  test("returns empty set when no migrations", async () => {
    const db = makeMockDB();
    const applied = await getAppliedMigrations(db);
    expect(applied.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyMigrations
// ---------------------------------------------------------------------------

describe("applyMigrations", () => {
  test("applies new migrations and records them", async () => {
    const db = makeMockDB();
    const stmts: MigrationStatement[] = [
      {
        pluginId: "test",
        tableName: "items",
        prefixedName: "plugin_test_items",
        sql: 'CREATE TABLE IF NOT EXISTS "plugin_test_items" ("id" UUID PRIMARY KEY);',
        hash: "aabb0011",
      },
    ];

    const result = await applyMigrations(db, stmts);
    expect(result.applied).toEqual(["plugin_test_items"]);
    expect(result.skipped).toHaveLength(0);

    // Should have: ensureMigrationsTable, getAppliedMigrations, CREATE TABLE, INSERT into plugin_migrations
    const createTableQuery = db.queries.find((q) => q.sql.includes("plugin_test_items"));
    expect(createTableQuery).toBeDefined();

    const insertQuery = db.queries.find((q) => q.sql.includes("INSERT INTO plugin_migrations"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.params).toEqual(["test", "items", "aabb0011"]);
  });

  test("skips already-applied migrations", async () => {
    const db = makeMockDB({
      existingMigrations: [
        { plugin_id: "test", table_name: "items", sql_hash: "aabb0011" },
      ],
    });

    const stmts: MigrationStatement[] = [
      {
        pluginId: "test",
        tableName: "items",
        prefixedName: "plugin_test_items",
        sql: 'CREATE TABLE IF NOT EXISTS "plugin_test_items" ("id" UUID PRIMARY KEY);',
        hash: "aabb0011",
      },
    ];

    const result = await applyMigrations(db, stmts);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toEqual(["plugin_test_items"]);

    // Should NOT have a CREATE TABLE query (only ensureMigrations + getApplied)
    const createTableQuery = db.queries.find(
      (q) => q.sql.includes("plugin_test_items") && q.sql.includes("CREATE TABLE"),
    );
    expect(createTableQuery).toBeUndefined();
  });

  test("applies changed migration (different hash)", async () => {
    const db = makeMockDB({
      existingMigrations: [
        { plugin_id: "test", table_name: "items", sql_hash: "old_hash" },
      ],
    });

    const stmts: MigrationStatement[] = [
      {
        pluginId: "test",
        tableName: "items",
        prefixedName: "plugin_test_items",
        sql: 'CREATE TABLE IF NOT EXISTS "plugin_test_items" ("id" UUID PRIMARY KEY, "name" TEXT);',
        hash: "new_hash",
      },
    ];

    const result = await applyMigrations(db, stmts);
    expect(result.applied).toEqual(["plugin_test_items"]);
    expect(result.skipped).toHaveLength(0);
  });

  test("handles multiple statements with mixed state", async () => {
    const db = makeMockDB({
      existingMigrations: [
        { plugin_id: "a", table_name: "existing", sql_hash: "hash1" },
      ],
    });

    const stmts: MigrationStatement[] = [
      {
        pluginId: "a",
        tableName: "existing",
        prefixedName: "plugin_a_existing",
        sql: "CREATE TABLE ...",
        hash: "hash1",
      },
      {
        pluginId: "b",
        tableName: "new_table",
        prefixedName: "plugin_b_new_table",
        sql: "CREATE TABLE ...",
        hash: "hash2",
      },
    ];

    const result = await applyMigrations(db, stmts);
    expect(result.applied).toEqual(["plugin_b_new_table"]);
    expect(result.skipped).toEqual(["plugin_a_existing"]);
  });

  test("handles empty statements array", async () => {
    const db = makeMockDB();
    const result = await applyMigrations(db, []);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test("propagates db errors with context", async () => {
    const db = makeMockDB({ failOnCreate: true });
    const stmts: MigrationStatement[] = [
      {
        pluginId: "test",
        tableName: "items",
        prefixedName: "plugin_test_items",
        sql: 'CREATE TABLE IF NOT EXISTS "plugin_test_items" ("id" UUID PRIMARY KEY);',
        hash: "abc",
      },
    ];

    await expect(applyMigrations(db, stmts)).rejects.toThrow(/plugin_test_items/);
    await expect(applyMigrations(db, stmts)).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------
// diffSchema
// ---------------------------------------------------------------------------

describe("diffSchema", () => {
  test("identifies new and existing tables", async () => {
    const db = makeMockDB({
      existingTables: ["plugin_test_items"],
    });

    const stmts: MigrationStatement[] = [
      {
        pluginId: "test",
        tableName: "items",
        prefixedName: "plugin_test_items",
        sql: "",
        hash: "",
      },
      {
        pluginId: "test",
        tableName: "users",
        prefixedName: "plugin_test_users",
        sql: "",
        hash: "",
      },
    ];

    const diff = await diffSchema(db, stmts);
    expect(diff.existingTables).toEqual(["plugin_test_items"]);
    expect(diff.newTables).toEqual(["plugin_test_users"]);
  });

  test("all new when no tables exist", async () => {
    const db = makeMockDB();

    const stmts: MigrationStatement[] = [
      { pluginId: "x", tableName: "a", prefixedName: "plugin_x_a", sql: "", hash: "" },
    ];

    const diff = await diffSchema(db, stmts);
    expect(diff.newTables).toEqual(["plugin_x_a"]);
    expect(diff.existingTables).toHaveLength(0);
  });

  test("returns empty diff for empty statements", async () => {
    const db = makeMockDB({ existingTables: ["some_table"] });
    const diff = await diffSchema(db, []);
    expect(diff.newTables).toHaveLength(0);
    expect(diff.existingTables).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateColumnMigrations
// ---------------------------------------------------------------------------

describe("generateColumnMigrations", () => {
  test("generates ALTER TABLE for missing columns", async () => {
    const db = makeMockDB({
      existingColumns: {
        plugin_test_items: ["id", "name", "created_at", "updated_at"],
      },
    });
    const plugins = [
      makePlugin("test", {
        items: {
          fields: {
            name: { type: "string", required: true },
            priority: { type: "number" },
            active: { type: "boolean" },
          },
        },
      }),
    ];

    const stmts = await generateColumnMigrations(
      db,
      plugins as Parameters<typeof generateColumnMigrations>[1],
    );

    // name already exists, priority and active are new
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toContain('ALTER TABLE "plugin_test_items"');
    expect(stmts[0].sql).toContain('"priority" INTEGER');
    expect(stmts[1].sql).toContain('"active" BOOLEAN');
  });

  test("skips tables that don't exist yet", async () => {
    const db = makeMockDB({
      existingColumns: {},  // no tables in DB
    });
    const plugins = [
      makePlugin("test", {
        items: { fields: { name: { type: "string" } } },
      }),
    ];

    const stmts = await generateColumnMigrations(
      db,
      plugins as Parameters<typeof generateColumnMigrations>[1],
    );
    expect(stmts).toHaveLength(0);
  });

  test("returns empty when all columns already exist", async () => {
    const db = makeMockDB({
      existingColumns: {
        plugin_test_items: ["id", "name", "count", "created_at", "updated_at"],
      },
    });
    const plugins = [
      makePlugin("test", {
        items: {
          fields: {
            name: { type: "string" },
            count: { type: "number" },
          },
        },
      }),
    ];

    const stmts = await generateColumnMigrations(
      db,
      plugins as Parameters<typeof generateColumnMigrations>[1],
    );
    expect(stmts).toHaveLength(0);
  });

  test("handles case-insensitive column matching", async () => {
    const db = makeMockDB({
      existingColumns: {
        plugin_test_items: ["id", "MyColumn", "created_at", "updated_at"],
      },
    });
    const plugins = [
      makePlugin("test", {
        items: {
          fields: {
            mycolumn: { type: "string" },
          },
        },
      }),
    ];

    const stmts = await generateColumnMigrations(
      db,
      plugins as Parameters<typeof generateColumnMigrations>[1],
    );
    // MyColumn matches mycolumn (case-insensitive)
    expect(stmts).toHaveLength(0);
  });

  test("skips plugins without schema", async () => {
    const db = makeMockDB();
    const plugins = [{ id: "no-schema" }];

    const stmts = await generateColumnMigrations(
      db,
      plugins as Parameters<typeof generateColumnMigrations>[1],
    );
    expect(stmts).toHaveLength(0);
  });

  test("generates columns with constraints", async () => {
    const db = makeMockDB({
      existingColumns: {
        plugin_test_items: ["id", "created_at", "updated_at"],
      },
    });
    const plugins = [
      makePlugin("test", {
        items: {
          fields: {
            email: { type: "string", required: true, unique: true },
            priority: { type: "number", defaultValue: 0 },
          },
        },
      }),
    ];

    const stmts = await generateColumnMigrations(
      db,
      plugins as Parameters<typeof generateColumnMigrations>[1],
    );
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toContain('"email" TEXT NOT NULL UNIQUE');
    expect(stmts[1].sql).toContain('"priority" INTEGER DEFAULT 0');
  });

  test("generates deterministic hashes for ALTER statements", async () => {
    const db = makeMockDB({
      existingColumns: {
        plugin_test_items: ["id", "created_at", "updated_at"],
      },
    });
    const plugins = [
      makePlugin("test", {
        items: { fields: { name: { type: "string" } } },
      }),
    ];

    const stmts1 = await generateColumnMigrations(
      db,
      plugins as Parameters<typeof generateColumnMigrations>[1],
    );
    const stmts2 = await generateColumnMigrations(
      db,
      plugins as Parameters<typeof generateColumnMigrations>[1],
    );
    expect(stmts1[0].hash).toBe(stmts2[0].hash);
  });
});

// ---------------------------------------------------------------------------
// runPluginMigrations
// ---------------------------------------------------------------------------

describe("runPluginMigrations", () => {
  test("runs CREATE TABLE and ALTER TABLE in sequence", async () => {
    const db = makeMockDB({
      // Simulate a table that was just created with only auto-columns —
      // Phase 2 detects the missing user-declared column
      existingColumns: {
        plugin_test_items: ["id", "created_at", "updated_at"],
      },
    });
    const plugins = [
      makePlugin("test", {
        items: {
          fields: {
            name: { type: "string" },
          },
        },
      }),
    ];

    const result = await runPluginMigrations(
      db,
      plugins as Parameters<typeof runPluginMigrations>[1],
    );

    // Phase 1: CREATE TABLE (1 table) + Phase 2: ALTER TABLE ADD COLUMN (1 column)
    expect(result.applied).toEqual(["plugin_test_items", "plugin_test_items"]);
    // Should have both CREATE TABLE and ALTER TABLE queries
    const createQuery = db.queries.find((q) =>
      q.sql.includes("CREATE TABLE") && q.sql.includes("plugin_test_items"),
    );
    expect(createQuery).toBeDefined();
    const alterQuery = db.queries.find((q) =>
      q.sql.includes("ALTER TABLE") && q.sql.includes('"name"'),
    );
    expect(alterQuery).toBeDefined();
  });

  test("merges results from both phases correctly", async () => {
    const db = makeMockDB({
      existingColumns: {
        plugin_a_items: ["id", "x", "created_at", "updated_at"],
        // plugin_b_things doesn't exist — no columns, Phase 2 skips it
      },
    });
    const plugins = [
      makePlugin("a", { items: { fields: { x: { type: "string" }, y: { type: "number" } } } }),
      makePlugin("b", { things: { fields: { z: { type: "boolean" } } } }),
    ];

    const result = await runPluginMigrations(
      db,
      plugins as Parameters<typeof runPluginMigrations>[1],
    );

    // Phase 1: 2 CREATE TABLE statements applied
    // Phase 2: 1 ALTER TABLE for plugin_a_items.y (x already exists, plugin_b skipped)
    expect(result.applied).toEqual([
      "plugin_a_items", "plugin_b_things", "plugin_a_items",
    ]);
  });

  test("handles plugins with no schema", async () => {
    const db = makeMockDB();
    const plugins = [{ id: "no-schema" }];

    const result = await runPluginMigrations(
      db,
      plugins as Parameters<typeof runPluginMigrations>[1],
    );
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("skips column migrations when no new columns needed", async () => {
    const db = makeMockDB({
      existingColumns: {
        plugin_test_items: ["id", "name", "created_at", "updated_at"],
      },
    });
    const plugins = [
      makePlugin("test", {
        items: {
          fields: {
            name: { type: "string" },
          },
        },
      }),
    ];

    await runPluginMigrations(
      db,
      plugins as Parameters<typeof runPluginMigrations>[1],
    );

    // ALTER TABLE should not appear (no new columns)
    const alterQuery = db.queries.find((q) => q.sql.includes("ALTER TABLE"));
    expect(alterQuery).toBeUndefined();
  });

  test("propagates Phase 1 errors and skips Phase 2", async () => {
    const db = makeMockDB({ failOnCreate: true });
    const plugins = [
      makePlugin("test", {
        items: { fields: { name: { type: "string" } } },
      }),
    ];

    await expect(
      runPluginMigrations(db, plugins as Parameters<typeof runPluginMigrations>[1]),
    ).rejects.toThrow(/permission denied/);

    // No ALTER TABLE queries should have been attempted
    const alterQuery = db.queries.find((q) => q.sql.includes("ALTER TABLE"));
    expect(alterQuery).toBeUndefined();
  });

  test("idempotent when run twice", async () => {
    const db = makeMockDB({
      existingColumns: {
        plugin_test_items: ["id", "name", "created_at", "updated_at"],
      },
    });
    const plugins = [
      makePlugin("test", {
        items: {
          fields: { name: { type: "string" } },
        },
      }),
    ];

    const result1 = await runPluginMigrations(
      db,
      plugins as Parameters<typeof runPluginMigrations>[1],
    );
    const result2 = await runPluginMigrations(
      db,
      plugins as Parameters<typeof runPluginMigrations>[1],
    );

    // First run applies CREATE TABLE
    expect(result1.applied).toEqual(["plugin_test_items"]);
    // Second run skips it (already tracked in plugin_migrations)
    expect(result2.applied).toEqual([]);
    expect(result2.skipped).toEqual(["plugin_test_items"]);
  });
});

// ---------------------------------------------------------------------------
// generateColumnMigrations — error context
// ---------------------------------------------------------------------------

describe("generateColumnMigrations error context", () => {
  test("wraps fieldToSQL errors with plugin and table context", async () => {
    const db = makeMockDB({
      existingColumns: {
        plugin_test_items: ["id", "created_at", "updated_at"],
      },
    });
    const plugins = [
      makePlugin("test", {
        items: { fields: { "bad name!": { type: "string" } } },
      }),
    ];

    await expect(
      generateColumnMigrations(db, plugins as Parameters<typeof generateColumnMigrations>[1]),
    ).rejects.toThrow(/Plugin "test", table "plugin_test_items"/);
  });
});
