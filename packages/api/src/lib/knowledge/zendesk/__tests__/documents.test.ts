/**
 * Tests for the Zendesk translation → ConnectorDocument assembly (#4396): the
 * per-locale archive path (`<locale>/<title-slug>-<id>.md`, prefixed), the
 * `atlas:` provenance block (connector + brand + article id + locale +
 * updated_at), the shared-converter integration (cross-link rewriting, counted
 * image degradations), and the contentless skip. Pure — no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  assembleZendeskDocuments,
  slugifyTitle,
  type ZendeskArticleTranslation,
} from "@atlas/api/lib/knowledge/zendesk/documents";

const OPTS = { collectionSlug: "zendesk-acme", brandSubdomain: "acme" };

function translation(overrides: Partial<ZendeskArticleTranslation> = {}): ZendeskArticleTranslation {
  return {
    articleId: "123",
    locale: "en-us",
    title: "Getting Started",
    bodyHtml: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    updatedAt: "2026-07-01T10:00:00.000Z",
    url: "https://acme.zendesk.com/hc/en-us/articles/123-Getting-Started",
    ...overrides,
  };
}

describe("slugifyTitle", () => {
  it("lowercases and dashes non-alphanumerics (NFKD, the Confluence convention)", () => {
    expect(slugifyTitle("Setup & Testing Guide!", "x")).toBe("setup-testing-guide");
  });
  it("falls back when the title has no usable characters", () => {
    expect(slugifyTitle("你好", "article")).toBe("article");
  });
});

describe("assembleZendeskDocuments", () => {
  it("emits one document per translation at <prefix>/<locale>/<slug>-<id>.md", () => {
    const result = assembleZendeskDocuments(
      [translation(), translation({ locale: "de", title: "Erste Schritte", articleId: "123" })],
      OPTS,
    );
    expect(result.documents.map((d) => d.path)).toEqual([
      "zendesk-acme/en-us/getting-started-123.md",
      "zendesk-acme/de/erste-schritte-123.md",
    ]);
  });

  it("stamps frontmatter provenance and the atlas: extension block", () => {
    const { documents } = assembleZendeskDocuments([translation()], OPTS);
    const content = documents[0].content;
    expect(content).toContain('title: "Getting Started"');
    expect(content).toContain(
      'resource: "https://acme.zendesk.com/hc/en-us/articles/123-Getting-Started"',
    );
    expect(content).toContain('timestamp: "2026-07-01T10:00:00.000Z"');
    expect(content).toContain("atlas:");
    expect(content).toContain('connector: "zendesk"');
    expect(content).toContain('brand: "acme"');
    expect(content).toContain('article_id: "123"');
    expect(content).toContain('locale: "en-us"');
    expect(content).toContain('updated_at: "2026-07-01T10:00:00.000Z"');
    // No provenance tags — `tags` is a mirrored change-comparison column, so
    // stamping one would re-draft every already-ingested document.
    expect(content).not.toContain("tags:");
  });

  it("rewrites relative help-center links against the brand host", () => {
    const { documents } = assembleZendeskDocuments(
      [translation({ bodyHtml: '<p>See <a href="/hc/en-us/articles/456">the FAQ</a> for details.</p>' })],
      OPTS,
    );
    expect(documents[0].content).toContain(
      "[the FAQ](https://acme.zendesk.com/hc/en-us/articles/456)",
    );
  });

  it("leaves absolute links untouched", () => {
    const { documents } = assembleZendeskDocuments(
      [translation({ bodyHtml: '<p>Visit <a href="https://example.com/page">our site</a> for more info.</p>' })],
      OPTS,
    );
    expect(documents[0].content).toContain("[our site](https://example.com/page)");
  });

  it("aggregates image degradations across translations", () => {
    const { degradations } = assembleZendeskDocuments(
      [
        translation({ bodyHtml: '<p>Some intro text here.</p><img src="a.png"><img src="b.png">' }),
        translation({ locale: "de", bodyHtml: '<p>Etwas Text hier drin.</p><img src="c.png">' }),
      ],
      OPTS,
    );
    expect(degradations).toEqual([{ name: "#image", count: 3 }]);
  });

  it("skips (and counts) a contentless translation instead of emitting an empty doc", () => {
    const result = assembleZendeskDocuments(
      [translation({ bodyHtml: "<div><script>x()</script></div>" }), translation({ locale: "fr" })],
      OPTS,
    );
    expect(result.skippedContentless).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].path).toContain("/fr/");
  });

  it("uses the fallback segment for an unslugifiable title (id keeps it unique)", () => {
    const { documents } = assembleZendeskDocuments(
      [translation({ title: "你好", articleId: "9" })],
      OPTS,
    );
    expect(documents[0].path).toBe("zendesk-acme/en-us/article-9.md");
  });
});
