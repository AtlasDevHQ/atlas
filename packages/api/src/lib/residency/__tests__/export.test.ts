/**
 * Tests for workspace data export for cross-region migration.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

const mockPoolQueryResults: Record<string, { rows: unknown[] }> = {};
let mockPoolQueryError: Error | null = null;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({
    query: (sql: string, _params: unknown[]) => {
      if (mockPoolQueryError) return Promise.reject(mockPoolQueryError);
      for (const [key, value] of Object.entries(mockPoolQueryResults)) {
        if (sql.includes(key)) return Promise.resolve(value);
      }
      return Promise.resolve({ rows: [] });
    },
    end: async () => {},
    on: () => {},
  }),
  internalQuery: () => Promise.resolve([]),
  internalExecute: () => {},
  getWorkspaceRegion: () => Promise.resolve(null),
  setWorkspaceRegion: () => Promise.resolve({ assigned: true }),
  insertSemanticAmendment: async () => "mock-amendment-id",
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ── Import after mocks ──────────────────────────────────────────────

const { exportWorkspaceBundle } = await import("../export");

// ── Helpers ─────────────────────────────────────────────────────────

function resetMocks() {
  for (const key of Object.keys(mockPoolQueryResults)) {
    delete mockPoolQueryResults[key];
  }
  mockPoolQueryError = null;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("exportWorkspaceBundle", () => {
  beforeEach(resetMocks);

  it("exports an empty bundle for a workspace with no data", async () => {
    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.manifest.version).toBe(1);
    expect(bundle.manifest.source.label).toBe("region-migration");
    expect(bundle.manifest.counts.conversations).toBe(0);
    expect(bundle.manifest.counts.messages).toBe(0);
    expect(bundle.manifest.counts.semanticEntities).toBe(0);
    expect(bundle.manifest.counts.learnedPatterns).toBe(0);
    expect(bundle.manifest.counts.settings).toBe(0);
    expect(bundle.conversations).toHaveLength(0);
    expect(bundle.semanticEntities).toHaveLength(0);
    expect(bundle.learnedPatterns).toHaveLength(0);
    expect(bundle.settings).toHaveLength(0);
  });

  it("exports conversations with messages", async () => {
    // Conversations query — key on unique column list
    mockPoolQueryResults["SELECT id, user_id"] = {
      rows: [
        {
          id: "conv-1",
          user_id: "user-1",
          title: "Test conversation",
          surface: "web",
          connection_id: null,
          starred: false,
          created_at: "2026-04-01T00:00:00Z",
          updated_at: "2026-04-01T01:00:00Z",
        },
      ],
    };
    // Messages JOIN query — key on unique column alias
    mockPoolQueryResults["m.conversation_id"] = {
      rows: [
        { id: "msg-1", conversation_id: "conv-1", role: "user", content: "Hello", created_at: "2026-04-01T00:00:00Z" },
        { id: "msg-2", conversation_id: "conv-1", role: "assistant", content: "Hi!", created_at: "2026-04-01T00:00:01Z" },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.conversations).toHaveLength(1);
    expect(bundle.conversations[0].id).toBe("conv-1");
    expect(bundle.conversations[0].userId).toBe("user-1");
    expect(bundle.conversations[0].messages).toHaveLength(2);
    expect(bundle.manifest.counts.conversations).toBe(1);
    expect(bundle.manifest.counts.messages).toBe(2);
  });

  it("groups messages by conversation correctly", async () => {
    mockPoolQueryResults["SELECT id, user_id"] = {
      rows: [
        { id: "conv-1", user_id: "user-1", title: "First", surface: "web", connection_id: null, starred: false, created_at: "2026-04-01T00:00:00Z", updated_at: "2026-04-01T00:00:00Z" },
        { id: "conv-2", user_id: "user-1", title: "Second", surface: "web", connection_id: null, starred: false, created_at: "2026-04-01T01:00:00Z", updated_at: "2026-04-01T01:00:00Z" },
      ],
    };
    mockPoolQueryResults["m.conversation_id"] = {
      rows: [
        { id: "msg-1", conversation_id: "conv-1", role: "user", content: "Hello", created_at: "2026-04-01T00:00:00Z" },
        { id: "msg-2", conversation_id: "conv-2", role: "user", content: "World", created_at: "2026-04-01T01:00:00Z" },
        { id: "msg-3", conversation_id: "conv-2", role: "assistant", content: "Reply", created_at: "2026-04-01T01:00:01Z" },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.conversations).toHaveLength(2);
    expect(bundle.conversations[0].messages).toHaveLength(1);
    expect(bundle.conversations[0].messages[0].id).toBe("msg-1");
    expect(bundle.conversations[1].messages).toHaveLength(2);
    expect(bundle.conversations[1].messages[0].id).toBe("msg-2");
    expect(bundle.manifest.counts.messages).toBe(3);
  });

  it("exports semantic entities", async () => {
    mockPoolQueryResults["FROM semantic_entities"] = {
      rows: [
        { name: "users", entity_type: "entity", yaml_content: "table: users\n", connection_id: null },
        { name: "orders", entity_type: "entity", yaml_content: "table: orders\n", connection_id: "conn-1" },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.semanticEntities).toHaveLength(2);
    expect(bundle.semanticEntities[0].name).toBe("users");
    expect(bundle.semanticEntities[1].connectionId).toBe("conn-1");
    expect(bundle.manifest.counts.semanticEntities).toBe(2);
  });

  it("exports learned patterns", async () => {
    mockPoolQueryResults["FROM learned_patterns"] = {
      rows: [
        {
          pattern_sql: "SELECT COUNT(*) FROM users",
          description: "User count",
          source_entity: "users",
          confidence: 0.9,
          status: "approved",
        },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.learnedPatterns).toHaveLength(1);
    expect(bundle.learnedPatterns[0].patternSql).toBe("SELECT COUNT(*) FROM users");
    expect(bundle.learnedPatterns[0].confidence).toBe(0.9);
    expect(bundle.manifest.counts.learnedPatterns).toBe(1);
  });

  it("exports org-scoped settings", async () => {
    mockPoolQueryResults["FROM settings"] = {
      rows: [
        { key: "theme", value: "dark" },
        { key: "model", value: "claude-3-opus" },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.settings).toHaveLength(2);
    expect(bundle.settings[0].key).toBe("theme");
    expect(bundle.settings[1].key).toBe("model");
    expect(bundle.manifest.counts.settings).toBe(2);
  });

  it("uses custom source label when provided", async () => {
    const bundle = await exportWorkspaceBundle("org-1", "region-migration:us-east");

    expect(bundle.manifest.source.label).toBe("region-migration:us-east");
  });

  it("propagates database errors", async () => {
    mockPoolQueryError = new Error("connection refused");

    await expect(exportWorkspaceBundle("org-1")).rejects.toThrow("connection refused");
  });
});
