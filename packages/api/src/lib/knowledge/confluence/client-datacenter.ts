/**
 * The Confluence Data Center / Server vendor client (#4394, PRD #4375) — a
 * {@link ConnectorVendorClient} over the Confluence REST **v1** API with a
 * Personal Access Token (Bearer auth), driven by the shared connector engine
 * (`connector-sync.ts`). It is the self-managed sibling of the Cloud client
 * (`client.ts`): it swaps ONLY the client layer (v1 REST paths, Bearer PAT) and
 * reuses the exact same converter + assembly (`documents.ts` →
 * `storage-to-markdown.ts`), so identical storage XHTML produces identical
 * markdown across Cloud and DC.
 *
 * Two cadences the engine decides, both served from one enumeration shape (the
 * same design as Cloud):
 *   - `fetchChanges({ since })` (incremental) — enumerate the space's page
 *     METADATA (id/title/ancestors/version — cheap, no bodies), keep those
 *     modified at-or-after `since`, and fetch the storage body only for those.
 *     The full metadata pass keeps hierarchy paths deterministic across modes
 *     (ancestors always resolve) while keeping body bandwidth to the changed set.
 *   - `fetchAll()` (reconciliation) — enumerate every current page WITH its
 *     storage body in one paginated pass and assemble all. The engine archives
 *     paths absent from this set, so a restricted/deleted page is treated as
 *     absent, never an error.
 *
 * v1 vs Cloud v2, the only differences this file owns:
 *   - Auth is `Authorization: Bearer <PAT>` (a Server/DC Personal Access Token),
 *     not Basic `email:token`.
 *   - Enumeration is `/rest/api/content?spaceKey=…&type=page` with
 *     `expand=version,ancestors[,body.storage]`; a single body is
 *     `/rest/api/content/{id}?expand=body.storage`; the space is resolved via
 *     `/rest/api/space?spaceKey=…`.
 *   - The parent id comes from v1's inline `ancestors` array (immediate parent =
 *     last ancestor), and the modification time is `version.when`.
 *
 * Security + hygiene mirror Cloud exactly: every request goes through
 * `guardedFetch` (customer base URL → SSRF egress guard; auth stripped on
 * cross-origin redirect). A 429 is the ONLY signal that becomes the engine's
 * backoff (thrown as {@link ConnectorRateLimitError}); every other failure is an
 * actionable error with the host redacted via `hostForLog` — the PAT lives in
 * the `Authorization` header, never a URL or a message.
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
import {
  assembleConfluenceDocuments,
  type ConfluencePage,
  type ConfluencePageNode,
} from "./documents";
// The Retry-After parser is auth/version-agnostic — share the Cloud one rather
// than duplicate the delta-seconds discipline.
import { parseRetryAfter } from "./client";

const log = createLogger("knowledge.confluence.datacenter.client");

/** Resolved, non-secret connection inputs plus the PAT. */
export interface ConfluenceDcClientConfig {
  /** Server/DC base, e.g. `https://confluence.acme.com` (no trailing slash). */
  readonly baseUrl: string;
  /** A Confluence Server/DC Personal Access Token (Bearer auth). */
  readonly apiToken: string;
  readonly spaceKey: string;
  /** The KB collection slug = `workspace_plugins.install_id` — the path prefix. */
  readonly collectionSlug: string;
}

export interface ConfluenceDcClientDeps {
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
// Raw v1 response shapes (only the fields we read)
// ---------------------------------------------------------------------------

// Every field is optional: this is untrusted vendor JSON, so `id`/`title`/
// `version.when` are narrowed at the use site (`normalizePage`) rather than
// asserted here.
interface V1Version {
  readonly when?: string;
}
interface V1Ancestor {
  readonly id?: string;
  readonly title?: string;
}
interface V1Links {
  readonly webui?: string;
  readonly base?: string;
  readonly next?: string;
}
interface V1Content {
  readonly id?: string;
  readonly title?: string;
  readonly ancestors?: readonly V1Ancestor[];
  readonly version?: V1Version;
  readonly body?: { readonly storage?: { readonly value?: string } };
  readonly _links?: V1Links;
}
interface V1ContentList {
  readonly results?: readonly V1Content[];
  readonly _links?: V1Links;
}
interface V1Space {
  readonly key?: string;
}
interface V1SpaceList {
  readonly results?: readonly V1Space[];
}

/** One enumerated page, normalized. `storageBody` is present only when fetched. */
interface EnumeratedPage extends ConfluencePageNode {
  /** Canonical ISO instant (`toIsoInstant`) — never the raw vendor string. */
  readonly modifiedAt: string;
  readonly webui: string;
  readonly storageBody: string | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Build a Confluence Data Center vendor client. `createClient` (the connector
 * factory) has already decrypted the token and validated config, so this
 * constructor does no I/O — the first fetch verifies the space lazily.
 */
export function createConfluenceDatacenterVendorClient(
  config: ConfluenceDcClientConfig,
  deps: ConfluenceDcClientDeps = {},
): ConnectorVendorClient {
  const api = new ConfluenceDcApi(config, deps);

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
 * supplied PAT. Cheap (one request) and loud: a bad token surfaces as a 401
 * error, an invalid/invisible space key as a not-found error, a private base URL
 * as an `EgressBlockedError`. The install handler maps each to a field-level 400
 * so "invalid credentials fail the install loudly."
 */
export async function verifyConfluenceDatacenterAccess(
  config: ConfluenceDcClientConfig,
  deps: ConfluenceDcClientDeps = {},
): Promise<void> {
  await new ConfluenceDcApi(config, deps).verifyAccess();
}

class ConfluenceDcApi {
  private readonly base: string;
  private readonly authHeader: string;
  private spaceVerified = false;
  private siteBase: string;

  constructor(
    private readonly config: ConfluenceDcClientConfig,
    private readonly deps: ConfluenceDcClientDeps,
  ) {
    this.base = config.baseUrl.replace(/\/+$/, "");
    this.siteBase = this.base;
    // Server/DC Personal Access Token → Bearer auth (introduced in Confluence
    // 7.9). Unlike Cloud, no email/username is paired with the token.
    this.authHeader = `Bearer ${config.apiToken}`;
  }

  /**
   * Enumerate + assemble. When `since` is null this is a reconciliation crawl
   * (bodies fetched in the enumeration pass, all pages assembled); otherwise an
   * incremental cycle (metadata-only enumeration, bodies fetched for the changed
   * subset only).
   */
  async fetch(opts: { since: string | null }): Promise<ConnectorChanges> {
    const reconciliation = opts.since === null;
    // Resolve the space FIRST: an invisible/renamed space must fail loudly, not
    // enumerate zero pages — a reconciliation off an empty crawl would archive
    // the whole collection.
    await this.ensureSpace();

    const { pages: enumerated, skippedMalformed } = await this.enumeratePages({
      withBody: reconciliation,
    });

    const byId = new Map<string, ConfluencePageNode>();
    let highWaterMark: string | null = null;
    // `modifiedAt` is normalized to an ISO instant at `normalizePage`, and the
    // engine's `since` is a toISOString — string comparisons are chronological.
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
        "Confluence Data Center conversion completed with degradations/skips",
      );
    }

    // A warn-skipped malformed page is a KNOWN hole in the set: its document
    // would otherwise be archived by a reconciliation off this partial crawl.
    // The flag makes the engine upsert-only and hold the reconcile clock.
    return {
      documents: assembled.documents,
      highWaterMark,
      cursor: null,
      coverageIncomplete: skippedMalformed > 0,
    };
  }

  /** Install-time reachability + credential check (resolves the space by key). */
  async verifyAccess(): Promise<void> {
    await this.ensureSpace();
  }

  /**
   * Resolve + confirm the space is visible to the PAT (v1 has no space-id
   * requirement for content enumeration — the key drives the query — so this is
   * purely a visibility/credential probe, cached after the first success).
   */
  private async ensureSpace(): Promise<void> {
    if (this.spaceVerified) return;
    const url = `${this.base}/rest/api/space?spaceKey=${encodeURIComponent(this.config.spaceKey)}&limit=1`;
    const body = await this.getJson<V1SpaceList>(url);
    const space = body.results?.[0];
    if (!space) {
      throw new Error(
        `Confluence space "${this.config.spaceKey}" was not found or is not visible to this token on ${hostForLog(this.base)} — check the space key and the token's permissions.`,
      );
    }
    // Fail loud on a truthy-but-empty element rather than treat a malformed
    // vendor response as a verified space (untrusted JSON — `key` is optional).
    // Mirrors the Cloud client's "unexpected vendor response" guard; DC drives
    // enumeration off the admin-supplied spaceKey, so no garbage reaches a URL,
    // but the fail-loud posture stays consistent across the two clients.
    if (typeof space.key !== "string" || space.key === "") {
      throw new Error(
        `Confluence returned a space for "${this.config.spaceKey}" with no key from ${hostForLog(this.base)} — unexpected vendor response.`,
      );
    }
    this.spaceVerified = true;
  }

  /** Paginate the space's pages; include storage bodies when `withBody`. */
  private async enumeratePages(opts: {
    withBody: boolean;
  }): Promise<{ pages: EnumeratedPage[]; skippedMalformed: number }> {
    const expand = opts.withBody ? "version,ancestors,body.storage" : "version,ancestors";
    const params = new URLSearchParams({
      spaceKey: this.config.spaceKey,
      type: "page",
      status: "current",
      start: "0",
      limit: String(PAGE_LIMIT),
      expand,
    });
    let nextUrl: string | null = `${this.base}/rest/api/content?${params}`;

    const pages: EnumeratedPage[] = [];
    let skippedMalformed = 0;
    while (nextUrl !== null) {
      // Annotate `body` explicitly: `nextUrl` is reassigned below from a value
      // derived from `body`, which is fetched with `nextUrl` — an inference cycle
      // TS otherwise gives up on (TS7022). The annotation breaks it.
      const body: V1ContentList = await this.getJson<V1ContentList>(nextUrl);
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
      // The count also flags the fetch's coverage as incomplete (see `fetch`).
      log.warn(
        { host: hostForLog(this.base), space: this.config.spaceKey, skippedMalformed },
        "Skipped Confluence pages missing id/title/version — not ingested (unexpected for current pages)",
      );
    }
    return { pages, skippedMalformed };
  }

  /** Fetch one page's storage body (incremental path — changed pages only). */
  private async fetchPageBody(pageId: string): Promise<string> {
    const url = `${this.base}/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage`;
    const body = await this.getJson<V1Content>(url);
    return body.body?.storage?.value ?? "";
  }

  private normalizePage(raw: V1Content, withBody: boolean): EnumeratedPage | null {
    // A page with no id/title/version is unusable — skip defensively rather than
    // emit a malformed document (v1 always populates these for a current page).
    // The timestamp is normalized to a canonical ISO instant so an offset-format
    // `when` can't compare wrong in the since-filter / high-water reduce; an
    // unparseable one counts as malformed (same skip, same coverage flag).
    const modifiedAt = toIsoInstant(raw.version?.when);
    if (!raw.id || !raw.title || modifiedAt === null) return null;
    // v1 returns the full ancestor chain inline (root → immediate parent); the
    // immediate parent is the last element. `documents.ts` walks parentId across
    // the full byId map to rebuild the path, exactly as the Cloud client does.
    const ancestors = raw.ancestors ?? [];
    const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined;
    const parentId = typeof parent?.id === "string" && parent.id !== "" ? parent.id : null;
    return {
      id: raw.id,
      title: raw.title,
      parentId,
      modifiedAt,
      webui: raw._links?.webui ?? "",
      storageBody: withBody ? raw.body?.storage?.value ?? "" : null,
    };
  }

  /**
   * Absolute page URL from a `_links.webui`. Confluence's `webui` is an absolute
   * PATH (`/display/…` or `/spaces/…`) whose canonical URL is `_links.base` +
   * `webui` (the site base already includes any context path) — so this
   * concatenates rather than URL-resolves, which would drop the context path.
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
        `Confluence rejected the credentials (${response.status}) for ${hostForLog(this.base)} — re-enter the Personal Access Token and confirm it can read the space.`,
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
