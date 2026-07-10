/**
 * Tests for the Front article-locale → ConnectorDocument assembly (#4400): the
 * per-locale archive path (`<locale>/<title-slug>-<id>.md`, prefixed), the
 * `atlas:` provenance block (connector + knowledge base + article id + locale +
 * last_edited), the shared-converter integration (counted image degradations),
 * and the contentless skip. Pure — no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  assembleFrontDocuments,
  slugifyTitle,
  type FrontArticleLocale,
} from "@atlas/api/lib/knowledge/front/documents";

const OPTS = { collectionSlug: "front-support", knowledgeBaseId: "kb_1" };

function article(overrides: Partial<FrontArticleLocale> = {}): FrontArticleLocale {
  return {
    articleId: "art_123",
    knowledgeBaseId: "kb_1",
    locale: "en",
    title: "Getting Started",
    bodyHtml: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    lastEdited: "2026-07-01T10:00:00.000Z",
    url: "https://help.acme.test/en/articles/art_123",
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

describe("assembleFrontDocuments", () => {
  it("emits one document per locale at <prefix>/<locale>/<slug>-<id>.md", () => {
    const result = assembleFrontDocuments(
      [article(), article({ locale: "fr", title: "Pour commencer", articleId: "art_123" })],
      OPTS,
    );
    expect(result.documents.map((d) => d.path)).toEqual([
      "front-support/en/getting-started-art_123.md",
      "front-support/fr/pour-commencer-art_123.md",
    ]);
  });

  it("stamps frontmatter provenance and the atlas: extension block", () => {
    const { documents } = assembleFrontDocuments([article()], OPTS);
    const content = documents[0].content;
    expect(content).toContain('title: "Getting Started"');
    expect(content).toContain('resource: "https://help.acme.test/en/articles/art_123"');
    expect(content).toContain('timestamp: "2026-07-01T10:00:00.000Z"');
    expect(content).toContain("atlas:");
    expect(content).toContain('connector: "front"');
    expect(content).toContain('knowledge_base: "kb_1"');
    expect(content).toContain('article_id: "art_123"');
    expect(content).toContain('locale: "en"');
    expect(content).toContain('last_edited: "2026-07-01T10:00:00.000Z"');
    // No provenance tags — `tags` is a mirrored change-comparison column, so
    // stamping one would re-draft every already-ingested document.
    expect(content).not.toContain("tags:");
  });

  it("aggregates image degradations across articles", () => {
    const { degradations } = assembleFrontDocuments(
      [
        article({ bodyHtml: '<p>Some intro text here.</p><img src="a.png"><img src="b.png">' }),
        article({ locale: "fr", bodyHtml: '<p>Un peu de texte ici dedans.</p><img src="c.png">' }),
      ],
      OPTS,
    );
    expect(degradations).toEqual([{ name: "#image", count: 3 }]);
  });

  it("skips (and counts) a contentless article instead of emitting an empty doc", () => {
    const result = assembleFrontDocuments(
      [article({ bodyHtml: "<div><script>x()</script></div>" }), article({ locale: "fr" })],
      OPTS,
    );
    expect(result.skippedContentless).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].path).toContain("/fr/");
  });

  it("uses the fallback segment for an unslugifiable title (id keeps it unique)", () => {
    const { documents } = assembleFrontDocuments([article({ title: "你好", articleId: "art_9" })], OPTS);
    expect(documents[0].path).toBe("front-support/en/article-art_9.md");
  });
});
