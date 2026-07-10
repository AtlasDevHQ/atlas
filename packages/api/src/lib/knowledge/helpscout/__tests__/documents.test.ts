/**
 * Tests for the Help Scout article → ConnectorDocument assembly (#4398): the
 * archive path (`<collection-slug>/<title-slug>-<id>.md`, prefixed), the
 * `atlas:` provenance block (connector + site + article id + updated_at), the
 * shared-converter integration (cross-link rewriting against the article's
 * public URL, counted image degradations), and the contentless skip. Pure — no
 * I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  assembleHelpScoutDocuments,
  slugifyTitle,
  type HelpScoutArticle,
} from "@atlas/api/lib/knowledge/helpscout/documents";

const OPTS = { collectionSlug: "helpscout-acme", siteId: "site-1" };

function article(overrides: Partial<HelpScoutArticle> = {}): HelpScoutArticle {
  return {
    articleId: "abc123",
    title: "Getting Started",
    bodyHtml: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    updatedAt: "2026-07-01T10:00:00.000Z",
    url: "https://acme.helpscoutdocs.com/article/1-getting-started",
    collectionSlug: "onboarding",
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

describe("assembleHelpScoutDocuments", () => {
  it("emits one document per article at <prefix>/<collection>/<slug>-<id>.md", () => {
    const result = assembleHelpScoutDocuments(
      [article(), article({ articleId: "def456", title: "Billing FAQ", collectionSlug: "billing" })],
      OPTS,
    );
    expect(result.documents.map((d) => d.path)).toEqual([
      "helpscout-acme/onboarding/getting-started-abc123.md",
      "helpscout-acme/billing/billing-faq-def456.md",
    ]);
  });

  it("stamps frontmatter provenance and the atlas: extension block (site + article id + updated_at)", () => {
    const { documents } = assembleHelpScoutDocuments([article()], OPTS);
    const content = documents[0].content;
    expect(content).toContain('title: "Getting Started"');
    expect(content).toContain(
      'resource: "https://acme.helpscoutdocs.com/article/1-getting-started"',
    );
    expect(content).toContain('timestamp: "2026-07-01T10:00:00.000Z"');
    expect(content).toContain("atlas:");
    expect(content).toContain('connector: "helpscout"');
    expect(content).toContain('site: "site-1"');
    expect(content).toContain('article_id: "abc123"');
    expect(content).toContain('updated_at: "2026-07-01T10:00:00.000Z"');
    // No provenance tags — `tags` is a mirrored change-comparison column, so
    // stamping one would re-draft every already-ingested document.
    expect(content).not.toContain("tags:");
  });

  it("rewrites relative article links against the article's public URL", () => {
    const { documents } = assembleHelpScoutDocuments(
      [article({ bodyHtml: '<p>See <a href="/article/456-faq">the FAQ</a> for details.</p>' })],
      OPTS,
    );
    expect(documents[0].content).toContain(
      "[the FAQ](https://acme.helpscoutdocs.com/article/456-faq)",
    );
  });

  it("leaves relative links untouched when the article has no public URL", () => {
    const { documents } = assembleHelpScoutDocuments(
      [article({ url: "", bodyHtml: '<p>See <a href="/article/456">the FAQ</a> here.</p>' })],
      OPTS,
    );
    expect(documents[0].content).toContain("[the FAQ](/article/456)");
    // …and with no resource URL, the frontmatter omits it rather than empty.
    expect(documents[0].content).not.toContain('resource: ""');
  });

  it("leaves absolute links untouched", () => {
    const { documents } = assembleHelpScoutDocuments(
      [article({ bodyHtml: '<p>Visit <a href="https://example.com/page">our site</a> now.</p>' })],
      OPTS,
    );
    expect(documents[0].content).toContain("[our site](https://example.com/page)");
  });

  it("aggregates image degradations across articles", () => {
    const { degradations } = assembleHelpScoutDocuments(
      [
        article({ bodyHtml: '<p>Some intro text here.</p><img src="a.png"><img src="b.png">' }),
        article({ articleId: "z9", bodyHtml: '<p>Etwas Text hier drin.</p><img src="c.png">' }),
      ],
      OPTS,
    );
    expect(degradations).toEqual([{ name: "#image", count: 3 }]);
  });

  it("skips (and counts) a contentless article instead of emitting an empty doc", () => {
    const result = assembleHelpScoutDocuments(
      [article({ bodyHtml: "<div><script>x()</script></div>" }), article({ articleId: "keep" })],
      OPTS,
    );
    expect(result.skippedContentless).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].path).toContain("-keep.md");
  });

  it("uses the fallback segment for an unslugifiable title (id keeps it unique)", () => {
    const { documents } = assembleHelpScoutDocuments(
      [article({ title: "你好", articleId: "9", collectionSlug: "misc" })],
      OPTS,
    );
    expect(documents[0].path).toBe("helpscout-acme/misc/article-9.md");
  });
});
