/**
 * GitBook page → OKF `ConnectorDocument` assembly (#4393, ADR-0030).
 *
 * Pure, deterministic glue between the markdown converter and the connector
 * ingest seam. For each page it:
 *   1. builds a **hierarchy slug path** from the page's GitBook `path` (already
 *      a root→leaf slug path, e.g. `guides/setup`), so the agent's `explore`
 *      mirror reads a readable tree — then folds it through `@atlas/okf-bundle`'s
 *      `deriveArchivePath` so reserved OKF basenames (`index.md`/`log.md`) can
 *      never be silently skipped at ingest;
 *   2. converts the GitBook-flavored markdown to honest CommonMark (counting
 *      block degradations);
 *   3. renders a conformant OKF document via the shared `renderOkfDocument`,
 *      stamping **provenance that survives ingest**: `resource` = the page's
 *      canonical URL and `timestamp` = the page's modification time, plus an
 *      `atlas:` extension block carrying `connector` + `page_id` + `updated_at`
 *      (vendor + page id + version). No provenance `tags`: `tags` is a mirrored
 *      column in the lenient parser's change comparison, so stamping one would
 *      re-draft every already-ingested GitBook document; the extension block
 *      stays outside the comparison (the Notion connector's posture).
 *
 * Paths are a pure function of the page's own `path` (no ordering, no batch
 * dependency) so the reconciliation subtractive diff stays stable: a page move
 * reads as "old path archived + new path drafted", the documented rename-churn
 * posture. GitBook paths are unique per space, but slugification can still
 * collide, so a collision is disambiguated with the page id rather than one page
 * silently overwriting the other; the count is returned so the client can
 * surface it (the module itself stays pure).
 */

import {
  deriveArchivePath,
  normalizePrefix,
  renderOkfDocument,
  isContentlessBody,
  ATLAS_EXTENSION_KEY,
} from "@atlas/okf-bundle";
import type { ConnectorDocument } from "../connectors";
import { GITBOOK_VENDOR } from "./config";
import { convertGitbookMarkdown, type BlockDegradation } from "./content-to-markdown";

/** A fully-fetched GitBook page ready to convert + assemble. */
export interface GitbookPage {
  /** GitBook page id (stable per page). */
  readonly id: string;
  /** Plain-text page title. */
  readonly title: string;
  /** The page's GitBook slug path within the space, e.g. `guides/setup`. */
  readonly path: string;
  /** The GitBook-flavored markdown body (`?format=markdown`). */
  readonly markdown: string;
  /** The page's modification time (canonical ISO instant). */
  readonly updatedAt: string;
  /** Canonical web URL of the page (`urls.app`), or a fallback. */
  readonly url: string;
}

export interface AssembleResult {
  readonly documents: readonly ConnectorDocument[];
  /** Block degradations aggregated across every assembled page. */
  readonly degradations: readonly BlockDegradation[];
  /** Pages skipped because they carried no ingestable prose (empty pages). */
  readonly skippedContentless: number;
  /** Pages whose path collided and were disambiguated with the page id. */
  readonly collisionsRenamed: number;
}

/** Slugify one GitBook path segment into a single path token; `fallback` guarantees non-empty. */
function slugifySegment(segment: string, fallback: string): string {
  const slug = segment
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
}

/** The collection-relative archive path for one page (prefix included). */
function pagePath(page: GitbookPage, prefixSegments: readonly string[]): string {
  const rawSegments = page.path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const segments =
    rawSegments.length > 0
      ? rawSegments.map((s, i) => slugifySegment(s, `section-${i}`))
      : [slugifySegment(page.title, `page-${page.id}`)];
  const derived = deriveArchivePath(`${segments.join("/")}.md`);
  return [...prefixSegments, derived.path].join("/");
}

/**
 * Assemble collected OKF documents from a set of fetched pages. `pages` is the
 * subset to convert + emit (the changed set on an incremental cycle, the full
 * set on reconciliation).
 */
export function assembleGitbookDocuments(
  pages: readonly GitbookPage[],
  options: { readonly collectionSlug: string },
): AssembleResult {
  const prefixSegments = normalizePrefix(options.collectionSlug);
  const documents: ConnectorDocument[] = [];
  const degradationTotals = new Map<string, number>();
  const usedPaths = new Map<string, string>();
  let skippedContentless = 0;
  let collisionsRenamed = 0;

  for (const page of pages) {
    const { markdown, degradations } = convertGitbookMarkdown(page.markdown, {
      pageUrl: page.url,
    });
    for (const d of degradations) {
      degradationTotals.set(d.name, (degradationTotals.get(d.name) ?? 0) + d.count);
    }
    if (isContentlessBody(markdown)) {
      skippedContentless++;
      continue;
    }

    let path = pagePath(page, prefixSegments);
    const owner = usedPaths.get(path);
    if (owner !== undefined && owner !== page.id) {
      // Deterministic disambiguation — append the page id rather than let one
      // page silently clobber another's document at ingest.
      const withoutExt = path.replace(/\.md$/i, "");
      path = `${withoutExt}-${page.id}.md`;
      collisionsRenamed++;
    }
    usedPaths.set(path, page.id);

    const title = page.title.trim();
    const content = renderOkfDocument(
      {
        ...(title !== "" ? { title } : {}),
        resource: page.url,
        timestamp: page.updatedAt,
      },
      [],
      markdown,
      {
        key: ATLAS_EXTENSION_KEY,
        fields: {
          connector: GITBOOK_VENDOR,
          page_id: page.id,
          updated_at: page.updatedAt,
        },
      },
    );
    documents.push({ path, content });
  }

  const degradations = [...degradationTotals.entries()]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return { documents, degradations, skippedContentless, collisionsRenamed };
}
