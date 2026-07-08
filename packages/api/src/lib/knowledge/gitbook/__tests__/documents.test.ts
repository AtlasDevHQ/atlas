/**
 * Tests for GitBook page → OKF document assembly (#4393). Pure — asserts the
 * archive path (GitBook slug path → prefixed `.md`), the `atlas:` provenance
 * block (connector + page id + version), contentless-skip, and collision
 * disambiguation.
 */

import { describe, expect, it } from "bun:test";
import {
  assembleGitbookDocuments,
  type GitbookPage,
} from "@atlas/api/lib/knowledge/gitbook/documents";

function page(overrides: Partial<GitbookPage> = {}): GitbookPage {
  return {
    id: "page-1",
    title: "Setup",
    path: "guides/setup",
    markdown: "Install the thing.",
    updatedAt: "2026-07-06T09:00:00.000Z",
    url: "https://acme.gitbook.io/docs/guides/setup",
    ...overrides,
  };
}

describe("assembleGitbookDocuments", () => {
  it("derives a prefixed, hierarchy-mirroring archive path from the GitBook path", () => {
    const { documents } = assembleGitbookDocuments([page()], { collectionSlug: "gitbook-docs" });
    expect(documents).toHaveLength(1);
    expect(documents[0].path).toBe("gitbook-docs/guides/setup.md");
  });

  it("stamps resource, timestamp, and the atlas provenance block", () => {
    const { documents } = assembleGitbookDocuments([page()], { collectionSlug: "gitbook-docs" });
    const content = documents[0].content;
    expect(content).toContain('resource: "https://acme.gitbook.io/docs/guides/setup"');
    expect(content).toContain('timestamp: "2026-07-06T09:00:00.000Z"');
    expect(content).toContain("atlas:");
    expect(content).toContain('connector: "gitbook"');
    expect(content).toContain('page_id: "page-1"');
    expect(content).toContain('updated_at: "2026-07-06T09:00:00.000Z"');
    expect(content).toContain("Install the thing.");
    // No provenance `tags` line — it would re-draft on every sync (Notion posture).
    expect(content).not.toContain("tags:");
  });

  it("carries no title line for an untitled page but still emits the document", () => {
    const { documents } = assembleGitbookDocuments([page({ title: "  " })], {
      collectionSlug: "c",
    });
    expect(documents).toHaveLength(1);
    expect(documents[0].content).not.toContain("title:");
  });

  it("skips a contentless page rather than emitting an empty doc", () => {
    const result = assembleGitbookDocuments([page({ markdown: "   " })], { collectionSlug: "c" });
    expect(result.documents).toHaveLength(0);
    expect(result.skippedContentless).toBe(1);
  });

  it("aggregates converter degradations across pages", () => {
    const result = assembleGitbookDocuments(
      [
        page({ id: "a", path: "a", markdown: '{% file src="x" %}\n\ntext' }),
        page({ id: "b", path: "b", markdown: '{% file src="y" %}\n\ntext' }),
      ],
      { collectionSlug: "c" },
    );
    expect(result.degradations).toEqual([{ name: "file", count: 2 }]);
  });

  it("disambiguates a path collision with the page id rather than clobbering", () => {
    // Two distinct pages whose slugified paths collide (`A/B` vs `a-b`).
    const result = assembleGitbookDocuments(
      [
        page({ id: "1", path: "A B", markdown: "first document body content here" }),
        page({ id: "2", path: "a-b", markdown: "second document body content here" }),
      ],
      { collectionSlug: "c" },
    );
    expect(result.documents).toHaveLength(2);
    expect(result.collisionsRenamed).toBe(1);
    const paths = result.documents.map((d) => d.path);
    expect(new Set(paths).size).toBe(2);
    expect(paths.some((p) => p.endsWith("-2.md"))).toBe(true);
  });

  it("falls back to the title slug when the path has no usable segments", () => {
    const { documents } = assembleGitbookDocuments([page({ path: "   ", title: "My Page" })], {
      collectionSlug: "c",
    });
    expect(documents[0].path).toBe("c/my-page.md");
  });
});
