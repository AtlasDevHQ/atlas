/**
 * Tests for migration bundle types — validates type shapes and bundle constants.
 */

import { describe, it, expect } from "bun:test";
import type { ExportBundle, ExportedBrainFact, ImportResult, ExportManifest, ExportedDashboard, ExportedKnowledgeDocument } from "../migration";
import { EXPORT_BUNDLE_VERSION } from "../migration";

describe("migration types", () => {
  it("EXPORT_BUNDLE_VERSION is 3 (v3 put a brain fact's identity on the wire, #5035)", () => {
    // Pinned as a literal rather than compared to itself. The importer
    // DISCRIMINATES on this number — carry the keys at v3, compute them below it
    // — so a bump that reached the exporter and not this constant would route v3
    // bundles through the re-derive arm ADR-0037 §8 exists to refuse.
    expect(EXPORT_BUNDLE_VERSION).toBe(3);
  });

  it("a legacy v1 bundle (four sections, v2 sections absent) still type-checks", () => {
    const bundle: ExportBundle = {
      manifest: {
        version: 1,
        exportedAt: "2026-04-02T00:00:00Z",
        source: { label: "self-hosted" },
        counts: {
          conversations: 1,
          messages: 2,
          semanticEntities: 1,
          learnedPatterns: 0,
          settings: 0,
        },
      },
      conversations: [
        {
          id: "conv-1",
          userId: null,
          title: "Test",
          surface: "web",
          connectionId: null,
          starred: false,
          createdAt: "2026-04-02T00:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
          messages: [
            { id: "msg-1", role: "user", content: "Hello", createdAt: "2026-04-02T00:00:00Z" },
          ],
        },
      ],
      semanticEntities: [
        { name: "users", entityType: "entity", yamlContent: "table: users", connectionGroupId: null },
      ],
      learnedPatterns: [],
      settings: [],
    };

    expect(bundle.manifest.version).toBe(1);
    expect(bundle.conversations).toHaveLength(1);
    expect(bundle.conversations[0].messages).toHaveLength(1);
  });

  it("a brain fact carries its identity from v3, with null legitimate at every position", () => {
    // The three states the wire has to express, and the reason the fields are
    // OPTIONAL and NULLABLE rather than one or the other (#5035, ADR-0037 §8):
    //
    //   absent — a v1/v2 bundle. Its facts are keyed once at import.
    //   null   — a v3 row that genuinely has no value there. A surface that
    //            normalizes away has no key, permanently; NULL is how `unknown`
    //            is spelled at a `_cmp`.
    //   string — the carried value.
    //
    // Optionality alone would not do: a required `string | null` makes every
    // legacy bundle unrepresentable. Nullability alone would not either: absent
    // and "no key" would collapse, and the importer discriminates its two arms
    // on the manifest precisely so they cannot.
    const carried: ExportedBrainFact = {
      id: "fact-1",
      subject: "Business tier",
      predicate: "bundled plan",
      object: "49 USD",
      validFrom: null,
      validTo: null,
      ingestedAt: "2026-08-06T00:00:00Z",
      invalidatedAt: null,
      extractedAt: null,
      provenance: { producer: "extraction:v1" },
      status: "published",
      visibleTo: ["org"],
      preWideningVisibleTo: null,
      subjectKey: "business tier",
      predicateKey: "bundled plan",
      // The permanent-null case: a surface made only of separators.
      objectKey: null,
      subjectCmp: "entity:01J7X",
      objectCmp: "money:USD:49",
      createdAt: "2026-08-06T00:00:00Z",
      updatedAt: "2026-08-06T00:00:00Z",
    };
    expect(carried.objectCmp).toBe("money:USD:49");
    expect(carried.objectKey).toBeNull();

    // …and the legacy shape, with every identity field absent, still typechecks
    // — which is the property that keeps a months-old bundle importable.
    const legacy: ExportedBrainFact = {
      ...carried,
      subjectKey: undefined,
      predicateKey: undefined,
      objectKey: undefined,
      subjectCmp: undefined,
      objectCmp: undefined,
      // The field v3 dropped. Still declared, so a consumer that sets it keeps
      // compiling; the importer ignores it.
      predicateCardinality: "single",
    };
    expect(legacy.subjectKey).toBeUndefined();
    expect(legacy.predicateCardinality).toBe("single");
  });

  it("a current bundle carries the #4460 sections with nested children", () => {
    const dashboard: ExportedDashboard = {
      id: "dash-1",
      ownerId: "user-1",
      title: "Revenue",
      description: null,
      shareMode: "org",
      refreshSchedule: null,
      parameters: [],
      firstPublishedAt: "2026-04-02T00:00:00Z",
      createdAt: "2026-04-02T00:00:00Z",
      updatedAt: "2026-04-02T00:00:00Z",
      cards: [
        {
          id: "card-1",
          position: 0,
          title: "MRR",
          sql: "SELECT 1",
          chartConfig: { type: "line" },
          content: null,
          annotations: [],
          connectionGroupId: null,
          layout: null,
          createdAt: "2026-04-02T00:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
        },
      ],
      drafts: [
        {
          userId: "user-1",
          draft: { title: "Revenue", cards: [] },
          baseline: { title: "Revenue", cards: [] },
          publishedBaselineAt: "2026-04-02T00:00:00Z",
          createdAt: "2026-04-02T00:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
        },
      ],
    };

    const doc: ExportedKnowledgeDocument = {
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
      status: "published",
      createdAt: "2026-04-02T00:00:00Z",
      updatedAt: "2026-04-02T00:00:00Z",
      links: [{ targetPath: "policies/returns.md", anchorText: "returns" }],
    };

    const bundle: ExportBundle = {
      manifest: {
        version: EXPORT_BUNDLE_VERSION,
        exportedAt: "2026-04-02T00:00:00Z",
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
      dashboards: [dashboard],
      knowledgeDocuments: [doc],
      scheduledTasks: [
        {
          id: "task-1",
          ownerId: "user-1",
          name: "Weekly revenue",
          question: "What was revenue last week?",
          cronExpression: "0 9 * * 1",
          deliveryChannel: "webhook",
          recipients: [],
          connectionGroupId: null,
          approvalMode: "auto",
          enabled: true,
          pluginId: null,
          createdAt: "2026-04-02T00:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
        },
      ],
      agentSessionMemory: [
        {
          conversationId: "conv-1",
          namespace: "scratchpad",
          value: { note: "seen" },
          createdAt: "2026-04-02T00:00:00Z",
          updatedAt: "2026-04-02T00:00:00Z",
        },
      ],
    };

    // The LITERAL, not `EXPORT_BUNDLE_VERSION` — the object above is built from
    // that constant, so comparing to it is a self-comparison that cannot fail.
    // (It was one for a round, changed to silence a bump; the bump belongs
    // here, which is the point of a pin.)
    expect(bundle.manifest.version).toBe(3);
    expect(bundle.dashboards?.[0].cards).toHaveLength(1);
    expect(bundle.dashboards?.[0].drafts).toHaveLength(1);
    expect(bundle.knowledgeDocuments?.[0].links).toHaveLength(1);
    expect(bundle.scheduledTasks).toHaveLength(1);
    expect(bundle.agentSessionMemory).toHaveLength(1);
  });

  it("ImportResult shape covers every bundle section", () => {
    const result: ImportResult = {
      conversations: { imported: 5, skipped: 2 },
      semanticEntities: { imported: 3, skipped: 0 },
      learnedPatterns: { imported: 1, skipped: 1 },
      settings: { imported: 4, skipped: 0 },
      dashboards: { imported: 2, skipped: 0 },
      knowledgeDocuments: { imported: 6, skipped: 1 },
      scheduledTasks: { imported: 1, skipped: 0 },
      agentSessionMemory: { imported: 3, skipped: 0 },
      brainEpisodes: { imported: 4, skipped: 1 },
      brainFacts: { imported: 8, skipped: 2 },
      brainEdges: { imported: 5, skipped: 0 },
      factAudienceMembers: { imported: 3, skipped: 1 },
      // The one section with a THIRD counter (#5036).
      brainVocabularyEdges: { imported: 2, skipped: 1, refused: 4 },
      brainSlackChannelExclusions: { imported: 3, skipped: 2, refused: 0 },
      brainEnrollments: { imported: 4, skipped: 1, namingDropped: 2 },
      // Distinct numbers from every neighbour, so a mis-wired section cannot be
      // satisfied by another's counters.
      brainEntities: { imported: 7, skipped: 3 },
    };

    expect(result.conversations.imported + result.conversations.skipped).toBe(7);
    expect(result.dashboards.imported).toBe(2);
    expect(result.knowledgeDocuments.skipped).toBe(1);
    expect(result.brainFacts.imported).toBe(8);
    expect(result.factAudienceMembers.skipped).toBe(1);
    // The counter SET rather than a literal read back: reading `refused: 4` out
    // of the object this test itself just wrote cannot go red for any change.
    //
    // ⚠️ Its reach is narrower than "catches a fourth counter", and the limit is
    // worth stating: a REQUIRED addition stops this literal type-checking, so
    // someone edits it and this fires — but an OPTIONAL one changes nothing
    // here. `bun run type` is the real enforcement of the shape; this is the
    // runtime half, and it catches a rename or a removal.
    expect(Object.keys(result.brainVocabularyEdges).toSorted()).toEqual([
      "imported",
      "refused",
      "skipped",
    ]);
  });

  it("ExportManifest includes optional apiUrl", () => {
    const manifest: ExportManifest = {
      version: 1,
      exportedAt: "2026-04-02T00:00:00Z",
      source: { label: "production", apiUrl: "https://api.example.com" },
      counts: { conversations: 0, messages: 0, semanticEntities: 0, learnedPatterns: 0, settings: 0 },
    };

    expect(manifest.source.apiUrl).toBe("https://api.example.com");
  });
});
