/**
 * The Notion REST seam for the Knowledge Sync Connector (#4378, PRD #4375,
 * ADR-0030). One thin client owns every cross-cutting concern the connector's
 * enumeration + content fetch must not re-remember per call:
 *
 *   1. AUTH + VERSION HEADERS — a `Bearer` internal-integration token and a
 *      DELIBERATELY PINNED `Notion-Version`. The 2025-09-03 release split
 *      databases into data sources and bifurcated older code paths; the page
 *      markdown endpoint (Feb 2026) requires `2026-03-11`, which post-dates the
 *      split — so pinning one version keeps search, block descent, and the
 *      markdown endpoint on the same side of the fork. The value is recorded in
 *      {@link NOTION_API_VERSION} and asserted by the client's tests (AC:
 *      "`Notion-Version` header pinned and recorded").
 *   2. THROTTLE — Notion documents ~3 requests/second per token. A connector
 *      that enumerates a large workspace makes many sub-requests, so the client
 *      spaces request STARTS by {@link NOTION_MIN_REQUEST_INTERVAL_MS}; the
 *      engine's own 429 backoff is the safety net, not the primary limiter.
 *   3. 429 → {@link ConnectorRateLimitError} — the ONE exception the engine's
 *      bounded backoff retries. A 429 carries Notion's `Retry-After` (integer
 *      seconds); every other non-2xx is a plain, actionable error.
 *   4. REDACTION — errors never carry the token. Notion's own error envelope
 *      (`{ code, message }`) is safe to surface (it names the misconfig, e.g.
 *      `unauthorized`, `restricted_resource`) and is; the `Authorization`
 *      header never is. The base host is a fixed Notion constant, not a
 *      customer-supplied URL, so there is no SSRF surface here (unlike
 *      bundle-sync's endpoint) — plain `fetch`, no egress guard.
 *
 * `fetch`, the clock, and the sleep are all injected so the vendor client is
 * fully test-doubled: no test reaches the network (AC: "no test calls Notion").
 */

import { ConnectorRateLimitError } from "../connectors";

/**
 * The pinned Notion API version. `2026-03-11` is the first version carrying the
 * page-markdown endpoint; it post-dates the 2025-09-03 data-source split, so
 * search (`filter.value: "data_source"`), block descent, and the markdown
 * endpoint all speak the same dialect under it. Bump deliberately — a version
 * change can reshape search filters and the database/data-source model.
 */
export const NOTION_API_VERSION = "2026-03-11";

/** The Notion REST base — a fixed vendor host, never customer-supplied. */
export const NOTION_API_BASE = "https://api.notion.com/v1";

/**
 * Minimum spacing between request starts: Notion allows ~3 req/s per token, so
 * one request every ~334 ms keeps a full-workspace crawl under the average
 * without leaning on the engine's 429 backoff for routine pacing.
 */
export const NOTION_MIN_REQUEST_INTERVAL_MS = Math.ceil(1000 / 3);

/** Cap a pathological `Retry-After` echoed into the error (the engine also caps its wait). */
const RETRY_AFTER_MAX_SECONDS = 3600;

type FetchImpl = typeof globalThis.fetch;
type Now = () => number;
type Sleep = (ms: number) => Promise<void>;

export interface NotionHttpClientOptions {
  /** The workspace's internal-integration token (decrypted). Never logged. */
  readonly token: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchImpl?: FetchImpl;
  /** Injected clock (ms) for the throttle; defaults to `Date.now`. Only the
   *  elapsed-since-last-request delta is used, so a wall clock is fine. */
  readonly now?: Now;
  /** Injected sleep for the throttle; defaults to a real timer. */
  readonly sleep?: Sleep;
}

/** A Notion error envelope — safe to surface (names the misconfig, no secrets). */
interface NotionErrorBody {
  readonly object?: string;
  readonly status?: number;
  readonly code?: string;
  readonly message?: string;
}

/**
 * A minimal Notion REST client: throttled, version-pinned, 429-aware, and
 * token-redacting. `get`/`post` return the parsed JSON as `unknown` — the
 * enumeration/content layers narrow it at their read sites (the one place that
 * knows the shape it asked for).
 */
export class NotionHttpClient {
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;
  private readonly now: Now;
  private readonly sleep: Sleep;
  /** Start time (ms) of the most recent request — the throttle's only state. */
  private lastRequestStartedAt: number | null = null;

  constructor(options: NotionHttpClientOptions) {
    if (options.token.trim() === "") {
      // A blank token would 401 on the first call with a confusing "unauthorized"
      // — fail here with the actionable cause instead.
      throw new Error("NotionHttpClient requires a non-empty integration token");
    }
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** GET a Notion resource path (relative to {@link NOTION_API_BASE}). */
  async get(path: string): Promise<unknown> {
    return this.request("GET", path, undefined);
  }

  /** POST a JSON body to a Notion resource path. */
  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", path, body);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    await this.throttle();
    const url = `${NOTION_API_BASE}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_API_VERSION,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // Network / DNS / abort — a transport failure, not a vendor rejection.
      // The path (not the token) is safe context; `cause` preserves the original.
      throw new Error(
        `Notion API ${method} ${path} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (res.status === 429) {
      throw new ConnectorRateLimitError(
        "Notion is rate limiting this integration token (HTTP 429).",
        parseRetryAfter(res.headers.get("Retry-After")),
      );
    }

    if (!res.ok) {
      const detail = await this.readErrorDetail(res);
      throw new Error(`Notion API ${method} ${path} failed (HTTP ${res.status})${detail}`);
    }

    try {
      return (await res.json()) as unknown;
    } catch (err) {
      throw new Error(
        `Notion API ${method} ${path} returned a non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /**
   * Space request starts by {@link NOTION_MIN_REQUEST_INTERVAL_MS}. Records the
   * start time AFTER sleeping so back-to-back calls stay one interval apart even
   * under the injected clock (which tests advance deterministically).
   */
  private async throttle(): Promise<void> {
    const last = this.lastRequestStartedAt;
    if (last !== null) {
      const elapsed = this.now() - last;
      const wait = NOTION_MIN_REQUEST_INTERVAL_MS - elapsed;
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestStartedAt = this.now();
  }

  /** Read Notion's error envelope for an actionable, secret-free suffix. */
  private async readErrorDetail(res: Response): Promise<string> {
    try {
      // `res.json()` is `any` and a vendor error body could be a primitive /
      // array / null — narrow to an object before reading fields.
      const parsed: unknown = await res.json();
      const body: NotionErrorBody =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as NotionErrorBody)
          : {};
      const code = typeof body.code === "string" ? body.code : null;
      const message = typeof body.message === "string" ? body.message : null;
      if (code && message) return `: ${code} — ${message}`;
      if (code) return `: ${code}`;
      if (message) return `: ${message}`;
      return "";
    } catch {
      // intentionally ignored: a non-JSON error body (proxy HTML, empty) carries
      // no safe detail worth surfacing — the status code above is the signal.
      return "";
    }
  }
}

/**
 * Parse a `Retry-After` header (integer seconds per Notion's docs) into a
 * bounded number, or null when absent, unparseable, zero, or negative (the
 * engine then picks its default wait). Only a positive hour-plus value clamps
 * (to {@link RETRY_AFTER_MAX_SECONDS}) rather than wedging the sync.
 */
function parseRetryAfter(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, RETRY_AFTER_MAX_SECONDS);
}
