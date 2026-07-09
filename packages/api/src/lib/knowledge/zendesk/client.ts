/**
 * The Zendesk Guide vendor client (#4396, PRD #4395) — a
 * {@link ConnectorVendorClient} over the Zendesk Help Center REST API, driven
 * by the shared connector engine (`connector-sync.ts`). It owns ONLY
 * enumerate + fetch + convert; scheduling, high-water marks, reconciliation
 * cadence, 429 backoff, and caps are the engine's (ADR-0030).
 *
 * Two cadences the engine decides:
 *   - `fetchChanges({ since })` (incremental) — walk the NATIVE incremental
 *     feed (`/api/v2/help_center/incremental/articles?start_time=`, the reason
 *     Zendesk anchors the support tier), paging by the response's `end_time`
 *     as the next `start_time` cursor, then fetch each changed article's
 *     per-locale translations. Zendesk caps this endpoint at 10 req/min — a
 *     429 is thrown as {@link ConnectorRateLimitError} and the ENGINE applies
 *     the bounded backoff (never a client-side sleep).
 *   - `fetchAll()` (reconciliation) — cursor-paginate the full article list
 *     with translations sideloaded (`include=translations`), one document per
 *     published translation. The engine archives paths absent from this set,
 *     so a deleted or unpublished (`draft: true`) article/translation is
 *     treated as absent, never an error.
 *
 * Draft semantics: a `draft: true` article (and a `draft: true` translation)
 * is UNPUBLISHED — never emitted. An article that BECOMES draft simply stops
 * appearing in the emitted set; the reconciliation crawl's subtractive diff
 * archives its documents (the AC's "draft flag + archive semantics detect
 * unpublish/delete").
 *
 * Security + hygiene: hosts are composed from validated `*.zendesk.com`
 * subdomain labels and every request goes through `guardedFetch` (SSRF egress
 * guard; auth stripped on cross-origin redirect). A 429 is the ONLY signal
 * that becomes the engine's backoff; every other failure is an actionable
 * error with the host redacted via `hostForLog` — the token lives in the
 * `Authorization` header, never a URL or a message.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  guardedFetch,
  EgressBlockedError,
  hostForLog,
} from "@atlas/api/lib/openapi/egress-guard";
import {
  ConnectorRateLimitError,
  toIsoInstant,
  type ConnectorChanges,
  type ConnectorFetchSince,
  type ConnectorVendorClient,
} from "../connectors";
import { zendeskHostFor } from "./config";
import { assembleZendeskDocuments, type ZendeskArticleTranslation } from "./documents";

const log = createLogger("knowledge.zendesk.client");

/**
 * Zendesk rejected the credentials (401/403). A distinct class — not a
 * `cause`-presence side channel — so the install handler can blame the
 * `api_token` field with `instanceof` (the `ConnectorRateLimitError`
 * precedent; plain subclass, this is not Effect code).
 */
export class ZendeskAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZendeskAuthError";
  }
}

/** Zendesk returned 404 — wrong subdomain, or the brand has no Help Center. */
export class ZendeskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZendeskNotFoundError";
  }
}

/** Resolved, non-secret connection inputs plus the token. One brand per client. */
export interface ZendeskClientConfig {
  /** The BRAND's validated subdomain label — the help-center host to fetch. */
  readonly brandSubdomain: string;
  readonly email: string;
  readonly apiToken: string;
  /** The KB collection slug = `workspace_plugins.install_id` — the path prefix. */
  readonly collectionSlug: string;
}

export interface ZendeskClientDeps {
  /** Injected fetch for tests; defaults to the guarded global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** Per-request timeout (bounds the whole redirect chain). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Article-list page size (cursor pagination). */
const PAGE_SIZE = 100;
/**
 * Hard anti-runaway bound on enumerated articles — NOT the ingest cap (the
 * engine owns that, and surfaces the real over-limit numbers). A help center
 * larger than this is pathological; we fail loud rather than loop unbounded
 * on a broken `next` link.
 */
const MAX_ARTICLES = 100_000;
/**
 * Anti-runaway bound on pages walked in one paginated enumeration — the
 * article list, the incremental feed, AND the brand listing all share it, so
 * every walk fails loud on a stuck `next` cursor rather than looping forever.
 */
const MAX_FEED_PAGES = 1_000;
/** Anti-runaway bound on one article's translation pages (locales are few). */
const MAX_TRANSLATION_PAGES = 20;

// ---------------------------------------------------------------------------
// Raw API response shapes (only the fields we read; untrusted vendor JSON —
// every field optional, narrowed at the use sites)
// ---------------------------------------------------------------------------

interface RawTranslation {
  readonly locale?: string;
  readonly title?: string;
  readonly body?: string | null;
  readonly draft?: boolean;
  readonly updated_at?: string;
  readonly html_url?: string;
}
interface RawArticle {
  readonly id?: number | string;
  readonly title?: string;
  readonly draft?: boolean;
  readonly updated_at?: string;
  readonly html_url?: string;
  readonly translations?: readonly RawTranslation[];
}
interface CursorLinks {
  readonly next?: string | null;
}
interface CursorMeta {
  readonly has_more?: boolean;
}
interface ArticleListResponse {
  readonly articles?: readonly RawArticle[];
  readonly links?: CursorLinks;
  readonly meta?: CursorMeta;
}
interface IncrementalResponse {
  readonly articles?: readonly RawArticle[];
  readonly next_page?: string | null;
  readonly end_time?: number;
}
interface TranslationListResponse {
  readonly translations?: readonly RawTranslation[];
  readonly next_page?: string | null;
}
interface RawBrand {
  readonly id?: number | string;
  readonly name?: string;
  readonly subdomain?: string;
  readonly has_help_center?: boolean;
  readonly active?: boolean;
}
interface BrandListResponse {
  readonly brands?: readonly RawBrand[];
  readonly links?: CursorLinks;
  readonly meta?: CursorMeta;
}

/** One enumerated article, normalized (timestamps canonical, id stringified). */
interface NormalizedArticle {
  readonly id: string;
  readonly draft: boolean;
  /** Canonical ISO instant (`toIsoInstant`) — never the raw vendor string. */
  readonly updatedAt: string;
  readonly translations: readonly RawTranslation[] | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Build a Zendesk vendor client for ONE brand's help center. `createClient`
 * (the connector factory) has already decrypted the token and validated
 * config, so this constructor does no I/O.
 */
export function createZendeskVendorClient(
  config: ZendeskClientConfig,
  deps: ZendeskClientDeps = {},
): ConnectorVendorClient {
  const api = new ZendeskApi(config, deps);

  return {
    async fetchChanges(params: ConnectorFetchSince): Promise<ConnectorChanges> {
      // The engine only runs incremental with a persisted mark, but a null
      // `since` is served defensively as a full crawl (the contract's advice).
      if (params.since === null) return api.fetchAll();
      return api.fetchChanges(params.since);
    },
    async fetchAll(): Promise<ConnectorChanges> {
      return api.fetchAll();
    },
  };
}

/** One Zendesk brand, normalized for the install handler's fan-out. */
export interface ZendeskBrand {
  /** Stringified numeric brand id. */
  readonly id: string;
  readonly name: string;
  /** The brand's own `*.zendesk.com` subdomain label. */
  readonly subdomain: string;
  /** True when the brand has a help center to mirror. */
  readonly hasHelpCenter: boolean;
  readonly active: boolean;
}

export interface ZendeskAccountParams {
  /** The ACCOUNT subdomain (validated label) to enumerate brands from. */
  readonly subdomain: string;
  readonly email: string;
  readonly apiToken: string;
}

/**
 * Enumerate the account's brands — ALSO the install-time credential check
 * (the first authenticated request doubles as it; loud on every failure). A
 * bad token surfaces as
 * a 401 error, a wrong subdomain typically as a 404, both actionable and
 * host-redacted; the install handler maps them to field-level 400s so
 * "invalid credentials fail the install loudly."
 */
export async function listZendeskBrands(
  params: ZendeskAccountParams,
  deps: ZendeskClientDeps = {},
): Promise<ZendeskBrand[]> {
  const base = zendeskHostFor(params.subdomain);
  const http = new ZendeskHttp(base, params.email, params.apiToken, deps);
  const brands: ZendeskBrand[] = [];
  let skippedMalformed = 0;
  let url: string | null = `${base}/api/v2/brands.json?page[size]=${PAGE_SIZE}`;
  let pages = 0;
  while (url !== null) {
    if (++pages > MAX_FEED_PAGES) {
      throw new Error(
        `Zendesk brand listing on ${hostForLog(base)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
      );
    }
    const body: BrandListResponse = await http.getJson<BrandListResponse>(url);
    for (const raw of body.brands ?? []) {
      const id = idOf(raw.id);
      const subdomain = typeof raw.subdomain === "string" ? raw.subdomain.trim().toLowerCase() : "";
      if (id === "" || subdomain === "") {
        skippedMalformed++;
        continue;
      }
      brands.push({
        id,
        name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : subdomain,
        subdomain,
        hasHelpCenter: raw.has_help_center === true,
        active: raw.active !== false,
      });
    }
    const next = body.links?.next;
    url =
      body.meta?.has_more === true && typeof next === "string" && next !== ""
        ? sameOriginPageUrl(next, base)
        : null;
  }
  if (skippedMalformed > 0) {
    log.warn(
      { host: hostForLog(base), skippedMalformed },
      "Skipped Zendesk brands missing id/subdomain — not installable (unexpected vendor response)",
    );
  }
  return brands;
}

/**
 * Resolve a vendor-supplied pagination link against the client's base and pin
 * it to the SAME origin. Pagination URLs come from response bodies and are
 * fetched with the `Authorization` header — an off-origin link (broken or
 * malicious vendor payload) must fail loudly rather than forward credentials
 * (the egress guard blocks private hosts, this closes the public-host case).
 */
function sameOriginPageUrl(rawNext: string, base: string): string {
  let resolved: URL;
  try {
    resolved = new URL(rawNext, base);
  } catch (err) {
    // Translate-and-rethrow: the raw link must not reach the message (it is
    // untrusted vendor payload), but the parse failure rides along as cause.
    throw new Error(
      `Zendesk returned an unparseable pagination link from ${hostForLog(base)} — unexpected vendor response.`,
      { cause: err },
    );
  }
  if (resolved.origin !== new URL(base).origin) {
    throw new Error(
      `Zendesk returned a pagination link pointing off ${hostForLog(base)} — refusing to follow it with credentials.`,
    );
  }
  return resolved.toString();
}

class ZendeskApi {
  private readonly base: string;
  private readonly http: ZendeskHttp;

  constructor(
    private readonly config: ZendeskClientConfig,
    deps: ZendeskClientDeps,
  ) {
    this.base = zendeskHostFor(config.brandSubdomain);
    this.http = new ZendeskHttp(this.base, config.email, config.apiToken, deps);
  }

  /**
   * Reconciliation: cursor-paginate the FULL article list with translations
   * sideloaded. One document per published translation of a published article.
   */
  async fetchAll(): Promise<ConnectorChanges> {
    const articles: NormalizedArticle[] = [];
    let skippedMalformed = 0;
    let url: string | null = `${this.base}/api/v2/help_center/articles.json?include=translations&page[size]=${PAGE_SIZE}`;
    let pages = 0;
    while (url !== null) {
      // Page-count bound, not just the article-count one below: a stuck
      // cursor that keeps returning EMPTY pages never grows `articles`, and
      // an unbounded loop here would silently wedge the sync fiber.
      if (++pages > MAX_FEED_PAGES) {
        throw new Error(
          `Zendesk article listing on ${hostForLog(this.base)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
        );
      }
      const body: ArticleListResponse = await this.http.getJson<ArticleListResponse>(url);
      for (const raw of body.articles ?? []) {
        const normalized = normalizeArticle(raw);
        if (normalized !== null) articles.push(normalized);
        else skippedMalformed++;
      }
      if (articles.length > MAX_ARTICLES) {
        throw new Error(
          `Zendesk help center on ${hostForLog(this.base)} exceeds ${MAX_ARTICLES} articles — narrow the connector's scope. (This is a safety bound, not the ingest cap ATLAS_KNOWLEDGE_INGEST_MAX_DOCS.)`,
        );
      }
      const next = body.links?.next;
      url =
        body.meta?.has_more === true && typeof next === "string" && next !== ""
          ? sameOriginPageUrl(next, this.base)
          : null;
    }
    return this.assemble(articles, skippedMalformed, "reconciliation");
  }

  /**
   * Incremental: walk the native feed since the engine's `since` instant. The
   * feed pages by time — each response's `end_time` is the next request's
   * `start_time` — and reports whole changed ARTICLES; the per-locale
   * translations are then fetched per changed article.
   */
  async fetchChanges(since: string): Promise<ConnectorChanges> {
    const sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) {
      // The engine derives `since` from its own persisted ISO mark, so this is
      // defensive — fail loud rather than silently refetch everything.
      throw new Error(`Zendesk incremental fetch got an unparseable since instant ("${since}").`);
    }
    let startTime = Math.max(0, Math.floor(sinceMs / 1000));

    // Later pages override earlier ones so an article touched twice inside the
    // walk keeps its newest snapshot.
    const changedById = new Map<string, NormalizedArticle>();
    let skippedMalformed = 0;
    for (let page = 1; ; page++) {
      if (page > MAX_FEED_PAGES) {
        throw new Error(
          `Zendesk incremental feed on ${hostForLog(this.base)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
        );
      }
      const url = `${this.base}/api/v2/help_center/incremental/articles.json?start_time=${startTime}`;
      const body = await this.http.getJson<IncrementalResponse>(url);
      const raws = body.articles ?? [];
      for (const raw of raws) {
        const normalized = normalizeArticle(raw);
        if (normalized !== null) changedById.set(normalized.id, normalized);
        else skippedMalformed++;
      }
      // The feed's cursor is time-shaped: `end_time` is the next `start_time`.
      // Stop on an empty page, a missing next page, or a time cursor that is
      // absent or did not advance (guards an infinite loop on a stuck feed).
      const endTime = typeof body.end_time === "number" ? body.end_time : null;
      const hasNext = typeof body.next_page === "string" && body.next_page !== "";
      if (raws.length === 0 || !hasNext || endTime === null || endTime <= startTime) break;
      startTime = endTime;
    }

    // The changed set is article-level; translations are per-locale documents,
    // fetched per changed article (bounded by the changed set's size, the
    // incremental feed's whole point).
    const articles: NormalizedArticle[] = [];
    for (const article of changedById.values()) {
      if (article.draft) {
        // Unpublished: contributes its timestamp to the high-water mark but
        // emits no documents; reconciliation archives its stale paths.
        articles.push(article);
        continue;
      }
      const translations = await this.fetchTranslations(article.id);
      articles.push({ ...article, translations });
    }
    return this.assemble(articles, skippedMalformed, "incremental");
  }

  /** One article's translations (paginated defensively; locales are few). */
  private async fetchTranslations(articleId: string): Promise<RawTranslation[]> {
    const translations: RawTranslation[] = [];
    let url: string | null =
      `${this.base}/api/v2/help_center/articles/${encodeURIComponent(articleId)}/translations.json`;
    let pages = 0;
    while (url !== null) {
      if (++pages > MAX_TRANSLATION_PAGES) {
        throw new Error(
          `Zendesk translations for one article on ${hostForLog(this.base)} did not terminate after ${MAX_TRANSLATION_PAGES} pages — unexpected vendor pagination.`,
        );
      }
      const body: TranslationListResponse = await this.http.getJson<TranslationListResponse>(url);
      translations.push(...(body.translations ?? []));
      const next = body.next_page;
      url = typeof next === "string" && next !== "" ? sameOriginPageUrl(next, this.base) : null;
    }
    return translations;
  }

  /** Normalize + convert the fetched set into `ConnectorChanges`. */
  private async assemble(
    articles: readonly NormalizedArticle[],
    skippedMalformedArticles: number,
    mode: "incremental" | "reconciliation",
  ): Promise<ConnectorChanges> {
    let skippedMalformed = skippedMalformedArticles;
    let sideloadFallbacks = 0;
    let highWaterMark: string | null = null;
    const emitted: ZendeskArticleTranslation[] = [];

    for (const article of articles) {
      // Every article — draft or not — advances the mark: its change is what
      // this fetch observed. ISO instants compare chronologically as strings.
      if (highWaterMark === null || article.updatedAt > highWaterMark) {
        highWaterMark = article.updatedAt;
      }
      if (article.draft) continue;

      // Reconciliation sideloads translations; a response missing the sideload
      // entirely (vendor quirk) falls back to the per-article fetch so the
      // crawl's coverage stays honest rather than silently emitting nothing.
      // Counted + logged below: the fallback flips the request profile from
      // ~1/100 articles to N+1, and an operator debugging sudden 429s needs
      // that breadcrumb. (On the incremental path the per-article fetch IS
      // the design, so the counter only ticks during reconciliation.)
      if (article.translations === null && mode === "reconciliation") sideloadFallbacks++;
      const rawTranslations =
        article.translations ?? (await this.fetchTranslations(article.id));

      for (const raw of rawTranslations) {
        if (raw.draft === true) continue; // unpublished locale — never emitted
        const locale = typeof raw.locale === "string" ? raw.locale.trim().toLowerCase() : "";
        const updatedAt = toIsoInstant(raw.updated_at);
        if (locale === "" || updatedAt === null) {
          // Never a silent drop: a translation we can't place (no locale) or
          // order (no timestamp) is counted, flags coverage as incomplete, and
          // is surfaced in the log below.
          skippedMalformed++;
          continue;
        }
        const title = typeof raw.title === "string" ? raw.title : "";
        emitted.push({
          articleId: article.id,
          locale,
          title,
          bodyHtml: typeof raw.body === "string" ? raw.body : "",
          updatedAt,
          url:
            typeof raw.html_url === "string" && raw.html_url !== ""
              ? raw.html_url
              : `${this.base}/hc/${locale}/articles/${article.id}`,
        });
      }
    }

    const assembled = assembleZendeskDocuments(emitted, {
      collectionSlug: this.config.collectionSlug,
      brandSubdomain: this.config.brandSubdomain,
    });
    if (assembled.degradations.length > 0 || assembled.skippedContentless > 0) {
      log.info(
        {
          host: hostForLog(this.base),
          mode,
          degradations: assembled.degradations,
          skippedContentless: assembled.skippedContentless,
        },
        "Zendesk conversion completed with degradations/skips",
      );
    }
    if (skippedMalformed > 0) {
      // A skipped article/translation is a KNOWN hole in the set: its document
      // would otherwise be archived by a reconciliation off this partial
      // crawl. The flag makes the engine upsert-only and hold the reconcile
      // clock.
      log.warn(
        { host: hostForLog(this.base), mode, skippedMalformed },
        "Skipped Zendesk articles/translations missing id/locale/timestamp — not ingested (unexpected for published content)",
      );
    }
    if (sideloadFallbacks > 0) {
      log.warn(
        { host: hostForLog(this.base), mode, sideloadFallbacks },
        "Zendesk article list returned no translations sideload — fell back to per-article translation fetches (N+1 request profile)",
      );
    }

    return {
      documents: assembled.documents,
      highWaterMark,
      cursor: null,
      coverageIncomplete: skippedMalformed > 0,
    };
  }
}

/** Stringify an untrusted vendor id — scalars only (`null`/objects = malformed). */
function idOf(raw: number | string | undefined): string {
  return typeof raw === "number" || typeof raw === "string" ? String(raw) : "";
}

/** Normalize one raw article; null = malformed (skip + count). */
function normalizeArticle(raw: RawArticle): NormalizedArticle | null {
  const id = idOf(raw.id);
  const updatedAt = toIsoInstant(raw.updated_at);
  if (id === "" || updatedAt === null) return null;
  return {
    id,
    draft: raw.draft === true,
    updatedAt,
    translations: Array.isArray(raw.translations) ? raw.translations : null,
  };
}

// ---------------------------------------------------------------------------
// HTTP (shared by the per-brand client and the account-level brand listing)
// ---------------------------------------------------------------------------

class ZendeskHttp {
  private readonly authHeader: string;

  constructor(
    private readonly base: string,
    email: string,
    apiToken: string,
    private readonly deps: ZendeskClientDeps,
  ) {
    // Zendesk token auth is Basic with the `{email}/token` username form.
    // Buffer.from handles any UTF-8 in the email (unlike btoa).
    this.authHeader = `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString("base64")}`;
  }

  /** GET + JSON through the SSRF guard, mapping vendor failures to typed errors. */
  async getJson<T>(url: string): Promise<T> {
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
        `Zendesk request to ${hostForLog(this.base)} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.status === 429) {
      throw new ConnectorRateLimitError(
        `Zendesk rate-limited the request to ${hostForLog(this.base)} (Zendesk rate limits apply; the incremental feed in particular is capped at 10 requests/minute).`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ZendeskAuthError(
        `Zendesk rejected the credentials (${response.status}) for ${hostForLog(this.base)} — re-enter the email + API token (Admin Center → Apps and integrations → Zendesk API) and confirm token access is enabled.`,
      );
    }
    if (response.status === 404) {
      throw new ZendeskNotFoundError(
        `Zendesk returned 404 from ${hostForLog(this.base)} — check the subdomain, and that the brand's Help Center is activated.`,
      );
    }
    if (response.status >= 500) {
      throw new Error(
        `Zendesk returned HTTP ${response.status} from ${hostForLog(this.base)} — a vendor-side error; the next scheduled sync (or retrying the install) will usually succeed.`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Zendesk returned HTTP ${response.status} from ${hostForLog(this.base)} — an unexpected Zendesk API response; if it persists, re-install the collection or check Zendesk's API status.`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(
        `Zendesk returned a non-JSON response from ${hostForLog(this.base)}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

/** Parse a `Retry-After` header (delta-seconds only; HTTP-date → null). */
export function parseRetryAfter(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
