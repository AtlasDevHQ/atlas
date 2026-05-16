/**
 * Tests for migration bundle validation and import logic.
 *
 * Imports validateBundle directly from the route module and verifies bundle
 * type shapes for round-trip export → import compatibility.
 */

import { describe, it, expect } from "bun:test";
import type { ExportBundle, ExportedSemanticEntity, ImportResult } from "@useatlas/types";
import type { InternalPoolClient } from "@atlas/api/lib/db/internal";
import { importBundle, validateBundle } from "../routes/admin-migrate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validBundle(overrides?: Partial<ExportBundle>): ExportBundle {
  return {
    manifest: {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: { label: "self-hosted" },
      counts: {
        conversations: 1,
        messages: 2,
        semanticEntities: 1,
        learnedPatterns: 1,
        settings: 1,
      },
    },
    conversations: [
      {
        id: "conv-001",
        userId: "user-1",
        title: "Test conversation",
        surface: "web",
        connectionId: null,
        starred: false,
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        messages: [
          { id: "msg-001", role: "user", content: "Hello", createdAt: "2026-04-01T00:00:00Z" },
          { id: "msg-002", role: "assistant", content: "Hi there!", createdAt: "2026-04-01T00:00:01Z" },
        ],
      },
    ],
    semanticEntities: [
      { name: "users", entityType: "entity", yamlContent: "table: users\n", connectionGroupId: null },
    ],
    learnedPatterns: [
      { patternSql: "SELECT COUNT(*) FROM users", description: "User count", sourceEntity: "users", confidence: 0.9, status: "approved" },
    ],
    settings: [
      { key: "theme", value: "dark" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateBundle", () => {
  it("accepts a valid bundle", () => {
    const result = validateBundle(validBundle());
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateBundle(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("JSON object");
  });

  it("rejects non-object", () => {
    const result = validateBundle("not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects missing manifest", () => {
    const result = validateBundle({ conversations: [], semanticEntities: [], learnedPatterns: [], settings: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("manifest");
  });

  it("rejects wrong version", () => {
    const bundle = validBundle();
    (bundle.manifest as unknown as Record<string, unknown>).version = 99;
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported bundle version: 99");
  });

  it("rejects missing conversations array", () => {
    const result = validateBundle({
      manifest: { version: 1 },
      semanticEntities: [],
      learnedPatterns: [],
      settings: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("conversations");
  });

  it("rejects missing semanticEntities array", () => {
    const result = validateBundle({
      manifest: { version: 1 },
      conversations: [],
      learnedPatterns: [],
      settings: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("semanticEntities");
  });

  it("rejects missing learnedPatterns array", () => {
    const result = validateBundle({
      manifest: { version: 1 },
      conversations: [],
      semanticEntities: [],
      settings: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("learnedPatterns");
  });

  it("rejects missing settings array", () => {
    const result = validateBundle({
      manifest: { version: 1 },
      conversations: [],
      semanticEntities: [],
      learnedPatterns: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("settings");
  });

  it("accepts empty arrays", () => {
    const bundle = validBundle({
      conversations: [],
      semanticEntities: [],
      learnedPatterns: [],
      settings: [],
    });
    const result = validateBundle(bundle);
    expect(result.ok).toBe(true);
  });

  // Per-element validation tests
  it("rejects conversation missing id", () => {
    const result = validateBundle({
      manifest: { version: 1 },
      conversations: [{ messages: [] }],
      semanticEntities: [],
      learnedPatterns: [],
      settings: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("conversations[0]");
  });

  it("rejects conversation missing messages array", () => {
    const result = validateBundle({
      manifest: { version: 1 },
      conversations: [{ id: "conv-1" }],
      semanticEntities: [],
      learnedPatterns: [],
      settings: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("conversations[0]");
  });

  it("rejects semantic entity missing required fields", () => {
    const result = validateBundle({
      manifest: { version: 1 },
      conversations: [],
      semanticEntities: [{ name: "test" }],
      learnedPatterns: [],
      settings: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("semanticEntities[0]");
  });

  it("rejects learned pattern missing patternSql", () => {
    const result = validateBundle({
      manifest: { version: 1 },
      conversations: [],
      semanticEntities: [],
      learnedPatterns: [{ description: "test" }],
      settings: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("learnedPatterns[0]");
  });

  it("rejects setting missing key or value", () => {
    const result = validateBundle({
      manifest: { version: 1 },
      conversations: [],
      semanticEntities: [],
      learnedPatterns: [],
      settings: [{ key: "test" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("settings[0]");
  });
});

describe("bundle round-trip shape", () => {
  it("serializes and deserializes without data loss", () => {
    const original = validBundle();
    const json = JSON.stringify(original);
    const parsed = JSON.parse(json) as ExportBundle;

    expect(parsed.manifest.version).toBe(1);
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0].id).toBe("conv-001");
    expect(parsed.conversations[0].messages).toHaveLength(2);
    expect(parsed.semanticEntities).toHaveLength(1);
    expect(parsed.semanticEntities[0].name).toBe("users");
    expect(parsed.learnedPatterns).toHaveLength(1);
    expect(parsed.learnedPatterns[0].patternSql).toBe("SELECT COUNT(*) FROM users");
    expect(parsed.settings).toHaveLength(1);
    expect(parsed.settings[0].key).toBe("theme");
  });

  it("preserves message content of various types", () => {
    const bundle = validBundle();
    bundle.conversations[0].messages = [
      { id: "m1", role: "user", content: "plain string", createdAt: "2026-04-01T00:00:00Z" },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "structured" }], createdAt: "2026-04-01T00:00:01Z" },
      { id: "m3", role: "tool", content: { result: { columns: ["a"], rows: [{ a: 1 }] } }, createdAt: "2026-04-01T00:00:02Z" },
    ];

    const roundTripped = JSON.parse(JSON.stringify(bundle)) as ExportBundle;
    expect(roundTripped.conversations[0].messages[0].content).toBe("plain string");
    expect(roundTripped.conversations[0].messages[1].content).toEqual([{ type: "text", text: "structured" }]);
    expect(roundTripped.conversations[0].messages[2].content).toEqual({ result: { columns: ["a"], rows: [{ a: 1 }] } });
  });

  it("ImportResult has all entity types", () => {
    const result: ImportResult = {
      conversations: { imported: 10, skipped: 2 },
      semanticEntities: { imported: 5, skipped: 0 },
      learnedPatterns: { imported: 3, skipped: 1 },
      settings: { imported: 8, skipped: 0 },
    };

    const total = (r: { imported: number; skipped: number }) => r.imported + r.skipped;
    expect(total(result.conversations)).toBe(12);
    expect(total(result.semanticEntities)).toBe(5);
    expect(total(result.learnedPatterns)).toBe(4);
    expect(total(result.settings)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// ExportedSemanticEntity.connectionGroupId optionality (#2423)
// ---------------------------------------------------------------------------

function bundleWithEntities(entities: ExportedSemanticEntity[]): ExportBundle {
  return {
    manifest: {
      version: 1,
      exportedAt: "2026-05-15T00:00:00Z",
      source: { label: "test" },
      counts: { conversations: 0, messages: 0, semanticEntities: entities.length, learnedPatterns: 0, settings: 0 },
    },
    conversations: [],
    semanticEntities: entities,
    learnedPatterns: [],
    settings: [],
  };
}

function bundleWithEntity(entity: ExportedSemanticEntity): ExportBundle {
  return bundleWithEntities([entity]);
}

/**
 * Capture-only in-memory pool client. The `existing` map gates which probes
 * return a row (key = `${entityType}::${name}`) so we can drive the importer
 * down both the insert and the idempotent-skip branches without spinning up
 * pg.
 */
function captureClient(existing: Set<string> = new Set()): {
  client: InternalPoolClient;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: InternalPoolClient = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("SELECT id FROM semantic_entities")) {
        const [, entityType, name] = (params ?? []) as [string, string, string];
        if (existing.has(`${entityType}::${name}`)) return { rows: [{ id: "existing" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return { client, calls };
}

describe("ExportedSemanticEntity.connectionGroupId — three import shapes", () => {
  it("accepts the omitted shape at compile time and at runtime", () => {
    // Compile-time: must type-check without `connectionGroupId`. Without
    // optionality on the type, this assignment would error at TS level.
    const legacyEntity: ExportedSemanticEntity = {
      name: "users",
      entityType: "entity",
      yamlContent: "table: users\n",
    };

    const result = validateBundle(bundleWithEntity(legacyEntity));
    expect(result.ok).toBe(true);
  });

  it("accepts explicit null", () => {
    const result = validateBundle(bundleWithEntity({
      name: "users",
      entityType: "entity",
      yamlContent: "table: users\n",
      connectionGroupId: null,
    }));
    expect(result.ok).toBe(true);
  });

  it("accepts an explicit string", () => {
    const result = validateBundle(bundleWithEntity({
      name: "users",
      entityType: "entity",
      yamlContent: "table: users\n",
      connectionGroupId: "g_prod_us",
    }));
    expect(result.ok).toBe(true);
  });

  it("coalesces omitted connectionGroupId to null in the INSERT", async () => {
    const { client, calls } = captureClient();
    await importBundle(client, bundleWithEntity({
      name: "users",
      entityType: "entity",
      yamlContent: "table: users\n",
    }), "org-test");

    const insert = calls.find((c) => c.sql.includes("INSERT INTO semantic_entities"));
    expect(insert).toBeDefined();
    // 5-tuple: org_id, entity_type, name, yaml_content, connection_group_id
    expect(insert?.params[4]).toBeNull();
  });

  it("preserves explicit null in the INSERT", async () => {
    const { client, calls } = captureClient();
    await importBundle(client, bundleWithEntity({
      name: "users",
      entityType: "entity",
      yamlContent: "table: users\n",
      connectionGroupId: null,
    }), "org-test");

    const insert = calls.find((c) => c.sql.includes("INSERT INTO semantic_entities"));
    expect(insert?.params[4]).toBeNull();
  });

  it("forwards an explicit group id into the INSERT", async () => {
    const { client, calls } = captureClient();
    await importBundle(client, bundleWithEntity({
      name: "users",
      entityType: "entity",
      yamlContent: "table: users\n",
      connectionGroupId: "g_prod_us",
    }), "org-test");

    const insert = calls.find((c) => c.sql.includes("INSERT INTO semantic_entities"));
    expect(insert?.params[4]).toBe("g_prod_us");
  });

  it("emits one INSERT per entity for a mixed-shape bundle, in order", async () => {
    const { client, calls } = captureClient();
    await importBundle(client, bundleWithEntities([
      { name: "users", entityType: "entity", yamlContent: "table: users\n" },
      { name: "orders", entityType: "entity", yamlContent: "table: orders\n", connectionGroupId: null },
      { name: "events", entityType: "entity", yamlContent: "table: events\n", connectionGroupId: "g_prod_us" },
    ]), "org-test");

    const inserts = calls.filter((c) => c.sql.includes("INSERT INTO semantic_entities"));
    expect(inserts).toHaveLength(3);
    expect(inserts[0].params[2]).toBe("users");
    expect(inserts[0].params[4]).toBeNull();
    expect(inserts[1].params[2]).toBe("orders");
    expect(inserts[1].params[4]).toBeNull();
    expect(inserts[2].params[2]).toBe("events");
    expect(inserts[2].params[4]).toBe("g_prod_us");
  });

  it("skips re-import when the entity already exists, regardless of wire shape", async () => {
    const { client, calls } = captureClient(new Set(["entity::users"]));
    const result = await importBundle(client, bundleWithEntity({
      name: "users",
      entityType: "entity",
      yamlContent: "table: users\n",
      // omitted connectionGroupId — confirms the skip path doesn't depend
      // on the field being present.
    }), "org-test");

    const inserts = calls.filter((c) => c.sql.includes("INSERT INTO semantic_entities"));
    expect(inserts).toHaveLength(0);
    expect(result.semanticEntities.skipped).toBe(1);
    expect(result.semanticEntities.imported).toBe(0);
  });
});

describe("validateBundle — connectionGroupId type guard", () => {
  // Optionality widens the field to `string | null | undefined`. Anything
  // else is a producer bug and must surface as a 400 — never reach pg.
  function bundleWithRawEntity(entity: Record<string, unknown>): unknown {
    return {
      manifest: { version: 1, exportedAt: "x", source: { label: "x" }, counts: { conversations: 0, messages: 0, semanticEntities: 1, learnedPatterns: 0, settings: 0 } },
      conversations: [],
      semanticEntities: [entity],
      learnedPatterns: [],
      settings: [],
    };
  }

  function rejected(value: unknown): string | undefined {
    const result = validateBundle(bundleWithRawEntity({
      name: "users",
      entityType: "entity",
      yamlContent: "table: users\n",
      connectionGroupId: value,
    }));
    return result.ok ? undefined : result.error;
  }

  it("rejects a numeric connectionGroupId", () => {
    const err = rejected(42);
    expect(err).toBeDefined();
    expect(err).toContain("semanticEntities[0].connectionGroupId");
  });

  it("rejects an object connectionGroupId", () => {
    expect(rejected({})).toContain("semanticEntities[0].connectionGroupId");
  });

  it("rejects an array connectionGroupId", () => {
    expect(rejected([])).toContain("semanticEntities[0].connectionGroupId");
  });

  it("rejects an empty-string connectionGroupId", () => {
    // Empty string would silently insert "" and fail the FK lookup later.
    // Reject upfront so the producer sees a clear 400.
    expect(rejected("")).toContain("semanticEntities[0].connectionGroupId");
  });

  it("accepts undefined, null, and a non-empty string", () => {
    expect(rejected(undefined)).toBeUndefined();
    expect(rejected(null)).toBeUndefined();
    expect(rejected("g_prod_us")).toBeUndefined();
  });
});
