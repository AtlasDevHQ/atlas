/**
 * The Intercom vendor client (#4399, PRD #4395) — a {@link ConnectorVendorClient}
 * over the Intercom Articles REST API, driven by the shared connector engine
 * (`connector-sync.ts`). It owns ONLY enumerate + fetch + convert; scheduling,
 * high-water marks, reconciliation cadence, 429 backoff, and caps are the
 * engine's (ADR-0030).
 *
 * RECONCILIATION-DIFF POSTURE (the PRD's delta-less design): Intercom exposes
 * NO server-side `updated_since` change feed, so BOTH cadences the engine
 * decides are served from the same full cursor-paginated walk of
 * `GET /articles`:
 *   - `fetchAll()` (reconciliation) — walk every article, emit one document per
 *     published locale. The engine archives paths absent from this set, so a
 *     deleted or unpublished (`state: "draft"`) article/locale is treated as
 *     absent, never an error.
 *   - `fetchChanges({ since })` (incremental) — the SAME full walk, but only the
 *     articles whose newest `updated_at` is at-or-after `since` contribute
 *     documents (a client-side diff against the high-water mark). Intercom's
 *     generous 1,000+ rpm budget makes the full-page-and-diff affordable; the
 *     engine's overlap window re-emits the boundary and the upsert-by-path diff
 *     no-ops unchanged docs.
 *
 * Multi-locale: each `translated_content` entry is a distinct document with its
 * own `state`. A `state: "draft"` locale is UNPUBLISHED — never emitted; an
 * article/locale that BECOMES draft simply stops appearing in the emitted set,
 * and the reconciliation crawl's subtractive diff archives its documents (the
 * AC's "deletes via reconcile").
 *
 * Security + hygiene: the host is a fixed Intercom constant, yet every request
 * still goes through `guardedFetch` (SSRF egress guard; auth stripped on
 * cross-origin redirect). A 429 is the ONLY signal that becomes the engine's
 * backoff (thrown as {@link ConnectorRateLimitError}); every other failure is an
 * actionable error with the host redacted via `hostForLog` — the token lives in
 * the `Authorization` header, never a URL or a message.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  guardedFetch,
  EgressBlockedError,
  hostForLog,
} from "@atlas/api/lib/openapi/egress-guard";
import { getIngestMaxDocs } from "../ingest-limits";
import {
  ConnectorRateLimitError,
  type ConnectorChanges,
  type ConnectorFetchSince,
  type ConnectorVendorClient,
} from "../connectors";
import { INTERCOM_API_BASE } from "./config";
import { assembleIntercomDocuments, type IntercomArticleContent } from "./documents";

const log = createLogger("knowledge.intercom.client");

/**
 * Intercom rejected the credentials (401/403). A distinct class — not a
 * `cause`-presence side channel — so the install handler can blame the
 * `access_token` field with `instanceof` (the `ConnectorRateLimitError`
 * precedent; plain subclass, this is not Effect code).
 */
export class IntercomAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntercomAuthError";
  }
}

/** Resolved, non-secret connection inputs plus the token. */
export interface IntercomClientConfig {
  readonly apiToken: string;
  /** The KB collection slug = `workspace_plugins.install_id` — the path prefix. */
  readonly collectionSlug: string;
}

export interface IntercomClientDeps {
  /** Injected fetch for tests; defaults to the guarded global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Test-only override of the ingest doc cap (defaults to the settings value). */
  readonly maxDocs?: number;
}

/** Per-request timeout (bounds the whole redirect chain). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Article-list page size (`starting_after` cursor pagination). */
const PAGE_SIZE = 150;
/**
 * Hard anti-runaway bound on enumerated articles — NOT the ingest cap (the
 * engine owns that, and surfaces the real over-limit numbers). A help center
 * larger than this is pathological; we fail loud rather than loop unbounded on a
 * broken `next` cursor.
 */
const MAX_ARTICLES = 100_000;
/**
 * Anti-runaway bound on pages walked in one paginated enumeration — a stuck
 * `starting_after` cursor fails loud rather than looping forever.
 */
const MAX_FEED_PAGES = 2_000;

// ---------------------------------------------------------------------------
// Raw API response shapes (only the fields we read; untrusted vendor JSON —
// every field optional, narrowed at the use sites)
// ---------------------------------------------------------------------------

interface RawArticleContent {
  readonly title?: string;
  readonly body?: string | null;
  readonly state?: string;
  readonly updated_at?: number;
  readonly url?: string;
}
interface RawArticle {
  readonly id?: number | string;
  readonly title?: string;
  readonly body?: string | null;
  readonly state?: string;
  readonly updated_at?: number;
  readonly url?: string;
  readonly default_locale?: string;
  /** Locale → article_content, plus a `type` discriminator we skip. */
  readonly translated_content?: Record<string, unknown> | null;
}
interface RawPagesNext {
  readonly starting_after?: string;
}
interface RawPages {
  readonly next?: RawPagesNext | string | null;
}
interface ArticleListResponse {
  readonly data?: readonly RawArticle[];
  readonly pages?: RawPages | null;
}
interface RawMe {
  readonly type?: string;
  readonly id?: string;
}

/** One locale of an article, normalized (timestamp canonical, published flag resolved). */
interface NormalizedContent {
  readonly locale: string;
  readonly title: string;
  readonly bodyHtml: string;
  /** Canonical ISO instant — never the raw vendor epoch. */
  readonly updatedAt: string;
  readonly url: string;
  readonly published: boolean;
}

/** One enumerated article, normalized to its per-locale contents. */
interface NormalizedArticle {
  readonly id: string;
  /** Newest instant across the article + all its locales — drives the mark + since filter. */
  readonly effectiveUpdatedAt: string;
  readonly contents: readonly NormalizedContent[];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Build an Intercom vendor client. `createClient` (the connector factory) has
 * already decrypted the token, so this constructor does no I/O.
 */
export function createIntercomVendorClient(
  config: IntercomClientConfig,
  deps: IntercomClientDeps = {},
): ConnectorVendorClient {
  const api = new IntercomApi(config, deps);
  return {
    async fetchChanges(params: ConnectorFetchSince): Promise<ConnectorChanges> {
      return api.fetch({ since: params.since });
    },
    async fetchAll(): Promise<ConnectorChanges> {
      return api.fetch({ since: null });
    },
  };
}

/**
 * Verify the connection at INSTALL time — resolve the authenticated admin with
 * the supplied token (`GET /me`). Cheap (one request) and loud: a bad token
 * surfaces as a 401. The install handler maps it to a field-level 400 so
 * "invalid credentials fail the install loudly."
 */
export async function verifyIntercomAccess(
  config: IntercomClientConfig,
  deps: IntercomClientDeps = {},
): Promise<void> {
  await new IntercomApi(config, deps).verifyAccess();
}

class IntercomApi {
  private readonly authHeader: string;
  private readonly maxDocs: number;

  constructor(
    private readonly config: IntercomClientConfig,
    private readonly deps: IntercomClientDeps,
  ) {
    this.authHeader = `Bearer ${config.apiToken}`;
    this.maxDocs = deps.maxDocs ?? getIngestMaxDocs();
  }

  /** Install-time reachability + credential check (`GET /me`). */
  async verifyAccess(): Promise<void> {
    const me = await this.getJson<RawMe>(`${INTERCOM_API_BASE}/me`);
    // Intercom's /me always carries a `type` (and an `id`); neither present is
    // an anomalous response — surface it rather than accept a hollow 200.
    if (typeof me.type !== "string" && typeof me.id !== "string") {
      throw new Error(
        `Intercom did not return a recognizable identity from ${hostForLog(INTERCOM_API_BASE)} — check that the access token is valid.`,
      );
    }
  }

  /**
   * Walk the full article list + assemble. When `since` is null this is a
   * reconciliation crawl (every published locale emitted); otherwise an
   * incremental cycle (only articles changed at-or-after `since` contribute —
   * the client-side diff of the delta-less posture).
   */
  async fetch(opts: { since: string | null }): Promise<ConnectorChanges> {
    const reconciliation = opts.since === null;
    const { articles, skippedMalformed } = await this.enumerateArticles();

    let highWaterMark: string | null = null;
    for (const a of articles) {
      if (highWaterMark === null || a.effectiveUpdatedAt > highWaterMark) {
        highWaterMark = a.effectiveUpdatedAt;
      }
    }

    // `effectiveUpdatedAt` is a normalized ISO instant, and the engine's `since`
    // is a toISOString — string comparisons are chronological.
    const selected = reconciliation
      ? articles
      : articles.filter((a) => opts.since === null || a.effectiveUpdatedAt >= opts.since);

    const contents: IntercomArticleContent[] = [];
    for (const a of selected) {
      for (const c of a.contents) {
        if (!c.published) continue; // draft locale — never emitted
        contents.push({
          articleId: a.id,
          locale: c.locale,
          title: c.title,
          bodyHtml: c.bodyHtml,
          updatedAt: c.updatedAt,
          url: c.url,
        });
      }
    }

    // Reject an over-cap FULL set BEFORE converting bodies (the engine's ingest
    // cap is the backstop, but checking here puts real numbers in the error —
    // the AC's "caps validated over the full set").
    if (reconciliation && contents.length > this.maxDocs) {
      throw new Error(
        `This Intercom workspace has ${contents.length} published article translations, over the ${this.maxDocs}-document limit (ATLAS_KNOWLEDGE_INGEST_MAX_DOCS) — narrow the connector's scope, or raise the cap.`,
      );
    }

    const assembled = assembleIntercomDocuments(contents, {
      collectionSlug: this.config.collectionSlug,
    });
    if (assembled.degradations.length > 0 || assembled.skippedContentless > 0) {
      log.info(
        {
          host: hostForLog(INTERCOM_API_BASE),
          mode: reconciliation ? "reconciliation" : "incremental",
          degradations: assembled.degradations,
          skippedContentless: assembled.skippedContentless,
        },
        "Intercom conversion completed with degradations/skips",
      );
    }
    if (skippedMalformed > 0) {
      // A skipped article/locale is a KNOWN hole in the set: its document would
      // otherwise be archived by a reconciliation off this partial crawl. The
      // flag makes the engine upsert-only and hold the reconcile clock.
      log.warn(
        { host: hostForLog(INTERCOM_API_BASE), skippedMalformed },
        "Skipped Intercom articles/translations missing id/locale/timestamp — not ingested (unexpected for published content)",
      );
    }

    return {
      documents: assembled.documents,
      highWaterMark,
      cursor: null,
      coverageIncomplete: skippedMalformed > 0,
    };
  }

  /** Cursor-paginate the full article list, normalizing each into its locales. */
  private async enumerateArticles(): Promise<{
    articles: NormalizedArticle[];
    skippedMalformed: number;
  }> {
    const articles: NormalizedArticle[] = [];
    let skippedMalformed = 0;
    let url: string | null = `${INTERCOM_API_BASE}/articles?per_page=${PAGE_SIZE}`;
    let pages = 0;
    while (url !== null) {
      if (++pages > MAX_FEED_PAGES) {
        throw new Error(
          `Intercom article listing on ${hostForLog(INTERCOM_API_BASE)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
        );
      }
      const body: ArticleListResponse = await this.getJson<ArticleListResponse>(url);
      for (const raw of body.data ?? []) {
        const { article, skipped } = normalizeArticle(raw);
        skippedMalformed += skipped;
        if (article !== null) articles.push(article);
      }
      if (articles.length > MAX_ARTICLES) {
        throw new Error(
          `Intercom workspace on ${hostForLog(INTERCOM_API_BASE)} exceeds ${MAX_ARTICLES} articles — narrow the connector's scope. (This is a safety bound, not the ingest cap ATLAS_KNOWLEDGE_INGEST_MAX_DOCS.)`,
        );
      }
      url = nextPageUrl(body.pages);
    }
    return { articles, skippedMalformed };
  }

  /** GET + JSON through the SSRF guard, mapping vendor failures to typed errors. */
  private async getJson<T>(url: string): Promise<T> {
    const fetchImpl = this.deps.fetchImpl;
    let response: Response;
    try {
      response = await guardedFetch(
        url,
        {
          method: "GET",
          headers: { Authorization: this.authHeader, Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
        fetchImpl ? { fetchImpl } : {},
      );
    } catch (err) {
      if (err instanceof EgressBlockedError) throw err; // host-redacted + actionable
      throw new Error(
        `Intercom request to ${hostForLog(INTERCOM_API_BASE)} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.status === 429) {
      throw new ConnectorRateLimitError(
        `Intercom rate-limited the request to ${hostForLog(INTERCOM_API_BASE)} (the Articles API allows ~1,000 requests/minute).`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new IntercomAuthError(
        `Intercom rejected the credentials (${response.status}) for ${hostForLog(INTERCOM_API_BASE)} — re-enter the access token (Intercom → Settings → Developers → your app → Authentication) and confirm it can read Articles.`,
      );
    }
    if (response.status >= 500) {
      throw new Error(
        `Intercom returned HTTP ${response.status} from ${hostForLog(INTERCOM_API_BASE)} — a vendor-side error; the next scheduled sync (or retrying the install) will usually succeed.`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Intercom returned HTTP ${response.status} from ${hostForLog(INTERCOM_API_BASE)} — an unexpected Intercom API response; if it persists, re-install the collection or check Intercom's API status.`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(
        `Intercom returned a non-JSON response from ${hostForLog(INTERCOM_API_BASE)}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

/**
 * Resolve the next-page cursor into a same-origin URL, or null when the walk is
 * done. `pages.next` is either a `{ starting_after }` object (cursor pagination,
 * the documented shape) or null; a missing / empty cursor stops the walk.
 */
function nextPageUrl(pages: RawPages | null | undefined): string | null {
  const next = pages?.next;
  if (next === null || next === undefined) return null;
  const cursor =
    typeof next === "object" && typeof next.starting_after === "string" ? next.starting_after.trim() : "";
  if (cursor === "") return null;
  return `${INTERCOM_API_BASE}/articles?per_page=${PAGE_SIZE}&starting_after=${encodeURIComponent(cursor)}`;
}

/** Stringify an untrusted vendor id — string/number only (anything else = malformed → ""). */
function idOf(raw: number | string | undefined): string {
  return typeof raw === "number" || typeof raw === "string" ? String(raw) : "";
}

/**
 * Normalize a Unix epoch-seconds timestamp (Intercom's clock) to a canonical
 * ISO-8601 instant, or null when it doesn't parse. Intercom returns integer
 * seconds; `toIsoInstant` (which `Date.parse`es a string) can't read those, so
 * connector timestamps route through here.
 */
export function epochSecondsToIso(value: unknown): string | null {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
        ? Number(value)
        : null;
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const ms = seconds * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Normalize one raw article into its per-locale contents. Returns
 * `{ article: null, skipped }` when the article itself is malformed (no
 * id/updated_at); `skipped` also counts individual locales dropped for a
 * missing locale key.
 */
function normalizeArticle(raw: RawArticle): { article: NormalizedArticle | null; skipped: number } {
  const id = idOf(raw.id);
  const articleUpdatedAt = epochSecondsToIso(raw.updated_at);
  if (id === "" || articleUpdatedAt === null) return { article: null, skipped: 1 };

  const rawLocales = collectLocaleContents(raw);
  const contents: NormalizedContent[] = [];
  let skipped = 0;
  let effectiveUpdatedAt = articleUpdatedAt;

  for (const { locale, content } of rawLocales) {
    const trimmedLocale = locale.trim().toLowerCase();
    if (trimmedLocale === "") {
      skipped++;
      continue;
    }
    // A locale content's own updated_at wins; fall back to the article's so a
    // locale without its own timestamp still orders (never a null instant).
    const updatedAt = epochSecondsToIso(content.updated_at) ?? articleUpdatedAt;
    if (updatedAt > effectiveUpdatedAt) effectiveUpdatedAt = updatedAt;
    // Per-locale state is authoritative; fall back to the article-level state
    // (the default locale mirrors it) so a locale without its own state still
    // resolves published/draft rather than defaulting silently.
    const state = typeof content.state === "string" ? content.state : raw.state;
    contents.push({
      locale: trimmedLocale,
      title: typeof content.title === "string" ? content.title : "",
      bodyHtml: typeof content.body === "string" ? content.body : "",
      updatedAt,
      url: contentUrl(content.url, raw.url, id),
      published: state === "published",
    });
  }

  return { article: { id, effectiveUpdatedAt, contents }, skipped };
}

/**
 * Collect the per-locale contents of an article. Prefers `translated_content`
 * (the canonical multi-locale source — each key is a locale, minus the `type`
 * discriminator); when it carries no usable locale, synthesizes one content from
 * the top-level article fields under its `default_locale` (so a single-locale
 * article with no translation block still ingests).
 */
function collectLocaleContents(
  raw: RawArticle,
): Array<{ locale: string; content: RawArticleContent }> {
  const out: Array<{ locale: string; content: RawArticleContent }> = [];
  const translated = raw.translated_content;
  if (translated !== null && typeof translated === "object") {
    for (const [key, value] of Object.entries(translated)) {
      if (key === "type") continue; // the object's discriminator, not a locale
      if (value !== null && typeof value === "object") {
        out.push({ locale: key, content: value as RawArticleContent });
      }
    }
  }
  if (out.length === 0) {
    const locale = typeof raw.default_locale === "string" && raw.default_locale.trim() !== "" ? raw.default_locale : "en";
    out.push({
      locale,
      content: {
        title: raw.title,
        body: raw.body,
        state: raw.state,
        updated_at: raw.updated_at,
        url: raw.url,
      },
    });
  }
  return out;
}

/** The canonical help-center URL for one locale, with fallbacks. */
function contentUrl(contentUrlRaw: unknown, articleUrl: unknown, id: string): string {
  if (typeof contentUrlRaw === "string" && contentUrlRaw !== "") return contentUrlRaw;
  if (typeof articleUrl === "string" && articleUrl !== "") return articleUrl;
  return `${INTERCOM_API_BASE}/articles/${id}`;
}

/** Parse a `Retry-After` header (delta-seconds only; HTTP-date → null). */
export function parseRetryAfter(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
