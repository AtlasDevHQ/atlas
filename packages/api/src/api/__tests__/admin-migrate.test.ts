/**
 * Tests for migration bundle validation and import logic.
 *
 * Imports validateBundle directly from the route module and verifies bundle
 * type shapes for round-trip export → import compatibility.
 */

import { describe, it, expect } from "bun:test";
import type {
  ExportBundle,
  ExportedLearnedPattern,
  ExportedSemanticEntity,
  ImportResult,
} from "@useatlas/types";
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
      dashboards: { imported: 2, skipped: 1 },
      knowledgeDocuments: { imported: 4, skipped: 0 },
      scheduledTasks: { imported: 1, skipped: 0 },
      agentSessionMemory: { imported: 6, skipped: 2 },
    };

    const total = (r: { imported: number; skipped: number }) => r.imported + r.skipped;
    expect(total(result.conversations)).toBe(12);
    expect(total(result.semanticEntities)).toBe(5);
    expect(total(result.learnedPatterns)).toBe(4);
    expect(total(result.settings)).toBe(8);
    expect(total(result.dashboards)).toBe(3);
    expect(total(result.knowledgeDocuments)).toBe(4);
    expect(total(result.scheduledTasks)).toBe(1);
    expect(total(result.agentSessionMemory)).toBe(8);
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

// ---------------------------------------------------------------------------
// Learned-pattern amendment identity round-trips through import (#4569, M9)
// ---------------------------------------------------------------------------

function bundleWithPatterns(patterns: ExportedLearnedPattern[]): ExportBundle {
  return {
    manifest: {
      version: 1,
      exportedAt: "2026-07-11T00:00:00Z",
      source: { label: "test" },
      counts: { conversations: 0, messages: 0, semanticEntities: 0, learnedPatterns: patterns.length, settings: 0 },
    },
    conversations: [],
    semanticEntities: [],
    learnedPatterns: patterns,
    settings: [],
  };
}

const AMENDMENT_PAYLOAD = {
  entityName: "orders",
  amendmentType: "add_dimension",
  amendment: { name: "region", sql: "region", type: "string" },
  rationale: "geo breakdowns",
};

describe("importBundle — learned-pattern amendment identity (#4569)", () => {
  it("round-trips type, amendment_payload (serialized) and connection_group_id for an amendment row", async () => {
    const { client, calls } = captureClient();
    await importBundle(client, bundleWithPatterns([
      {
        patternSql: "amendment:orders:add_dimension:region",
        description: "Add region dimension",
        sourceEntity: "orders",
        confidence: 0.9,
        status: "approved",
        type: "semantic_amendment",
        amendmentPayload: AMENDMENT_PAYLOAD,
        connectionGroupId: "g_prod_us",
        reviewedBy: "admin-1",
        reviewedAt: "2026-07-10T12:00:00Z",
        repetitionCount: 3,
      },
    ]), "org-test");

    const insert = calls.find((c) => c.sql.includes("INSERT INTO learned_patterns"));
    expect(insert).toBeDefined();
    // Columns: org_id, pattern_sql, description, source_entity, confidence,
    // status, type, amendment_payload, connection_group_id, reviewed_by,
    // reviewed_at, repetition_count.
    const p = insert!.params;
    expect(p[6]).toBe("semantic_amendment");
    // jsonb param must be a serialized string, not the raw object.
    expect(typeof p[7]).toBe("string");
    expect(JSON.parse(p[7] as string)).toEqual(AMENDMENT_PAYLOAD);
    expect(p[8]).toBe("g_prod_us");
    expect(p[9]).toBe("admin-1");
    expect(p[10]).toBe("2026-07-10T12:00:00Z");
    expect(p[11]).toBe(3);
  });

  it("carries the human-approval flag (#4571) so the eligibility bypass survives import", async () => {
    const { client, calls } = captureClient();
    await importBundle(client, bundleWithPatterns([
      {
        patternSql: "SELECT COUNT(*) FROM orders",
        description: "Order count",
        sourceEntity: "orders",
        confidence: 0.1, // below threshold — only survives injection via the bypass
        status: "approved",
        autoPromoted: false,
      },
    ]), "org-test");

    const insert = calls.find((c) => c.sql.includes("INSERT INTO learned_patterns"));
    expect(insert).toBeDefined();
    // auto_promoted is the last INSERT column (param $13 → index 12).
    expect(insert!.params[12]).toBe(false);
  });

  it("defaults a pre-#4569 bundle (no amendment fields) to a query pattern, failing closed on auto_promoted (#4571)", async () => {
    const { client, calls } = captureClient();
    await importBundle(client, bundleWithPatterns([
      {
        patternSql: "SELECT COUNT(*) FROM orders",
        description: "Order count",
        sourceEntity: "orders",
        confidence: 0.8,
        status: "pending",
      },
    ]), "org-test");

    const insert = calls.find((c) => c.sql.includes("INSERT INTO learned_patterns"));
    expect(insert).toBeDefined();
    const p = insert!.params;
    expect(p[6]).toBe("query_pattern");
    expect(p[7]).toBeNull(); // amendment_payload
    expect(p[8]).toBeNull(); // connection_group_id
    expect(p[9]).toBeNull(); // reviewed_by
    expect(p[10]).toBeNull(); // reviewed_at
    expect(p[11]).toBe(1); // repetition_count default
    // A pre-#4571 bundle omits auto_promoted → fail closed to machine/gated
    // (true), so an old bundle can never grant an unearned confidence bypass.
    expect(p[12]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v2 bundle sections (#4460) — dashboards, knowledge, scheduled tasks, memory
// ---------------------------------------------------------------------------

function validV2Bundle(overrides?: Partial<ExportBundle>): ExportBundle {
  return {
    manifest: {
      version: 2,
      exportedAt: "2026-07-18T00:00:00Z",
      source: { label: "region-migration:us-east" },
      counts: {
        conversations: 0,
        messages: 0,
        semanticEntities: 0,
        learnedPatterns: 0,
        settings: 0,
        dashboards: 1,
        dashboardCards: 1,
        dashboardUserDrafts: 1,
        knowledgeDocuments: 1,
        knowledgeLinks: 1,
        scheduledTasks: 1,
        agentSessionMemory: 1,
      },
    },
    conversations: [],
    semanticEntities: [],
    learnedPatterns: [],
    settings: [],
    dashboards: [
      {
        id: "dash-1",
        ownerId: "user-1",
        title: "Revenue",
        description: "MRR overview",
        shareMode: "org",
        refreshSchedule: "0 8 * * *",
        parameters: [{ key: "region", type: "string" }],
        firstPublishedAt: "2026-06-01T00:00:00Z",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
        cards: [
          {
            id: "card-1",
            position: 0,
            title: "MRR",
            sql: "SELECT 1",
            chartConfig: { type: "line" },
            content: null,
            annotations: [{ x: "2026-06-01", label: "launch" }],
            connectionGroupId: "g-prod",
            layout: { x: 0, y: 0, w: 6, h: 4 },
            createdAt: "2026-05-01T00:00:00Z",
            updatedAt: "2026-05-02T00:00:00Z",
          },
        ],
        drafts: [
          {
            userId: "user-2",
            draft: { title: "Revenue (wip)", cards: [] },
            baseline: { title: "Revenue", cards: [] },
            publishedBaselineAt: "2026-06-01T00:00:00Z",
            createdAt: "2026-06-02T00:00:00Z",
            updatedAt: "2026-06-03T00:00:00Z",
          },
        ],
      },
    ],
    knowledgeDocuments: [
      {
        id: "doc-1",
        collectionId: "handbook",
        path: "policies/refunds.md",
        type: "guide",
        title: "Refund policy",
        description: null,
        tags: ["policy"],
        docTimestamp: null,
        resource: null,
        body: "# Refunds",
        atlasSource: null,
        atlasIngestedAt: null,
        status: "draft",
        createdAt: "2026-03-02T00:00:00Z",
        updatedAt: "2026-03-02T00:00:00Z",
        links: [{ targetPath: "policies/returns.md", anchorText: "returns" }],
      },
    ],
    scheduledTasks: [
      {
        id: "task-1",
        ownerId: "user-1",
        name: "Weekly revenue",
        question: "What was revenue last week?",
        cronExpression: "0 9 * * 1",
        deliveryChannel: "email",
        recipients: ["ops@example.com"],
        connectionGroupId: "g-prod",
        approvalMode: "auto",
        enabled: true,
        pluginId: null,
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      },
    ],
    agentSessionMemory: [
      {
        conversationId: "conv-001",
        namespace: "scratchpad",
        value: { note: "weekly grain preferred" },
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-02T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

/**
 * Capture client for the v2 sections: `existingSql` substrings gate which
 * existence probes report a hit, driving the idempotent-skip branches.
 */
function v2CaptureClient(existingSql: string[] = []): {
  client: InternalPoolClient;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: InternalPoolClient = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (existingSql.some((fragment) => sql.includes(fragment))) {
        return { rows: [{ id: "existing" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return { client, calls };
}

describe("validateBundle — v2 sections (#4460)", () => {
  it("accepts a full v2 bundle", () => {
    const result = validateBundle(validV2Bundle());
    expect(result.ok).toBe(true);
  });

  it("still accepts a legacy v1 bundle with the v2 sections absent", () => {
    const result = validateBundle(validBundle());
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown future version", () => {
    const bundle = validV2Bundle();
    (bundle.manifest as unknown as Record<string, unknown>).version = 3;
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported bundle version");
  });

  it("rejects a v2 bundle missing a required section (producer drift fails loudly)", () => {
    for (const section of ["dashboards", "knowledgeDocuments", "scheduledTasks", "agentSessionMemory"] as const) {
      const bundle = validV2Bundle();
      delete (bundle as unknown as Record<string, unknown>)[section];
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(section);
    }
  });

  it("validates sections when present on a v1-labeled bundle (no version-gated skip)", () => {
    const bundle = validBundle({
      dashboards: [
        // Missing ownerId/title/cards/drafts — must be rejected even though
        // the manifest claims v1.
        { id: "dash-1" } as unknown as NonNullable<ExportBundle["dashboards"]>[number],
      ],
    });
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("dashboards[0]");
  });

  it("rejects a knowledge document with an invalid content-mode status", () => {
    const bundle = validV2Bundle();
    (bundle.knowledgeDocuments![0] as unknown as Record<string, unknown>).status = "live";
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("status");
  });

  it("rejects a scheduled task missing its cron expression", () => {
    const bundle = validV2Bundle();
    delete (bundle.scheduledTasks![0] as unknown as Record<string, unknown>).cronExpression;
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("scheduledTasks[0]");
  });

  it("rejects a memory slot missing its value", () => {
    const bundle = validV2Bundle();
    delete (bundle.agentSessionMemory![0] as unknown as Record<string, unknown>).value;
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("agentSessionMemory[0]");
  });

  it("rejects an invalid or absent shareMode — never widened to 'public' by default", () => {
    // Invalid value would abort the transaction on chk_dashboard_share_mode;
    // an ABSENT value must not silently widen sharing either.
    for (const bad of ["private", undefined]) {
      const bundle = validV2Bundle();
      (bundle.dashboards![0] as unknown as Record<string, unknown>).shareMode = bad;
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("shareMode");
    }
  });

  it("rejects a draft missing its snapshot payloads (NOT NULL columns)", () => {
    for (const field of ["draft", "baseline"] as const) {
      const bundle = validV2Bundle();
      delete (bundle.dashboards![0].drafts[0] as unknown as Record<string, unknown>)[field];
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("drafts[0]");
    }
  });

  it("rejects a task missing its approval posture or enabled flag — never defaulted permissively", () => {
    for (const field of ["approvalMode", "enabled"] as const) {
      const bundle = validV2Bundle();
      delete (bundle.scheduledTasks![0] as unknown as Record<string, unknown>)[field];
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
  });
});

describe("importBundle — v2 sections (#4460)", () => {
  it("imports a dashboard with cards and drafts, preserving UUIDs and re-minting the share token", async () => {
    const { client, calls } = v2CaptureClient();
    const result = await importBundle(client, validV2Bundle(), "org-test");

    const dashInsert = calls.find((c) => c.sql.includes("INSERT INTO dashboards"));
    expect(dashInsert).toBeDefined();
    // Columns: id, org_id, owner_id, title, description, share_mode,
    // refresh_schedule, next_refresh_at, parameters, first_published_at,
    // created_at, updated_at
    expect(dashInsert!.params[0]).toBe("dash-1"); // original UUID preserved
    expect(dashInsert!.params[1]).toBe("org-test");
    expect(dashInsert!.params[5]).toBe("org"); // shareMode preference survives
    // share_token is not an INSERT column at all — the owner re-shares in the target.
    expect(dashInsert!.sql).not.toContain("share_token");
    // Auto-refresh re-planned: next_refresh_at recomputed from the schedule
    // and in the FUTURE — a NULL here would silently kill auto-refresh (the
    // due-refresh scan requires next_refresh_at <= now()).
    const nextRefreshAt = dashInsert!.params[7];
    expect(typeof nextRefreshAt).toBe("string");
    expect(new Date(nextRefreshAt as string).getTime()).toBeGreaterThan(Date.now());
    // jsonb parameters serialized, not raw.
    expect(typeof dashInsert!.params[8]).toBe("string");

    const cardInsert = calls.find((c) => c.sql.includes("INSERT INTO dashboard_cards"));
    expect(cardInsert).toBeDefined();
    expect(cardInsert!.params[0]).toBe("card-1");
    expect(cardInsert!.params[1]).toBe("dash-1"); // FK survives via preserved UUID
    // cached_* result snapshots are a carve-out — never inserted.
    expect(cardInsert!.sql).not.toContain("cached_");

    const draftInsert = calls.find((c) => c.sql.includes("INSERT INTO dashboard_user_drafts"));
    expect(draftInsert).toBeDefined();
    expect(draftInsert!.params[0]).toBe("user-2");
    expect(draftInsert!.params[1]).toBe("dash-1");

    expect(result.dashboards).toEqual({ imported: 1, skipped: 0 });
  });

  it("skips an already-imported dashboard (idempotent re-import)", async () => {
    const { client, calls } = v2CaptureClient(["SELECT id FROM dashboards"]);
    const result = await importBundle(client, validV2Bundle(), "org-test");

    expect(calls.find((c) => c.sql.includes("INSERT INTO dashboards"))).toBeUndefined();
    expect(calls.find((c) => c.sql.includes("INSERT INTO dashboard_cards"))).toBeUndefined();
    expect(result.dashboards).toEqual({ imported: 0, skipped: 1 });
  });

  it("imports a knowledge document with preserved UUID, review status, and its links", async () => {
    const { client, calls } = v2CaptureClient();
    const result = await importBundle(client, validV2Bundle(), "org-test");

    const docInsert = calls.find((c) => c.sql.includes("INSERT INTO knowledge_documents"));
    expect(docInsert).toBeDefined();
    expect(docInsert!.params[0]).toBe("doc-1");
    expect(docInsert!.params[1]).toBe("org-test"); // workspace_id = importing org
    expect(docInsert!.params[13]).toBe("draft"); // review status preserved
    // The FTS vector is a generated column — the INSERT must not touch it.
    expect(docInsert!.sql).not.toContain("fts");

    const linkInsert = calls.find((c) => c.sql.includes("INSERT INTO knowledge_links"));
    expect(linkInsert).toBeDefined();
    expect(linkInsert!.params[0]).toBe("doc-1");
    expect(linkInsert!.params[1]).toBe("policies/returns.md");

    expect(result.knowledgeDocuments).toEqual({ imported: 1, skipped: 0 });
  });

  it("imports a scheduled task and recomputes next_run_at from the cron expression", async () => {
    const { client, calls } = v2CaptureClient();
    const result = await importBundle(client, validV2Bundle(), "org-test");

    const taskInsert = calls.find((c) => c.sql.includes("INSERT INTO scheduled_tasks"));
    expect(taskInsert).toBeDefined();
    // Columns: id, owner_id, org_id, name, question, cron_expression,
    // delivery_channel, recipients, connection_group_id, approval_mode,
    // enabled, plugin_id, next_run_at, created_at, updated_at
    expect(taskInsert!.params[0]).toBe("task-1");
    expect(taskInsert!.params[2]).toBe("org-test");
    expect(taskInsert!.params[5]).toBe("0 9 * * 1");
    // next_run_at is recomputed at import (target scheduler re-plans), and
    // must land in the FUTURE — never carried from the source bundle.
    const nextRunAt = taskInsert!.params[12];
    expect(typeof nextRunAt).toBe("string");
    expect(new Date(nextRunAt as string).getTime()).toBeGreaterThan(Date.now());

    expect(result.scheduledTasks).toEqual({ imported: 1, skipped: 0 });
  });

  it("imports a session memory slot scoped to the importing org", async () => {
    const { client, calls } = v2CaptureClient();
    const result = await importBundle(client, validV2Bundle(), "org-test");

    const memInsert = calls.find((c) => c.sql.includes("INSERT INTO agent_session_memory"));
    expect(memInsert).toBeDefined();
    // Columns: conversation_id, org_id, namespace, value, created_at, updated_at
    expect(memInsert!.params[0]).toBe("conv-001");
    expect(memInsert!.params[1]).toBe("org-test");
    expect(memInsert!.params[2]).toBe("scratchpad");
    // jsonb value serialized.
    expect(typeof memInsert!.params[3]).toBe("string");

    expect(result.agentSessionMemory).toEqual({ imported: 1, skipped: 0 });
  });

  it("skips an existing memory slot (idempotent re-import)", async () => {
    const { client, calls } = v2CaptureClient(["FROM agent_session_memory WHERE"]);
    const result = await importBundle(client, validV2Bundle(), "org-test");

    expect(calls.find((c) => c.sql.includes("INSERT INTO agent_session_memory"))).toBeUndefined();
    expect(result.agentSessionMemory).toEqual({ imported: 0, skipped: 1 });
  });

  it("skips an already-imported knowledge document — and its links (idempotent re-import)", async () => {
    const { client, calls } = v2CaptureClient(["SELECT id FROM knowledge_documents"]);
    const result = await importBundle(client, validV2Bundle(), "org-test");

    expect(calls.find((c) => c.sql.includes("INSERT INTO knowledge_documents"))).toBeUndefined();
    expect(calls.find((c) => c.sql.includes("INSERT INTO knowledge_links"))).toBeUndefined();
    expect(result.knowledgeDocuments).toEqual({ imported: 0, skipped: 1 });
  });

  it("skips an already-imported scheduled task (idempotent re-import)", async () => {
    const { client, calls } = v2CaptureClient(["SELECT id FROM scheduled_tasks"]);
    const result = await importBundle(client, validV2Bundle(), "org-test");

    expect(calls.find((c) => c.sql.includes("INSERT INTO scheduled_tasks"))).toBeUndefined();
    expect(result.scheduledTasks).toEqual({ imported: 0, skipped: 1 });
  });

  it("imports an unparseable-cron task with next_run_at NULL instead of aborting the transaction", async () => {
    const bundle = validV2Bundle();
    bundle.scheduledTasks![0].cronExpression = "not a cron";
    const { client, calls } = v2CaptureClient();
    const result = await importBundle(client, bundle, "org-test");

    const taskInsert = calls.find((c) => c.sql.includes("INSERT INTO scheduled_tasks"));
    expect(taskInsert).toBeDefined();
    // Matches create-task semantics: the task exists but is unscheduled until
    // the admin fixes the expression (warn-logged with import context).
    expect(taskInsert!.params[12]).toBeNull();
    expect(result.scheduledTasks).toEqual({ imported: 1, skipped: 0 });
  });

  it("imports v2 sections present on a v1-labeled bundle (never version-gate-skipped)", async () => {
    // The wire contract (migration.ts) promises present sections import
    // regardless of the claimed version — a future "gate sections behind
    // version === 2" refactor would silently strand data, the exact #4460 bug.
    const v2 = validV2Bundle();
    const bundle = validBundle({
      dashboards: v2.dashboards,
      knowledgeDocuments: v2.knowledgeDocuments,
      scheduledTasks: v2.scheduledTasks,
      agentSessionMemory: v2.agentSessionMemory,
    });
    expect(bundle.manifest.version).toBe(1);

    const { client } = v2CaptureClient();
    const result = await importBundle(client, bundle, "org-test");

    expect(result.dashboards).toEqual({ imported: 1, skipped: 0 });
    expect(result.knowledgeDocuments).toEqual({ imported: 1, skipped: 0 });
    expect(result.scheduledTasks).toEqual({ imported: 1, skipped: 0 });
    expect(result.agentSessionMemory).toEqual({ imported: 1, skipped: 0 });
  });

  it("returns 0/0 for the v2 sections when importing a legacy v1 bundle", async () => {
    const { client } = v2CaptureClient();
    const result = await importBundle(client, validBundle(), "org-test");

    expect(result.dashboards).toEqual({ imported: 0, skipped: 0 });
    expect(result.knowledgeDocuments).toEqual({ imported: 0, skipped: 0 });
    expect(result.scheduledTasks).toEqual({ imported: 0, skipped: 0 });
    expect(result.agentSessionMemory).toEqual({ imported: 0, skipped: 0 });
  });
});
