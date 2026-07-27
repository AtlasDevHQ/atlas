/**
 * Tests for workspace data export for cross-region migration.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

const mockPoolQueryResults: Record<string, { rows: unknown[] }> = {};
let mockPoolQueryError: Error | null = null;
const recordedQueries: Array<{ sql: string; params: unknown[] }> = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({
    query: (sql: string, params: unknown[]) => {
      recordedQueries.push({ sql, params });
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
  getPendingAmendmentCount: async () => 0,
}));

void mock.module("@atlas/api/lib/logger", () => ({
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
  recordedQueries.length = 0;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("exportWorkspaceBundle", () => {
  beforeEach(resetMocks);

  it("exports an empty bundle for a workspace with no data", async () => {
    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.manifest.version).toBe(2);
    expect(bundle.manifest.source.label).toBe("region-migration");
    expect(bundle.manifest.counts.conversations).toBe(0);
    expect(bundle.manifest.counts.messages).toBe(0);
    expect(bundle.manifest.counts.semanticEntities).toBe(0);
    expect(bundle.manifest.counts.learnedPatterns).toBe(0);
    expect(bundle.manifest.counts.settings).toBe(0);
    expect(bundle.manifest.counts.dashboards).toBe(0);
    expect(bundle.manifest.counts.knowledgeDocuments).toBe(0);
    expect(bundle.manifest.counts.scheduledTasks).toBe(0);
    expect(bundle.manifest.counts.agentSessionMemory).toBe(0);
    expect(bundle.conversations).toHaveLength(0);
    expect(bundle.semanticEntities).toHaveLength(0);
    expect(bundle.learnedPatterns).toHaveLength(0);
    expect(bundle.settings).toHaveLength(0);
    // v2 sections are always PRESENT (possibly empty) on a produced bundle —
    // presence is what the importer's v2 validation requires (#4460).
    expect(bundle.dashboards).toHaveLength(0);
    expect(bundle.knowledgeDocuments).toHaveLength(0);
    expect(bundle.scheduledTasks).toHaveLength(0);
    expect(bundle.agentSessionMemory).toHaveLength(0);
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
        { name: "users", entity_type: "entity", yaml_content: "table: users\n", connection_group_id: null },
        { name: "orders", entity_type: "entity", yaml_content: "table: orders\n", connection_group_id: "g-prod" },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.semanticEntities).toHaveLength(2);
    expect(bundle.semanticEntities[0].name).toBe("users");
    expect(bundle.semanticEntities[1].connectionGroupId).toBe("g-prod");
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
          auto_promoted: false,
        },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.learnedPatterns).toHaveLength(1);
    expect(bundle.learnedPatterns[0].patternSql).toBe("SELECT COUNT(*) FROM users");
    expect(bundle.learnedPatterns[0].confidence).toBe(0.9);
    // Human-approval provenance carried so the eligibility bypass survives the
    // region migration (#4571).
    expect(bundle.learnedPatterns[0].autoPromoted).toBe(false);
    expect(bundle.manifest.counts.learnedPatterns).toBe(1);
  });

  it("carries the machine-promoted flag (#4571) so a migrated pattern stays confidence-gated", async () => {
    mockPoolQueryResults["FROM learned_patterns"] = {
      rows: [
        {
          pattern_sql: "SELECT COUNT(*) FROM orders",
          description: "Order count",
          source_entity: "orders",
          confidence: 0.9,
          status: "approved",
          auto_promoted: true,
        },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");
    expect(bundle.learnedPatterns[0].autoPromoted).toBe(true);
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

  it("records the source apiUrl in the manifest when provided (CLI path)", async () => {
    const bundle = await exportWorkspaceBundle(null, "self-hosted", "http://localhost:3001");

    expect(bundle.manifest.source.apiUrl).toBe("http://localhost:3001");
  });

  it("null org scope emits IS NULL clauses with ZERO bind params on every section query", async () => {
    // The CLI (`atlas-operator export`) depends entirely on this path for
    // no-auth self-hosted instances. If `scopeClause` regressed to `= $1`
    // with an empty params array, real Postgres would throw — but a
    // results-only mock would stay green. Assert the SQL/param pairing.
    await exportWorkspaceBundle(null, "self-hosted");

    expect(recordedQueries.length).toBeGreaterThanOrEqual(12); // one per section query
    for (const q of recordedQueries) {
      expect(q.sql).toContain("IS NULL");
      expect(q.sql).not.toContain("$1");
      expect(q.params).toEqual([]);
    }
  });

  it("string org scope emits = $1 with exactly one bind param on every section query", async () => {
    await exportWorkspaceBundle("org-1");

    expect(recordedQueries.length).toBeGreaterThanOrEqual(12);
    for (const q of recordedQueries) {
      expect(q.sql).toContain("= $1");
      expect(q.params).toEqual(["org-1"]);
    }
  });

  // ── v2 sections (#4460) ─────────────────────────────────────────────

  it("exports dashboards with nested cards and per-user drafts — share token excluded", async () => {
    mockPoolQueryResults["FROM dashboards WHERE"] = {
      rows: [
        {
          id: "dash-1",
          owner_id: "user-1",
          title: "Revenue",
          description: "MRR overview",
          share_mode: "org",
          refresh_schedule: "0 8 * * *",
          parameters: [{ key: "region", type: "string" }],
          first_published_at: "2026-06-01T00:00:00Z",
          created_at: "2026-05-01T00:00:00Z",
          updated_at: "2026-06-01T00:00:00Z",
        },
      ],
    };
    mockPoolQueryResults["FROM dashboard_cards"] = {
      rows: [
        {
          id: "card-1",
          dashboard_id: "dash-1",
          position: 0,
          title: "MRR",
          sql: "SELECT 1",
          chart_config: { type: "line" },
          content: null,
          annotations: [{ x: "2026-06-01", label: "launch" }],
          connection_group_id: "g-prod",
          layout: { x: 0, y: 0, w: 6, h: 4 },
          created_at: "2026-05-01T00:00:00Z",
          updated_at: "2026-05-02T00:00:00Z",
        },
      ],
    };
    mockPoolQueryResults["FROM dashboard_user_drafts"] = {
      rows: [
        {
          user_id: "user-2",
          dashboard_id: "dash-1",
          draft: { title: "Revenue (wip)", cards: [] },
          baseline: { title: "Revenue", cards: [] },
          published_baseline_at: "2026-06-01T00:00:00Z",
          created_at: "2026-06-02T00:00:00Z",
          updated_at: "2026-06-03T00:00:00Z",
        },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.dashboards).toHaveLength(1);
    const dash = bundle.dashboards![0];
    expect(dash.id).toBe("dash-1");
    expect(dash.shareMode).toBe("org");
    // Share tokens are region-bound and re-minted in the target — the wire
    // shape must not carry one at all.
    expect("shareToken" in dash).toBe(false);
    expect(dash.cards).toHaveLength(1);
    expect(dash.cards[0].connectionGroupId).toBe("g-prod");
    expect(dash.drafts).toHaveLength(1);
    expect(dash.drafts[0].userId).toBe("user-2");
    expect(bundle.manifest.counts.dashboards).toBe(1);
    expect(bundle.manifest.counts.dashboardCards).toBe(1);
    expect(bundle.manifest.counts.dashboardUserDrafts).toBe(1);
  });

  it("exports knowledge documents with review status and nested link graph", async () => {
    mockPoolQueryResults["FROM knowledge_documents WHERE"] = {
      rows: [
        {
          id: "doc-1",
          collection_id: "handbook",
          path: "policies/refunds.md",
          type: "guide",
          title: "Refund policy",
          description: null,
          tags: ["policy"],
          timestamp: "2026-03-01T00:00:00Z",
          resource: null,
          body: "# Refunds",
          atlas_source: "sync:endpoint",
          atlas_ingested_at: "2026-03-02T00:00:00Z",
          status: "draft",
          created_at: "2026-03-02T00:00:00Z",
          updated_at: "2026-03-02T00:00:00Z",
        },
      ],
    };
    mockPoolQueryResults["FROM knowledge_links"] = {
      rows: [
        { source_document_id: "doc-1", target_path: "policies/returns.md", anchor_text: "returns" },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.knowledgeDocuments).toHaveLength(1);
    const doc = bundle.knowledgeDocuments![0];
    expect(doc.id).toBe("doc-1");
    // Review status is preserved — a draft arrives as a draft (#4460).
    expect(doc.status).toBe("draft");
    expect(doc.docTimestamp).toBe("2026-03-01T00:00:00Z");
    expect(doc.links).toHaveLength(1);
    expect(doc.links[0].targetPath).toBe("policies/returns.md");
    expect(bundle.manifest.counts.knowledgeDocuments).toBe(1);
    expect(bundle.manifest.counts.knowledgeLinks).toBe(1);
  });

  it("exports scheduled-task definitions without run bookkeeping", async () => {
    mockPoolQueryResults["FROM scheduled_tasks"] = {
      rows: [
        {
          id: "task-1",
          owner_id: "user-1",
          name: "Weekly revenue",
          question: "What was revenue last week?",
          cron_expression: "0 9 * * 1",
          delivery_channel: "email",
          recipients: ["ops@example.com"],
          connection_group_id: "g-prod",
          approval_mode: "auto",
          enabled: true,
          plugin_id: null,
          created_at: "2026-05-01T00:00:00Z",
          updated_at: "2026-05-01T00:00:00Z",
        },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.scheduledTasks).toHaveLength(1);
    const task = bundle.scheduledTasks![0];
    expect(task.cronExpression).toBe("0 9 * * 1");
    // next/last run are deliberately absent — the importer recomputes
    // next_run_at so the target scheduler re-plans (#4460).
    expect("nextRunAt" in task).toBe(false);
    expect("lastRunAt" in task).toBe(false);
    expect(bundle.manifest.counts.scheduledTasks).toBe(1);
  });

  it("exports durable agent session memory slots", async () => {
    mockPoolQueryResults["FROM agent_session_memory"] = {
      rows: [
        {
          conversation_id: "conv-1",
          namespace: "scratchpad",
          value: { note: "user prefers weekly grain" },
          created_at: "2026-06-01T00:00:00Z",
          updated_at: "2026-06-02T00:00:00Z",
        },
      ],
    };

    const bundle = await exportWorkspaceBundle("org-1");

    expect(bundle.agentSessionMemory).toHaveLength(1);
    expect(bundle.agentSessionMemory![0].conversationId).toBe("conv-1");
    expect(bundle.agentSessionMemory![0].namespace).toBe("scratchpad");
    expect(bundle.manifest.counts.agentSessionMemory).toBe(1);
  });

  it("propagates database errors", async () => {
    mockPoolQueryError = new Error("connection refused");

    await expect(exportWorkspaceBundle("org-1")).rejects.toThrow("connection refused");
  });
});

/**
 * The bundle half of #4836 — a widened fact's ACL input has to reach the target
 * region, and nothing except a `-pg` test (which skips silently without a
 * database) otherwise notices when it stops.
 *
 * This is the gap that let round 1's CRITICAL exist: the bundle-scope tripwire
 * gates new TABLES, not new COLUMNS, so an ACL column added to an
 * already-exported table can be dropped from the SELECT with every always-run
 * gate green. TypeScript cannot see it either — the projection is `unknown`-in.
 */
describe("brain facts — the pre-widening grant travels (#4836)", () => {
  beforeEach(resetMocks);

  /** One `brain_facts` export row, as the SELECT would hand it back. */
  function factRow(preWidening: unknown) {
    return {
      id: "fact-1",
      source_episode_id: "ep-1",
      subject: "acme",
      predicate: "uses",
      object: "Postgres",
      valid_from: null,
      valid_to: null,
      ingested_at: "2026-06-01T00:00:00Z",
      invalidated_at: null,
      extracted_at: "2026-06-01T00:05:00Z",
      provenance: { actor: "U-FOUNDER" },
      status: "published",
      visible_to: ["audience:chat-channel:slack:C-FOUNDERS", "org"],
      pre_widening_visible_to: preWidening,
      predicate_cardinality: "single",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:05:00Z",
    };
  }

  function seed(preWidening: unknown) {
    mockPoolQueryResults["FROM brain_episodes WHERE"] = {
      rows: [
        {
          id: "ep-1",
          source: "slack",
          source_id: "C-FOUNDERS:1799999999.001",
          source_actor: "U-FOUNDER",
          body: "…",
          locator: null,
          occurred_at: "2026-06-01T00:00:00Z",
          ingested_at: "2026-06-01T00:00:00Z",
          extracted_at: "2026-06-01T00:05:00Z",
          visible_to: ["audience:chat-channel:slack:C-FOUNDERS"],
          created_at: "2026-06-01T00:00:00Z",
        },
      ],
    };
    mockPoolQueryResults["FROM brain_facts f"] = { rows: [factRow(preWidening)] };
  }

  const exportedFact = async () => {
    const bundle = await exportWorkspaceBundle("org-1");
    return bundle.brainEpisodes![0]!.facts[0]!;
  };

  it("SELECTs the column at all", async () => {
    seed(null);
    await exportWorkspaceBundle("org-1");
    const factQuery = recordedQueries.find((q) => q.sql.includes("FROM brain_facts f"));
    expect(factQuery).toBeDefined();
    // Without this the projection reads `undefined` and — before the narrowing
    // below existed — exported `null`, i.e. "never widened", for every fact.
    expect(factQuery!.sql).toContain("f.pre_widening_visible_to");
  });

  it("carries a widened fact's original grant into the bundle", async () => {
    seed(["audience:chat-channel:slack:C-FOUNDERS"]);
    expect((await exportedFact()).preWideningVisibleTo).toEqual([
      "audience:chat-channel:slack:C-FOUNDERS",
    ]);
  });

  it("carries NULL through as null, so a never-widened fact stays disclosed", async () => {
    // The negative. An exporter that defaulted this to the live grant would
    // withhold attribution across the whole imported corpus — the opposite
    // failure, equally silent, and the one #4836 explicitly refuses.
    seed(null);
    expect((await exportedFact()).preWideningVisibleTo).toBeNull();
  });

  it("degrades DRIFT to an empty grant, not to null", async () => {
    // `null` means "never widened" and DISCLOSES in the target region. A
    // column the SELECT dropped arrives `undefined`, and a driver that stopped
    // decoding `text[]` arrives as a string — neither is evidence that nothing
    // widened. Folding them into `null` is precisely the fail-open this
    // module's read-side twin (`attributionDecision`) refuses, with a blast
    // radius of a whole region and no way back. `[]` overlaps no reader token,
    // so the target withholds from everyone: visible, and recoverable.
    for (const drift of [undefined, "{org}", 42, {}]) {
      resetMocks();
      seed(drift);
      expect((await exportedFact()).preWideningVisibleTo).toEqual([]);
    }
  });
});
