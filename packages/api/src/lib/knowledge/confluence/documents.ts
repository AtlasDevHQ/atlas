/**
 * Confluence page → OKF `ConnectorDocument` assembly (#4377, PRD #4375).
 *
 * Pure, deterministic glue between the storage→markdown converter and the
 * connector ingest seam. For each page it:
 *   1. builds a **hierarchy slug path** from the page's ancestor titles (root →
 *      leaf), so the agent's `explore` mirror reads a readable tree — then folds
 *      it through `@atlas/okf-bundle`'s `deriveArchivePath` so reserved OKF
 *      basenames (`index.md`/`log.md`) can never be silently skipped at ingest;
 *   2. converts the storage XHTML to markdown (counting macro degradations);
 *   3. renders a conformant OKF document via the shared `renderOkfDocument`,
 *      stamping **provenance that survives ingest**: `resource` = the page's
 *      canonical URL (which encodes the vendor page id and is the compliance
 *      trace-back link) and `timestamp` = the current version's modification
 *      time. Vendor + sync-time provenance are added structurally downstream
 *      (`atlas_source = connector:confluence`, `atlas_ingested_at`) and
 *      regenerated on the mirror's `atlas:` block.
 *
 * In the common case, paths are a pure function of ancestor + own titles (no
 * page ids, no ordering) so the reconciliation subtractive diff stays stable: a
 * title rename reads as "old path archived + new path drafted", the documented
 * rename-churn posture. The one exception: two pages that slugify to the same
 * path (rare — Confluence enforces unique titles per space, but slugification
 * can still collide) are disambiguated with the numeric page id rather than one
 * silently overwriting the other. The count of such renames is returned so the
 * client can surface it (the module itself stays pure).
 */

import {
  deriveArchivePath,
  normalizePrefix,
  renderOkfDocument,
  isContentlessBody,
} from "@atlas/okf-bundle";
import type { ConnectorDocument } from "../connectors";
import { convertStorageToMarkdown, type MacroDegradation } from "./storage-to-markdown";

/** The minimal per-page metadata the path builder walks (id → parent). */
export interface ConfluencePageNode {
  readonly id: string;
  readonly title: string;
  /** Parent page id, or null for a space-root page. */
  readonly parentId: string | null;
}

/** A fully-fetched page ready to convert + assemble. */
export interface ConfluencePage extends ConfluencePageNode {
  /** Storage-format XHTML body (`body-format=storage`). */
  readonly storageBody: string;
  /** The current version's modification time (ISO-8601) — `version.createdAt`. */
  readonly modifiedAt: string;
  /** Canonical web URL of the page (`_links.base` + `_links.webui`). */
  readonly url: string;
}

export interface AssembleResult {
  readonly documents: readonly ConnectorDocument[];
  /** Macro/image degradations aggregated across every assembled page. */
  readonly degradations: readonly MacroDegradation[];
  /** Pages skipped because they carried no ingestable prose (empty containers). */
  readonly skippedContentless: number;
  /** Pages whose path collided and were disambiguated with the page id. */
  readonly collisionsRenamed: number;
}

/** The `tags` stamped on every Confluence document (provenance; survives ingest). */
const CONFLUENCE_TAG = "confluence";

/**
 * Root-first ancestor titles for a page, walking `parentId` in `byId`. Stops on
 * a missing parent (a restricted/absent ancestor) or a cycle — a defensive
 * guard, since a real Confluence tree is acyclic.
 */
export function ancestorTitles(
  pageId: string,
  byId: ReadonlyMap<string, ConfluencePageNode>,
): string[] {
  const titles: string[] = [];
  const seen = new Set<string>([pageId]);
  let current = byId.get(pageId)?.parentId ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const node = byId.get(current);
    if (node === undefined) break;
    titles.push(node.title);
    current = node.parentId;
  }
  return titles.reverse();
}

/** Slugify a title into a single path segment; `fallback` guarantees non-empty. */
export function slugifyTitle(title: string, fallback: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
}

/** The collection-relative archive path for one page (prefix included). */
function pagePath(
  page: ConfluencePageNode,
  byId: ReadonlyMap<string, ConfluencePageNode>,
  prefixSegments: readonly string[],
): string {
  const segments = [
    ...ancestorTitles(page.id, byId).map((t, i) => slugifyTitle(t, `section-${i}`)),
    slugifyTitle(page.title, `page-${page.id}`),
  ];
  const derived = deriveArchivePath(`${segments.join("/")}.md`);
  return [...prefixSegments, derived.path].join("/");
}

/**
 * Assemble collected OKF documents from a set of fetched pages. `byId` is the
 * FULL space metadata map (so ancestry resolves even when `pages` is only the
 * changed subset of an incremental cycle); `pages` is the subset to actually
 * convert + emit.
 */
export function assembleConfluenceDocuments(
  pages: readonly ConfluencePage[],
  byId: ReadonlyMap<string, ConfluencePageNode>,
  options: { readonly collectionSlug: string },
): AssembleResult {
  const prefixSegments = normalizePrefix(options.collectionSlug);
  const documents: ConnectorDocument[] = [];
  const degradationTotals = new Map<string, number>();
  const usedPaths = new Map<string, string>();
  let skippedContentless = 0;
  let collisionsRenamed = 0;

  for (const page of pages) {
    const { markdown, degradations } = convertStorageToMarkdown(page.storageBody, {
      pageUrl: page.url,
    });
    for (const d of degradations) {
      degradationTotals.set(d.name, (degradationTotals.get(d.name) ?? 0) + d.count);
    }
    if (isContentlessBody(markdown)) {
      skippedContentless++;
      continue;
    }

    let path = pagePath(page, byId, prefixSegments);
    const owner = usedPaths.get(path);
    if (owner !== undefined && owner !== page.id) {
      // Deterministic disambiguation — append the page id rather than let one
      // page silently clobber another's document at ingest.
      const withoutExt = path.replace(/\.md$/i, "");
      path = `${withoutExt}-${page.id}.md`;
      collisionsRenamed++;
    }
    usedPaths.set(path, page.id);

    const content = renderOkfDocument(
      { title: page.title, resource: page.url, timestamp: page.modifiedAt },
      [CONFLUENCE_TAG],
      markdown,
    );
    documents.push({ path, content });
  }

  const degradations = [...degradationTotals.entries()]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return { documents, degradations, skippedContentless, collisionsRenamed };
}
