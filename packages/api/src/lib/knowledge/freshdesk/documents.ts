/**
 * Freshdesk article-locale → OKF `ConnectorDocument` assembly (#4401,
 * PRD #4395).
 *
 * Pure, deterministic glue between the SHARED support HTML→markdown converter
 * (`../support/html-to-markdown.ts` — this vendor deliberately owns no
 * HTML→md logic of its own) and the connector ingest seam. Each PUBLISHED
 * language variant of an article is a distinct document (the PRD's "per-language
 * translations are distinct documents"); draft articles (`status !== 2`) are
 * never emitted, so an unpublish/delete reads as "path absent" and the
 * reconciliation crawl archives it.
 *
 * Paths are `<locale>/<title-slug>-<article-id>.md` — locale + article id make
 * them collision-free by construction (two language variants never share both),
 * and the id suffix means a basename can never be a reserved OKF name — the
 * `deriveArchivePath` fold still runs as defence in depth. A title rename reads
 * as "old path archived + new path drafted", the documented rename-churn
 * posture (same as Zendesk/Front).
 *
 * Provenance that survives ingest: `resource` = the article's canonical
 * help-center URL, `timestamp` = its `updated_at`, plus an `atlas:` extension
 * block carrying connector + product (category) + category id + article id +
 * locale + updated_at (the AC's provenance fields). No provenance `tags`:
 * `tags` is a mirrored column in the lenient parser's change comparison, so
 * stamping one would re-draft every already-ingested document; the extension
 * block stays outside the comparison (the Zendesk/Front posture).
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
import { FRESHDESK_VENDOR } from "./config";

/** One PUBLISHED language variant of an article, ready to convert. */
export interface FreshdeskArticleLocale {
  /** Stable Freshdesk article id (shared across its language variants). */
  readonly articleId: string;
  /** The Solutions category this article belongs to (its numeric id). */
  readonly categoryId: string;
  /** Human category name — the provenance `product` label. */
  readonly categoryName: string;
  /** Article language, e.g. `en` or `fr` (normalized lowercase). */
  readonly locale: string;
  readonly title: string;
  /** The article's HTML body (`description`). */
  readonly bodyHtml: string;
  /** Canonical ISO instant (`toIsoInstant`) — never the raw vendor string. */
  readonly updatedAt: string;
  /** The article's own URL, or a canonical help-center path when it omits one. */
  readonly url: string;
}

export interface FreshdeskAssembleResult {
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
 * Assemble collected OKF documents from a set of fetched article locales.
 * `categoryName`/`categoryId` land in the `atlas:` provenance block (the AC's
 * "provenance carries product + article id + locale + updated_at").
 */
export function assembleFreshdeskDocuments(
  articles: readonly FreshdeskArticleLocale[],
  options: { readonly collectionSlug: string },
): FreshdeskAssembleResult {
  const prefixSegments = normalizePrefix(options.collectionSlug);
  const documents: ConnectorDocument[] = [];
  const degradationTotals = new Map<string, number>();
  let skippedContentless = 0;

  for (const a of articles) {
    const { markdown, degradations } = convertSupportHtmlToMarkdown(a.bodyHtml, {
      pageUrl: a.url,
    });
    for (const d of degradations) {
      degradationTotals.set(d.name, (degradationTotals.get(d.name) ?? 0) + d.count);
    }
    if (isContentlessBody(markdown)) {
      skippedContentless++;
      continue;
    }

    const segments = [
      slugifyTitle(a.locale, "locale"),
      `${slugifyTitle(a.title, "article")}-${a.articleId}`,
    ];
    const derived = deriveArchivePath(`${segments.join("/")}.md`);
    const path = [...prefixSegments, derived.path].join("/");

    const title = a.title.trim();
    const content = renderOkfDocument(
      {
        ...(title !== "" ? { title } : {}),
        resource: a.url,
        timestamp: a.updatedAt,
      },
      [],
      markdown,
      {
        key: ATLAS_EXTENSION_KEY,
        fields: {
          connector: FRESHDESK_VENDOR,
          product: a.categoryName !== "" ? a.categoryName : a.categoryId,
          category_id: a.categoryId,
          article_id: a.articleId,
          locale: a.locale,
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
