/**
 * Help Scout article → OKF `ConnectorDocument` assembly (#4398, PRD #4395).
 *
 * Pure, deterministic glue between the SHARED support HTML→markdown converter
 * (`../support/html-to-markdown.ts` — this vendor deliberately owns no HTML→md
 * logic of its own, per the PRD) and the connector ingest seam. Each PUBLISHED
 * article is a distinct document; unpublished/deleted articles never reach here
 * (the client filters `status=published`), so an unpublish reads as "path
 * absent" and the reconciliation crawl archives it.
 *
 * Paths are `<source-collection-slug>/<title-slug>-<article-id>.md` under the
 * KB collection's slug prefix (`normalizePrefix(options.collectionSlug)`) — the
 * article id makes them collision-free by construction (two articles never
 * share it) and means a basename can never be a reserved OKF name; the
 * `deriveArchivePath` fold still runs as defence in depth. A title rename reads
 * as "old path archived + new path drafted", the documented rename-churn
 * posture (same as Zendesk/GitBook/Confluence).
 *
 * Provenance that survives ingest: `resource` = the article's canonical public
 * URL, `timestamp` = its modification time, plus an `atlas:` extension block
 * carrying connector + site + article id + updated_at (the AC's provenance
 * fields). No provenance `tags`: `tags` is a mirrored column in the lenient
 * parser's change comparison, so stamping one would re-draft every
 * already-ingested document; the extension block stays outside the comparison
 * (the Zendesk/GitBook posture).
 */

import {
  deriveArchivePath,
  normalizePrefix,
  renderOkfDocument,
  isContentlessBody,
  ATLAS_EXTENSION_KEY,
} from "@atlas/okf-bundle";
import type { ConnectorDocument } from "../connectors";
import {
  convertSupportHtmlToMarkdown,
  type HtmlDegradation,
} from "../support/html-to-markdown";
import { HELPSCOUT_VENDOR } from "./config";

/** One PUBLISHED article, body fetched, ready to convert. */
export interface HelpScoutArticle {
  /** Stringified article id (stable across renames/moves). */
  readonly articleId: string;
  readonly title: string;
  /** The article's HTML body (`text`). */
  readonly bodyHtml: string;
  /** Canonical ISO instant (`toIsoInstant`) — never the raw vendor string. */
  readonly updatedAt: string;
  /** Canonical public URL of this article (may be empty for a private site). */
  readonly url: string;
  /** The source Docs collection slug — the leading path segment. */
  readonly collectionSlug: string;
}

export interface HelpScoutAssembleResult {
  readonly documents: readonly ConnectorDocument[];
  /** Media degradations aggregated across every assembled article. */
  readonly degradations: readonly HtmlDegradation[];
  /** Articles skipped because they carried no ingestable prose. */
  readonly skippedContentless: number;
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

/**
 * Assemble collected OKF documents from a set of fetched articles. `siteId`
 * lands in the `atlas:` provenance block (the AC's "site"); the article's own
 * public URL resolves the converter's cross-link hook (relative hrefs
 * absolutize against it).
 */
export function assembleHelpScoutDocuments(
  articles: readonly HelpScoutArticle[],
  options: { readonly collectionSlug: string; readonly siteId: string },
): HelpScoutAssembleResult {
  const prefixSegments = normalizePrefix(options.collectionSlug);
  const documents: ConnectorDocument[] = [];
  const degradationTotals = new Map<string, number>();
  let skippedContentless = 0;

  for (const a of articles) {
    const { markdown, degradations } = convertSupportHtmlToMarkdown(a.bodyHtml, {
      pageUrl: a.url,
      rewriteLink: (href) => rewriteArticleLink(href, a.url),
    });
    for (const d of degradations) {
      degradationTotals.set(d.name, (degradationTotals.get(d.name) ?? 0) + d.count);
    }
    if (isContentlessBody(markdown)) {
      skippedContentless++;
      continue;
    }

    const segments = [
      slugifyTitle(a.collectionSlug, "collection"),
      `${slugifyTitle(a.title, "article")}-${a.articleId}`,
    ];
    const derived = deriveArchivePath(`${segments.join("/")}.md`);
    const path = [...prefixSegments, derived.path].join("/");

    const title = a.title.trim();
    const content = renderOkfDocument(
      {
        ...(title !== "" ? { title } : {}),
        ...(a.url !== "" ? { resource: a.url } : {}),
        timestamp: a.updatedAt,
      },
      [],
      markdown,
      {
        key: ATLAS_EXTENSION_KEY,
        fields: {
          connector: HELPSCOUT_VENDOR,
          site: options.siteId,
          article_id: a.articleId,
          updated_at: a.updatedAt,
        },
      },
    );
    documents.push({ path, content });
  }

  const degradations = [...degradationTotals.entries()]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return { documents, degradations, skippedContentless };
}

/**
 * The converter's cross-link hook: absolutize relative article hrefs against
 * the article's own public URL so a mirrored link stays live. Absolute and
 * unparseable hrefs (and the no-public-URL case) pass through untouched.
 */
function rewriteArticleLink(href: string, articleUrl: string): string {
  if (articleUrl === "") return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href; // already absolute (any scheme)
  try {
    return new URL(href, articleUrl).toString();
  } catch {
    // intentionally ignored: an unparseable href renders as-is — the label text
    // is preserved either way, and a broken vendor link is the vendor's.
    return href;
  }
}
