import type { AdvancedIndex } from "fumadocs-core/search/server";
import { findPath, type Root } from "fumadocs-core/page-tree";

/**
 * The three docs sections a search result can belong to (PRD #4257, slice
 * #4262), in display order. This ordered list is the single source of truth —
 * `SearchSection` derives from it, `sectionForUrl` produces it, and the search
 * dialog's facet selector renders from it — so a rename lands in exactly one
 * place. Each value is the search **facet** stamped onto every index entry:
 *   - `saas`        → SaaS / Cloud docs at the site root (`/…`)
 *   - `self-hosted` → on-prem docs at `/self-hosted/…`
 *   - `api`         → the OpenAPI-generated reference at `/api-reference/…`
 */
export const SEARCH_SECTIONS = ["saas", "self-hosted", "api"] as const;

export type SearchSection = (typeof SEARCH_SECTIONS)[number];

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
  /**
   * Section-appropriate breadcrumb trail (ancestor folder names), pre-resolved by
   * the caller via `breadcrumbsFor` against the page's OWN section tree. Optional
   * so synthetic fixtures may omit it; `SharedIndex.breadcrumbs` is optional too.
   */
  readonly breadcrumbs?: readonly string[];
  readonly data: {
    readonly title: string;
    readonly description?: string;
    /**
     * The RESOLVED structured data. Assumes eager (non-`async`) collections — this
     * is the object, not the lazy `() => Promise<StructuredData>` an `async: true`
     * collection would emit. If a collection is ever flipped to async, `getPages()`
     * stops being assignable here and the build fails at compile time rather than
     * silently indexing unresolved functions.
     */
    readonly structuredData: AdvancedIndex["structuredData"];
  };
}

/**
 * A search-index entry with its facet narrowed to `SearchSection` — the invariant
 * `buildSearchIndexes` establishes (every `tag` is one of the three sections),
 * carried through to consumers instead of widening back to `AdvancedIndex`'s
 * `string | string[] | undefined`.
 */
export type SectionIndex = AdvancedIndex & { tag: SearchSection };

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

/** Fumadocs treats only non-empty string names as breadcrumb items. */
function isBreadcrumbName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0;
}

/**
 * Resolve a page's breadcrumb trail from its section's page tree — the string
 * names of its ancestors (the tree/root name + each ancestor folder). This
 * mirrors Fumadocs' own `buildBreadcrumbs`, which is internal and not importable,
 * by reusing the PUBLIC `findPath` (same walk Fumadocs uses) and its
 * `isBreadcrumbItem` rule (non-empty string names only — folder `name`s are
 * `ReactNode`, so an element/empty name is skipped). It restores the breadcrumb
 * context the previous `createFromSource(source)` populated automatically; the
 * hand-built combined index in `route.ts` does not get it for free. Pass each
 * page its OWN section tree so the ancestry (and the section-appropriate root
 * name) is correct.
 */
export function breadcrumbsFor(tree: Root, url: string): string[] {
  const path = findPath(
    tree.children,
    (node) => node.type === "page" && node.url === url,
  );
  if (!path) return [];

  const names: string[] = [];
  if (isBreadcrumbName(tree.name)) names.push(tree.name);
  // `findPath` returns the ancestor chain ending in the matched page node; drop
  // that leaf so only the ancestor folders (+ root) become breadcrumbs.
  path.pop();
  for (const segment of path) {
    if (isBreadcrumbName(segment.name)) names.push(segment.name);
  }
  return names;
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
): SectionIndex[] {
  return pages.map((page) => ({
    id: page.url,
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    tag: sectionForUrl(page.url),
    breadcrumbs: page.breadcrumbs ? [...page.breadcrumbs] : undefined,
    structuredData: page.data.structuredData,
  }));
}
