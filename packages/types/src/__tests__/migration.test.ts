/**
 * Tests for migration bundle types — validates type shapes and bundle constants.
 */

import { describe, it, expect } from "bun:test";
import type { ExportBundle, ImportResult, ExportManifest, ExportedDashboard, ExportedKnowledgeDocument } from "../migration";
import { EXPORT_BUNDLE_VERSION } from "../migration";

describe("migration types", () => {
  it("EXPORT_BUNDLE_VERSION is 2 (v2 widened the bundle to the post-v1 pillars, #4460)", () => {
    expect(EXPORT_BUNDLE_VERSION).toBe(2);
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

  it("a v2 bundle carries the #4460 sections with nested children", () => {
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

    expect(bundle.manifest.version).toBe(2);
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
    };

    expect(result.conversations.imported + result.conversations.skipped).toBe(7);
    expect(result.dashboards.imported).toBe(2);
    expect(result.knowledgeDocuments.skipped).toBe(1);
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
