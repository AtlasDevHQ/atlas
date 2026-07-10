/**
 * The Help Scout Docs vendor client (#4398, PRD #4395) — a
 * {@link ConnectorVendorClient} over the Help Scout **Docs** API
 * (`docsapi.helpscout.net`, distinct from the Mailbox API), driven by the
 * shared connector engine (`connector-sync.ts`). It owns ONLY enumerate +
 * fetch + convert; scheduling, high-water marks, reconciliation cadence, 429
 * backoff, and caps are the engine's (ADR-0030).
 *
 * The Docs API lists articles BODYLESS — `GET …/articles` returns article REFS
 * (id, updatedAt, no HTML). So each cadence enumerates refs, then fetches the
 * body of exactly the articles it needs via `GET /v1/articles/{id}`:
 *
 *   - `fetchChanges({ since })` (incremental) — for each collection in the
 *     site, page the article list `sort=updatedAt&order=desc` and take refs
 *     newer than `since`, STOPPING each collection's walk at the first ref at
 *     or before the mark (the list is newest-first, so the rest are older).
 *     Then fetch ONE body per changed ref — the AC's "one Get Article per
 *     changed article only (not per full sweep)".
 *   - `fetchAll()` (reconciliation) — page every collection's full published
 *     article list and fetch each body. The engine archives paths absent from
 *     this set, so an unpublished/deleted article (never returned under
 *     `status=published`) is treated as absent, never an error.
 *
 * Published semantics: the list is filtered to `status=published`, so a
 * `notpublished` (unpublished) or deleted article simply stops appearing; the
 * reconciliation crawl's subtractive diff archives its document (the AC's
 * "deletes via reconcile").
 *
 * Security + hygiene: the host is a fixed vendor constant and every request
 * goes through `guardedFetch` (SSRF egress guard; auth stripped on cross-origin
 * redirect). A 429 is the ONLY signal that becomes the engine's backoff; every
 * other failure is an actionable error with the host redacted via `hostForLog`
 * — the key lives in the `Authorization` header, never a URL or a message.
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
import { HELPSCOUT_DOCS_API_BASE } from "./config";
import { assembleHelpScoutDocuments, type HelpScoutArticle } from "./documents";

const log = createLogger("knowledge.helpscout.client");

/**
 * Help Scout rejected the credentials (401/403). A distinct class — not a
 * `cause`-presence side channel — so the install handler can blame the
 * `api_key` field with `instanceof` (the `ConnectorRateLimitError` precedent;
 * plain subclass, this is not Effect code).
 */
export class HelpScoutAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelpScoutAuthError";
  }
}

/** Help Scout returned 404 — the site/collection/article is gone or unreachable. */
export class HelpScoutNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelpScoutNotFoundError";
  }
}

/** Resolved connection inputs plus the key. One Docs Site per client. */
export interface HelpScoutClientConfig {
  /** The Docs Site id this client enumerates (the API filter). */
  readonly siteId: string;
  /** The Docs API key (Basic-auth username). */
  readonly apiKey: string;
  /** The KB collection slug = `workspace_plugins.install_id` — the path prefix. */
  readonly collectionSlug: string;
}

export interface HelpScoutClientDeps {
  /** Injected fetch for tests; defaults to the guarded global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** Per-request timeout (bounds the whole redirect chain). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Article-list page size — the Docs API caps `pageSize` at 100 (the AC bound). */
const PAGE_SIZE = 100;
/**
 * Hard anti-runaway bound on enumerated articles per site — NOT the ingest cap
 * (the engine owns that, and surfaces the real over-limit numbers). A Docs site
 * larger than this is pathological; we fail loud rather than loop unbounded on a
 * broken pagination cursor.
 */
const MAX_ARTICLES = 100_000;
/**
 * Anti-runaway bound on pages walked in one paginated enumeration — the
 * collection listing AND each collection's article listing share it, so every
 * walk fails loud on a stuck `pages` count rather than looping forever.
 */
const MAX_FEED_PAGES = 1_000;

// ---------------------------------------------------------------------------
// Raw API response shapes (only the fields we read; untrusted vendor JSON —
// every field optional, narrowed at the use sites). The Docs API wraps list
// responses in a named paged envelope: `{ "<key>": { page, pages, items } }`.
// ---------------------------------------------------------------------------

interface RawPage<T> {
  readonly page?: number;
  readonly pages?: number;
  readonly items?: readonly T[];
}
interface RawSite {
  readonly id?: string | number;
  readonly title?: string;
  readonly subDomain?: string;
  readonly status?: string;
}
interface SitesResponse {
  readonly sites?: RawPage<RawSite>;
}
interface RawCollection {
  readonly id?: string | number;
  readonly name?: string;
  readonly slug?: string;
}
interface CollectionsResponse {
  readonly collections?: RawPage<RawCollection>;
}
/** A bodyless article ref from a list endpoint — no `text`. */
interface RawArticleRef {
  readonly id?: string | number;
  readonly updatedAt?: string;
  readonly status?: string;
}
interface ArticlesResponse {
  readonly articles?: RawPage<RawArticleRef>;
}
/** A full article from `GET /v1/articles/{id}` — carries the `text` HTML body. */
interface RawArticle {
  readonly id?: string | number;
  readonly name?: string;
  readonly text?: string | null;
  readonly status?: string;
  readonly updatedAt?: string;
  readonly publicUrl?: string;
}
interface ArticleResponse {
  readonly article?: RawArticle;
}

/** One enumerated article ref, normalized (timestamp canonical, id stringified). */
interface NormalizedRef {
  readonly id: string;
  /** Canonical ISO instant (`toIsoInstant`) — never the raw vendor string. */
  readonly updatedAt: string;
  /** The source Docs collection slug (or id fallback) — a path segment. */
  readonly collectionSlug: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Build a Help Scout Docs vendor client for ONE Docs Site. `createClient` (the
 * connector factory) has already decrypted the key and validated config, so
 * this constructor does no I/O.
 */
export function createHelpScoutVendorClient(
  config: HelpScoutClientConfig,
  deps: HelpScoutClientDeps = {},
): ConnectorVendorClient {
  const api = new HelpScoutApi(config, deps);
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

/** One enumerated Docs Site, normalized for the install handler's fan-out. */
export interface HelpScoutSite {
  /** Stringified site id. */
  readonly id: string;
  /** Human site title (falls back to the id when the vendor omits it). */
  readonly name: string;
  /** The site's `*.helpscoutdocs.com` subdomain label, or null. */
  readonly subdomain: string | null;
}

export interface HelpScoutAccountParams {
  readonly apiKey: string;
}

/**
 * Enumerate the account's Docs Sites — ALSO the install-time credential check
 * (the first authenticated request doubles as it; loud on every failure). A bad
 * key surfaces as a 401, both actionable and host-redacted; the install handler
 * maps it to a field-level 400 so "invalid credentials fail the install
 * loudly." One collection is created per site returned here.
 */
export async function listHelpScoutSites(
  params: HelpScoutAccountParams,
  deps: HelpScoutClientDeps = {},
): Promise<HelpScoutSite[]> {
  const http = new HelpScoutHttp(params.apiKey, deps);
  const sites: HelpScoutSite[] = [];
  let skippedMalformed = 0;
  for (let page = 1; page <= MAX_FEED_PAGES; page++) {
    const body = await http.getJson<SitesResponse>(
      `${HELPSCOUT_DOCS_API_BASE}/v1/sites?page=${page}`,
    );
    const envelope = body.sites;
    for (const raw of envelope?.items ?? []) {
      const id = idOf(raw.id);
      if (id === "") {
        skippedMalformed++;
        continue;
      }
      const title = typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title.trim() : id;
      const sub = typeof raw.subDomain === "string" ? raw.subDomain.trim().toLowerCase() : "";
      sites.push({ id, name: title, subdomain: sub === "" ? null : sub });
    }
    if (!hasNextPage(envelope, page)) break;
    if (page === MAX_FEED_PAGES) {
      throw new Error(
        `Help Scout site listing on ${hostForLog(HELPSCOUT_DOCS_API_BASE)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
      );
    }
  }
  if (skippedMalformed > 0) {
    log.warn(
      { host: hostForLog(HELPSCOUT_DOCS_API_BASE), skippedMalformed },
      "Skipped Help Scout sites missing an id — not installable (unexpected vendor response)",
    );
  }
  return sites;
}

class HelpScoutApi {
  private readonly http: HelpScoutHttp;

  constructor(
    private readonly config: HelpScoutClientConfig,
    deps: HelpScoutClientDeps,
  ) {
    this.http = new HelpScoutHttp(config.apiKey, deps);
  }

  /**
   * Reconciliation: enumerate EVERY published article in the site (all
   * collections, all pages), fetch each body. One document per published
   * article.
   */
  async fetchAll(): Promise<ConnectorChanges> {
    const { refs, skippedMalformed, highWaterMark } = await this.collectRefs(null);
    return this.assemble(refs, skippedMalformed, highWaterMark, "reconciliation");
  }

  /**
   * Incremental: for each collection, walk the `updatedAt desc` article list
   * and take refs newer than `since`, stopping each collection's walk at the
   * first ref at or before the mark. Then fetch one body per changed ref.
   */
  async fetchChanges(since: string): Promise<ConnectorChanges> {
    if (toIsoInstant(since) === null) {
      // The engine derives `since` from its own persisted ISO mark, so this is
      // defensive — fail loud rather than silently refetch everything.
      throw new Error(`Help Scout incremental fetch got an unparseable since instant ("${since}").`);
    }
    const { refs, skippedMalformed, highWaterMark } = await this.collectRefs(since);
    return this.assemble(refs, skippedMalformed, highWaterMark, "incremental");
  }

  /**
   * Enumerate article refs across the site's collections. `since === null`
   * collects every published article (reconciliation); a non-null `since`
   * collects only refs strictly newer than the mark, early-stopping each
   * collection's newest-first walk at the first older ref (incremental).
   */
  private async collectRefs(
    since: string | null,
  ): Promise<{ refs: NormalizedRef[]; skippedMalformed: number; highWaterMark: string | null }> {
    const collections = await this.listCollections();
    const refs: NormalizedRef[] = [];
    let skippedMalformed = 0;
    let highWaterMark: string | null = null;

    for (const collection of collections) {
      let stop = false;
      for (let page = 1; page <= MAX_FEED_PAGES && !stop; page++) {
        const url =
          `${HELPSCOUT_DOCS_API_BASE}/v1/collections/${encodeURIComponent(collection.id)}/articles` +
          `?status=published&sort=updatedAt&order=desc&pageSize=${PAGE_SIZE}&page=${page}`;
        const body = await this.http.getJson<ArticlesResponse>(url);
        const envelope = body.articles;
        for (const raw of envelope?.items ?? []) {
          const id = idOf(raw.id);
          const updatedAt = toIsoInstant(raw.updatedAt);
          if (id === "" || updatedAt === null) {
            skippedMalformed++;
            continue;
          }
          // Every ref read advances the mark — the newest change this fetch
          // observed. ISO instants compare chronologically as strings.
          if (highWaterMark === null || updatedAt > highWaterMark) highWaterMark = updatedAt;
          if (since !== null && updatedAt <= since) {
            // Newest-first: this ref and every later one are at/older than the
            // mark — nothing more changed in this collection.
            stop = true;
            break;
          }
          refs.push({ id, updatedAt, collectionSlug: collection.slug });
          if (refs.length > MAX_ARTICLES) {
            throw new Error(
              `Help Scout site on ${hostForLog(HELPSCOUT_DOCS_API_BASE)} exceeds ${MAX_ARTICLES} articles — narrow the connector's scope. (This is a safety bound, not the ingest cap ATLAS_KNOWLEDGE_INGEST_MAX_DOCS.)`,
            );
          }
        }
        if (!hasNextPage(envelope, page)) break;
        if (page === MAX_FEED_PAGES) {
          throw new Error(
            `Help Scout article listing on ${hostForLog(HELPSCOUT_DOCS_API_BASE)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
          );
        }
      }
    }
    return { refs, skippedMalformed, highWaterMark };
  }

  /** Enumerate the site's collections (paginated). */
  private async listCollections(): Promise<Array<{ id: string; slug: string }>> {
    const collections: Array<{ id: string; slug: string }> = [];
    let skippedMalformed = 0;
    for (let page = 1; page <= MAX_FEED_PAGES; page++) {
      const url = `${HELPSCOUT_DOCS_API_BASE}/v1/collections?siteId=${encodeURIComponent(this.config.siteId)}&page=${page}`;
      const body = await this.http.getJson<CollectionsResponse>(url);
      const envelope = body.collections;
      for (const raw of envelope?.items ?? []) {
        const id = idOf(raw.id);
        if (id === "") {
          skippedMalformed++;
          continue;
        }
        const slug =
          typeof raw.slug === "string" && raw.slug.trim() !== ""
            ? raw.slug.trim()
            : typeof raw.name === "string" && raw.name.trim() !== ""
              ? raw.name.trim()
              : id;
        collections.push({ id, slug });
      }
      if (!hasNextPage(envelope, page)) break;
      if (page === MAX_FEED_PAGES) {
        throw new Error(
          `Help Scout collection listing on ${hostForLog(HELPSCOUT_DOCS_API_BASE)} did not terminate after ${MAX_FEED_PAGES} pages — unexpected vendor pagination.`,
        );
      }
    }
    if (skippedMalformed > 0) {
      log.warn(
        { host: hostForLog(HELPSCOUT_DOCS_API_BASE), skippedMalformed },
        "Skipped Help Scout collections missing an id — cannot enumerate their articles (unexpected vendor response)",
      );
    }
    return collections;
  }

  /**
   * Fetch each ref's body (`GET /v1/articles/{id}`) and convert. A 404 on a
   * just-listed article (deleted mid-sweep) is skipped and flags coverage
   * incomplete — the engine then holds subtractive archiving rather than
   * archiving off a partial view. Auth/429/5xx propagate (429 → engine backoff;
   * auth → fail loud).
   */
  private async assemble(
    refs: readonly NormalizedRef[],
    skippedMalformedRefs: number,
    highWaterMark: string | null,
    mode: "incremental" | "reconciliation",
  ): Promise<ConnectorChanges> {
    let skippedMalformed = skippedMalformedRefs;
    const articles: HelpScoutArticle[] = [];

    for (const ref of refs) {
      let raw: RawArticle | undefined;
      try {
        const body = await this.http.getJson<ArticleResponse>(
          `${HELPSCOUT_DOCS_API_BASE}/v1/articles/${encodeURIComponent(ref.id)}`,
        );
        raw = body.article;
      } catch (err) {
        if (err instanceof HelpScoutNotFoundError) {
          // Deleted between list and fetch — a KNOWN hole; flag coverage so the
          // engine doesn't archive off this partial view. Never a silent drop.
          skippedMalformed++;
          log.warn(
            { host: hostForLog(HELPSCOUT_DOCS_API_BASE), mode, articleId: ref.id },
            "Help Scout article vanished between listing and fetch — skipping (coverage held)",
          );
          continue;
        }
        throw err; // 429 (backoff), auth, 5xx — surfaced loudly
      }
      if (raw === undefined) {
        skippedMalformed++;
        continue;
      }
      // A published-list race: the article was unpublished between list and
      // fetch. Treat as absent (reconciliation archives it), never emitted. Not
      // a coverage hole (a clean 200 we deliberately dropped), but logged so the
      // drop is observable — in incremental mode there is no subtractive
      // archiving, so the already-ingested doc stays live until reconciliation.
      if (typeof raw.status === "string" && raw.status.trim().toLowerCase() !== "published") {
        log.debug(
          { host: hostForLog(HELPSCOUT_DOCS_API_BASE), mode, articleId: ref.id },
          "Help Scout article unpublished between listing and body fetch — skipping (archived on next reconciliation)",
        );
        continue;
      }

      articles.push({
        articleId: ref.id,
        title: typeof raw.name === "string" ? raw.name : "",
        bodyHtml: typeof raw.text === "string" ? raw.text : "",
        updatedAt: toIsoInstant(raw.updatedAt) ?? ref.updatedAt,
        url: typeof raw.publicUrl === "string" ? raw.publicUrl : "",
        collectionSlug: ref.collectionSlug,
      });
    }

    const assembled = assembleHelpScoutDocuments(articles, {
      collectionSlug: this.config.collectionSlug,
      siteId: this.config.siteId,
    });
    if (assembled.degradations.length > 0 || assembled.skippedContentless > 0) {
      log.info(
        {
          host: hostForLog(HELPSCOUT_DOCS_API_BASE),
          mode,
          degradations: assembled.degradations,
          skippedContentless: assembled.skippedContentless,
        },
        "Help Scout conversion completed with degradations/skips",
      );
    }
    if (skippedMalformed > 0) {
      log.warn(
        { host: hostForLog(HELPSCOUT_DOCS_API_BASE), mode, skippedMalformed },
        "Skipped Help Scout articles missing id/timestamp or vanished mid-sweep — not ingested (coverage held)",
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
function idOf(raw: string | number | undefined): string {
  return typeof raw === "number" || typeof raw === "string" ? String(raw).trim() : "";
}

/** True when a paged envelope reports more pages after `page`. */
function hasNextPage(envelope: RawPage<unknown> | undefined, page: number): boolean {
  const pages = typeof envelope?.pages === "number" ? envelope.pages : 1;
  const items = envelope?.items ?? [];
  // Stop on an empty page too — a `pages` count that never shrinks would loop.
  return items.length > 0 && page < pages;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class HelpScoutHttp {
  private readonly authHeader: string;

  constructor(
    apiKey: string,
    private readonly deps: HelpScoutClientDeps,
  ) {
    // Help Scout Docs API auth is HTTP Basic with the API KEY as the username
    // and a dummy password (their documented "X"). Buffer.from handles any
    // UTF-8 in the key (unlike btoa).
    this.authHeader = `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`;
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
        `Help Scout request to ${hostForLog(HELPSCOUT_DOCS_API_BASE)} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.status === 429) {
      throw new ConnectorRateLimitError(
        `Help Scout rate-limited the request to ${hostForLog(HELPSCOUT_DOCS_API_BASE)} (the Docs API allows roughly 200–400 requests/minute, scaling with site count).`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new HelpScoutAuthError(
        `Help Scout rejected the credentials (${response.status}) for ${hostForLog(HELPSCOUT_DOCS_API_BASE)} — re-enter the Docs API key (Help Scout → Your Profile → Authentication → API Keys) and confirm Docs access is enabled.`,
      );
    }
    if (response.status === 404) {
      throw new HelpScoutNotFoundError(
        `Help Scout returned 404 from ${hostForLog(HELPSCOUT_DOCS_API_BASE)} — the site, collection, or article was not found.`,
      );
    }
    if (response.status >= 500) {
      throw new Error(
        `Help Scout returned HTTP ${response.status} from ${hostForLog(HELPSCOUT_DOCS_API_BASE)} — a vendor-side error; the next scheduled sync (or retrying the install) will usually succeed.`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Help Scout returned HTTP ${response.status} from ${hostForLog(HELPSCOUT_DOCS_API_BASE)} — an unexpected Docs API response; if it persists, re-install the collection or check Help Scout's API status.`,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new Error(
        `Help Scout returned a non-JSON response from ${hostForLog(HELPSCOUT_DOCS_API_BASE)}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    // A top-level `null`/array/primitive is valid JSON but not a Docs envelope;
    // reject it with an actionable message rather than let a caller's `body.x`
    // deref throw an opaque TypeError.
    if (json === null || typeof json !== "object") {
      throw new Error(
        `Help Scout returned an unexpected JSON envelope from ${hostForLog(HELPSCOUT_DOCS_API_BASE)} (not an object) — an unexpected Docs API response.`,
      );
    }
    return json as T;
  }
}

/** Parse a `Retry-After` header (delta-seconds only; HTTP-date → null). */
export function parseRetryAfter(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
