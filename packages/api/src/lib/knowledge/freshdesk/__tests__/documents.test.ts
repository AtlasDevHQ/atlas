/**
 * Tests for the Freshdesk article-locale → ConnectorDocument assembly (#4401):
 * the per-locale archive path (`<locale>/<title-slug>-<id>.md`, prefixed), the
 * `atlas:` provenance block (connector + product + category id + article id +
 * locale + updated_at), the shared-converter integration (counted image
 * degradations), and the contentless skip. Pure — no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  assembleFreshdeskDocuments,
  slugifyTitle,
  type FreshdeskArticleLocale,
} from "@atlas/api/lib/knowledge/freshdesk/documents";

const OPTS = { collectionSlug: "freshdesk-support" };

function article(overrides: Partial<FreshdeskArticleLocale> = {}): FreshdeskArticleLocale {
  return {
    articleId: "9001",
    categoryId: "80000001",
    categoryName: "Support",
    locale: "en",
    title: "Getting Started",
    bodyHtml: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    updatedAt: "2026-07-01T10:00:00.000Z",
    url: "https://acme.freshdesk.com/support/solutions/articles/9001",
    ...overrides,
  };
}

describe("slugifyTitle", () => {
  it("lowercases and dashes non-alphanumerics (NFKD)", () => {
    expect(slugifyTitle("Setup & Testing Guide!", "x")).toBe("setup-testing-guide");
  });
  it("falls back when the title has no usable characters", () => {
    expect(slugifyTitle("你好", "article")).toBe("article");
  });
});

describe("assembleFreshdeskDocuments", () => {
  it("emits one document per locale at <prefix>/<locale>/<slug>-<id>.md", () => {
    const result = assembleFreshdeskDocuments(
      [article(), article({ locale: "fr", title: "Pour commencer" })],
      OPTS,
    );
    expect(result.documents.map((d) => d.path)).toEqual([
      "freshdesk-support/en/getting-started-9001.md",
      "freshdesk-support/fr/pour-commencer-9001.md",
    ]);
  });

  it("stamps frontmatter provenance and the atlas: extension block", () => {
    const { documents } = assembleFreshdeskDocuments([article()], OPTS);
    const content = documents[0].content;
    expect(content).toContain('title: "Getting Started"');
    expect(content).toContain('resource: "https://acme.freshdesk.com/support/solutions/articles/9001"');
    expect(content).toContain('timestamp: "2026-07-01T10:00:00.000Z"');
    expect(content).toContain("atlas:");
    expect(content).toContain('connector: "freshdesk"');
    expect(content).toContain('product: "Support"');
    expect(content).toContain('category_id: "80000001"');
    expect(content).toContain('article_id: "9001"');
    expect(content).toContain('locale: "en"');
    expect(content).toContain('updated_at: "2026-07-01T10:00:00.000Z"');
    // No provenance tags — `tags` is a mirrored change-comparison column, so
    // stamping one would re-draft every already-ingested document.
    expect(content).not.toContain("tags:");
  });

  it("falls back to the category id for product when the name is blank", () => {
    const { documents } = assembleFreshdeskDocuments([article({ categoryName: "" })], OPTS);
    expect(documents[0].content).toContain('product: "80000001"');
  });

  it("aggregates image degradations across articles", () => {
    const { degradations } = assembleFreshdeskDocuments(
      [
        article({ bodyHtml: '<p>Some intro text here.</p><img src="a.png"><img src="b.png">' }),
        article({ locale: "fr", bodyHtml: '<p>Un peu de texte ici dedans.</p><img src="c.png">' }),
      ],
      OPTS,
    );
    expect(degradations).toEqual([{ name: "#image", count: 3 }]);
  });

  it("skips (and counts) a contentless article instead of emitting an empty doc", () => {
    const result = assembleFreshdeskDocuments(
      [article({ bodyHtml: "<div><script>x()</script></div>" }), article({ locale: "fr" })],
      OPTS,
    );
    expect(result.skippedContentless).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].path).toContain("/fr/");
  });

  it("uses the fallback segment for an unslugifiable title (id keeps it unique)", () => {
    const { documents } = assembleFreshdeskDocuments([article({ title: "你好", articleId: "77" })], OPTS);
    expect(documents[0].path).toBe("freshdesk-support/en/article-77.md");
  });
});
