/**
 * Tests for Confluence page → OKF ConnectorDocument assembly (#4377):
 * hierarchy-slug paths from ancestor titles, reserved-basename folding,
 * provenance frontmatter (resource + timestamp), contentless skips, collision
 * disambiguation, and aggregated macro degradations.
 */

import { describe, expect, it } from "bun:test";
import {
  assembleConfluenceDocuments,
  ancestorTitles,
  slugifyTitle,
  type ConfluencePage,
  type ConfluencePageNode,
} from "@atlas/api/lib/knowledge/confluence/documents";

const BASE = "https://acme.atlassian.net/wiki";

function page(over: Partial<ConfluencePage> & { id: string; title: string }): ConfluencePage {
  return {
    parentId: null,
    storageBody: `<p>${over.title} body prose that is clearly not empty.</p>`,
    modifiedAt: "2026-07-01T00:00:00.000Z",
    url: `${BASE}/spaces/ENG/pages/${over.id}`,
    ...over,
  };
}

function mapOf(nodes: ConfluencePageNode[]): Map<string, ConfluencePageNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe("ancestorTitles", () => {
  it("walks parentId root-first and stops at the root", () => {
    const byId = mapOf([
      { id: "1", title: "Engineering", parentId: null },
      { id: "2", title: "Runbooks", parentId: "1" },
      { id: "3", title: "Oncall", parentId: "2" },
    ]);
    expect(ancestorTitles("3", byId)).toEqual(["Engineering", "Runbooks"]);
  });

  it("stops on a missing (restricted/absent) ancestor without throwing", () => {
    const byId = mapOf([{ id: "3", title: "Oncall", parentId: "missing" }]);
    expect(ancestorTitles("3", byId)).toEqual([]);
  });

  it("does not loop on a cyclic parent chain", () => {
    const byId = mapOf([
      { id: "a", title: "A", parentId: "b" },
      { id: "b", title: "B", parentId: "a" },
    ]);
    expect(ancestorTitles("a", byId).length).toBeLessThanOrEqual(2);
  });
});

describe("slugifyTitle", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyTitle("On-Call Runbook (v2)", "x")).toBe("on-call-runbook-v2");
  });
  it("falls back when a title slugifies to empty", () => {
    expect(slugifyTitle("！！！", "page-42")).toBe("page-42");
  });
});

describe("assembleConfluenceDocuments", () => {
  const byId = mapOf([
    { id: "1", title: "Engineering", parentId: null },
    { id: "2", title: "Runbooks", parentId: "1" },
    { id: "3", title: "Oncall Guide", parentId: "2" },
  ]);

  it("builds a hierarchy-slug path under the collection prefix", () => {
    const result = assembleConfluenceDocuments([page({ id: "3", title: "Oncall Guide", parentId: "2" })], byId, {
      collectionSlug: "confluence-eng",
    });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].path).toBe("confluence-eng/engineering/runbooks/oncall-guide.md");
  });

  it("stamps resource + timestamp provenance and the confluence tag in the OKF frontmatter", () => {
    const result = assembleConfluenceDocuments([page({ id: "3", title: "Oncall Guide", parentId: "2" })], byId, {
      collectionSlug: "confluence-eng",
    });
    const content = result.documents[0].content;
    expect(content).toContain('resource: "https://acme.atlassian.net/wiki/spaces/ENG/pages/3"');
    expect(content).toContain('timestamp: "2026-07-01T00:00:00.000Z"');
    expect(content).toContain('title: "Oncall Guide"');
    expect(content).toContain('tags: ["confluence"]');
  });

  it("folds a root page titled 'index' off the reserved OKF basename", () => {
    const idxById = mapOf([{ id: "9", title: "Index", parentId: null }]);
    const result = assembleConfluenceDocuments([page({ id: "9", title: "Index" })], idxById, {
      collectionSlug: "kb",
    });
    // A root 'index' folds to the overview stem so ingest can't silently skip it.
    expect(result.documents[0].path).toBe("kb/overview.md");
  });

  it("renames a page titled 'log' off the reserved OKF basename with a -doc suffix", () => {
    const nodes = mapOf([
      { id: "1", title: "Ops", parentId: null },
      { id: "2", title: "Log", parentId: "1" },
    ]);
    const result = assembleConfluenceDocuments([page({ id: "2", title: "Log", parentId: "1" })], nodes, {
      collectionSlug: "kb",
    });
    expect(result.documents[0].path).toBe("kb/ops/log-doc.md");
  });

  it("skips a contentless page and counts it, emitting no document", () => {
    const empty = page({ id: "5", title: "Empty", storageBody: "<p></p>" });
    const result = assembleConfluenceDocuments([empty], mapOf([{ id: "5", title: "Empty", parentId: null }]), {
      collectionSlug: "kb",
    });
    expect(result.documents).toHaveLength(0);
    expect(result.skippedContentless).toBe(1);
  });

  it("disambiguates two pages that slugify to the same path with the page id", () => {
    const nodes = mapOf([
      { id: "10", title: "A B", parentId: null },
      { id: "11", title: "A  B", parentId: null },
    ]);
    const result = assembleConfluenceDocuments(
      [page({ id: "10", title: "A B" }), page({ id: "11", title: "A  B" })],
      nodes,
      { collectionSlug: "kb" },
    );
    const paths = result.documents.map((d) => d.path).toSorted();
    expect(paths).toEqual(["kb/a-b-11.md", "kb/a-b.md"]);
  });

  it("aggregates macro degradations across pages", () => {
    const p1 = page({
      id: "20",
      title: "One",
      storageBody: '<p>x</p><ac:structured-macro ac:name="jira"/>',
    });
    const p2 = page({
      id: "21",
      title: "Two",
      storageBody: '<p>y</p><ac:structured-macro ac:name="jira"/><ac:image><ri:attachment ri:filename="a.png"/></ac:image>',
    });
    const result = assembleConfluenceDocuments(
      [p1, p2],
      mapOf([
        { id: "20", title: "One", parentId: null },
        { id: "21", title: "Two", parentId: null },
      ]),
      { collectionSlug: "kb" },
    );
    expect(result.degradations).toEqual([
      { name: "#image", count: 1 },
      { name: "jira", count: 2 },
    ]);
  });
});
