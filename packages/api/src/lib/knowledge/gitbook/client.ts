/**
 * The GitBook Cloud vendor client (#4393, ADR-0030) — a
 * {@link ConnectorVendorClient} over the GitBook REST API, driven by the shared
 * connector engine (`connector-sync.ts`). It owns ONLY enumerate + fetch +
 * convert; scheduling, high-water marks, reconciliation cadence, 429 backoff,
 * and caps are the engine's.
 *
 * Two cadences the engine decides, both served from one enumeration shape:
 *   - `fetchChanges({ since })` (incremental) — enumerate the space's page tree
 *     METADATA (id/title/path/updatedAt — cheap, no bodies), keep those modified
 *     at-or-after `since`, and fetch the markdown body only for those.
 *   - `fetchAll()` (reconciliation) — enumerate every current page and fetch all
 *     of their bodies. The engine archives paths absent from this set, so a
 *     deleted/unpublished page (never returned by the content tree) is treated
 *     as absent, never an error.
 *
 * GitBook gives each page its full slug `path`, so hierarchy is deterministic
 * across modes without an ancestor walk. Security + hygiene: every request goes
 * through `guardedFetch` (the SSRF egress guard; auth stripped on cross-origin
 * redirect) even though the host is a fixed GitBook constant. A 429 is the ONLY
 * signal that becomes the engine's backoff (thrown as
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
import { GITBOOK_API_BASE } from "./config";
import { assembleGitbookDocuments, type GitbookPage } from "./documents";

const log = createLogger("knowledge.gitbook.client");

/** Resolved, non-secret connection inputs plus the token. */
export interface GitbookClientConfig {
  /** The GitBook space id this collection mirrors. */
  readonly spaceId: string;
  readonly apiToken: string;
  /** The KB collection slug = `workspace_plugins.install_id` — the path prefix. */
  readonly collectionSlug: string;
}

export interface GitbookClientDeps {
  /** Injected fetch for tests; defaults to the guarded global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Test-only override of the ingest doc cap (defaults to the settings value). */
  readonly maxDocs?: number;
}

/** Per-request timeout (bounds the whole redirect chain). */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Hard anti-runaway bound on tree recursion depth — NOT a content limit. A
 * GitBook space nested deeper than this is pathological; the descent stops and
 * flags coverage incomplete rather than looping unbounded on a cyclic tree.
 */
const MAX_TREE_DEPTH = 100;

// ---------------------------------------------------------------------------
// Raw response shapes (only the fields we read; every field optional — this is
// untrusted vendor JSON, narrowed at the use sites)
// ---------------------------------------------------------------------------

interface RawUrls {
  readonly app?: string;
}
interface RawRevisionPage {
  readonly id?: string;
  readonly title?: string;
  readonly path?: string;
  readonly slug?: string;
  readonly kind?: string;
  readonly type?: string;
  readonly updatedAt?: string;
  readonly urls?: RawUrls;
  readonly pages?: readonly RawRevisionPage[];
}
interface RawContent {
  readonly pages?: readonly RawRevisionPage[];
}
interface RawSpace {
  readonly id?: string;
  readonly title?: string;
}
interface RawPageMarkdown {
  readonly markdown?: string;
}

/** One enumerated page's metadata (bodies fetched separately). */
interface EnumeratedPage {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  /** Canonical ISO instant (`toIsoInstant`) — never the raw vendor string. */
  readonly updatedAt: string;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Build a GitBook vendor client. `createClient` (the connector factory) has
 * already decrypted the token and validated config, so this constructor does no
 * I/O.
 */
export function createGitbookVendorClient(
  config: GitbookClientConfig,
  deps: GitbookClientDeps = {},
): ConnectorVendorClient {
  const api = new GitbookApi(config, deps);
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
 * Verify the connection at INSTALL time — resolve the space by id with the
 * supplied credentials. Cheap (one request) and loud: a bad token surfaces as a
 * 401, an invalid/invisible space id as a not-found error. The install handler
 * maps each to a field-level 400 so "invalid credentials fail the install
 * loudly."
 */
export async function verifyGitbookAccess(
  config: GitbookClientConfig,
  deps: GitbookClientDeps = {},
): Promise<void> {
  await new GitbookApi(config, deps).verifyAccess();
}

class GitbookApi {
  private readonly authHeader: string;
  private readonly maxDocs: number;

  constructor(
    private readonly config: GitbookClientConfig,
    private readonly deps: GitbookClientDeps,
  ) {
    this.authHeader = `Bearer ${config.apiToken}`;
    this.maxDocs = deps.maxDocs ?? getIngestMaxDocs();
  }

  /** Install-time reachability + credential check (resolves the space by id). */
  async verifyAccess(): Promise<void> {
    const space = await this.getJson<RawSpace>(
      `${GITBOOK_API_BASE}/v1/spaces/${encodeURIComponent(this.config.spaceId)}`,
    );
    if (typeof space.id !== "string" || space.id === "") {
      throw new Error(
        `GitBook space "${this.config.spaceId}" was not found or is not visible to this token — check the space id and the token's permissions.`,
      );
    }
  }

  /**
   * Enumerate the page tree + assemble. When `since` is null this is a
   * reconciliation crawl (every page fetched + assembled); otherwise an
   * incremental cycle (bodies fetched only for pages modified at-or-after
   * `since`).
   */
  async fetch(opts: { since: string | null }): Promise<ConnectorChanges> {
    const reconciliation = opts.since === null;
    const { pages: enumerated, skippedMalformed } = await this.enumeratePages();

    let highWaterMark: string | null = null;
    for (const p of enumerated) {
      if (highWaterMark === null || p.updatedAt > highWaterMark) highWaterMark = p.updatedAt;
    }

    // `updatedAt` is a normalized ISO instant, and the engine's `since` is a
    // toISOString — string comparisons are chronological.
    const selected = reconciliation
      ? enumerated
      : enumerated.filter((p) => opts.since === null || p.updatedAt >= opts.since);

    // Reject an over-cap FULL set BEFORE fetching bodies (the engine's ingest
    // cap is the backstop, but checking here saves N markdown fetches and puts
    // real numbers in the error — the AC's "caps validated over the full set").
    if (reconciliation && enumerated.length > this.maxDocs) {
      throw new Error(
        `This GitBook space has ${enumerated.length} pages, over the ${this.maxDocs}-document limit (ATLAS_KNOWLEDGE_INGEST_MAX_DOCS) — narrow the space's scope, or raise the cap.`,
      );
    }

    const pages: GitbookPage[] = [];
    for (const p of selected) {
      const markdown = await this.fetchPageMarkdown(p.id);
      pages.push({
        id: p.id,
        title: p.title,
        path: p.path,
        markdown,
        updatedAt: p.updatedAt,
        url: p.url,
      });
    }

    const assembled = assembleGitbookDocuments(pages, {
      collectionSlug: this.config.collectionSlug,
    });
    if (
      assembled.degradations.length > 0 ||
      assembled.skippedContentless > 0 ||
      assembled.collisionsRenamed > 0
    ) {
      log.info(
        {
          space: this.config.spaceId,
          mode: reconciliation ? "reconciliation" : "incremental",
          degradations: assembled.degradations,
          skippedContentless: assembled.skippedContentless,
          collisionsRenamed: assembled.collisionsRenamed,
        },
        "GitBook conversion completed with degradations/skips",
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

  /** Fetch + walk the space content tree into a flat list of document pages. */
  private async enumeratePages(): Promise<{ pages: EnumeratedPage[]; skippedMalformed: number }> {
    const content = await this.getJson<RawContent>(
      `${GITBOOK_API_BASE}/v1/spaces/${encodeURIComponent(this.config.spaceId)}/content`,
    );
    const pages: EnumeratedPage[] = [];
    let skippedMalformed = 0;
    const seen = new Set<string>();

    const walk = (nodes: readonly RawRevisionPage[], depth: number): void => {
      if (depth > MAX_TREE_DEPTH) {
        // A too-deep (or cyclic) tree: stop descending and flag coverage so the
        // engine won't archive the pages we never reached.
        skippedMalformed++;
        log.warn(
          { space: this.config.spaceId, depth },
          "GitBook page tree exceeded the max depth — descent stopped; subtractive archiving is skipped this cycle",
        );
        return;
      }
      for (const raw of nodes) {
        const normalized = this.normalizePage(raw);
        if (normalized === null) {
          // A group/link node carries no document; recurse into its children but
          // don't emit or count it. A malformed DOCUMENT node is counted below.
          if (isDocumentNode(raw)) skippedMalformed++;
        } else if (!seen.has(normalized.id)) {
          seen.add(normalized.id);
          pages.push(normalized);
        }
        if (raw.pages && raw.pages.length > 0) walk(raw.pages, depth + 1);
      }
    };
    walk(content.pages ?? [], 0);

    if (skippedMalformed > 0) {
      log.warn(
        { space: this.config.spaceId, skippedMalformed },
        "Skipped GitBook pages missing id/title/path/updatedAt — not ingested (coverage flagged incomplete)",
      );
    }
    return { pages, skippedMalformed };
  }

  /**
   * Fetch one page's markdown body (`?format=markdown`). A genuinely empty page
   * returns `{ markdown: "" }` (a present string) and legitimately assembles to
   * a contentless skip; an ABSENT/non-string `markdown` field is an anomalous
   * vendor response, and coercing it to `""` here would look identical to an
   * empty page — a silent contentless-skip that (unlike a malformed enumeration
   * node) never flags `coverageIncomplete`, so a reconciliation would archive a
   * live page. Throw instead: the fetch aborts, the engine records the
   * collection's error, and nothing is archived (prefer errors over silent
   * fallbacks). GitBook fetches each body in a SEPARATE request (Confluence gets
   * it inline), so this per-page failure surface is real.
   */
  private async fetchPageMarkdown(pageId: string): Promise<string> {
    const url = `${GITBOOK_API_BASE}/v1/spaces/${encodeURIComponent(this.config.spaceId)}/content/page/${encodeURIComponent(pageId)}?format=markdown`;
    const body = await this.getJson<RawPageMarkdown>(url);
    if (typeof body.markdown !== "string") {
      throw new Error(
        `GitBook returned a page body with no markdown field from ${hostForLog(GITBOOK_API_BASE)} (page ${pageId}) — unexpected vendor response.`,
      );
    }
    return body.markdown;
  }

  /**
   * Normalize a tree node into an {@link EnumeratedPage}, or null when it is not
   * an ingestable document (a group/link) or is a malformed document (missing
   * id/title/path/updatedAt — the caller counts the malformed case). The
   * timestamp is normalized to a canonical ISO instant so an offset-format
   * `updatedAt` can't compare wrong in the since-filter / high-water reduce.
   */
  private normalizePage(raw: RawRevisionPage): EnumeratedPage | null {
    if (!isDocumentNode(raw)) return null;
    const updatedAt = toIsoInstant(raw.updatedAt);
    const path = typeof raw.path === "string" ? raw.path.trim() : "";
    if (!raw.id || !raw.title || path === "" || updatedAt === null) return null;
    return {
      id: raw.id,
      title: raw.title,
      path,
      updatedAt,
      url: this.pageUrl(raw),
    };
  }

  /** Absolute page URL from `urls.app`, or a canonical fallback from the id. */
  private pageUrl(raw: RawRevisionPage): string {
    const app = raw.urls?.app;
    if (typeof app === "string" && /^https?:\/\//i.test(app)) return app;
    return `${GITBOOK_API_BASE}/v1/spaces/${encodeURIComponent(this.config.spaceId)}/content/page/${encodeURIComponent(raw.id ?? "")}`;
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
        `GitBook request to ${hostForLog(GITBOOK_API_BASE)} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.status === 429) {
      throw new ConnectorRateLimitError(
        `GitBook rate-limited the request to ${hostForLog(GITBOOK_API_BASE)}.`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `GitBook rejected the credentials (${response.status}) for ${hostForLog(GITBOOK_API_BASE)} — re-enter the API token and confirm it can read the space.`,
      );
    }
    if (response.status === 404) {
      throw new Error(
        `GitBook returned 404 for a request to ${hostForLog(GITBOOK_API_BASE)} — the space id may be wrong or the token can't see it.`,
      );
    }
    if (!response.ok) {
      throw new Error(`GitBook returned HTTP ${response.status} from ${hostForLog(GITBOOK_API_BASE)}.`);
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(
        `GitBook returned a non-JSON response from ${hostForLog(GITBOOK_API_BASE)}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

/**
 * True for a tree node that carries an ingestable document. GitBook marks a
 * content page `type: "document"` (newer API) or `kind: "sheet"` (older); a
 * `group` (container) / `link` (external) node is neither.
 */
function isDocumentNode(raw: RawRevisionPage): boolean {
  return raw.type === "document" || raw.kind === "sheet";
}

/** Parse a `Retry-After` header (delta-seconds only; HTTP-date → null). */
export function parseRetryAfter(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
