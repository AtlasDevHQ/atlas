import { test, expect } from "bun:test";
import type { Root } from "fumadocs-core/page-tree";
import {
  breadcrumbsFor,
  buildSearchIndexes,
  sectionForUrl,
  SEARCH_SECTIONS,
  type IndexablePage,
  type SearchSection,
} from "@/lib/search-index";

/**
 * Section-faceted combined-index test (PRD #4257, slice #4262).
 *
 * The static search index is rebuilt over all THREE docs sections (SaaS site
 * root, `/self-hosted`, `/api-reference`) as ONE index, each entry stamped with
 * its `section` facet so global search spans every section and can optionally
 * scope to one. These assertions exercise the pure builder + breadcrumb resolver
 * directly with synthetic fixtures, so they need neither the generated
 * `.source/server` (only the Next bundler can load its `*.mdx?collection=…`
 * modules) nor any network/filesystem access — the same self-contained shape as
 * `source-partition.test.ts`.
 */

// Minimal structuredData stub — the builder only forwards it onto the index,
// never inspects it. Matches the `{ headings, contents }` shape fumadocs emits.
const EMPTY_STRUCTURED = { headings: [], contents: [] };

function page(
  url: string,
  title: string,
  breadcrumbs?: readonly string[],
): IndexablePage {
  return {
    url,
    breadcrumbs,
    data: {
      title,
      description: `${title} description`,
      structuredData: EMPTY_STRUCTURED,
    },
  };
}

// A page from each of the three sections + a `shared` page mounted into BOTH
// human trees (so it appears once per mount, at `/x` and `/self-hosted/x`).
const rootSourcePages: IndexablePage[] = [
  page("/", "Introduction"), // saas
  page("/guides/billing-and-plans", "Billing & Plans"), // saas
  page("/api-reference", "API Reference"), // api
  page("/api-reference/chat/postChat", "POST /chat"), // api
  page("/semantic-layer", "Semantic Layer"), // shared, root mount
];
const selfHostedSourcePages: IndexablePage[] = [
  page("/self-hosted", "Self-Hosted"), // self-hosted
  page("/self-hosted/docker", "Docker Deploy"), // self-hosted
  page("/self-hosted/semantic-layer", "Semantic Layer"), // shared, self-hosted mount
];

const indexes = buildSearchIndexes([
  ...rootSourcePages,
  ...selfHostedSourcePages,
]);
const byUrl = new Map(indexes.map((i) => [i.url, i]));

test("SEARCH_SECTIONS is the SSOT for the facet values sectionForUrl produces", () => {
  // Every section sectionForUrl can emit is a member of the ordered SSOT, and
  // vice versa — so the dialog (which renders from SEARCH_SECTIONS) and the index
  // (tagged via sectionForUrl) can never fall out of sync.
  const produced = new Set(
    ["/", "/self-hosted/x", "/api-reference/x"].map(sectionForUrl),
  );
  expect(new Set(SEARCH_SECTIONS)).toEqual(produced);
});

test("sectionForUrl maps each URL to the right section facet", () => {
  const cases: Array<[string, SearchSection]> = [
    ["/", "saas"],
    ["/guides/billing-and-plans", "saas"],
    ["/semantic-layer", "saas"],
    ["/self-hosted", "self-hosted"],
    ["/self-hosted/docker", "self-hosted"],
    ["/api-reference", "api"],
    ["/api-reference/chat/postChat", "api"],
  ];
  for (const [url, section] of cases) {
    expect(sectionForUrl(url)).toBe(section);
  }
});

test("sectionForUrl does not confuse similar prefixes", () => {
  // A saas page whose slug merely starts with the letters "api" (no
  // `/api-reference` prefix) or "self" must stay `saas`.
  expect(sectionForUrl("/api-keys")).toBe("saas");
  expect(sectionForUrl("/apiary")).toBe("saas");
  expect(sectionForUrl("/self-service")).toBe("saas");
});

test("combined index carries one entry per mounted page across all three sections", () => {
  // Cardinality floor: an empty/partial build would slip past the per-section
  // `.some()` checks below, so pin the exact count first.
  expect(indexes.length).toBe(
    rootSourcePages.length + selfHostedSourcePages.length,
  );

  const sections = new Set(indexes.map((i) => i.tag));
  expect(sections).toEqual(
    new Set<SearchSection>(["saas", "self-hosted", "api"]),
  );

  // Every section is actually represented (not just present in the union type).
  expect(indexes.some((i) => i.tag === "saas")).toBe(true);
  expect(indexes.some((i) => i.tag === "self-hosted")).toBe(true);
  expect(indexes.some((i) => i.tag === "api")).toBe(true);
});

test("every index entry's tag equals sectionForUrl(url) and preserves url/title/description/data", () => {
  for (const idx of indexes) {
    expect(idx.tag).toBe(sectionForUrl(idx.url));
    // id === url (matches createFromSource's default), and the searchable
    // fields are carried through from the page.
    expect(idx.id).toBe(idx.url);
    expect(typeof idx.title).toBe("string");
    // description must survive the mapping (drives result snippets).
    expect(idx.description).toBe(`${idx.title} description`);
    expect(idx.structuredData).toBe(EMPTY_STRUCTURED);
  }
});

test("api-reference pages are tagged 'api', not 'saas' (they live inside the root source)", () => {
  // The api-reference tree lives under content/docs (the root source), so it
  // arrives in `rootSourcePages`; the facet must still separate it out as `api`.
  expect(byUrl.get("/api-reference")?.tag).toBe("api");
  expect(byUrl.get("/api-reference/chat/postChat")?.tag).toBe("api");
});

test("a shared page yields a distinct entry per mount, each linking to its own section URL", () => {
  const rootMount = byUrl.get("/semantic-layer");
  const selfHostedMount = byUrl.get("/self-hosted/semantic-layer");

  expect(rootMount).toBeDefined();
  expect(selfHostedMount).toBeDefined();

  // Same page, two mounts → two index entries with different URLs + facets, so a
  // reader finds it in either section and the result links to the mount they are
  // on (never a cross-section 404).
  expect(rootMount?.tag).toBe("saas");
  expect(selfHostedMount?.tag).toBe("self-hosted");
  expect(rootMount?.url).not.toBe(selfHostedMount?.url);
  expect(rootMount?.id).not.toBe(selfHostedMount?.id);
});

test("buildSearchIndexes forwards a page's breadcrumbs onto its index entry", () => {
  const [idx] = buildSearchIndexes([
    page("/guides/billing-and-plans", "Billing", ["Docs", "Guides"]),
  ]);
  expect(idx.breadcrumbs).toEqual(["Docs", "Guides"]);
  // A page without breadcrumbs leaves the field undefined (SharedIndex optional).
  expect(byUrl.get("/")?.breadcrumbs).toBeUndefined();
});

// ── breadcrumbsFor: mirrors Fumadocs' buildBreadcrumbs over a section page tree ──
//
// Synthetic PageTree fixture: a root ("Docs") with a top-level page, a "Guides"
// folder holding a page and a nested "Deep" folder whose landing is an index
// page, plus a folder with a non-string (React-node) name to prove such names are
// skipped. Uses the REAL `findPath`, so this pins our thin wrapper (root-name +
// pop + string filter), not a reimplemented walk.
const tree: Root = {
  name: "Docs",
  children: [
    { type: "page", name: "Home", url: "/" },
    {
      type: "folder",
      name: "Guides",
      children: [
        { type: "page", name: "Billing", url: "/guides/billing-and-plans" },
        {
          type: "folder",
          name: "Deep",
          index: { type: "page", name: "Deep Landing", url: "/guides/deep" },
          children: [
            { type: "page", name: "Nested", url: "/guides/deep/nested" },
          ],
        },
      ],
    },
    {
      type: "folder",
      // A non-string name (a number is a valid ReactNode) must be skipped, just
      // as Fumadocs' isBreadcrumbItem skips non-string names.
      name: 7,
      children: [{ type: "page", name: "Weird", url: "/weird/child" }],
    },
  ],
};

test("breadcrumbsFor returns root + ancestor folder names, dropping the page leaf", () => {
  expect(breadcrumbsFor(tree, "/guides/billing-and-plans")).toEqual([
    "Docs",
    "Guides",
  ]);
  expect(breadcrumbsFor(tree, "/guides/deep/nested")).toEqual([
    "Docs",
    "Guides",
    "Deep",
  ]);
});

test("breadcrumbsFor includes the folder for a folder-index landing page", () => {
  // The Deep folder's landing (/guides/deep) resolves through the folder's index;
  // the Deep folder still appears as a breadcrumb (its own leaf is dropped).
  expect(breadcrumbsFor(tree, "/guides/deep")).toEqual([
    "Docs",
    "Guides",
    "Deep",
  ]);
});

test("breadcrumbsFor skips non-string (React-node) folder names", () => {
  expect(breadcrumbsFor(tree, "/weird/child")).toEqual(["Docs"]);
});

test("breadcrumbsFor returns [] for a URL not in the tree", () => {
  expect(breadcrumbsFor(tree, "/does/not/exist")).toEqual([]);
});
