/**
 * Zendesk article translation → OKF `ConnectorDocument` assembly (#4396,
 * PRD #4395).
 *
 * Pure, deterministic glue between the SHARED support HTML→markdown converter
 * (`../support/html-to-markdown.ts` — this vendor deliberately owns no
 * HTML→md logic of its own) and the connector ingest seam. Each PUBLISHED
 * translation of a published article is a distinct document (the PRD's
 * "per-locale translations are distinct documents"); draft articles and draft
 * translations are never emitted, so an unpublish reads as "path absent" and
 * the reconciliation crawl archives it.
 *
 * Paths are `<locale>/<title-slug>-<article-id>.md` — locale + article id make
 * them collision-free by construction (two translations never share both),
 * and the id suffix means a basename can never be a reserved OKF name — the
 * `deriveArchivePath` fold still runs as defence in depth. A title rename
 * reads as "old path archived + new path drafted", the documented rename-churn
 * posture (same as Confluence/GitBook).
 *
 * Provenance that survives ingest: `resource` = the translation's canonical
 * help-center URL, `timestamp` = its modification time, plus an `atlas:`
 * extension block carrying connector + brand + article id + locale +
 * updated_at (the AC's provenance fields). No provenance `tags`: `tags` is a
 * mirrored column in the lenient parser's change comparison, so stamping one
 * would re-draft every already-ingested document; the extension block stays
 * outside the comparison (the GitBook/Notion posture).
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
import { ZENDESK_VENDOR, zendeskHostFor } from "./config";

/** One PUBLISHED translation of a PUBLISHED article, ready to convert. */
export interface ZendeskArticleTranslation {
  /** Stringified numeric article id (stable across renames/locales). */
  readonly articleId: string;
  /** Translation locale, e.g. `en-us` (Zendesk locales are lowercase). */
  readonly locale: string;
  readonly title: string;
  /** The translation's HTML body. */
  readonly bodyHtml: string;
  /** Canonical ISO instant (`toIsoInstant`) — never the raw vendor string. */
  readonly updatedAt: string;
  /** Canonical help-center URL of this translation. */
  readonly url: string;
}

export interface ZendeskAssembleResult {
  readonly documents: readonly ConnectorDocument[];
  /** Media degradations aggregated across every assembled translation. */
  readonly degradations: readonly HtmlDegradation[];
  /** Translations skipped because they carried no ingestable prose. */
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
 * Assemble collected OKF documents from a set of fetched translations.
 * `brandSubdomain` is the collection's brand host label — it resolves the
 * converter's cross-link hook (relative `/hc/…` hrefs absolutize against the
 * brand's help center) and lands in the `atlas:` provenance block.
 */
export function assembleZendeskDocuments(
  translations: readonly ZendeskArticleTranslation[],
  options: { readonly collectionSlug: string; readonly brandSubdomain: string },
): ZendeskAssembleResult {
  const prefixSegments = normalizePrefix(options.collectionSlug);
  const brandBase = zendeskHostFor(options.brandSubdomain);
  const documents: ConnectorDocument[] = [];
  const degradationTotals = new Map<string, number>();
  let skippedContentless = 0;

  for (const t of translations) {
    const { markdown, degradations } = convertSupportHtmlToMarkdown(t.bodyHtml, {
      pageUrl: t.url,
      rewriteLink: (href) => rewriteBrandLink(href, brandBase),
    });
    for (const d of degradations) {
      degradationTotals.set(d.name, (degradationTotals.get(d.name) ?? 0) + d.count);
    }
    if (isContentlessBody(markdown)) {
      skippedContentless++;
      continue;
    }

    const segments = [
      slugifyTitle(t.locale, "locale"),
      `${slugifyTitle(t.title, "article")}-${t.articleId}`,
    ];
    const derived = deriveArchivePath(`${segments.join("/")}.md`);
    const path = [...prefixSegments, derived.path].join("/");

    const title = t.title.trim();
    const content = renderOkfDocument(
      {
        ...(title !== "" ? { title } : {}),
        resource: t.url,
        timestamp: t.updatedAt,
      },
      [],
      markdown,
      {
        key: ATLAS_EXTENSION_KEY,
        fields: {
          connector: ZENDESK_VENDOR,
          brand: options.brandSubdomain,
          article_id: t.articleId,
          locale: t.locale,
          updated_at: t.updatedAt,
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
 * The converter's cross-link hook: absolutize relative help-center hrefs
 * against the brand host so a mirrored article's `/hc/en-us/articles/…` links
 * stay live. Absolute and unparseable hrefs pass through untouched.
 */
function rewriteBrandLink(href: string, brandBase: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href; // already absolute (any scheme)
  try {
    return new URL(href, brandBase).toString();
  } catch {
    // intentionally ignored: an unparseable href renders as-is — the label
    // text is preserved either way, and a broken vendor link is the vendor's.
    return href;
  }
}
