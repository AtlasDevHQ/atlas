/**
 * The Knowledge Sync Connector seam (#4376, ADR-0030) — the per-vendor
 * interface + the catalog-id-keyed registry the sync cycle dispatches on.
 *
 * A connector is three parts with a hard division of labor:
 *
 *   1. a VENDOR CLIENT (this interface) — enumerate + fetch changed documents
 *      from the vendor API, behind a per-vendor implementation with test
 *      doubles. It returns COLLECTED DOCUMENTS (relative path + full OKF
 *      markdown content — `@atlas/okf-bundle`'s collect machinery produces
 *      exactly this shape), never raw vendor payloads;
 *   2. a CONVERTER (pure functions inside the vendor package) — vendor format
 *      → markdown. The engine never sees vendor formats;
 *   3. the SHARED ENGINE (`connector-sync.ts` + the `sync.ts` cycle walk) —
 *      scheduling, high-water marks, reconciliation cadence, rate-limit
 *      backoff, caps, and the document-level ingest. Vendors implement NONE
 *      of that: 429 handling, overlap windows, and subtractive archiving are
 *      engine property, not per-vendor discipline.
 *
 * Everything a connector ingests lands `draft` behind the content-mode review
 * gate — structurally: the engine stamps `connector:<vendor>` as the
 * `IngestSource`, and the ingest seam rejects `publish` for every non-upload
 * source (ADR-0028 §4).
 */

/** One vendor document, already converted + collected to OKF markdown. */
export interface ConnectorDocument {
  /**
   * Collection-relative archive path (e.g. `docs/runbooks/oncall.md`).
   * Deterministic per vendor page — the upsert-by-path diff and the
   * reconciliation subtractive archive both key on it. Derive it via
   * `@atlas/okf-bundle`'s path machinery so reserved OKF basenames
   * (`index.md`/`log.md`) are folded/renamed at collect time, never silently
   * skipped at ingest.
   */
  readonly path: string;
  /** Full OKF document (frontmatter + markdown body). */
  readonly content: string;
}

/** One fetch's result — documents plus the bookkeeping to persist on success. */
export interface ConnectorChanges {
  readonly documents: readonly ConnectorDocument[];
  /**
   * The newest vendor change timestamp this fetch covered (ISO-8601), or null
   * when the vendor exposed none. Persisted (on a successful sync) as the
   * collection's high-water mark; the next incremental cycle asks for changes
   * since (mark − overlap window). Return the VENDOR's clock, not the local
   * one — skew between the two is exactly what the overlap window absorbs.
   */
  readonly highWaterMark: string | null;
  /**
   * Opaque vendor continuation token, persisted verbatim (on success) and
   * echoed back on the next fetch — for vendors whose change feeds are
   * cursor-shaped rather than timestamp-shaped. Omit / null when unused.
   */
  readonly cursor?: string | null;
}

/** What the engine hands a client for an incremental fetch. */
export interface ConnectorFetchSince {
  /**
   * Fetch changes at-or-after this ISO-8601 instant — the persisted high-water
   * mark minus the engine's overlap window. `null` on a collection that has
   * never synced successfully (the engine runs those as reconciliation crawls
   * instead, so a client may still treat null as "everything" defensively).
   */
  readonly since: string | null;
  /** The persisted vendor cursor from the last successful sync, or null. */
  readonly cursor: string | null;
}

/**
 * The per-vendor client the engine drives. Both methods may throw — a
 * {@link ConnectorRateLimitError} gets the engine's bounded backoff; anything
 * else becomes that collection's error outcome (isolated, never cycle-fatal).
 */
export interface ConnectorVendorClient {
  /**
   * Incremental: the documents changed since `params.since`. Deletions are
   * NOT detectable here — the reconciliation crawl owns subtractive archiving.
   */
  fetchChanges(params: ConnectorFetchSince): Promise<ConnectorChanges>;
  /**
   * Reconciliation: enumerate the FULL current document set. The engine
   * archives previously-ingested paths absent from it and validates the
   * ingest caps over the full set — this is the correctness anchor
   * (vendor change feeds are allowed to be non-exhaustive; this one is not).
   */
  fetchAll(): Promise<ConnectorChanges>;
}

/** What a connector gets to build a client from — the install row, no more. */
export interface ConnectorInstallContext {
  readonly workspaceId: string;
  /** The collection slug (= `workspace_plugins.install_id`). */
  readonly collectionSlug: string;
  /** The install row's config (vendor endpoint/scope fields; never secrets). */
  readonly config: Record<string, unknown> | null;
}

/**
 * A registered Knowledge Sync Connector: one knowledge-pillar catalog row →
 * one vendor client factory. `createClient` may throw (bad config, missing /
 * undecryptable credential) — the engine turns that into the collection's
 * error outcome with the message surfaced on /admin/knowledge, so make it
 * actionable.
 */
export interface KnowledgeSyncConnector {
  /** The catalog row this connector serves — the cycle-walk dispatch key. */
  readonly catalogId: string;
  /**
   * Short vendor slug (`[a-z0-9-]+`, e.g. `confluence`, `notion`) — stamped
   * into `atlas_source` as `connector:<vendor>` on every ingested row.
   */
  readonly vendor: string;
  createClient(
    ctx: ConnectorInstallContext,
  ): Promise<ConnectorVendorClient> | ConnectorVendorClient;
}

/**
 * A vendor 429 (or equivalent throttle signal). Vendor clients throw this —
 * and ONLY this — to request the engine's bounded backoff; any other error is
 * a plain failure. `retryAfterSeconds` is the parsed `Retry-After` when the
 * vendor sent one, null otherwise (the engine picks its default wait).
 */
export class ConnectorRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ConnectorRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Registry — catalog id → connector, read by the sync cycle walk
// ---------------------------------------------------------------------------

const VENDOR_SLUG = /^[a-z0-9][a-z0-9-]*$/;

const registry = new Map<string, KnowledgeSyncConnector>();

/**
 * Register a connector for its catalog row. Called once per vendor at wiring
 * time (module init of the vendor package / boot layer). Duplicate catalog ids
 * and malformed vendor slugs fail loudly — a silent overwrite would let one
 * vendor shadow another's installs.
 */
export function registerKnowledgeSyncConnector(connector: KnowledgeSyncConnector): void {
  if (!VENDOR_SLUG.test(connector.vendor)) {
    throw new Error(
      `Knowledge sync connector vendor slug "${connector.vendor}" is invalid — expected [a-z0-9-]+ (it is stamped into atlas_source as "connector:<vendor>")`,
    );
  }
  if (registry.has(connector.catalogId)) {
    throw new Error(
      `Knowledge sync connector for catalog id "${connector.catalogId}" is already registered`,
    );
  }
  registry.set(connector.catalogId, connector);
}

export function getKnowledgeSyncConnector(catalogId: string): KnowledgeSyncConnector | undefined {
  return registry.get(catalogId);
}

/** The catalog ids with a registered connector — the cycle walk's install filter. */
export function listKnowledgeSyncConnectorCatalogIds(): string[] {
  return [...registry.keys()];
}

/** Test-only: clear the registry (tests register fixtures per-suite, never at module top-level). */
export function _resetKnowledgeSyncConnectors(): void {
  registry.clear();
}
