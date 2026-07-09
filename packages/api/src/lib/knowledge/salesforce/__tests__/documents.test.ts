/**
 * Tests for the Salesforce article version → ConnectorDocument assembly
 * (#4397): the per-locale archive path
 * (`<language>/<title-slug>-<article-number>.md`, prefixed), the `atlas:`
 * provenance block (connector + article id + article number + version id +
 * version + locale + updated_at — the AC's provenance fields), rich/plain
 * body composition through the shared converter, cross-link absolutization
 * against the instance URL, and the contentless skip. Pure — no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  assembleSalesforceKnowledgeDocuments,
  slugifySegment,
  type SalesforceKnowledgeArticle,
} from "@atlas/api/lib/knowledge/salesforce/documents";

const OPTS = { collectionSlug: "sf-kb", instanceUrl: "https://acme.my.salesforce.com" };

function article(
  overrides: Partial<SalesforceKnowledgeArticle> = {},
): SalesforceKnowledgeArticle {
  return {
    versionId: "ka0x001",
    knowledgeArticleId: "kA0x001",
    articleNumber: "000001001",
    title: "Getting Started",
    summary: "How to get started with the product.",
    language: "en_us",
    versionNumber: "3",
    isMasterLanguage: true,
    updatedAt: "2026-07-01T10:00:00.000Z",
    url: "https://acme.my.salesforce.com/lightning/r/Knowledge__kav/ka0x001/view",
    bodyParts: [
      {
        field: "Body__c",
        value: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
        rich: true,
      },
    ],
    ...overrides,
  };
}

describe("slugifySegment", () => {
  it("lowercases and dashes non-alphanumerics (NFKD, the tier convention)", () => {
    expect(slugifySegment("Setup & Testing Guide!", "x")).toBe("setup-testing-guide");
    expect(slugifySegment("en_US", "locale")).toBe("en-us");
  });
  it("falls back when the value has no usable characters", () => {
    expect(slugifySegment("你好", "article")).toBe("article");
  });
});

describe("assembleSalesforceKnowledgeDocuments", () => {
  it("emits one document per version at <prefix>/<language>/<slug>-<number>.md", () => {
    const result = assembleSalesforceKnowledgeDocuments(
      [
        article(),
        article({
          versionId: "ka0x002",
          language: "de",
          title: "Erste Schritte",
          isMasterLanguage: false,
        }),
      ],
      OPTS,
    );
    // Translations share ArticleNumber across Language — each locale its own path.
    expect(result.documents.map((d) => d.path)).toEqual([
      "sf-kb/en-us/getting-started-000001001.md",
      "sf-kb/de/erste-schritte-000001001.md",
    ]);
  });

  it("stamps frontmatter provenance and the atlas: extension block (article id + version + locale)", () => {
    const { documents } = assembleSalesforceKnowledgeDocuments([article()], OPTS);
    const content = documents[0].content;
    expect(content).toContain('title: "Getting Started"');
    expect(content).toContain(
      'resource: "https://acme.my.salesforce.com/lightning/r/Knowledge__kav/ka0x001/view"',
    );
    expect(content).toContain('timestamp: "2026-07-01T10:00:00.000Z"');
    expect(content).toContain("atlas:");
    expect(content).toContain('connector: "salesforce"');
    expect(content).toContain('article_id: "kA0x001"');
    expect(content).toContain('article_number: "000001001"');
    expect(content).toContain('version_id: "ka0x001"');
    expect(content).toContain('version: "3"');
    expect(content).toContain('locale: "en_us"');
    expect(content).toContain('is_master_language: "true"');
    expect(content).toContain('updated_at: "2026-07-01T10:00:00.000Z"');
    // No provenance tags — `tags` is a mirrored change-comparison column, so
    // stamping one would re-draft every already-ingested document.
    expect(content).not.toContain("tags:");
  });

  it("omits version/is_master_language when the org's object lacks them", () => {
    const { documents } = assembleSalesforceKnowledgeDocuments(
      [article({ versionNumber: null, isMasterLanguage: null })],
      OPTS,
    );
    expect(documents[0].content).not.toContain("version:");
    expect(documents[0].content).not.toContain("is_master_language:");
  });

  it("leads with the summary and keeps plain body parts verbatim after rich ones", () => {
    const { documents } = assembleSalesforceKnowledgeDocuments(
      [
        article({
          bodyParts: [
            { field: "Body__c", value: "<p>Rich part with plenty of prose.</p>", rich: true },
            {
              field: "Details__c",
              value: "Plain part, first block.\n\nPlain part, second block.",
              rich: false,
            },
          ],
        }),
      ],
      OPTS,
    );
    const content = documents[0].content;
    const summaryAt = content.indexOf("How to get started with the product.");
    const richAt = content.indexOf("Rich part with plenty of prose.");
    const plainAt = content.indexOf("Plain part, first block.");
    expect(summaryAt).toBeGreaterThan(-1);
    expect(richAt).toBeGreaterThan(summaryAt);
    expect(plainAt).toBeGreaterThan(richAt);
    expect(content).toContain("Plain part, second block.");
  });

  it("absolutizes relative links against the instance URL and leaves absolute ones", () => {
    const { documents } = assembleSalesforceKnowledgeDocuments(
      [
        article({
          bodyParts: [
            {
              field: "Body__c",
              value:
                '<p>See <a href="/articles/en_US/FAQ/Billing">billing</a> and <a href="https://example.com/page">our site</a> for details.</p>',
              rich: true,
            },
          ],
        }),
      ],
      OPTS,
    );
    expect(documents[0].content).toContain(
      "[billing](https://acme.my.salesforce.com/articles/en_US/FAQ/Billing)",
    );
    expect(documents[0].content).toContain("[our site](https://example.com/page)");
  });

  it("aggregates image degradations across articles", () => {
    const { degradations } = assembleSalesforceKnowledgeDocuments(
      [
        article({
          bodyParts: [
            {
              field: "Body__c",
              value: '<p>Some intro text here.</p><img src="a.png"><img src="b.png">',
              rich: true,
            },
          ],
        }),
        article({
          versionId: "ka0x002",
          language: "de",
          bodyParts: [
            { field: "Body__c", value: '<p>Etwas Text hier drin.</p><img src="c.png">', rich: true },
          ],
        }),
      ],
      OPTS,
    );
    expect(degradations).toEqual([{ name: "#image", count: 3 }]);
  });

  it("skips (and counts) a contentless version instead of emitting an empty doc", () => {
    const result = assembleSalesforceKnowledgeDocuments(
      [
        article({ summary: null, bodyParts: [{ field: "Body__c", value: "<div><script>x()</script></div>", rich: true }] }),
        article({ versionId: "ka0x002", language: "fr" }),
      ],
      OPTS,
    );
    expect(result.skippedContentless).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].path).toContain("/fr/");
    // The WHICH, not just the count — reconciliation archives the vanished doc.
    expect(result.contentlessArticles).toEqual(["000001001:en_us"]);
  });

  it("uses the fallback segment for an unslugifiable title (number keeps it unique)", () => {
    const { documents } = assembleSalesforceKnowledgeDocuments(
      [article({ title: "你好" })],
      OPTS,
    );
    expect(documents[0].path).toBe("sf-kb/en-us/article-000001001.md");
  });
});
