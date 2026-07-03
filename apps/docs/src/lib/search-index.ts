import type { AdvancedIndex } from "fumadocs-core/search/server";

/**
 * The three docs sections a search result can belong to (PRD #4257, slice
 * #4262). This is the search **facet** — the value stamped onto every index
 * entry so a global search can be optionally scoped to one section:
 *   - `saas`        → SaaS / Cloud docs at the site root (`/…`)
 *   - `self-hosted` → on-prem docs at `/self-hosted/…`
 *   - `api`         → the OpenAPI-generated reference at `/api-reference/…`
 */
export type SearchSection = "saas" | "self-hosted" | "api";

/**
 * The minimal page shape the index builder reads — a structural subset of a real
 * Fumadocs page (`InferPageType<typeof source>`), so `source.getPages()` /
 * `selfHostedSource.getPages()` pass without a cast, and synthetic fixtures can
 * satisfy it in `bun test` (which cannot load the generated `.source/server`).
 * `structuredData` is derived from `AdvancedIndex` so there is no dependency on a
 * fragile deep import path for the type.
 */
export interface IndexablePage {
  readonly url: string;
  readonly data: {
    readonly title: string;
    readonly description?: string;
    readonly structuredData: AdvancedIndex["structuredData"];
  };
}

/**
 * Map a mounted page URL to its section facet. The URL already encodes the
 * mount: api-reference stays at `/api-reference/*`, self-hosted at
 * `/self-hosted/*`, and everything else is the SaaS site root (including a
 * `shared` page mounted at the root). The three prefixes are disjoint, so this
 * is unambiguous — a self-hosted URL never starts with `/api-reference`, etc.
 */
export function sectionForUrl(url: string): SearchSection {
  if (url === "/self-hosted" || url.startsWith("/self-hosted/"))
    return "self-hosted";
  if (url === "/api-reference" || url.startsWith("/api-reference/"))
    return "api";
  return "saas";
}

/**
 * Build the ONE combined advanced search index over every section's pages,
 * stamping each entry with its `section` facet (`tag`). Pass the union of both
 * loader sources' pages — the root source (saas + api-reference + shared-at-root)
 * and the self-hosted source (self-hosted + shared-at-`/self-hosted`). A `shared`
 * page therefore yields two entries — one per mount — each with the correct URL
 * and section tag, so it is searchable from both sections and always links to the
 * mount the reader is on.
 *
 * Pure over the page list (no `.source/server` import), so it is unit-testable
 * with synthetic fixtures. The output feeds `createSearchAPI("advanced", …)`,
 * whose `staticGET` exports the index as static JSON — no runtime search server.
 */
export function buildSearchIndexes(
  pages: readonly IndexablePage[],
): AdvancedIndex[] {
  return pages.map((page) => ({
    id: page.url,
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    tag: sectionForUrl(page.url),
    structuredData: page.data.structuredData,
  }));
}
