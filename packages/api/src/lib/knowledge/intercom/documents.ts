/**
 * Intercom article translation → OKF `ConnectorDocument` assembly (#4399,
 * PRD #4395).
 *
 * Pure, deterministic glue between the SHARED support HTML→markdown converter
 * (`../support/html-to-markdown.ts` — this vendor deliberately owns no HTML→md
 * logic of its own; it CONSUMES the Zendesk-anchor converter) and the connector
 * ingest seam. Each PUBLISHED locale of an article (a `translated_content`
 * entry with `state: "published"`) is a distinct document (the PRD's
 * "per-locale translations are distinct documents"); draft locales are never
 * emitted, so an unpublish reads as "path absent" and the reconciliation crawl
 * archives it.
 *
 * Paths are `<locale>/<title-slug>-<article-id>.md` — locale + article id make
 * them collision-free by construction (two locales never share both), and the
 * id suffix means a basename can never be a reserved OKF name — the
 * `deriveArchivePath` fold still runs as defence in depth. A title rename reads
 * as "old path archived + new path drafted", the documented rename-churn
 * posture (same as Zendesk/GitBook).
 *
 * Provenance that survives ingest: `resource` = the locale's canonical
 * help-center URL, `timestamp` = its modification time, plus an `atlas:`
 * extension block carrying connector + article id + locale + updated_at (the
 * AC's provenance fields). No provenance `tags`: `tags` is a mirrored column in
 * the lenient parser's change comparison, so stamping one would re-draft every
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
import { INTERCOM_VENDOR } from "./config";

/** One PUBLISHED locale of an article, ready to convert. */
export interface IntercomArticleContent {
  /** Stringified article id (stable across renames/locales). */
  readonly articleId: string;
  /** Locale code, e.g. `en` / `fr` (Intercom locales are lowercase). */
  readonly locale: string;
  readonly title: string;
  /** The locale's HTML body. */
  readonly bodyHtml: string;
  /** Canonical ISO instant (`epochSecondsToIso`) — never the raw vendor value. */
  readonly updatedAt: string;
  /** Canonical help-center URL of this locale. */
  readonly url: string;
}

export interface IntercomAssembleResult {
  readonly documents: readonly ConnectorDocument[];
  /** Media degradations aggregated across every assembled locale. */
  readonly degradations: readonly HtmlDegradation[];
  /** Locales skipped because they carried no ingestable prose. */
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
 * Assemble collected OKF documents from a set of fetched locales. Relative
 * hrefs in a body absolutize against that locale's own canonical URL (the
 * converter's cross-link hook), so a mirrored article's in-body links stay live.
 */
export function assembleIntercomDocuments(
  contents: readonly IntercomArticleContent[],
  options: { readonly collectionSlug: string },
): IntercomAssembleResult {
  const prefixSegments = normalizePrefix(options.collectionSlug);
  const documents: ConnectorDocument[] = [];
  const degradationTotals = new Map<string, number>();
  let skippedContentless = 0;

  for (const c of contents) {
    const { markdown, degradations } = convertSupportHtmlToMarkdown(c.bodyHtml, {
      pageUrl: c.url,
      rewriteLink: (href) => rewriteRelativeLink(href, c.url),
    });
    for (const d of degradations) {
      degradationTotals.set(d.name, (degradationTotals.get(d.name) ?? 0) + d.count);
    }
    if (isContentlessBody(markdown)) {
      skippedContentless++;
      continue;
    }

    const segments = [
      slugifyTitle(c.locale, "locale"),
      `${slugifyTitle(c.title, "article")}-${c.articleId}`,
    ];
    const derived = deriveArchivePath(`${segments.join("/")}.md`);
    const path = [...prefixSegments, derived.path].join("/");

    const title = c.title.trim();
    const content = renderOkfDocument(
      {
        ...(title !== "" ? { title } : {}),
        resource: c.url,
        timestamp: c.updatedAt,
      },
      [],
      markdown,
      {
        key: ATLAS_EXTENSION_KEY,
        fields: {
          connector: INTERCOM_VENDOR,
          article_id: c.articleId,
          locale: c.locale,
          updated_at: c.updatedAt,
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
 * The converter's cross-link hook: absolutize a relative help-center href
 * against the locale's own canonical URL so an in-body `/…` link stays live.
 * Absolute and unparseable hrefs pass through untouched.
 */
function rewriteRelativeLink(href: string, pageUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href; // already absolute (any scheme)
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    // intentionally ignored: an unparseable href renders as-is — the label text
    // is preserved either way, and a broken vendor link is the vendor's.
    return href;
  }
}
