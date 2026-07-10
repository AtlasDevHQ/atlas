/**
 * The Freshdesk Solutions vendor client (#4401, PRD #4395) — a
 * {@link ConnectorVendorClient} over Freshdesk's Solutions REST API
 * (`{subdomain}.freshdesk.com/api/v2`, API-key Basic auth), driven by the
 * shared connector engine (`connector-sync.ts`). It owns ONLY enumerate +
 * fetch + convert; scheduling, high-water marks, reconciliation cadence, 429
 * backoff, and caps are the engine's (ADR-0030).
 *
 * Freshdesk Solutions exposes NO server-side change feed (`updated_since`), so
 * both engine cadences are served from one full CATEGORY TREE-WALK — the PRD's
 * delta-less reconciliation-diff posture:
 *   - `fetchAll()` (reconciliation) — walk the collection's category →
 *     folders → subfolders → articles (the folder-article list carries each
 *     article's `description` body inline), emit one document per PUBLISHED
 *     language variant. The engine archives previously-ingested paths absent
 *     from this set, so a draft/deleted article is treated as absent, never an
 *     error (the AC's "deletes via reconcile").
 *   - `fetchChanges({ since })` (incremental) — the SAME full tree-walk, but
 *     only variants whose `updated_at` is at-or-after `since` are emitted
 *     (Freshdesk has no delta, but each article/translation carries
 *     `updated_at`, so the high-water mark still narrows the ingest churn).
 *     Deletions are not detectable here — the reconciliation crawl owns
 *     subtractive archiving.
 *
 * One client mirrors ONE Solutions category (the install handler fans one
 * install out to one collection per category). Multi-language: the account's
 * `supported_languages` (from `/settings/helpdesk`) drive a per-language
 * translation fetch (`GET /solutions/articles/{id}/{language_code}`); each
 * `(article, language)` pair is a distinct document. A single-language account
 * (the common case) pays nothing — the `others` set is empty and no translation
 * requests are made.
 *
 * Security + hygiene: the host is composed from a validated `*.freshdesk.com`
 * subdomain label (never a customer-supplied URL), and every request goes
 * through `guardedFetch` (SSRF egress guard; auth stripped on cross-origin
 * redirect). A 429 is the ONLY signal that becomes the engine's backoff (thrown
 * as {@link ConnectorRateLimitError}); every other failure is an actionable
 * error with the host redacted via `hostForLog` — the API key lives in the
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
import { freshdeskHostFor } from "./config";
import { assembleFreshdeskDocuments, type FreshdeskArticleLocale } from "./documents";

const log = createLogger("knowledge.freshdesk.client");

/**
 * Freshdesk rejected the credentials (401/403). A distinct class — not a
 * `cause`-presence side channel — so the install handler can blame the
 * `api_key` field with `instanceof` (the `ConnectorRateLimitError` precedent;
 * plain subclass, this is not Effect code).
 */
export class FreshdeskAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreshdeskAuthError";
  }
}

/** Freshdesk returned 404 — wrong subdomain, or the category is gone. */
export class FreshdeskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreshdeskNotFoundError";
  }
}

/** Freshdesk Solutions article/translation status: 1 = draft, 2 = published. */
const PUBLISHED_STATUS = 2;

/** Resolved, non-secret connection inputs plus the key. One category per client. */
export interface FreshdeskClientConfig {
  /** The account's validated subdomain label — the help-center host to fetch. */
  readonly subdomain: string;
  /** The Solutions category id this collection mirrors. */
  readonly categoryId: string;
  /** Human category name — the provenance `product` label. */
  readonly categoryName: string;
  readonly apiKey: string;
  /** The KB collection slug = `workspace_plugins.install_id` — the path prefix. */
  readonly collectionSlug: string;
}

export interface FreshdeskClientDeps {
  /** Injected fetch for tests; defaults to the guarded global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Test-only override of the ingest doc cap (defaults to the settings value). */
  readonly maxDocs?: number;
}

/** Per-request timeout (bounds the whole redirect chain). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Freshdesk list page size (`per_page` max is 100). */
const PER_PAGE = 100;
/**
 * Hard anti-runaway bound on pages walked in one paginated enumeration — the
 * category listing, folder listing, subfolder listing, AND article listing all
 * share it, so every walk fails loud on a stuck page cursor rather than looping
 * forever.
 */
const MAX_FEED_PAGES = 1_000;
/**
 * Hard anti-runaway bound on enumerated articles across a category tree — NOT
 * the ingest cap (the engine owns that, and surfaces the real over-limit
 * numbers). A category larger than this is pathological; we fail loud rather
 * than loop unbounded on a broken pagination response.
 */
const MAX_ARTICLES = 100_000;
/** Anti-runaway bound on subfolder nesting depth walked under one category. */
const MAX_FOLDER_DEPTH = 20;
/**
 * Anti-runaway bound on the non-primary languages walked per article. Freshdesk
 * supports a few dozen languages; far more is an anomalous account response.
 */
const MAX_LANGUAGES = 60;

// ---------------------------------------------------------------------------
// Raw API response shapes (only the fields we read; untrusted vendor JSON —
// every field optional, narrowed at the use sites)
// ---------------------------------------------------------------------------

interface RawCategory {
  readonly id?: number | string;
  readonly name?: string;
}
interface RawFolder {
  readonly id?: number | string;
  readonly sub_folders_count?: number;
  readonly articles_count?: number;
}
interface RawArticle {
  readonly id?: number | string;
  readonly title?: string;
  /** HTML body. */
  readonly description?: string | null;
  /** 1 = draft, 2 = published. */
  readonly status?: number;
  readonly updated_at?: string;
  readonly language?: string;
  readonly url?: string;
}
interface RawHelpdeskSettings {
  readonly primary_language?: string;
  readonly supported_languages?: readonly unknown[];
}

/** One enumerated primary-language article, normalized. */
interface NormalizedArticle {
  readonly id: string;
  /** 1 = draft, 2 = published (`0` when the vendor omitted it = not published). */
  readonly status: number;
  /** Canonical ISO instant (`toIsoInstant`) — never the raw vendor string. */
  readonly updatedAt: string;
  /** The primary-language `description` body, or null when absent. */
  readonly bodyHtml: string | null;
  readonly title: string;
  /** The article's own `language`, lowercased (`""` when the vendor omitted it). */
  readonly language: string;
  readonly url: string;
}

/** The account's language set — the walk driver. */
interface AccountLanguages {
  /** Primary language label, or null when `/settings/helpdesk` was unreadable. */
  readonly primary: string | null;
  /** Supported non-primary languages (translation variants to fetch). */
  readonly others: readonly string[];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Build a Freshdesk vendor client for ONE Solutions category. `createClient`
 * (the connector factory) has already decrypted the key and validated config,
 * so this constructor does no I/O.
 */
export function createFreshdeskVendorClient(
  config: FreshdeskClientConfig,
  deps: FreshdeskClientDeps = {},
): ConnectorVendorClient {
  const api = new FreshdeskApi(config, deps);
  return {
    async fetchChanges(params: ConnectorFetchSince): Promise<ConnectorChanges> {
      return api.fetch({ since: params.since });
    },
    async fetchAll(): Promise<ConnectorChanges> {
      return api.fetch({ since: null });
    },
  };
}

/** One Freshdesk Solutions category, normalized for the install handler's fan-out. */
export interface FreshdeskCategory {
  /** Stringified numeric category id. */
  readonly id: string;
  readonly name: string;
}

export interface FreshdeskAccountParams {
  /** The account subdomain (validated label) to enumerate categories from. */
  readonly subdomain: string;
  readonly apiKey: string;
}

/**
 * Enumerate the account's Solutions categories — ALSO the install-time
 * credential check (the first authenticated request doubles as it; loud on
 * every failure). A bad key surfaces as a 401, a wrong subdomain typically as a
 * 404, both actionable and host-redacted; the install handler maps them to
 * field-level 400s so "invalid credentials fail the install loudly."
 */
export async function listFreshdeskCategories(
  params: FreshdeskAccountParams,
  deps: FreshdeskClientDeps = {},
): Promise<FreshdeskCategory[]> {
  const base = freshdeskHostFor(params.subdomain);
  const http = new FreshdeskHttp(base, params.apiKey, deps);
  const categories: FreshdeskCategory[] = [];
  let skippedMalformed = 0;
  await paginate(base, `${base}/api/v2/solutions/categories`, async (url) => {
    const rows = await http.getJson<RawCategory[]>(url);
    for (const raw of asArray(rows)) {
      const id = idOf(raw.id);
      if (id === "") {
        skippedMalformed++;
        continue;
      }
      categories.push({
        id,
        name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : id,
      });
    }
    return asArray(rows).length;
  });
  if (skippedMalformed > 0) {
    log.warn(
      { host: hostForLog(base), skippedMalformed },
      "Skipped Freshdesk categories missing an id — not installable (unexpected vendor response)",
    );
  }
  return categories;
}

/**
 * Page-walk a Freshdesk list endpoint (`?page=N&per_page=100`), stopping when a
 * page returns fewer than `PER_PAGE` rows. `onPage` fetches + accumulates and
 * returns the row count it saw. Bounded by `MAX_FEED_PAGES` so a vendor that
 * keeps returning full pages fails loud rather than looping forever.
 */
async function paginate(
  base: string,
  endpoint: string,
  onPage: (url: string) => Promise<number>,
): Promise<void> {
  const sep = endpoint.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    if (page > MAX_FEED_PAGES) {
      throw new Error(
        `Freshdesk listing on ${hostForLog(base)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
      );
    }
    const url = `${endpoint}${sep}per_page=${PER_PAGE}&page=${page}`;
    const count = await onPage(url);
    if (count < PER_PAGE) break;
  }
}

class FreshdeskApi {
  private readonly base: string;
  private readonly http: FreshdeskHttp;
  private readonly maxDocs: number;

  constructor(
    private readonly config: FreshdeskClientConfig,
    deps: FreshdeskClientDeps,
  ) {
    this.base = freshdeskHostFor(config.subdomain);
    this.http = new FreshdeskHttp(this.base, config.apiKey, deps);
    this.maxDocs = deps.maxDocs ?? getIngestMaxDocs();
  }

  /**
   * Walk the category tree + assemble. When `since` is null this is a
   * reconciliation crawl (every published language variant emitted); otherwise
   * an incremental cycle (only variants edited at-or-after `since`).
   */
  async fetch(opts: { since: string | null }): Promise<ConnectorChanges> {
    const reconciliation = opts.since === null;
    await this.assertCategoryLive();
    const languages = await this.resolveLanguages();

    // Walk category → folders → subfolders, collecting every folder to list.
    const folders = await this.collectFolders();

    const primaryArticles: NormalizedArticle[] = [];
    let skippedMalformed = 0;
    let coverageIncomplete = false;
    for (const folder of folders) {
      const result = await this.listFolderArticles(folder.id);
      primaryArticles.push(...result.articles);
      skippedMalformed += result.skippedMalformed;
      // `articles_count` completeness check: fewer listed than the folder
      // reports means the walk missed some (a mid-walk vendor hiccup) — hold
      // subtractive archiving rather than wrongly archive the unseen ones.
      if (folder.articlesCount !== null && result.total < folder.articlesCount) {
        coverageIncomplete = true;
        log.warn(
          {
            host: hostForLog(this.base),
            folderId: folder.id,
            listed: result.total,
            reported: folder.articlesCount,
          },
          "Freshdesk folder listed fewer articles than its articles_count — holding subtractive archiving this cycle",
        );
      }
      if (primaryArticles.length > MAX_ARTICLES) {
        throw new Error(
          `Freshdesk category "${this.config.categoryId}" on ${hostForLog(this.base)} exceeds ${MAX_ARTICLES} articles — narrow the connector's scope. (This is a safety bound, not the ingest cap ATLAS_KNOWLEDGE_INGEST_MAX_DOCS.)`,
        );
      }
    }

    // Build the candidate variant set (primary + translations) and track the
    // high-water mark over EVERY observed timestamp (published or not, primary
    // or translation) — a draft's change was still observed by this fetch.
    let highWaterMark: string | null = null;
    const bump = (iso: string): void => {
      if (highWaterMark === null || iso > highWaterMark) highWaterMark = iso;
    };
    const emitted: FreshdeskArticleLocale[] = [];
    let translationFetches = 0;

    for (const a of primaryArticles) {
      bump(a.updatedAt);
      // Primary-language variant.
      const primaryLocale = a.language !== "" ? a.language : (languages.primary ?? "en");
      if (a.status === PUBLISHED_STATUS && withinSince(a.updatedAt, opts.since)) {
        if (a.bodyHtml === null) {
          // A published article with no body is a KNOWN hole: flag coverage and
          // skip rather than emit an empty document a later reconciliation would
          // then archive.
          skippedMalformed++;
        } else {
          emitted.push(this.toLocale(a, primaryLocale, a.title, a.bodyHtml, a.updatedAt));
        }
      }

      // Per-language translation variants. Freshdesk carries no per-article
      // translation list, so each `(article, language)` is a direct fetch —
      // gated on a multi-language account (single-language accounts pay
      // nothing). A translation can change independently of its primary, so the
      // delta-less posture fetches them on both cadences.
      for (const lang of languages.others) {
        translationFetches++;
        const t = await this.fetchTranslation(a.id, lang);
        if (t.kind === "absent") continue; // 404 — no translation in this language, not an error
        if (t.kind === "malformed") {
          // A PRESENT translation we can't order (unparseable updated_at) is a
          // known hole, not an absent one — count it (mirrors the primary path)
          // so coverage is flagged and the end-of-fetch warn surfaces it, never
          // a silent drop.
          skippedMalformed++;
          continue;
        }
        bump(t.updatedAt);
        if (t.status === PUBLISHED_STATUS && withinSince(t.updatedAt, opts.since)) {
          if (t.bodyHtml === null) {
            skippedMalformed++;
            continue;
          }
          emitted.push(this.toLocale(a, lang, t.title, t.bodyHtml, t.updatedAt, lang));
        }
      }
    }

    // Reject an over-cap published set on reconciliation BEFORE assembling — the
    // engine's ingest cap is the backstop, but checking here puts real numbers
    // in the error (the AC's "caps validated over the full set").
    if (reconciliation && emitted.length > this.maxDocs) {
      throw new Error(
        `This Freshdesk category has ${emitted.length} published article locales, over the ${this.maxDocs}-document limit (ATLAS_KNOWLEDGE_INGEST_MAX_DOCS) — narrow the category's scope, or raise the cap.`,
      );
    }

    const assembled = assembleFreshdeskDocuments(emitted, {
      collectionSlug: this.config.collectionSlug,
    });
    const mode = reconciliation ? "reconciliation" : "incremental";
    if (assembled.degradations.length > 0 || assembled.skippedContentless > 0) {
      log.info(
        {
          host: hostForLog(this.base),
          categoryId: this.config.categoryId,
          mode,
          degradations: assembled.degradations,
          skippedContentless: assembled.skippedContentless,
        },
        "Freshdesk conversion completed with degradations/skips",
      );
    }
    if (skippedMalformed > 0) {
      log.warn(
        { host: hostForLog(this.base), mode, skippedMalformed },
        "Skipped Freshdesk articles missing id/updated_at/body — not ingested (coverage flagged incomplete)",
      );
    }
    if (translationFetches > 0) {
      log.info(
        { host: hostForLog(this.base), mode, translationFetches },
        "Freshdesk translation fetches (multi-language account — N+1 request profile per language)",
      );
    }

    return {
      documents: assembled.documents,
      highWaterMark,
      cursor: null,
      coverageIncomplete: coverageIncomplete || skippedMalformed > 0,
    };
  }

  /**
   * Verify the collection's category is live — doubles as the sync-time
   * liveness check. A missing category is a loud not-found the engine surfaces
   * on the collection.
   */
  private async assertCategoryLive(): Promise<void> {
    const cat = await this.http.getJson<RawCategory | null>(
      `${this.base}/api/v2/solutions/categories/${encodeURIComponent(this.config.categoryId)}`,
    );
    // A 200 with a null / non-object body (a vendor quirk) must map to the
    // actionable not-found, never a bare TypeError from `idOf(cat.id)`.
    if (cat === null || typeof cat !== "object" || idOf(cat.id) === "") {
      throw new FreshdeskNotFoundError(
        `Freshdesk Solutions category "${this.config.categoryId}" was not found on ${hostForLog(this.base)} — check the category still exists and the API key can see it.`,
      );
    }
  }

  /**
   * Resolve the account's language set from `/settings/helpdesk`. Best-effort:
   * a 403/404 (an agent-scoped key without settings access, or an account
   * without the endpoint) degrades to primary-only with a logged warning — the
   * multilingual walk is an enhancement, not a reason to fail the whole sync. A
   * 401 still throws loudly (real auth failure).
   */
  private async resolveLanguages(): Promise<AccountLanguages> {
    const settings = await this.http.getJsonTolerant<RawHelpdeskSettings>(
      `${this.base}/api/v2/settings/helpdesk`,
      [403, 404],
    );
    if (settings === null) {
      log.warn(
        { host: hostForLog(this.base) },
        "Freshdesk /settings/helpdesk unreadable (403/404) — syncing primary language only",
      );
      return { primary: null, others: [] };
    }
    const primary =
      typeof settings.primary_language === "string" && settings.primary_language.trim() !== ""
        ? settings.primary_language.trim().toLowerCase()
        : null;
    const others = asArray(settings.supported_languages)
      .filter((l): l is string => typeof l === "string" && l.trim() !== "")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l !== primary);
    if (others.length > MAX_LANGUAGES) {
      throw new Error(
        `Freshdesk account on ${hostForLog(this.base)} reports ${others.length} supported languages, over the ${MAX_LANGUAGES} safety bound — unexpected vendor response.`,
      );
    }
    return { primary, others };
  }

  /**
   * Walk the collection's category → folders → subfolders, returning every
   * (sub)folder to list articles from. `sub_folders_count` on the folder object
   * gates the subfolder descent, and `MAX_FOLDER_DEPTH` bounds nesting.
   */
  private async collectFolders(): Promise<Array<{ id: string; articlesCount: number | null }>> {
    const collected: Array<{ id: string; articlesCount: number | null }> = [];
    const topLevel = await this.listFolders(
      `${this.base}/api/v2/solutions/categories/${encodeURIComponent(this.config.categoryId)}/folders`,
    );
    const queue = topLevel.map((f) => ({ folder: f, depth: 0 }));
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      const { folder, depth } = item;
      collected.push({ id: folder.id, articlesCount: folder.articlesCount });
      if (folder.subFoldersCount > 0 && depth < MAX_FOLDER_DEPTH) {
        const subs = await this.listFolders(
          `${this.base}/api/v2/solutions/folders/${encodeURIComponent(folder.id)}/subfolders`,
        );
        for (const sub of subs) queue.push({ folder: sub, depth: depth + 1 });
      }
    }
    return collected;
  }

  /** List one folder-listing endpoint, paginated + normalized. */
  private async listFolders(
    endpoint: string,
  ): Promise<Array<{ id: string; subFoldersCount: number; articlesCount: number | null }>> {
    const folders: Array<{ id: string; subFoldersCount: number; articlesCount: number | null }> =
      [];
    await paginate(this.base, endpoint, async (url) => {
      const rows = await this.http.getJson<RawFolder[]>(url);
      for (const raw of asArray(rows)) {
        const id = idOf(raw.id);
        if (id === "") continue;
        folders.push({
          id,
          subFoldersCount: typeof raw.sub_folders_count === "number" ? raw.sub_folders_count : 0,
          articlesCount: typeof raw.articles_count === "number" ? raw.articles_count : null,
        });
      }
      return asArray(rows).length;
    });
    return folders;
  }

  /** Paginate one folder's primary-language articles. */
  private async listFolderArticles(
    folderId: string,
  ): Promise<{ articles: NormalizedArticle[]; skippedMalformed: number; total: number }> {
    const articles: NormalizedArticle[] = [];
    let skippedMalformed = 0;
    let total = 0;
    await paginate(
      this.base,
      `${this.base}/api/v2/solutions/folders/${encodeURIComponent(folderId)}/articles`,
      async (url) => {
        const rows = await this.http.getJson<RawArticle[]>(url);
        const list = asArray(rows);
        total += list.length;
        for (const raw of list) {
          const normalized = normalizeArticle(raw);
          if (normalized !== null) articles.push(normalized);
          else skippedMalformed++;
        }
        return list.length;
      },
    );
    return { articles, skippedMalformed, total };
  }

  /**
   * Fetch one article's translation in `language` via the `{language_code}`
   * path segment (the AC's "multi-language via {language_code} path segment").
   * A 404 means no translation exists in that language — returns null (not an
   * error). Malformed (no updated_at) also returns null.
   */
  private async fetchTranslation(
    articleId: string,
    language: string,
  ): Promise<
    | { kind: "absent" }
    | { kind: "malformed" }
    | { kind: "ok"; status: number; updatedAt: string; bodyHtml: string | null; title: string }
  > {
    const raw = await this.http.getJsonTolerant<RawArticle>(
      `${this.base}/api/v2/solutions/articles/${encodeURIComponent(articleId)}/${encodeURIComponent(language)}`,
      [404],
    );
    if (raw === null) return { kind: "absent" }; // 404 — no translation in this language
    const updatedAt = toIsoInstant(raw.updated_at);
    // A PRESENT translation with an unparseable timestamp is distinct from an
    // absent one — the caller counts it (never conflated with the 404).
    if (updatedAt === null) return { kind: "malformed" };
    return {
      kind: "ok",
      status: typeof raw.status === "number" ? raw.status : 0,
      updatedAt,
      bodyHtml: typeof raw.description === "string" ? raw.description : null,
      title: typeof raw.title === "string" ? raw.title : "",
    };
  }

  /** Build one `FreshdeskArticleLocale` for assembly. */
  private toLocale(
    a: NormalizedArticle,
    locale: string,
    title: string,
    bodyHtml: string,
    updatedAt: string,
    langSegment?: string,
  ): FreshdeskArticleLocale {
    return {
      articleId: a.id,
      categoryId: this.config.categoryId,
      categoryName: this.config.categoryName,
      locale: locale.toLowerCase(),
      title,
      bodyHtml,
      updatedAt,
      url: this.articleUrl(a, langSegment),
    };
  }

  /** Prefer the article's own URL; fall back to a canonical help-center path. */
  private articleUrl(a: NormalizedArticle, langSegment?: string): string {
    if (a.url !== "" && /^https?:\/\//i.test(a.url)) return a.url;
    const suffix = langSegment !== undefined ? `/${encodeURIComponent(langSegment)}` : "";
    return `${this.base}/support/solutions/articles/${encodeURIComponent(a.id)}${suffix}`;
  }
}

/**
 * Whether a variant's `updatedAt` qualifies for `since`. Null since = full
 * crawl (everything). `>=` is inclusive so a variant edited exactly at the mark
 * re-emits (a regression to `>` would silently drop it). ISO instants compare
 * chronologically as strings.
 */
function withinSince(updatedAt: string, since: string | null): boolean {
  return since === null || updatedAt >= since;
}

/**
 * Coerce an untrusted vendor field to an array — a non-array body (an object, a
 * string) would otherwise throw a bare TypeError at the `for…of`; treating it as
 * empty keeps the walk's own bounds + coverage flagging in charge of anomalous
 * responses.
 */
function asArray<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/** Stringify an untrusted vendor id — scalars only (`null`/objects = malformed). */
function idOf(raw: unknown): string {
  return typeof raw === "number" || typeof raw === "string" ? String(raw) : "";
}

/** Normalize one raw primary-language article; null = malformed (skip + count). */
function normalizeArticle(raw: RawArticle): NormalizedArticle | null {
  const id = idOf(raw.id);
  const updatedAt = toIsoInstant(raw.updated_at);
  if (id === "" || updatedAt === null) return null;
  return {
    id,
    status: typeof raw.status === "number" ? raw.status : 0,
    updatedAt,
    // Null-vs-empty contract: a PRESENT string (incl. `""`) is the genuine body
    // — an empty one assembles to a contentless skip. Only an ABSENT / non-string
    // `description` is null, which flags coverage rather than emit an empty doc.
    bodyHtml: typeof raw.description === "string" ? raw.description : null,
    title: typeof raw.title === "string" ? raw.title : "",
    language: typeof raw.language === "string" ? raw.language.trim().toLowerCase() : "",
    url: typeof raw.url === "string" ? raw.url : "",
  };
}

// ---------------------------------------------------------------------------
// HTTP (shared by the per-category client and the account-level category listing)
// ---------------------------------------------------------------------------

class FreshdeskHttp {
  private readonly authHeader: string;

  constructor(
    private readonly base: string,
    apiKey: string,
    private readonly deps: FreshdeskClientDeps,
  ) {
    // Freshdesk API-key auth is HTTP Basic with the key as the username and any
    // string as the password (`X` by convention). Buffer.from handles any UTF-8.
    this.authHeader = `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`;
  }

  /** GET + JSON through the SSRF guard, mapping vendor failures to typed errors. */
  async getJson<T>(url: string): Promise<T> {
    const result = await this.request<T>(url, []);
    // `request` only returns null for a tolerated status; with no tolerated
    // statuses a non-2xx always throws, so this is a real body.
    return result as T;
  }

  /**
   * GET + JSON, returning null for the given tolerated statuses instead of
   * throwing (used for the best-effort `/settings/helpdesk` read and the
   * per-language translation fetch where a 404 means "no translation").
   */
  async getJsonTolerant<T>(url: string, tolerate: readonly number[]): Promise<T | null> {
    return this.request<T>(url, tolerate);
  }

  private async request<T>(url: string, tolerate: readonly number[]): Promise<T | null> {
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
        `Freshdesk request to ${hostForLog(this.base)} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (tolerate.includes(response.status)) return null;

    if (response.status === 429) {
      throw new ConnectorRateLimitError(
        `Freshdesk rate-limited the request to ${hostForLog(this.base)} (Freshdesk applies plan-tiered per-minute rate limits; honor Retry-After).`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new FreshdeskAuthError(
        `Freshdesk rejected the credentials (${response.status}) for ${hostForLog(this.base)} — re-enter the API key (Freshdesk → Profile settings → Your API Key) and confirm it can read Solutions.`,
      );
    }
    if (response.status === 404) {
      throw new FreshdeskNotFoundError(
        `Freshdesk returned 404 from ${hostForLog(this.base)} — check the subdomain, and that the Solutions category still exists.`,
      );
    }
    if (response.status >= 500) {
      throw new Error(
        `Freshdesk returned HTTP ${response.status} from ${hostForLog(this.base)} — a vendor-side error; the next scheduled sync (or retrying the install) will usually succeed.`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Freshdesk returned HTTP ${response.status} from ${hostForLog(this.base)} — an unexpected Freshdesk API response; if it persists, re-install the collection or check Freshdesk's API status.`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(
        `Freshdesk returned a non-JSON response from ${hostForLog(this.base)}: ${err instanceof Error ? err.message : String(err)}`,
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
