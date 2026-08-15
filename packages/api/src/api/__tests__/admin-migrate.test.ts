/**
 * Tests for migration bundle validation and import logic.
 *
 * Imports validateBundle directly from the route module and verifies bundle
 * type shapes for round-trip export → import compatibility.
 */

import { describe, it, expect } from "bun:test";
import { BRAIN_ENROLLMENT_NAME_MAX } from "@useatlas/schemas";
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
      brainEpisodes: { imported: 7, skipped: 1 },
      brainFacts: { imported: 9, skipped: 3 },
      brainEdges: { imported: 4, skipped: 0 },
      factAudienceMembers: { imported: 2, skipped: 5 },
      // Three counters here alone (#5036).
      brainVocabularyEdges: { imported: 1, skipped: 4, refused: 6 },
      brainSlackChannelExclusions: { imported: 2, skipped: 1, refused: 0 },
      brainEnrollments: { imported: 3, skipped: 1 },
      brainEntities: { imported: 6, skipped: 2 },
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
    expect(total(result.brainEpisodes)).toBe(8);
    expect(total(result.brainFacts)).toBe(12);
    expect(total(result.brainEdges)).toBe(4);
    expect(total(result.factAudienceMembers)).toBe(7);
    // ⚠️ THE COUNTER SET, not a sum of literals this test just wrote. Summing
    // `1 + 4 + 6 === 11` is arithmetic over its own fixture and cannot go red
    // for any production change.
    //
    // What the key set adds, stated at its real strength: it catches a counter
    // RENAMED or REMOVED, and it catches a REQUIRED fourth one (which stops the
    // literal above type-checking, so someone has to edit it). An OPTIONAL
    // fourth counter slips past both. The reconciliation behaviour that would
    // need revisiting is pinned in `migrate.test.ts`; this file pins shape, and
    // `bun run type` is what enforces it.
    expect(Object.keys(result.brainVocabularyEdges).toSorted()).toEqual([
      "imported",
      "refused",
      "skipped",
    ]);
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
    // 4, not 3 — v3 is now a version this importer reads (#5035). Named as the
    // NEXT one so the assertion keeps meaning "a version we do not know" rather
    // than drifting into "a version we happen not to have written yet".
    const bundle = validV2Bundle();
    (bundle.manifest as unknown as Record<string, unknown>).version = 4;
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported bundle version");
  });

  it("rejects a v2-or-later bundle missing a required section (producer drift fails loudly)", () => {
    // Run at BOTH v2 and v3. The gate used to read `version === CURRENT`, which
    // would have exempted every v3 bundle from the check the moment the constant
    // moved — a pillar stranded in the source region, silently, by a version
    // bump that looked unrelated.
    for (const version of [2, 3]) {
      for (const section of ["dashboards", "knowledgeDocuments", "scheduledTasks", "agentSessionMemory"] as const) {
        const bundle = validV2Bundle();
        (bundle.manifest as unknown as Record<string, unknown>).version = version;
        delete (bundle as unknown as Record<string, unknown>)[section];
        const result = validateBundle(bundle);
        expect(result.ok, `v${version} bundle missing '${section}' was accepted`).toBe(false);
        if (!result.ok) expect(result.error).toContain(section);
      }
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

describe("validateBundle — company brain (#4767)", () => {
  /** A minimal, valid brain payload: one episode, one fact, one edge, one member. */
  function brainBundle(): ExportBundle {
    const bundle = validV2Bundle();
    return {
      ...bundle,
      brainEpisodes: [
        {
          id: "ep-1",
          source: "slack",
          sourceId: "C1/1.0",
          sourceActor: "U-alice",
          body: "pricing is $49/seat",
          locator: null,
          occurredAt: "2026-06-01T00:00:00Z",
          ingestedAt: "2026-06-01T00:00:00Z",
          extractedAt: "2026-06-01T00:05:00Z",
          visibleTo: ["org"],
          createdAt: "2026-06-01T00:00:00Z",
          facts: [
            {
              id: "fact-1",
              subject: "acme:pro",
              predicate: "price_per_seat",
              object: "49",
              validFrom: "2026-06-01T00:00:00Z",
              validTo: null,
              ingestedAt: "2026-06-01T00:05:00Z",
              invalidatedAt: null,
              extractedAt: "2026-06-01T00:05:00Z",
              provenance: { actor: "U-alice" },
              status: "published",
              visibleTo: ["org"],
              // Never widened — the common case, and what the read path treats
              // as "disclose" (#4836).
              preWideningVisibleTo: null,
              predicateCardinality: "single",
              createdAt: "2026-06-01T00:05:00Z",
              updatedAt: "2026-06-01T00:05:00Z",
            },
          ],
        },
      ],
      brainEdges: [
        {
          edgeType: "provenance",
          fromFactId: "fact-1",
          fromEpisodeId: null,
          toFactId: null,
          toEpisodeId: "ep-1",
          createdAt: "2026-06-01T00:05:00Z",
        },
      ],
      factAudienceMembers: [
        { audienceId: "eng", userId: "u1", source: "slack", createdAt: "2026-06-01T00:00:00Z" },
      ],
    };
  }

  /** Mutate the single fact and expect rejection naming `expected`. */
  function expectFactRejected(mutate: (fact: Record<string, unknown>) => void, expected: string) {
    const bundle = brainBundle();
    mutate(bundle.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>);
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(expected);
  }

  it("accepts a well-formed brain payload", () => {
    expect(validateBundle(brainBundle()).ok).toBe(true);
  });

  it("accepts a v2 bundle with NO brain sections — the mid-rollout contract", () => {
    // A source region still running pre-#4767 code emits exactly this. If the
    // brain sections were ever added to the v2 REQUIRED list, every migration
    // out of a not-yet-upgraded region would start failing hard.
    const bundle = validV2Bundle();
    expect(validateBundle(bundle).ok).toBe(true);
  });

  // ── no-grant-no-promotion ────────────────────────────────────────────────
  // An absent, empty, or blank-element grant must never be defaulted. The DB
  // CHECK catches `[]`; it does NOT catch `[null]` or `['']`, which are the
  // same denies-everyone state smuggled past it by the layer meant to
  // front-run the constraint.
  it("rejects a fact grant that is absent, empty, or has no usable principal", () => {
    for (const bad of [undefined, [], [null], [""], [123], [null, ""]]) {
      expectFactRejected((f) => { f.visibleTo = bad; }, "visibleTo");
    }
  });

  it("accepts anything the CHECK accepts — the importer is never stricter than the DB", () => {
    // Load-bearing: a workspace whose grant Postgres legally stores must stay
    // migratable. An importer stricter than `chk_*_grant_nonempty` would leave
    // that workspace permanently stuck in its current region, discovered only
    // at cutover time. Grammar validity is #4768's read-time deny+log problem,
    // not a reason to refuse a bundle.
    for (const odd of [["everyone"], ["  "], ["org", null], ["org", ""]]) {
      const bundle = brainBundle();
      (bundle.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>).visibleTo = odd;
      expect(validateBundle(bundle).ok).toBe(true);
    }
  });

  it("rejects an episode grant that is absent, empty, or has blank principals", () => {
    for (const bad of [undefined, [], [null], [""]]) {
      const bundle = brainBundle();
      (bundle.brainEpisodes![0] as unknown as Record<string, unknown>).visibleTo = bad;
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("visibleTo");
    }
  });

  // ── no-provenance-no-promotion ───────────────────────────────────────────
  it("rejects a fact whose provenance is absent, empty, or not an object", () => {
    for (const bad of [undefined, null, {}, [], "actor"]) {
      expectFactRejected((f) => { f.provenance = bad; }, "provenance");
    }
  });

  // ── content-mode vocabulary ──────────────────────────────────────────────
  it("rejects a fact with an unknown status", () => {
    expectFactRejected((f) => { f.status = "live"; }, "status");
    expectFactRejected((f) => { delete f.status; }, "status");
  });

  it("accepts a fact with NO predicateCardinality, and one with a nonsense value (#5035)", () => {
    // v3 dropped the field: #5027 moved cardinality onto the canonical
    // predicate, and the per-row values were LLM guesses. The importer ignores
    // it, so validation must not gate on it in either direction — refusing an
    // absent one would reject every v3 bundle, and refusing a bad one would
    // strand a legacy workspace over a field nothing reads.
    for (const value of [undefined, "one", 7, null]) {
      const bundle = brainBundle();
      const fact = bundle.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>;
      if (value === undefined) delete fact.predicateCardinality;
      else fact.predicateCardinality = value;
      expect(validateBundle(bundle).ok).toBe(true);
    }
  });

  // ── identity on the wire (#5035, ADR-0037 §8) ────────────────────────────
  //
  // The importer discriminates its two key arms on the MANIFEST — carry at v3,
  // compute below it — so validation has to make the manifest's claim true.
  // Presence is checked in both directions, and the asymmetry in the two
  // failures is why:
  //
  //   a v3 fact MISSING a key  → lands unkeyed, joins nothing, and the publish
  //                              disclosure says "nothing to supersede" without
  //                              being able to say the check could not run
  //   a v2 fact CARRYING a key → the legacy arm recomputes it anyway, so the
  //                              importer would hold two answers for one row

  const IDENTITY_FIELDS = ["subjectKey", "predicateKey", "objectKey", "subjectCmp", "objectCmp"] as const;

  /** `brainBundle()` at v3, with every identity field present. */
  function v3BrainBundle(): ExportBundle {
    const bundle = brainBundle();
    (bundle.manifest as unknown as Record<string, unknown>).version = 3;
    Object.assign(bundle.brainEpisodes![0].facts[0]!, {
      subjectKey: "acme:pro",
      predicateKey: "price per seat",
      objectKey: "49",
      subjectCmp: null,
      objectCmp: "money:USD:49",
    });
    return bundle;
  }

  it("accepts a v3 fact carrying its identity, nulls included", () => {
    expect(validateBundle(v3BrainBundle()).ok).toBe(true);

    // `null` at EVERY position, which is a legal row and not a broken one: a
    // surface that normalizes away has no key, permanently, and NULL is how
    // `unknown` is spelled at a `_cmp`. A validator that tested truthiness
    // instead of presence would refuse it.
    const allNull = v3BrainBundle();
    for (const field of IDENTITY_FIELDS) {
      (allNull.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>)[field] = null;
    }
    expect(validateBundle(allNull).ok).toBe(true);
  });

  it("rejects a v3 fact missing an identity field, or carrying one of the wrong type", () => {
    for (const field of IDENTITY_FIELDS) {
      const missing = v3BrainBundle();
      delete (missing.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>)[field];
      const result = validateBundle(missing);
      expect(result.ok, `a v3 fact with no '${field}' was accepted`).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);

      // A non-string, non-null value would be bound straight into a `text`
      // column the destination's collision join reads — and at `object_cmp`
      // that join stamps `valid_to`.
      const wrongType = v3BrainBundle();
      (wrongType.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>)[field] = 49;
      expect(validateBundle(wrongType).ok, `a numeric '${field}' was accepted`).toBe(false);
    }
  });

  it("refuses an EMPTY slot key, and accepts an empty `_cmp`", () => {
    // ⚠️ The split is the test. `""` at a SLOT KEY is not inert the way `null`
    // is: `=` matches every OTHER empty key, so a bundle carrying them puts
    // unrelated claims in ONE slot, where reconcile corroborates them into a
    // single row and the publish gate stamps `valid_to` across the group. No
    // writer produces one — `slotKey` returns `null` for a surface that
    // normalizes away and 0187 backfills through `NULLIF(…, '')` — and the
    // column has no CHECK, so validation is the only place it can be refused.
    //
    // At the two `_cmp` positions there is nothing to refuse HERE: they go
    // through `regionPortableComparable`, which reads `""` as absent. Asserting
    // the accept side is what makes this a split rather than a blanket rule —
    // and it is what fails if the key/cmp partition is ever inverted, which a
    // type predicate cannot catch because TypeScript does not check its body.
    for (const field of ["subjectKey", "predicateKey", "objectKey"] as const) {
      const bundle = v3BrainBundle();
      (bundle.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>)[field] = "";
      const result = validateBundle(bundle);
      expect(result.ok, `an empty '${field}' was accepted`).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
    for (const field of ["subjectCmp", "objectCmp"] as const) {
      const bundle = v3BrainBundle();
      (bundle.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>)[field] = "";
      expect(validateBundle(bundle).ok, `an empty '${field}' was refused`).toBe(true);
    }
  });

  it("rejects a v1/v2 fact that carries identity it has no format for", () => {
    for (const version of [1, 2]) {
      for (const field of IDENTITY_FIELDS) {
        const bundle = brainBundle();
        (bundle.manifest as unknown as Record<string, unknown>).version = version;
        // v1 has no required sections, so this is a valid bundle at either
        // version once the field is removed again.
        (bundle.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>)[field] = "smuggled";
        const result = validateBundle(bundle);
        expect(result.ok, `a v${version} fact carrying '${field}' was accepted`).toBe(false);
        if (!result.ok) expect(result.error).toContain(field);
      }
    }
  });

  // ── NOT NULL timestamps ──────────────────────────────────────────────────
  // node-pg binds `undefined` as NULL, and an explicit NULL overrides the
  // column default — so an omitted timestamp is a 23502 that rolls back the
  // entire import, not a silently-defaulted `now()`.
  it("rejects a fact missing a NOT NULL timestamp", () => {
    for (const field of ["ingestedAt", "createdAt", "updatedAt"]) {
      expectFactRejected((f) => { delete f[field]; }, field);
    }
  });

  it("rejects an episode missing a NOT NULL timestamp", () => {
    for (const field of ["ingestedAt", "createdAt"]) {
      const bundle = brainBundle();
      delete (bundle.brainEpisodes![0] as unknown as Record<string, unknown>)[field];
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
  });

  it("rejects a fact whose closed validity interval runs backwards", () => {
    expectFactRejected((f) => {
      f.validFrom = "2026-06-01T00:00:00Z";
      f.validTo = "2026-01-01T00:00:00Z";
    }, "precedes");
  });

  // ── episode body XOR locator ─────────────────────────────────────────────
  it("rejects an episode carrying both a body and a locator, or neither", () => {
    for (const [body, locator] of [
      ["b", "l"],
      [undefined, undefined],
      [null, null],
    ] as const) {
      const bundle = brainBundle();
      const e = bundle.brainEpisodes![0] as unknown as Record<string, unknown>;
      e.body = body;
      e.locator = locator;
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("brainEpisodes[0]");
    }
  });

  it("rejects an episode whose body is present but not a non-empty string", () => {
    // The guard must reject the wrong TYPE rather than read it as "absent" —
    // a numeric body would otherwise pass the XOR check and still be bound.
    for (const bad of [5, "", {}]) {
      const bundle = brainBundle();
      const e = bundle.brainEpisodes![0] as unknown as Record<string, unknown>;
      e.body = bad;
      e.locator = null;
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
    }
  });

  // ── edges ────────────────────────────────────────────────────────────────
  it("rejects an unknown edge type", () => {
    const bundle = brainBundle();
    (bundle.brainEdges![0] as unknown as Record<string, unknown>).edgeType = "contradicts";
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("edgeType");
  });

  it("rejects an edge with zero or two endpoints on a side", () => {
    for (const patch of [
      { toEpisodeId: null }, // zero on the `to` side
      { toFactId: "fact-1" }, // two on the `to` side
      { fromFactId: null }, // zero on the `from` side
    ]) {
      const bundle = brainBundle();
      Object.assign(bundle.brainEdges![0] as unknown as Record<string, unknown>, patch);
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("brainEdges[0]");
    }
  });

  it("rejects an edge whose endpoint kind contradicts its type", () => {
    // Mirrors chk_brain_edges_endpoint_kinds: `provenance` is the EVIDENCE
    // pointer and must reach an episode; arbitration types compare claims.
    const provenanceAtFact = brainBundle();
    Object.assign(provenanceAtFact.brainEdges![0] as unknown as Record<string, unknown>, {
      toEpisodeId: null,
      toFactId: "fact-1",
    });
    expect(validateBundle(provenanceAtFact).ok).toBe(false);

    const supersedesAtEpisode = brainBundle();
    Object.assign(supersedesAtEpisode.brainEdges![0] as unknown as Record<string, unknown>, {
      edgeType: "supersedes",
    });
    expect(validateBundle(supersedesAtEpisode).ok).toBe(false);
  });

  it("rejects an edge pointing at an id the bundle does not carry", () => {
    // Edges import LAST, so a dangling endpoint would otherwise abort the
    // transaction after every other pillar has already been written.
    const bundle = brainBundle();
    (bundle.brainEdges![0] as unknown as Record<string, unknown>).toEpisodeId = "ep-missing";
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not carried by this bundle");
  });

  it("rejects a malformed audience member", () => {
    for (const field of ["audienceId", "userId", "source", "createdAt"]) {
      const bundle = brainBundle();
      delete (bundle.factAudienceMembers![0] as unknown as Record<string, unknown>)[field];
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("factAudienceMembers[0]");
    }
  });

  it("rejects non-array brain sections", () => {
    for (const section of ["brainEpisodes", "brainEdges", "factAudienceMembers"] as const) {
      const bundle = brainBundle();
      (bundle as unknown as Record<string, unknown>)[section] = "nope";
      const result = validateBundle(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(section);
    }
  });

  // ── The pre-widening grant travels (#4836) ───────────────────────────────
  //
  // Pairs with `residency/__tests__/export.test.ts`. Between them, dropping
  // the column from either side of the bundle now fails a test that ALWAYS
  // runs, rather than only the `-pg` round-trip that skips silently without a
  // database — which is how round 1 of the review panel came to find this by
  // hand. The bundle-scope tripwire gates new TABLES, not new COLUMNS, and
  // TypeScript cannot see a missing bind in a positional INSERT.
  //
  // The failure is not loud: a widened fact landing with a NULL pre-widening
  // grant reads as never-widened in the target region and discloses its first
  // episode's actor, channel and timestamp to the whole org. The import writes
  // `status` verbatim, so the fact never re-publishes and the widening UPDATE
  // that derives the column never runs again to repair it.

  function widenedBundle(preWidening: unknown): ExportBundle {
    const bundle = brainBundle();
    const fact = bundle.brainEpisodes![0].facts[0] as unknown as Record<string, unknown>;
    if (preWidening === undefined) delete fact.preWideningVisibleTo;
    else fact.preWideningVisibleTo = preWidening;
    return bundle;
  }

  it("names the column on the INSERT and binds the bundle's value", async () => {
    const { client, calls } = v2CaptureClient();
    await importBundle(client, widenedBundle(["audience:chat-channel:slack:C-FOUNDERS"]), "org-test");

    const insert = calls.find((c) => c.sql.includes("INSERT INTO brain_facts"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("pre_widening_visible_to");
    // Positional INSERT, so ORDER is the contract — a misplaced bind would
    // write one grant into the other's column. Anchored off `visible_to`,
    // which the column list puts immediately before it.
    const visibleToAt = insert!.params.findIndex((p) => Array.isArray(p) && p.includes("org"));
    expect(visibleToAt).toBeGreaterThan(-1);
    expect(insert!.params[visibleToAt + 1]).toEqual(["audience:chat-channel:slack:C-FOUNDERS"]);
  });

  it("binds null when the bundle carries none, so the fact stays disclosed", async () => {
    // The negative, and the legacy-bundle path: a pre-#4836 exporter emits no
    // such field. An importer that defaulted it to the live grant would
    // withhold attribution across the whole imported corpus — the opposite
    // failure, equally silent, and the one #4836 explicitly refuses.
    const { client, calls } = v2CaptureClient();
    await importBundle(client, widenedBundle(undefined), "org-test");

    const insert = calls.find((c) => c.sql.includes("INSERT INTO brain_facts"));
    expect(insert!.sql).toContain("pre_widening_visible_to");
    const visibleToAt = insert!.params.findIndex((p) => Array.isArray(p) && p.includes("org"));
    expect(insert!.params[visibleToAt + 1]).toBeNull();
  });

  it("restores an out-of-vocabulary episode source VERBATIM — the carve-out is real", async () => {
    // `lib/brain/sources.ts` closes the episode-source vocabulary and
    // `registerBrainSourceConnector` enforces it, but the region import is the
    // documented exception: a bundle written by a NEWER vocabulary must still
    // import, or a workspace whose source region has shipped a new connector
    // becomes permanently unmigratable. That is the same reasoning
    // `grantProblem` records — anything Postgres stores must remain migratable.
    //
    // Pinned in BOTH directions, because each has a real cost. Rejecting the
    // value strands the workspace; NORMALISING it (to `human`, to `null`, to a
    // nearest member) would silently rewrite provenance and, if the true kind
    // were warehouse-shaped, hand tier-1 facts a correction path ADR-0036
    // forbids. Verbatim is the only answer that is neither.
    const bundle = brainBundle();
    const episode = bundle.brainEpisodes![0] as unknown as Record<string, unknown>;
    episode.source = "snowflake";
    // The FACT's own provenance too, and that is the load-bearing half: the
    // #4964 quarantine reads `brain_facts.provenance.source`, NOT this episode
    // row, and nothing cross-checks the two (`admin-migrate.ts` says so at the
    // insert). If a future normalisation or key-allowlist stripped this value
    // on the way in, the quarantine would become silently unreachable while
    // every fake-store unit test stayed green.
    (episode.facts as Array<Record<string, unknown>>)[0]!.provenance = {
      source: "snowflake",
      producer: "region-import",
    };
    // Validation does not gate it — the carve-out starts here, not at the INSERT.
    expect(validateBundle(bundle).ok).toBe(true);

    const { client, calls } = v2CaptureClient();
    await importBundle(client, bundle, "org-test");

    const insert = calls.find((c) => c.sql.includes("INSERT INTO brain_episodes"));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain("snowflake");

    // The fact's provenance survives byte-for-byte, `source` included.
    const factInsert = calls.find((c) => c.sql.includes("INSERT INTO brain_facts"));
    expect(factInsert).toBeDefined();
    expect(factInsert!.params).toContain(
      JSON.stringify({ source: "snowflake", producer: "region-import" }),
    );
    // The route logs this (`admin-migrate.ts`) precisely because the value then
    // escapes `isWarehouseDerived` — `lib/brain/__tests__/sources.test.ts` pins
    // that the predicate really does decline `"snowflake"`.
    //
    // The log is no longer the only signal (#4964): because nothing here can
    // tell whether the kind is warehouse-shaped, `correction.ts` refuses to
    // CORRECT any fact carrying it, under `UNRECOGNIZED_SOURCE_KIND`. That
    // refusal is what makes accepting the value verbatim safe rather than
    // merely documented, and it is pinned in `lib/brain/__tests__/correction.test.ts`.
    // This assertion — that the import still ACCEPTS it — is the other half of
    // that bargain and must not be relaxed into a rejection: the rule
    // `acl.ts`'s header states for GRANTS — never stricter at import than the
    // database is at rest — holds here for the same reason, and this column
    // carries no CHECK at all, so the bar is lower still.
  });

  it("REFUSES a pre-widening grant of the wrong shape", () => {
    // Caught in `validateBundle`, not at the INSERT. `"org"` would otherwise
    // abort the whole cutover on a raw `malformed array literal` after every
    // earlier pillar is already written — and `{}` is worse: node-pg
    // stringifies it to `{}`, which Postgres accepts as a legal empty
    // `text[]`, so junk silently becomes a real ACL value.
    for (const bad of ["org", 42, {}, [1, 2]]) {
      const result = validateBundle(widenedBundle(bad));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("preWideningVisibleTo");
    }
  });

  it("accepts absent, null, and an array of strings", () => {
    // The permissive half must stay permissive, and `grantProblem` is the
    // WRONG validator here for exactly that reason: absent is a legacy
    // bundle, `null` is "never widened", and `[]` is the source region saying
    // it could not vouch for the grant and wants the target to withhold.
    for (const good of [undefined, null, [], ["org"], ["audience:x", "role:admin"]]) {
      expect(validateBundle(widenedBundle(good)).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The curated identity vocabulary (#5022, ADR-0037 §6/§8)
// ---------------------------------------------------------------------------
//
// This is the UNTRUSTED-INPUT boundary for a cross-region POST, and every arm
// below existed with no test at all: deleting the whole validation block left
// this file green. The stakes are in the block's own comment — an unrecognized
// `slotPosition` fails the table's CHECK mid-transaction and rolls back an
// import that has already written every earlier pillar.
//
// The re-norm arms are the ones that are not merely defensive. The importer is
// the SECOND writer into `brain_vocabulary_edge` and the only one that cannot
// re-norm (ADR-0037 §8 carries a row-copy path verbatim rather than rewriting
// another region's decision), so refusal is the only remaining guard: nothing
// in the schema rejects `Priced At`, and it would import "successfully" as an
// alias that can never match anything.

describe("validateBundle — the vocabulary (#5022)", () => {
  const vocabularyBundle = (edges: unknown[]): unknown => ({
    ...validV2Bundle(),
    brainVocabularyEdges: edges,
  });

  const validEdge = () => ({
    slotPosition: "predicate",
    fromNorm: "is priced at",
    toNorm: "priced at",
    approvedBy: "user-1",
    approvedAt: "2026-06-01T00:00:00Z",
  });

  it("accepts a well-formed vocabulary section (the control)", () => {
    // Without this, every refusal below is satisfied by a validator that
    // rejects the section unconditionally.
    const result = validateBundle(
      vocabularyBundle([validEdge(), { ...validEdge(), fromNorm: "priced at", toNorm: "unit price", approvedBy: null }]),
    );
    expect(result.ok).toBe(true);
    // …and the section SURVIVED. `ok: true` alone would pass a validator that
    // accepted the bundle while silently dropping the vocabulary, which is the
    // exact failure the route's zod declaration exists to prevent.
    if (result.ok) expect(result.bundle.brainVocabularyEdges).toHaveLength(2);
  });

  it("refuses a non-object element", () => {
    for (const bad of [null, 42, "edge", []]) {
      const result = validateBundle(vocabularyBundle([bad]));
      expect(result.ok, `element ${JSON.stringify(bad)} was accepted`).toBe(false);
      if (!result.ok) expect(result.error).toContain("brainVocabularyEdges[0]");
    }
  });

  it("refuses a section that is not an array", () => {
    const result = validateBundle({ ...validV2Bundle(), brainVocabularyEdges: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("brainVocabularyEdges");
  });

  it("refuses an unrecognized slot position, naming the row", () => {
    // The arm that matters most: this value is part of the primary key, and
    // without the check it reaches `ck_brain_vocabulary_edge_slot_position`
    // inside the import transaction and takes the whole migration with it.
    for (const bad of ["Predicate", "verb", "", 42, null, undefined]) {
      const result = validateBundle(vocabularyBundle([{ ...validEdge(), slotPosition: bad }]));
      expect(result.ok, `slotPosition ${JSON.stringify(bad)} was accepted`).toBe(false);
      if (!result.ok) expect(result.error).toContain("brainVocabularyEdges[0].slotPosition");
    }
  });

  it("refuses a non-string or missing norm", () => {
    for (const bad of [42, null, undefined, {}]) {
      expect(validateBundle(vocabularyBundle([{ ...validEdge(), fromNorm: bad }])).ok).toBe(false);
      expect(validateBundle(vocabularyBundle([{ ...validEdge(), toNorm: bad }])).ok).toBe(false);
    }
  });

  it("refuses an empty norm on either side", () => {
    // The `DEFAULT ''` hazard migration 0187 rejects, reached through the
    // bundle: a stored empty key joins every other degenerate row.
    expect(validateBundle(vocabularyBundle([{ ...validEdge(), fromNorm: "" }])).ok).toBe(false);
    expect(validateBundle(vocabularyBundle([{ ...validEdge(), toNorm: "" }])).ok).toBe(false);
  });

  it("refuses a 1-cycle", () => {
    const identical = validateBundle(
      vocabularyBundle([{ ...validEdge(), fromNorm: "price", toNorm: "price" }]),
    );
    expect(identical.ok).toBe(false);

    // The post-NORMALIZATION 1-cycle (`Price` → `price`) is refused too, but by
    // the norm check below rather than by this arm — and the error says so.
    // Asserting only `ok === false` here would hide which guard is load-bearing,
    // and the explicit post-norm arm that used to exist was unreachable for
    // exactly this reason.
    const afterNorm = validateBundle(
      vocabularyBundle([{ ...validEdge(), fromNorm: "Price", toNorm: "price" }]),
    );
    expect(afterNorm.ok).toBe(false);
    if (!afterNorm.ok) expect(afterNorm.error).toContain("is not a lexical norm");
  });

  it("refuses an endpoint that is not already a lexical norm", () => {
    // `Priced At` on the `from` side is the silent one: it satisfies every
    // CHECK, imports as `imported`, and is an alias that can never fire,
    // because the lookup is keyed on the norm and would never match it.
    for (const raw of ["Priced At", "is_priced  at", " priced at "]) {
      const result = validateBundle(vocabularyBundle([{ ...validEdge(), fromNorm: raw }]));
      expect(result.ok, `fromNorm ${JSON.stringify(raw)} was accepted`).toBe(false);
      if (!result.ok) expect(result.error).toContain("is not a lexical norm");
    }
    const target = validateBundle(vocabularyBundle([{ ...validEdge(), toNorm: "Priced At" }]));
    expect(target.ok).toBe(false);
    if (!target.ok) expect(target.error).toContain("toNorm");
  });

  it("refuses a non-string approver, and an OMITTED one, but accepts null", () => {
    expect(validateBundle(vocabularyBundle([{ ...validEdge(), approvedBy: 42 }])).ok).toBe(false);
    // Omitted is refused rather than read as `null`. Optional AND nullable is
    // three input states for two meanings, and the omitted one would silently
    // record an AUTO-APPROVAL on the column an audit reads first — the same
    // reasoning that made `AliasEdgeInput.approvedBy` required-and-nullable,
    // applied at the boundary where the untrusted input actually arrives.
    const { approvedBy: _omitted, ...withoutApprover } = validEdge();
    const omitted = validateBundle(vocabularyBundle([withoutApprover]));
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) expect(omitted.error).toContain("approvedBy");
    // `null` is the legitimate auto-approved edge and must stay accepted.
    expect(validateBundle(vocabularyBundle([{ ...validEdge(), approvedBy: null }])).ok).toBe(true);
  });

  it("refuses a missing or malformed approval timestamp", () => {
    for (const bad of [undefined, "not-a-date", 42]) {
      const result = validateBundle(vocabularyBundle([{ ...validEdge(), approvedAt: bad }]));
      expect(result.ok, `approvedAt ${JSON.stringify(bad)} was accepted`).toBe(false);
      if (!result.ok) expect(result.error).toContain("approvedAt");
    }
  });

  it("rebuilds the closure even when the driver reports no rowCount", async () => {
    // The touched-set must not be gated on `rowCount`. That value is the one
    // whose ABSENCE means "did this land?" is unknowable, so gating the rebuild
    // on it commits an edge with no closure row — precisely the half-rebuilt
    // state `loadClaimVocabulary` refuses to load, reached through the importer.
    //
    // A real-Postgres test cannot see this: `pg` always reports `rowCount`, so
    // the gate is invisible there. A client that omits it is the only executor
    // that separates the two implementations.
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: InternalPoolClient = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        // The one statement this mock must answer honestly: the vocabulary
        // primitives refuse to run outside a transaction, and the probe is how
        // they tell. Everything else returns no rows AND no `rowCount`.
        if (sql.includes("FROM pg_locks")) return { rows: [{ n: 1 }] };
        return { rows: [] };
      },
      release: () => {},
    };

    await importBundle(client, vocabularyBundle([validEdge()]) as never, "org-test");

    expect(calls.some((c) => c.sql.includes("INSERT INTO brain_vocabulary_edge"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("INSERT INTO brain_vocabulary_target"))).toBe(true);
  });

  it("accepts a bundle with no vocabulary section at all", () => {
    // A pre-#5022 producer. The section is optional on the wire for the same
    // reason every other v2 section is.
    expect(validateBundle(validV2Bundle()).ok).toBe(true);
  });
});

/**
 * The enrolled reach's validation arm (#5196, ADR-0039).
 *
 * The region import is the SECOND write door into `brain_enrollment` — the admin
 * route is the first, and it goes through `normalizeEnrollmentPair`, which this
 * path does not. So these branches are the only thing standing between a bundle
 * and a row, and each one exists to stop a specific bad row:
 *
 *   - an empty half hits `ck_brain_enrollment_names_present` as a 23514
 *     **mid-transaction**, aborting an entire live region cutover over one row;
 *   - an UNTRIMMED half satisfies that CHECK (`entity <> ''` admits `"   "`)
 *     and lands a pair that sits in the destination's list looking live while
 *     the producer's `has()` can never match it;
 *   - an empty `enrolledBy` hits `ck_brain_enrollment_attributed` — authority
 *     nobody can be shown to have granted.
 */
describe("validateBundle — the enrolled reach (#5196)", () => {
  const enrollmentBundle = (rows: unknown[]): unknown => ({
    ...validV2Bundle(),
    brainEnrollments: rows,
  });

  const validEnrollment = () => ({
    entity: "accounts",
    dimension: "arr_band",
    enrolledAt: "2026-08-14T00:00:00Z",
    enrolledBy: "user-1",
    note: null,
  });

  it("accepts a well-formed enrollment section (the control)", () => {
    // Without this, every refusal below is satisfied by a validator that
    // rejects the section unconditionally.
    const result = validateBundle(
      enrollmentBundle([validEnrollment(), { ...validEnrollment(), dimension: "status", note: "why" }]),
    );
    expect(result.ok).toBe(true);
    // …and the section SURVIVED. `ok: true` alone would pass a validator that
    // accepted the bundle while silently dropping the reach — which lands a
    // destination whose producer emits nothing, indistinguishable from a
    // working one.
    if (result.ok) expect(result.bundle.brainEnrollments).toHaveLength(2);
  });

  it("refuses a non-array section", () => {
    for (const bad of ["nope", 42, {}]) {
      const result = validateBundle(enrollmentBundle(bad as never));
      expect(result.ok, `section ${JSON.stringify(bad)} was accepted`).toBe(false);
      if (!result.ok) expect(result.error).toContain("brainEnrollments");
    }
  });

  it("refuses a non-object element", () => {
    for (const bad of [null, 42, "row", []]) {
      const result = validateBundle(enrollmentBundle([bad]));
      expect(result.ok, `element ${JSON.stringify(bad)} was accepted`).toBe(false);
      if (!result.ok) expect(result.error).toContain("brainEnrollments[0]");
    }
  });

  it("refuses an empty or non-string half, naming the field AND the row", () => {
    for (const field of ["entity", "dimension"] as const) {
      for (const bad of ["", 42, null, undefined]) {
        // Row INDEX 1, so an `i`-vs-`0` slip in the loop goes red. A validator
        // that always reported row 0 would pass a bare field-name assertion.
        const result = validateBundle(
          enrollmentBundle([validEnrollment(), { ...validEnrollment(), [field]: bad }]),
        );
        expect(result.ok, `${field}=${JSON.stringify(bad)} was accepted`).toBe(false);
        if (!result.ok) expect(result.error).toContain(`brainEnrollments[1].${field}`);
      }
    }
  });

  it("refuses an untrimmed half — the CHECK would admit it and the producer never would", () => {
    for (const field of ["entity", "dimension"] as const) {
      for (const bad of ["  accounts", "accounts  ", "   "]) {
        const result = validateBundle(enrollmentBundle([{ ...validEnrollment(), [field]: bad }]));
        expect(result.ok, `${field}=${JSON.stringify(bad)} was accepted`).toBe(false);
      }
    }
    // The control: the same names WITHOUT surrounding whitespace are fine, so
    // this is a whitespace rule rather than a validator that refuses everything.
    expect(validateBundle(enrollmentBundle([validEnrollment()])).ok).toBe(true);
  });

  it("refuses an over-long half at the same bound the seam enforces", () => {
    const tooLong = "x".repeat(BRAIN_ENROLLMENT_NAME_MAX + 1);
    const atBound = "x".repeat(BRAIN_ENROLLMENT_NAME_MAX);
    expect(validateBundle(enrollmentBundle([{ ...validEnrollment(), entity: tooLong }])).ok).toBe(false);
    // The off-by-one control — `>` vs `>=` is the mistake this branch makes, and
    // without the at-bound case both spellings pass.
    expect(validateBundle(enrollmentBundle([{ ...validEnrollment(), entity: atBound }])).ok).toBe(true);
  });

  it("refuses an unattributed enrollment, whitespace included", () => {
    // ⚠️ `"   "` is the one that matters and the one a bare `=== ""` admits.
    // It passes `ck_brain_enrollment_attributed` (`enrolled_by <> ''`) too, so
    // it lands STORED — an enrollment that looks attributed and names nobody,
    // on the column an audit of "who authorized this?" reads first.
    for (const bad of ["", "   ", "\t", 42, null, undefined]) {
      const result = validateBundle(enrollmentBundle([{ ...validEnrollment(), enrolledBy: bad }]));
      expect(result.ok, `enrolledBy=${JSON.stringify(bad)} was accepted`).toBe(false);
      if (!result.ok) expect(result.error).toContain("enrolledBy");
    }
    // The control: a real author is accepted, so this is an attribution rule
    // rather than a validator that refuses the field outright.
    expect(validateBundle(enrollmentBundle([validEnrollment()])).ok).toBe(true);
  });

  it("refuses a NUL byte — the rule lives in the seam and reaches this door", () => {
    // The falsifier for the two doors sharing ONE rule set. The seam's
    // `normalizeEnrollmentPair` owns this rule; this arm never restates it, so
    // the test goes red the moment the import stops calling the seam. That is
    // exactly the regression the previous cut shipped: a rule added at one door
    // under a comment claiming both doors carried it.
    for (const field of ["entity", "dimension"] as const) {
      const result = validateBundle(
        enrollmentBundle([{ ...validEnrollment(), [field]: "acc\u0000ounts" }]),
      );
      expect(result.ok, `${field} with a NUL was accepted`).toBe(false);
      // The seam's own sentence travels out, rather than a second wording here.
      if (!result.ok) expect(result.error).toContain("NUL");
    }
  });

  it("accepts an absent or null note and refuses a non-string one", () => {
    const { note: _dropped, ...noNote } = validEnrollment();
    expect(validateBundle(enrollmentBundle([noNote])).ok).toBe(true);
    expect(validateBundle(enrollmentBundle([{ ...validEnrollment(), note: null }])).ok).toBe(true);
    expect(validateBundle(enrollmentBundle([{ ...validEnrollment(), note: 42 }])).ok).toBe(false);
  });

  it("refuses a missing or unparseable enrolledAt", () => {
    const { enrolledAt: _dropped, ...noStamp } = validEnrollment();
    expect(validateBundle(enrollmentBundle([noStamp])).ok).toBe(false);
    expect(validateBundle(enrollmentBundle([{ ...validEnrollment(), enrolledAt: "yesterday" }])).ok).toBe(
      false,
    );
  });

  it("accepts a bundle with no enrollment section at all", () => {
    // A pre-#5196 producer. Optional on the wire like every other v2 section.
    expect(validateBundle(validV2Bundle()).ok).toBe(true);
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
