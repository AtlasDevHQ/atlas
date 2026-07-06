/**
 * The Confluence Cloud vendor client (#4377, PRD #4375) — a
 * {@link ConnectorVendorClient} over the Confluence REST v2 API, driven by the
 * shared connector engine (`connector-sync.ts`). It owns ONLY enumerate + fetch
 * + convert; scheduling, high-water marks, reconciliation cadence, 429 backoff,
 * and caps are the engine's (ADR-0030).
 *
 * Two cadences the engine decides, both served from one enumeration shape:
 *   - `fetchChanges({ since })` (incremental) — enumerate the space's page
 *     METADATA (id/title/parentId/version — cheap, no bodies), keep those
 *     modified at-or-after `since`, and fetch the storage body only for those.
 *     The full metadata pass is what makes hierarchy paths deterministic across
 *     modes (ancestors always resolve) while keeping body bandwidth to the
 *     changed set.
 *   - `fetchAll()` (reconciliation) — enumerate every current page WITH its
 *     storage body in one paginated pass and assemble all. The engine archives
 *     paths absent from this set, so a restricted/deleted page (never returned
 *     by v2) is treated as absent, never an error.
 *
 * Security + hygiene: every request goes through `guardedFetch` (customer base
 * URL → SSRF egress guard; auth stripped on cross-origin redirect). A 429 is
 * the ONLY signal that becomes the engine's backoff (thrown as
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
import {
  ConnectorRateLimitError,
  type ConnectorChanges,
  type ConnectorFetchSince,
  type ConnectorVendorClient,
} from "../connectors";
import {
  assembleConfluenceDocuments,
  type ConfluencePage,
  type ConfluencePageNode,
} from "./documents";

const log = createLogger("knowledge.confluence.client");

/** Resolved, non-secret connection inputs plus the token. */
export interface ConfluenceClientConfig {
  /** Site wiki base, e.g. `https://acme.atlassian.net/wiki` (no trailing slash). */
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly spaceKey: string;
  /** The KB collection slug = `workspace_plugins.install_id` — the path prefix. */
  readonly collectionSlug: string;
}

export interface ConfluenceClientDeps {
  /** Injected fetch for tests; defaults to the guarded global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** Per-request timeout (bounds the whole redirect chain). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Page-list page size. */
const PAGE_LIMIT = 100;
/**
 * Hard anti-runaway bound on pagination — NOT the ingest cap (the engine owns
 * that, and surfaces the real over-limit numbers). A space larger than this is
 * pathological; we fail loud rather than loop unbounded on a broken `next`.
 */
const MAX_PAGES = 100_000;

// ---------------------------------------------------------------------------
// Raw v2 response shapes (only the fields we read)
// ---------------------------------------------------------------------------

// Every field is optional: this is untrusted vendor JSON, so `id`/`title`/
// `version.createdAt` are narrowed at the use sites (`normalizePage`,
// `ensureSpaceId`) rather than asserted here.
interface V2Version {
  readonly createdAt?: string;
}
interface V2Links {
  readonly webui?: string;
  readonly base?: string;
  readonly next?: string;
}
interface V2Page {
  readonly id?: string;
  readonly title?: string;
  readonly parentId?: string | null;
  readonly version?: V2Version;
  readonly body?: { readonly storage?: { readonly value?: string } };
  readonly _links?: V2Links;
}
interface V2PageList {
  readonly results?: readonly V2Page[];
  readonly _links?: V2Links;
}
interface V2Space {
  readonly id?: string;
}
interface V2SpaceList {
  readonly results?: readonly V2Space[];
}

/** One enumerated page, normalized. `storageBody` is present only when fetched. */
interface EnumeratedPage extends ConfluencePageNode {
  readonly modifiedAt: string;
  readonly webui: string;
  readonly storageBody: string | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Build a Confluence vendor client. `createClient` (the connector factory) has
 * already decrypted the token and validated config, so this constructor does no
 * I/O — the first fetch resolves the space id lazily.
 */
export function createConfluenceVendorClient(
  config: ConfluenceClientConfig,
  deps: ConfluenceClientDeps = {},
): ConnectorVendorClient {
  const api = new ConfluenceApi(config, deps);

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
 * Verify the connection at INSTALL time — resolve the space by key with the
 * supplied credentials. Cheap (one request) and loud: a bad token surfaces as a
 * 401 error, an invalid/invisible space key as a not-found error, a private
 * base URL as an `EgressBlockedError`. The install handler maps each to a
 * field-level 400 so "invalid credentials fail the install loudly."
 */
export async function verifyConfluenceAccess(
  config: ConfluenceClientConfig,
  deps: ConfluenceClientDeps = {},
): Promise<void> {
  await new ConfluenceApi(config, deps).verifyAccess();
}

class ConfluenceApi {
  private readonly base: string;
  private readonly authHeader: string;
  private spaceId: string | null = null;
  private siteBase: string;

  constructor(
    private readonly config: ConfluenceClientConfig,
    private readonly deps: ConfluenceClientDeps,
  ) {
    this.base = config.baseUrl.replace(/\/+$/, "");
    this.siteBase = this.base;
    // Basic auth header: base64("email:token"). Buffer.from handles any UTF-8 in
    // the email (unlike btoa, which throws on non-ASCII).
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
  }

  /**
   * Enumerate + assemble. When `since` is null this is a reconciliation crawl
   * (bodies fetched in the enumeration pass, all pages assembled); otherwise an
   * incremental cycle (metadata-only enumeration, bodies fetched for the changed
   * subset only).
   */
  async fetch(opts: { since: string | null }): Promise<ConnectorChanges> {
    const reconciliation = opts.since === null;
    const enumerated = await this.enumeratePages({ withBody: reconciliation });

    const byId = new Map<string, ConfluencePageNode>();
    let highWaterMark: string | null = null;
    for (const p of enumerated) {
      byId.set(p.id, { id: p.id, title: p.title, parentId: p.parentId });
      if (highWaterMark === null || p.modifiedAt > highWaterMark) highWaterMark = p.modifiedAt;
    }

    const selected = reconciliation
      ? enumerated
      : enumerated.filter((p) => opts.since === null || p.modifiedAt >= opts.since);

    const pages: ConfluencePage[] = [];
    for (const p of selected) {
      const storageBody = p.storageBody ?? (await this.fetchPageBody(p.id));
      pages.push({
        id: p.id,
        title: p.title,
        parentId: p.parentId,
        storageBody,
        modifiedAt: p.modifiedAt,
        url: this.pageUrl(p.webui),
      });
    }

    const assembled = assembleConfluenceDocuments(pages, byId, {
      collectionSlug: this.config.collectionSlug,
    });
    if (
      assembled.degradations.length > 0 ||
      assembled.skippedContentless > 0 ||
      assembled.collisionsRenamed > 0
    ) {
      log.info(
        {
          host: hostForLog(this.base),
          space: this.config.spaceKey,
          mode: reconciliation ? "reconciliation" : "incremental",
          degradations: assembled.degradations,
          skippedContentless: assembled.skippedContentless,
          collisionsRenamed: assembled.collisionsRenamed,
        },
        "Confluence conversion completed with degradations/skips",
      );
    }

    return { documents: assembled.documents, highWaterMark, cursor: null };
  }

  /** Install-time reachability + credential check (resolves the space by key). */
  async verifyAccess(): Promise<void> {
    await this.ensureSpaceId();
  }

  /** Lazily resolve + cache the space id from the space key. */
  private async ensureSpaceId(): Promise<string> {
    if (this.spaceId !== null) return this.spaceId;
    const url = `${this.base}/api/v2/spaces?keys=${encodeURIComponent(this.config.spaceKey)}&limit=1`;
    const body = await this.getJson<V2SpaceList>(url);
    const space = body.results?.[0];
    if (!space) {
      throw new Error(
        `Confluence space "${this.config.spaceKey}" was not found or is not visible to this token on ${hostForLog(this.base)} — check the space key and the token's permissions.`,
      );
    }
    // Fail loud rather than propagate `undefined`/garbage into the pages URL if
    // the vendor response is malformed (untrusted JSON — `id` is optional here).
    if (typeof space.id !== "string" || space.id === "") {
      throw new Error(
        `Confluence returned a space for "${this.config.spaceKey}" with no id from ${hostForLog(this.base)} — unexpected vendor response.`,
      );
    }
    this.spaceId = space.id;
    return space.id;
  }

  /** Paginate the space's pages; include storage bodies when `withBody`. */
  private async enumeratePages(opts: { withBody: boolean }): Promise<EnumeratedPage[]> {
    const spaceId = await this.ensureSpaceId();
    const params = new URLSearchParams({ status: "current", limit: String(PAGE_LIMIT) });
    if (opts.withBody) params.set("body-format", "storage");
    let nextUrl: string | null = `${this.base}/api/v2/spaces/${encodeURIComponent(spaceId)}/pages?${params}`;

    const pages: EnumeratedPage[] = [];
    let skippedMalformed = 0;
    while (nextUrl !== null) {
      // Annotate `body` explicitly: `nextUrl` is reassigned below from a value
      // derived from `body`, which is fetched with `nextUrl` — an inference cycle
      // TS otherwise gives up on (TS7022). The annotation breaks it.
      const body: V2PageList = await this.getJson<V2PageList>(nextUrl);
      if (body._links?.base) this.siteBase = body._links.base.replace(/\/+$/, "");
      for (const raw of body.results ?? []) {
        const normalized = this.normalizePage(raw, opts.withBody);
        if (normalized !== null) pages.push(normalized);
        else skippedMalformed++;
      }
      if (pages.length > MAX_PAGES) {
        throw new Error(
          `Confluence space "${this.config.spaceKey}" exceeds ${MAX_PAGES} pages — narrow the connector's scope. (This is a safety bound, not the ingest cap ATLAS_KNOWLEDGE_INGEST_MAX_DOCS.)`,
        );
      }
      const rel: string | undefined = body._links?.next;
      nextUrl = rel ? new URL(rel, this.base).toString() : null;
    }
    if (skippedMalformed > 0) {
      // Never a silent drop: a page missing id/title/version isn't ingested, and
      // if it was an ancestor its descendants' paths shorten — surface it loudly
      // so an operator can see the hole rather than infer it from a smaller tree.
      log.warn(
        { host: hostForLog(this.base), space: this.config.spaceKey, skippedMalformed },
        "Skipped Confluence pages missing id/title/version — not ingested (unexpected for current pages)",
      );
    }
    return pages;
  }

  /** Fetch one page's storage body (incremental path — changed pages only). */
  private async fetchPageBody(pageId: string): Promise<string> {
    const url = `${this.base}/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`;
    const body = await this.getJson<V2Page>(url);
    return body.body?.storage?.value ?? "";
  }

  private normalizePage(raw: V2Page, withBody: boolean): EnumeratedPage | null {
    // A page with no id/title/version is unusable — skip defensively rather than
    // emit a malformed document (v2 always populates these for a current page).
    const modifiedAt = raw.version?.createdAt;
    if (!raw.id || !raw.title || !modifiedAt) return null;
    return {
      id: raw.id,
      title: raw.title,
      parentId: raw.parentId ?? null,
      modifiedAt,
      webui: raw._links?.webui ?? "",
      storageBody: withBody ? raw.body?.storage?.value ?? "" : null,
    };
  }

  /**
   * Absolute page URL from a `_links.webui`. Confluence's `webui` is an absolute
   * PATH (`/spaces/…`) whose canonical URL is `_links.base` + `webui` (the site
   * base already includes the `/wiki` context path) — so this concatenates
   * rather than URL-resolves, which would drop `/wiki`.
   */
  private pageUrl(webui: string): string {
    if (webui === "") return this.base;
    if (/^https?:\/\//i.test(webui)) return webui;
    return `${this.siteBase}${webui.startsWith("/") ? "" : "/"}${webui}`;
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
        `Confluence request to ${hostForLog(this.base)} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.status === 429) {
      throw new ConnectorRateLimitError(
        `Confluence rate-limited the request to ${hostForLog(this.base)}.`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Confluence rejected the credentials (${response.status}) for ${hostForLog(this.base)} — re-enter the email + API token and confirm the token can read the space.`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Confluence returned HTTP ${response.status} from ${hostForLog(this.base)}.`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(
        `Confluence returned a non-JSON response from ${hostForLog(this.base)}: ${err instanceof Error ? err.message : String(err)}`,
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
