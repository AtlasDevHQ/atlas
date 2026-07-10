/**
 * The Front Knowledge Base vendor client (#4400, PRD #4395) — a
 * {@link ConnectorVendorClient} over Front's authenticated Core API
 * (`api2.frontapp.com`, scope `knowledge_bases:read`), driven by the shared
 * connector engine (`connector-sync.ts`). It owns ONLY enumerate + fetch +
 * convert; scheduling, high-water marks, reconciliation cadence, 429 backoff,
 * and caps are the engine's (ADR-0030).
 *
 * Front exposes NO server-side change feed (`updated_since`), so both engine
 * cadences are served from one full enumeration — the PRD's delta-less
 * reconciliation-diff posture:
 *   - `fetchAll()` (reconciliation) — walk every KB locale's article list via
 *     cursor pagination (`_pagination.next`), emit one document per PUBLISHED
 *     locale variant. The engine archives previously-ingested paths absent from
 *     this set, so a draft/archived/deleted article is treated as absent, never
 *     an error (the AC's "article state drives published filter + archive
 *     detection").
 *   - `fetchChanges({ since })` (incremental) — the SAME full crawl, but only
 *     articles whose `last_edited` is at-or-after `since` are emitted (Front has
 *     no delta, but each article carries `last_edited`, so the high-water mark
 *     still narrows the ingest churn). Deletions are not detectable here — the
 *     reconciliation crawl owns subtractive archiving.
 *
 * One client mirrors ONE knowledge base (the install handler fans one install
 * out to one collection per KB). A KB's declared `locales` drive the per-locale
 * walk; each `(article, locale)` pair is a distinct document.
 *
 * Security + hygiene: the host is a fixed Front constant, but every request
 * still goes through `guardedFetch` (SSRF egress guard; auth stripped on
 * cross-origin redirect), and a vendor-supplied `_pagination.next` is pinned to
 * the same origin before being fetched with the `Authorization` header. A 429
 * is the ONLY signal that becomes the engine's backoff (thrown as
 * {@link ConnectorRateLimitError}); every other failure is an actionable error
 * with the host redacted via `hostForLog` — the token lives in the
 * `Authorization` header, never a URL or a message.
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
  toIsoInstant,
  type ConnectorChanges,
  type ConnectorFetchSince,
  type ConnectorVendorClient,
} from "../connectors";
import { FRONT_API_BASE } from "./config";
import { assembleFrontDocuments, type FrontArticleLocale } from "./documents";

const log = createLogger("knowledge.front.client");

/**
 * Front rejected the credentials (401/403). A distinct class — not a
 * `cause`-presence side channel — so the install handler can blame the
 * `api_token` field with `instanceof` (the `ConnectorRateLimitError`
 * precedent; plain subclass, this is not Effect code).
 */
export class FrontAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontAuthError";
  }
}

/** Front returned 404 — the knowledge base id is wrong or invisible to the token. */
export class FrontNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontNotFoundError";
  }
}

/** Resolved, non-secret connection inputs plus the token. One KB per client. */
export interface FrontClientConfig {
  /** The Front knowledge base id this collection mirrors. */
  readonly knowledgeBaseId: string;
  readonly apiToken: string;
  /** The KB collection slug = `workspace_plugins.install_id` — the path prefix. */
  readonly collectionSlug: string;
}

export interface FrontClientDeps {
  /** Injected fetch for tests; defaults to the guarded global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Test-only override of the ingest doc cap (defaults to the settings value). */
  readonly maxDocs?: number;
}

/** Per-request timeout (bounds the whole redirect chain). */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Hard anti-runaway bound on pages walked in one paginated enumeration — the
 * article list AND the knowledge-base listing share it, so every walk fails
 * loud on a stuck `_pagination.next` cursor rather than looping forever.
 */
const MAX_FEED_PAGES = 1_000;
/**
 * Hard anti-runaway bound on enumerated articles across all locales — NOT the
 * ingest cap (the engine owns that, and surfaces the real over-limit numbers).
 * A KB larger than this is pathological; we fail loud rather than loop unbounded
 * on a broken `next` link.
 */
const MAX_ARTICLES = 100_000;
/**
 * Anti-runaway bound on the locales walked for one KB. Front supports ~40
 * locales; a KB reporting far more is an anomalous vendor response.
 */
const MAX_LOCALES = 200;

// ---------------------------------------------------------------------------
// Raw API response shapes (only the fields we read; untrusted vendor JSON —
// every field optional, narrowed at the use sites)
// ---------------------------------------------------------------------------

interface FrontPagination {
  readonly next?: string | null;
}
interface RawKnowledgeBase {
  readonly id?: string;
  readonly name?: string;
  readonly locales?: readonly unknown[];
}
interface KnowledgeBaseListResponse {
  readonly _results?: readonly RawKnowledgeBase[];
  readonly _pagination?: FrontPagination;
}
interface RawArticle {
  readonly id?: number | string;
  readonly name?: string;
  /** `draft` | `published` | `archived`. */
  readonly status?: string;
  readonly html_content?: string | null;
  /** Front timestamp: Unix epoch seconds (float) or an ISO-8601 string. */
  readonly last_edited?: number | string;
  readonly locale?: string;
  readonly url?: string;
}
interface ArticleListResponse {
  readonly _results?: readonly RawArticle[];
  readonly _pagination?: FrontPagination;
}

/** One enumerated article-locale, normalized (timestamp canonical, id stringified). */
interface NormalizedArticle {
  readonly id: string;
  /** Lowercased article status; `""` when the vendor omitted it (= not published). */
  readonly status: string;
  /** Canonical ISO instant (`toIsoInstant`) — never the raw vendor value. */
  readonly lastEdited: string;
  /** The list entry's `html_content`, or null when the list omitted the body. */
  readonly htmlContent: string | null;
  readonly title: string;
  /** Resolved locale label for the path/provenance (lowercased). */
  readonly locale: string;
  /** The `?locale=` param this row was walked with (null = default-locale walk). */
  readonly localeParam: string | null;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Build a Front vendor client for ONE knowledge base. `createClient` (the
 * connector factory) has already decrypted the token and validated config, so
 * this constructor does no I/O.
 */
export function createFrontVendorClient(
  config: FrontClientConfig,
  deps: FrontClientDeps = {},
): ConnectorVendorClient {
  const api = new FrontApi(config, deps);
  return {
    async fetchChanges(params: ConnectorFetchSince): Promise<ConnectorChanges> {
      return api.fetch({ since: params.since });
    },
    async fetchAll(): Promise<ConnectorChanges> {
      return api.fetch({ since: null });
    },
  };
}

/** One Front knowledge base, normalized for the install handler's fan-out. */
export interface FrontKnowledgeBase {
  /** The knowledge base id. */
  readonly id: string;
  readonly name: string;
}

export interface FrontAccountParams {
  readonly apiToken: string;
}

/**
 * Enumerate the company's knowledge bases — ALSO the install-time credential
 * check (the first authenticated request doubles as it; loud on every failure).
 * A bad token surfaces as a 401, both actionable and host-redacted; the install
 * handler maps it to a field-level 400 so "invalid credentials fail the install
 * loudly."
 */
export async function listFrontKnowledgeBases(
  params: FrontAccountParams,
  deps: FrontClientDeps = {},
): Promise<FrontKnowledgeBase[]> {
  const http = new FrontHttp(params.apiToken, deps);
  const bases: FrontKnowledgeBase[] = [];
  let skippedMalformed = 0;
  let url: string | null = `${FRONT_API_BASE}/knowledge_bases`;
  let pages = 0;
  while (url !== null) {
    if (++pages > MAX_FEED_PAGES) {
      throw new Error(
        `Front knowledge-base listing on ${hostForLog(FRONT_API_BASE)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
      );
    }
    const body: KnowledgeBaseListResponse =
      await http.getJson<KnowledgeBaseListResponse>(url);
    for (const raw of asArray(body._results)) {
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (id === "") {
        skippedMalformed++;
        continue;
      }
      bases.push({
        id,
        name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : id,
      });
    }
    url = nextPageUrl(body._pagination?.next);
  }
  if (skippedMalformed > 0) {
    log.warn(
      { host: hostForLog(FRONT_API_BASE), skippedMalformed },
      "Skipped Front knowledge bases missing an id — not installable (unexpected vendor response)",
    );
  }
  return bases;
}

/**
 * Resolve a vendor-supplied pagination link and pin it to Front's origin.
 * `_pagination.next` is fetched with the `Authorization` header — an off-origin
 * link (broken or malicious vendor payload) must fail loudly rather than
 * forward credentials. Null / empty ends the walk.
 */
function nextPageUrl(rawNext: string | null | undefined): string | null {
  if (typeof rawNext !== "string" || rawNext === "") return null;
  let resolved: URL;
  try {
    resolved = new URL(rawNext, FRONT_API_BASE);
  } catch (err) {
    // Translate-and-rethrow: the raw link must not reach the message (untrusted
    // vendor payload), but the parse failure rides along as cause.
    throw new Error(
      `Front returned an unparseable pagination link from ${hostForLog(FRONT_API_BASE)} — unexpected vendor response.`,
      { cause: err },
    );
  }
  if (resolved.origin !== new URL(FRONT_API_BASE).origin) {
    throw new Error(
      `Front returned a pagination link pointing off ${hostForLog(FRONT_API_BASE)} — refusing to follow it with credentials.`,
    );
  }
  return resolved.toString();
}

class FrontApi {
  private readonly http: FrontHttp;
  private readonly maxDocs: number;

  constructor(
    private readonly config: FrontClientConfig,
    deps: FrontClientDeps,
  ) {
    this.http = new FrontHttp(config.apiToken, deps);
    this.maxDocs = deps.maxDocs ?? getIngestMaxDocs();
  }

  /**
   * Enumerate every locale variant of the KB's articles + assemble. When
   * `since` is null this is a reconciliation crawl (every published locale
   * variant emitted); otherwise an incremental cycle (only variants edited
   * at-or-after `since`).
   */
  async fetch(opts: { since: string | null }): Promise<ConnectorChanges> {
    const reconciliation = opts.since === null;
    const locales = await this.resolveLocales();

    const collected: NormalizedArticle[] = [];
    let skippedMalformed = 0;
    for (const locale of locales) {
      const result = await this.listArticlesForLocale(locale);
      collected.push(...result.articles);
      skippedMalformed += result.skippedMalformed;
      if (collected.length > MAX_ARTICLES) {
        throw new Error(
          `Front knowledge base "${this.config.knowledgeBaseId}" exceeds ${MAX_ARTICLES} articles — narrow the connector's scope. (This is a safety bound, not the ingest cap ATLAS_KNOWLEDGE_INGEST_MAX_DOCS.)`,
        );
      }
    }

    // Every article — published or not — advances the mark: its change is what
    // this fetch observed. ISO instants compare chronologically as strings.
    let highWaterMark: string | null = null;
    for (const a of collected) {
      if (highWaterMark === null || a.lastEdited > highWaterMark) highWaterMark = a.lastEdited;
    }

    // Only PUBLISHED variants are candidate documents; on incremental, narrow to
    // those edited at-or-after `since`. Draft/archived variants are simply absent
    // — the reconciliation crawl's subtractive diff archives their stale paths.
    // `reconciliation === (opts.since === null)`, so the reconciliation path
    // keeps every published variant; incremental keeps those edited at-or-after
    // the mark (>= is inclusive so an article edited exactly at `since` re-emits).
    const candidates = collected.filter(
      (a) => a.status === "published" && (opts.since === null || a.lastEdited >= opts.since),
    );

    // Reject an over-cap FULL published set on reconciliation BEFORE fetching
    // any fallback bodies — the engine's ingest cap is the backstop, but checking
    // here puts real numbers in the error (the AC's "caps validated over the full
    // set").
    if (reconciliation && candidates.length > this.maxDocs) {
      throw new Error(
        `This Front knowledge base has ${candidates.length} published article locales, over the ${this.maxDocs}-document limit (ATLAS_KNOWLEDGE_INGEST_MAX_DOCS) — narrow the KB's scope, or raise the cap.`,
      );
    }

    let sideloadFallbacks = 0;
    const emitted: FrontArticleLocale[] = [];
    for (const a of candidates) {
      // The article list SHOULD carry `html_content`; when it doesn't, fetch the
      // single localized article (the canonical body source). Counted + logged:
      // the fallback flips the request profile to N+1, and an operator debugging
      // sudden 429s needs the breadcrumb.
      let bodyHtml = a.htmlContent;
      if (bodyHtml === null) {
        sideloadFallbacks++;
        bodyHtml = await this.fetchArticleHtml(a.id, a.localeParam);
      }
      if (bodyHtml === null) {
        // A published article we can't get a body for is a KNOWN hole: skip +
        // count so it flags coverage incomplete (the engine holds subtractive
        // archiving), never a silently-emitted empty document that a later
        // reconciliation would then archive.
        skippedMalformed++;
        continue;
      }
      emitted.push({
        articleId: a.id,
        knowledgeBaseId: this.config.knowledgeBaseId,
        locale: a.locale,
        title: a.title,
        bodyHtml,
        lastEdited: a.lastEdited,
        url: a.url,
      });
    }

    const assembled = assembleFrontDocuments(emitted, {
      collectionSlug: this.config.collectionSlug,
      knowledgeBaseId: this.config.knowledgeBaseId,
    });
    const mode = reconciliation ? "reconciliation" : "incremental";
    if (assembled.degradations.length > 0 || assembled.skippedContentless > 0) {
      log.info(
        {
          host: hostForLog(FRONT_API_BASE),
          knowledgeBaseId: this.config.knowledgeBaseId,
          mode,
          degradations: assembled.degradations,
          skippedContentless: assembled.skippedContentless,
        },
        "Front conversion completed with degradations/skips",
      );
    }
    if (skippedMalformed > 0) {
      log.warn(
        { host: hostForLog(FRONT_API_BASE), mode, skippedMalformed },
        "Skipped Front articles missing id/last_edited/body — not ingested (coverage flagged incomplete)",
      );
    }
    if (sideloadFallbacks > 0) {
      log.warn(
        { host: hostForLog(FRONT_API_BASE), mode, sideloadFallbacks },
        "Front article list returned no html_content — fell back to per-article fetches (N+1 request profile)",
      );
    }

    return {
      documents: assembled.documents,
      highWaterMark,
      cursor: null,
      coverageIncomplete: skippedMalformed > 0,
    };
  }

  /**
   * Resolve the KB's locales (the walk set) AND verify the KB is live. A KB
   * declaring no locales falls back to a single default-locale walk (a `null`
   * entry = no `?locale=` param). Doubles as the reconciliation-time liveness
   * check: a missing KB is a loud not-found.
   */
  private async resolveLocales(): Promise<Array<string | null>> {
    const kb = await this.http.getJson<RawKnowledgeBase>(
      `${FRONT_API_BASE}/knowledge_bases/${encodeURIComponent(this.config.knowledgeBaseId)}`,
    );
    if (typeof kb.id !== "string" || kb.id === "") {
      throw new FrontNotFoundError(
        `Front knowledge base "${this.config.knowledgeBaseId}" was not found or is not visible to this token — check the KB id and the token's permissions.`,
      );
    }
    const locales = asArray(kb.locales)
      .filter((l): l is string => typeof l === "string" && l.trim() !== "")
      .map((l) => l.trim());
    if (locales.length > MAX_LOCALES) {
      throw new Error(
        `Front knowledge base "${this.config.knowledgeBaseId}" reports ${locales.length} locales, over the ${MAX_LOCALES} safety bound — unexpected vendor response.`,
      );
    }
    return locales.length > 0 ? locales : [null];
  }

  /** Cursor-paginate one locale's article list. `walkLocale` null = default. */
  private async listArticlesForLocale(
    walkLocale: string | null,
  ): Promise<{ articles: NormalizedArticle[]; skippedMalformed: number }> {
    const articles: NormalizedArticle[] = [];
    let skippedMalformed = 0;
    const localeQuery = walkLocale !== null ? `?locale=${encodeURIComponent(walkLocale)}` : "";
    let url: string | null =
      `${FRONT_API_BASE}/knowledge_bases/${encodeURIComponent(this.config.knowledgeBaseId)}/articles${localeQuery}`;
    let pages = 0;
    while (url !== null) {
      if (++pages > MAX_FEED_PAGES) {
        throw new Error(
          `Front article listing on ${hostForLog(FRONT_API_BASE)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
        );
      }
      const body: ArticleListResponse = await this.http.getJson<ArticleListResponse>(url);
      for (const raw of asArray(body._results)) {
        const normalized = this.normalizeArticle(raw, walkLocale);
        if (normalized !== null) articles.push(normalized);
        else skippedMalformed++;
      }
      url = nextPageUrl(body._pagination?.next);
    }
    return { articles, skippedMalformed };
  }

  /** One published article's body when the list omitted it; null = still absent. */
  private async fetchArticleHtml(
    articleId: string,
    localeParam: string | null,
  ): Promise<string | null> {
    const localeQuery = localeParam !== null ? `?locale=${encodeURIComponent(localeParam)}` : "";
    const url = `${FRONT_API_BASE}/knowledge_bases/${encodeURIComponent(this.config.knowledgeBaseId)}/articles/${encodeURIComponent(articleId)}${localeQuery}`;
    const body = await this.http.getJson<RawArticle>(url);
    return typeof body.html_content === "string" ? body.html_content : null;
  }

  /** Normalize one raw article; null = malformed (skip + count). */
  private normalizeArticle(raw: RawArticle, walkLocale: string | null): NormalizedArticle | null {
    const id = idOf(raw.id);
    const lastEdited = normalizeFrontTimestamp(raw.last_edited);
    if (id === "" || lastEdited === null) return null;
    const rawLocale =
      typeof raw.locale === "string" && raw.locale.trim() !== "" ? raw.locale.trim() : walkLocale;
    return {
      id,
      status: typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "",
      lastEdited,
      // Null-vs-empty contract: a PRESENT string (incl. `""`) is the genuine
      // body — an empty one assembles to a contentless skip. Only an ABSENT /
      // non-string field is `null`, which triggers the per-article fallback
      // fetch (never a silent empty-body emit that a reconciliation could then
      // wrongly archive — mirrors gitbook/client.ts).
      htmlContent: typeof raw.html_content === "string" ? raw.html_content : null,
      title: typeof raw.name === "string" ? raw.name : "",
      locale: (rawLocale ?? "default").toLowerCase(),
      localeParam: walkLocale,
      url: this.articleUrl(raw, id, walkLocale),
    };
  }

  /** Prefer the article's own URL; fall back to a canonical API resource path. */
  private articleUrl(raw: RawArticle, id: string, walkLocale: string | null): string {
    if (typeof raw.url === "string" && /^https?:\/\//i.test(raw.url)) return raw.url;
    const localeQuery = walkLocale !== null ? `?locale=${encodeURIComponent(walkLocale)}` : "";
    return `${FRONT_API_BASE}/knowledge_bases/${encodeURIComponent(this.config.knowledgeBaseId)}/articles/${encodeURIComponent(id)}${localeQuery}`;
  }
}

/**
 * Coerce an untrusted vendor field to a readonly array — a non-array `_results`
 * / `locales` (an object, a string) would otherwise throw a bare TypeError at
 * the `for…of`; treating it as empty keeps the walk's own bounds + coverage
 * flagging in charge of anomalous responses.
 */
function asArray<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/** Stringify an untrusted vendor id — scalars only (`null`/objects = malformed). */
function idOf(raw: number | string | undefined): string {
  return typeof raw === "number" || typeof raw === "string" ? String(raw) : "";
}

/**
 * Normalize a Front timestamp to a canonical ISO instant. Front core timestamps
 * are Unix epoch SECONDS (float); a string is parsed as ISO-8601. Anything else
 * (or an unparseable value) is null.
 */
export function normalizeFrontTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return toIsoInstant(value);
}

// ---------------------------------------------------------------------------
// HTTP (shared by the per-KB client and the account-level KB listing)
// ---------------------------------------------------------------------------

class FrontHttp {
  private readonly authHeader: string;

  constructor(
    apiToken: string,
    private readonly deps: FrontClientDeps,
  ) {
    this.authHeader = `Bearer ${apiToken}`;
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
        `Front request to ${hostForLog(FRONT_API_BASE)} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.status === 429) {
      throw new ConnectorRateLimitError(
        `Front rate-limited the request to ${hostForLog(FRONT_API_BASE)} (Front applies per-endpoint rate limits; honor Retry-After).`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new FrontAuthError(
        `Front rejected the credentials (${response.status}) for ${hostForLog(FRONT_API_BASE)} — re-enter the API token (Front → Settings → Developers → API tokens) and confirm it has the knowledge_bases:read scope.`,
      );
    }
    if (response.status === 404) {
      throw new FrontNotFoundError(
        `Front returned 404 from ${hostForLog(FRONT_API_BASE)} — the knowledge base id may be wrong or the token can't see it.`,
      );
    }
    if (response.status >= 500) {
      throw new Error(
        `Front returned HTTP ${response.status} from ${hostForLog(FRONT_API_BASE)} — a vendor-side error; the next scheduled sync (or retrying the install) will usually succeed.`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Front returned HTTP ${response.status} from ${hostForLog(FRONT_API_BASE)} — an unexpected Front API response; if it persists, re-install the collection or check Front's API status.`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(
        `Front returned a non-JSON response from ${hostForLog(FRONT_API_BASE)}: ${err instanceof Error ? err.message : String(err)}`,
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
