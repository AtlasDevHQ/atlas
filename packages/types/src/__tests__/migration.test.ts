/**
 * Tests for migration bundle types — validates type shapes and bundle constants.
 */

import { describe, it, expect } from "bun:test";
import type { ExportBundle, ImportResult, ExportManifest } from "../migration";
import { EXPORT_BUNDLE_VERSION } from "../migration";

describe("migration types", () => {
  it("EXPORT_BUNDLE_VERSION is 1", () => {
    expect(EXPORT_BUNDLE_VERSION).toBe(1);
  });

  it("ExportBundle shape is structurally valid", () => {
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
        { name: "users", entityType: "entity", yamlContent: "table: users", connectionId: null },
      ],
      learnedPatterns: [],
      settings: [],
    };

    expect(bundle.manifest.version).toBe(1);
    expect(bundle.conversations).toHaveLength(1);
    expect(bundle.conversations[0].messages).toHaveLength(1);
  });

  it("ImportResult shape is structurally valid", () => {
    const result: ImportResult = {
      conversations: { imported: 5, skipped: 2 },
      semanticEntities: { imported: 3, skipped: 0 },
      learnedPatterns: { imported: 1, skipped: 1 },
      settings: { imported: 4, skipped: 0 },
    };

    expect(result.conversations.imported + result.conversations.skipped).toBe(7);
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
