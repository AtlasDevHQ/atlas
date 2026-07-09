/**
 * Salesforce Knowledge article version → OKF `ConnectorDocument` assembly
 * (#4397, PRD #4395).
 *
 * Pure, deterministic glue between the SHARED support HTML→markdown converter
 * (`../support/html-to-markdown.ts` — this vendor deliberately owns no
 * HTML→md logic of its own) and the connector ingest seam. Each ONLINE
 * article-version row is a distinct document; translations share
 * `ArticleNumber` across `Language`, so each locale is its own document (the
 * issue's "translations share ArticleNumber across Language").
 *
 * Bodies are the org's custom textarea fields in describe order: rich-text
 * fields go through the shared converter (counted degradations, cross-link
 * absolutization against the org's instance URL); plain long-text fields are
 * already prose and pass through as-is. The standard `Summary` leads when
 * present.
 *
 * Paths are `<language>/<title-slug>-<article-number>.md` — language +
 * ArticleNumber make them collision-free by construction (two versions never
 * share both; ArticleNumber is stable across version flips and locales, so a
 * republished version upserts the SAME path), and the number suffix means a
 * basename can never be a reserved OKF name — the `deriveArchivePath` fold
 * still runs as defence in depth. A title rename reads as "old path archived +
 * new path drafted", the documented rename-churn posture (same as Zendesk).
 *
 * Provenance that survives ingest: `resource` = the version's Lightning URL,
 * `timestamp` = its `SystemModstamp`, plus an `atlas:` extension block
 * carrying connector + article id + article number + version id + version
 * number + locale + updated_at (the AC's "provenance carries article id +
 * version + locale"). No provenance `tags` — same rationale as Zendesk (a
 * mirrored column in the lenient parser's change comparison).
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
import { SALESFORCE_KNOWLEDGE_VENDOR } from "./config";

/** One body field's value, tagged rich (HTML) or plain (long text area). */
export interface SalesforceArticleBodyPart {
  readonly field: string;
  readonly value: string;
  readonly rich: boolean;
}

/** One ONLINE article version, ready to convert. */
export interface SalesforceKnowledgeArticle {
  /** The version row's Id (changes on every published version). */
  readonly versionId: string;
  /** The stable KnowledgeArticleId shared by every version + locale. */
  readonly knowledgeArticleId: string;
  /** The human article number — stable across versions AND locales. */
  readonly articleNumber: string;
  readonly title: string;
  readonly summary: string | null;
  /** Lowercased locale, e.g. `en-us`. */
  readonly language: string;
  readonly versionNumber: string | null;
  /** True = the master-language row; null when the org lacks the field. */
  readonly isMasterLanguage: boolean | null;
  /** Canonical ISO instant (`toIsoInstant(SystemModstamp)`). */
  readonly updatedAt: string;
  /** Canonical Lightning record URL of this version. */
  readonly url: string;
  readonly bodyParts: readonly SalesforceArticleBodyPart[];
}

export interface SalesforceAssembleResult {
  readonly documents: readonly ConnectorDocument[];
  /** Media degradations aggregated across every assembled article. */
  readonly degradations: readonly HtmlDegradation[];
  /** Articles skipped because they carried no ingestable prose. */
  readonly skippedContentless: number;
  /**
   * `<articleNumber>:<language>` breadcrumbs for the skipped articles (capped
   * at {@link CONTENTLESS_BREADCRUMB_CAP}) — a reconciliation crawl archives a
   * previously-mirrored document that converts to empty, so the operator
   * investigating a vanished article needs more than a count.
   */
  readonly contentlessArticles: readonly string[];
}

/** Bound on the contentless breadcrumb list (log hygiene, not correctness). */
export const CONTENTLESS_BREADCRUMB_CAP = 20;

/** Slugify into a single path segment; `fallback` guarantees non-empty. */
export function slugifySegment(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
}

/**
 * Assemble collected OKF documents from a set of fetched article versions.
 * `instanceUrl` resolves the converter's cross-link hook (relative hrefs in
 * rich-text bodies absolutize against the org).
 */
export function assembleSalesforceKnowledgeDocuments(
  articles: readonly SalesforceKnowledgeArticle[],
  options: { readonly collectionSlug: string; readonly instanceUrl: string },
): SalesforceAssembleResult {
  const prefixSegments = normalizePrefix(options.collectionSlug);
  const instanceBase = options.instanceUrl.replace(/\/+$/, "");
  const documents: ConnectorDocument[] = [];
  const degradationTotals = new Map<string, number>();
  let skippedContentless = 0;
  const contentlessArticles: string[] = [];

  for (const article of articles) {
    const sections: string[] = [];
    if (article.summary !== null && article.summary.trim() !== "") {
      sections.push(article.summary.trim());
    }
    for (const part of article.bodyParts) {
      if (part.rich) {
        const { markdown, degradations } = convertSupportHtmlToMarkdown(part.value, {
          pageUrl: article.url,
          rewriteLink: (href) => rewriteInstanceLink(href, instanceBase),
        });
        for (const d of degradations) {
          degradationTotals.set(d.name, (degradationTotals.get(d.name) ?? 0) + d.count);
        }
        if (markdown.trim() !== "") sections.push(markdown.trim());
      } else {
        // Plain long-text areas are already prose — never routed through the
        // HTML parser (it would eat `<` runs and collapse blank lines).
        const text = part.value.trim();
        if (text !== "") sections.push(text);
      }
    }
    const markdown = sections.join("\n\n");
    if (isContentlessBody(markdown)) {
      skippedContentless++;
      if (contentlessArticles.length < CONTENTLESS_BREADCRUMB_CAP) {
        contentlessArticles.push(`${article.articleNumber}:${article.language}`);
      }
      continue;
    }

    const segments = [
      slugifySegment(article.language, "locale"),
      `${slugifySegment(article.title, "article")}-${slugifySegment(article.articleNumber, "article-number")}`,
    ];
    const derived = deriveArchivePath(`${segments.join("/")}.md`);
    const path = [...prefixSegments, derived.path].join("/");

    const title = article.title.trim();
    const content = renderOkfDocument(
      {
        ...(title !== "" ? { title } : {}),
        resource: article.url,
        timestamp: article.updatedAt,
      },
      [],
      markdown,
      {
        key: ATLAS_EXTENSION_KEY,
        fields: {
          connector: SALESFORCE_KNOWLEDGE_VENDOR,
          article_id: article.knowledgeArticleId,
          article_number: article.articleNumber,
          version_id: article.versionId,
          ...(article.versionNumber !== null ? { version: article.versionNumber } : {}),
          locale: article.language,
          ...(article.isMasterLanguage !== null
            ? { is_master_language: article.isMasterLanguage ? "true" : "false" }
            : {}),
          updated_at: article.updatedAt,
        },
      },
    );
    documents.push({ path, content });
  }

  const degradations = [...degradationTotals.entries()]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return { documents, degradations, skippedContentless, contentlessArticles };
}

/**
 * The converter's cross-link hook: absolutize relative hrefs against the
 * org's instance URL so mirrored article links stay live. Absolute and
 * unparseable hrefs pass through untouched.
 */
function rewriteInstanceLink(href: string, instanceBase: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href; // already absolute (any scheme)
  try {
    return new URL(href, instanceBase).toString();
  } catch {
    // intentionally ignored: an unparseable href renders as-is — the label
    // text is preserved either way, and a broken org link is the org's.
    return href;
  }
}
