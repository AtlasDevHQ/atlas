import { source, selfHostedSource } from "@/lib/source";
import {
  breadcrumbsFor,
  buildSearchIndexes,
  type IndexablePage,
} from "@/lib/search-index";
import { createSearchAPI } from "fumadocs-core/search/server";
import type { Root } from "fumadocs-core/page-tree";

export const revalidate = false;

// Enrich a section's pages with breadcrumbs resolved against that section's OWN
// page tree, so the ancestry (and the section-appropriate root name) is correct.
// The hand-built combined index below doesn't get breadcrumbs for free the way
// `createFromSource` did, so we fill them here at build time. Generic over the
// concrete page type so `data.structuredData` survives (the base LoaderConfig
// page would drop it).
function sectionPages<P extends IndexablePage>(
  pages: readonly P[],
  tree: Root,
): IndexablePage[] {
  return pages.map((page) => ({
    ...page,
    breadcrumbs: breadcrumbsFor(tree, page.url),
  }));
}

// Combined static search index across all THREE docs sections (PRD #4257, slice
// #4262): the SaaS site-root tree + the `/api-reference/*` tree (both in the root
// `source`) and the `/self-hosted/*` tree (`selfHostedSource`). Each page is
// stamped with its section facet (the `tag` field = `saas` | `self-hosted` |
// `api`) via `buildSearchIndexes`, so global search spans every section and the
// dialog can optionally scope to one. A `shared` page mounts in both human trees
// and so appears once per mount, each entry keeping the URL of the mount it links
// to.
//
// Still a static export: `createSearchAPI("advanced", …)` uses the same Orama
// engine as the previous `createFromSource(source)`, and its `staticGET` emits
// the index as static JSON — no runtime search server (paired with the client's
// `useDocsSearch({ type: "static" })`).
export const { staticGET: GET } = createSearchAPI("advanced", {
  indexes: buildSearchIndexes([
    ...sectionPages(source.getPages(), source.getPageTree()),
    ...sectionPages(selfHostedSource.getPages(), selfHostedSource.getPageTree()),
  ]),
});
