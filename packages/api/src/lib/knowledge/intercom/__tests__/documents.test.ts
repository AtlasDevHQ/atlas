/**
 * Tests for the Intercom document assembly (#4399) — the pure glue between the
 * SHARED support HTML→markdown converter and the connector ingest seam. Covers
 * the per-locale path shape (`<locale>/<title-slug>-<id>.md`), the `atlas:`
 * provenance block, contentless skips, relative-link rewriting, and degradation
 * aggregation.
 */

import { describe, expect, it } from "bun:test";
import {
  assembleIntercomDocuments,
  slugifyTitle,
  type IntercomArticleContent,
} from "@atlas/api/lib/knowledge/intercom/documents";

function con(overrides: Partial<IntercomArticleContent> = {}): IntercomArticleContent {
  return {
    articleId: "42",
    locale: "en",
    title: "Getting Started",
    bodyHtml: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    updatedAt: "2026-07-01T10:00:00.000Z",
    url: "https://help.acme.com/en/articles/42-getting-started",
    ...overrides,
  };
}

describe("assembleIntercomDocuments", () => {
  it("builds a locale/title-slug-id path and stamps provenance", () => {
    const { documents } = assembleIntercomDocuments([con()], { collectionSlug: "intercom-docs" });
    expect(documents).toHaveLength(1);
    expect(documents[0].path).toBe("intercom-docs/en/getting-started-42.md");
    const content = documents[0].content;
    expect(content).toContain('connector: "intercom"');
    expect(content).toContain('article_id: "42"');
    expect(content).toContain('locale: "en"');
    expect(content).toContain('updated_at: "2026-07-01T10:00:00.000Z"');
    expect(content).toContain('resource: "https://help.acme.com/en/articles/42-getting-started"');
  });

  it("gives each locale of the same article a distinct, collision-free path", () => {
    const { documents } = assembleIntercomDocuments(
      [con({ locale: "en" }), con({ locale: "fr", title: "Facturation" })],
      { collectionSlug: "kb" },
    );
    expect(documents.map((d) => d.path).toSorted()).toEqual([
      "kb/en/getting-started-42.md",
      "kb/fr/facturation-42.md",
    ]);
  });

  it("skips a locale whose body converts to nothing (contentless)", () => {
    const { documents, skippedContentless } = assembleIntercomDocuments(
      [con({ bodyHtml: "<p>   </p>" })],
      { collectionSlug: "kb" },
    );
    expect(documents).toHaveLength(0);
    expect(skippedContentless).toBe(1);
  });

  it("absolutizes a relative in-body link against the locale's own URL", () => {
    const { documents } = assembleIntercomDocuments(
      [con({ bodyHtml: '<p>See <a href="/en/articles/99-more">more here in the docs</a> now.</p>' })],
      { collectionSlug: "kb" },
    );
    expect(documents[0].content).toContain("https://help.acme.com/en/articles/99-more");
  });

  it("aggregates media degradations across locales", () => {
    const { degradations } = assembleIntercomDocuments(
      [con({ bodyHtml: '<p>Body prose here for length.</p><img src="https://x/a.png">' })],
      { collectionSlug: "kb" },
    );
    expect(degradations.some((d) => d.name === "#image" && d.count >= 1)).toBe(true);
  });
});

describe("slugifyTitle", () => {
  it("slugifies and falls back to the given token when empty", () => {
    expect(slugifyTitle("Hello World!", "x")).toBe("hello-world");
    expect(slugifyTitle("   ", "fallback")).toBe("fallback");
  });
});
