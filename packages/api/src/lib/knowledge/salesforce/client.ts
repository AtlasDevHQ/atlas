/**
 * The Salesforce Knowledge vendor client (#4397, PRD #4395) — a
 * {@link ConnectorVendorClient} running SOQL against `Knowledge__kav` (or a
 * Classic `<Type>__kav`) over the workspace's EXISTING Salesforce OAuth
 * connection. It owns ONLY enumerate + fetch + convert; scheduling, high-water
 * marks, reconciliation cadence, backoff, and caps are the shared engine's
 * (ADR-0030).
 *
 * The connection is the lazy-built {@link SalesforcePluginInstance} the
 * `querySalesforce` agent tool also uses — reached here through the narrow
 * {@link SalesforceKnowledgeApi} slice (`describeObject` + the paged query
 * pair), NOT the agent tool itself: the tool's semantic-layer object whitelist
 * and auto-LIMIT are agent policy, and its `query()` truncates at the first
 * SOQL batch, which is unsound for a reconciliation crawl. OAuth refresh,
 * token storage, and reconnect handling all live behind the instance
 * (`lazy-builder.ts`) — this client never sees a credential.
 *
 * Two cadences the engine decides:
 *   - `fetchChanges({ since })` (incremental) — one SOQL walk over the indexed
 *     `SystemModstamp` with an EXPLICIT `PublishStatus IN (...)` filter: a row
 *     that changed to Draft/Archived (an unpublish, a version flip) advances
 *     the high-water mark but emits nothing — its documents are archived by
 *     the next reconciliation crawl's subtractive diff (deletions are engine
 *     property, invisible to incremental by design).
 *   - `fetchAll()` (reconciliation) — enumerate every `PublishStatus =
 *     'Online'` row (each language a distinct row = a distinct document) via
 *     `queryMore`/`nextRecordsUrl` batches.
 *
 * Explicit-status discipline: EVERY query filters `PublishStatus` explicitly.
 * Modern Salesforce API versions return Draft + Archived versions on an
 * unfiltered `*__kav` query (older versions required a single-status filter
 * outright), so an unfiltered query would leak unpublished content into the
 * mirror — never rely on a vendor default here.
 *
 * Governor limits: Salesforce signals org-level API exhaustion with
 * `REQUEST_LIMIT_EXCEEDED` (not an HTTP 429 the guardedFetch path would see) —
 * mapped to {@link ConnectorRateLimitError} so the ENGINE applies its bounded
 * backoff. Batch size is Salesforce's own (~2000 records, self-reduced for
 * wide rows), so paging is governor-aware by construction; the page/row
 * bounds here are anti-runaway, not throttles.
 *
 * Body discovery: article bodies live in per-org CUSTOM rich-text fields, so
 * the client `describe`s the object and selects every custom `textarea` field
 * (rich ones converted via the shared support HTML→markdown converter, plain
 * ones passed through as prose). Field names are validated against the SOQL
 * identifier pattern before interpolation — org metadata is data, not SQL.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hostForLog } from "@atlas/api/lib/openapi/egress-guard";
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import type {
  SalesforceObjectDescribe,
  SalesforceQueryPage,
} from "@atlas/api/lib/integrations/salesforce/lazy-builder";
import {
  ConnectorRateLimitError,
  toIsoInstant,
  type ConnectorChanges,
  type ConnectorFetchSince,
  type ConnectorVendorClient,
} from "../connectors";
import {
  SALESFORCE_KNOWLEDGE_CHANNEL_FIELDS,
  type SalesforceKnowledgeChannel,
} from "./config";
import {
  assembleSalesforceKnowledgeDocuments,
  type SalesforceKnowledgeArticle,
  type SalesforceArticleBodyPart,
} from "./documents";

const log = createLogger("knowledge.salesforce.client");

/**
 * The narrow slice of the lazy-built Salesforce plugin instance this client
 * drives — structural, so tests double it with fixtures and no test touches a
 * live org. All three methods are OAuth-refresh-retried by the instance.
 */
export interface SalesforceKnowledgeApi {
  describeObject(objectName: string): Promise<SalesforceObjectDescribe>;
  queryPage(soql: string): Promise<SalesforceQueryPage>;
  queryMorePage(nextRecordsUrl: string): Promise<SalesforceQueryPage>;
}

/** Resolved, non-secret inputs. The connector factory validated all of them. */
export interface SalesforceKnowledgeClientConfig {
  /** The KB collection slug = `workspace_plugins.install_id` — the path prefix. */
  readonly collectionSlug: string;
  /** Validated `*__kav` article-version object API name. */
  readonly articleObject: string;
  /** Channel scope, or null for all channels. */
  readonly channel: SalesforceKnowledgeChannel | null;
  /** The org's instance URL — canonical article links + link absolutization. */
  readonly instanceUrl: string;
}

/**
 * Hard anti-runaway bound on enumerated article versions — NOT the ingest cap
 * (the engine owns that). A knowledge base larger than this is pathological;
 * fail loud rather than loop unbounded on a broken locator.
 */
const MAX_ARTICLES = 100_000;
/** Anti-runaway bound on `queryMore` batches walked in one enumeration. */
const MAX_QUERY_PAGES = 1_000;
/** Defensive cap on discovered custom body fields (orgs rarely exceed a few). */
const MAX_BODY_FIELDS = 20;

/** SOQL identifier — the only shape a field/object name may take in a query. */
const SOQL_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Standard fields every article-version object must expose. */
const REQUIRED_FIELDS = [
  "Id",
  "KnowledgeArticleId",
  "ArticleNumber",
  "Title",
  "Language",
  "PublishStatus",
  "SystemModstamp",
] as const;

/** Standard fields selected when the org's object has them. */
const OPTIONAL_FIELDS = ["Summary", "UrlName", "VersionNumber", "IsMasterLanguage"] as const;

/** One discovered custom body field. */
export interface SalesforceBodyField {
  readonly name: string;
  /** True = rich text (HTML, converted); false = plain long text area. */
  readonly rich: boolean;
}

/** The describe-resolved query shape for one collection's article object. */
interface ArticleObjectShape {
  readonly selectFields: readonly string[];
  readonly bodyFields: readonly SalesforceBodyField[];
  readonly optionalPresent: ReadonlySet<string>;
  /** The channel-visibility field to read, when a channel is configured. */
  readonly visibilityField: string | null;
}

/**
 * Build a Salesforce Knowledge vendor client for ONE collection. The factory
 * (`connector.ts`) has already resolved the plugin instance and validated the
 * config, so construction does no I/O; the `describe` runs on first fetch.
 */
export function createSalesforceKnowledgeVendorClient(
  api: SalesforceKnowledgeApi,
  config: SalesforceKnowledgeClientConfig,
): ConnectorVendorClient {
  const client = new SalesforceKnowledgeClient(api, config);
  return {
    async fetchChanges(params: ConnectorFetchSince): Promise<ConnectorChanges> {
      // The engine only runs incremental with a persisted mark, but a null
      // `since` is served defensively as a full crawl (the contract's advice).
      if (params.since === null) return client.fetchAll();
      return client.fetchChanges(params.since);
    },
    async fetchAll(): Promise<ConnectorChanges> {
      return client.fetchAll();
    },
  };
}

/** One normalized article-version row (timestamps canonical, ids stringified). */
interface NormalizedArticleVersion {
  readonly versionId: string;
  readonly knowledgeArticleId: string;
  readonly articleNumber: string;
  readonly title: string;
  readonly summary: string | null;
  readonly language: string;
  readonly publishStatus: string;
  readonly versionNumber: string | null;
  readonly isMasterLanguage: boolean | null;
  /** Canonical ISO instant (`toIsoInstant(SystemModstamp)`). */
  readonly updatedAt: string;
  /** Channel visibility per config (true when no channel is configured). */
  readonly visible: boolean;
  readonly bodyParts: readonly SalesforceArticleBodyPart[];
}

class SalesforceKnowledgeClient {
  private shapePromise: Promise<ArticleObjectShape> | null = null;

  constructor(
    private readonly api: SalesforceKnowledgeApi,
    private readonly config: SalesforceKnowledgeClientConfig,
  ) {}

  /** Reconciliation: enumerate every published (per-channel) version row. */
  async fetchAll(): Promise<ConnectorChanges> {
    const shape = await this.resolveShape();
    const clauses = [`PublishStatus = 'Online'`];
    // Channel scope is ALSO re-checked per row in `normalize` — the clause is
    // a payload optimization, the row check is the correctness anchor shared
    // with the incremental path.
    if (shape.visibilityField !== null) clauses.push(`${shape.visibilityField} = true`);
    const rows = await this.enumerate(shape, clauses.join(" AND "));
    return this.assemble(shape, rows, "reconciliation");
  }

  /**
   * Incremental: one indexed `SystemModstamp` walk with the explicit
   * three-status filter. Non-Online changed rows (a version flip to Draft, an
   * archive) advance the high-water mark but emit nothing — reconciliation's
   * subtractive diff archives their paths.
   */
  async fetchChanges(since: string): Promise<ConnectorChanges> {
    const sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) {
      // The engine derives `since` from its own persisted ISO mark, so this is
      // defensive — fail loud rather than silently refetch everything.
      throw new Error(
        `Salesforce Knowledge incremental fetch got an unparseable since instant ("${since}").`,
      );
    }
    const shape = await this.resolveShape();
    // SOQL datetime literals are unquoted ISO instants without milliseconds.
    // `>` (not `>=`) is safe against the contract's "at-or-after": `since` is
    // already mark − overlap window, and truncating the milliseconds widens
    // the `>` window further downward.
    const soqlSince = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const where = `SystemModstamp > ${soqlSince} AND PublishStatus IN ('Online', 'Draft', 'Archived')`;
    const rows = await this.enumerate(shape, where);
    return this.assemble(shape, rows, "incremental");
  }

  /** Describe the article object once per client; validate + cache the shape. */
  private resolveShape(): Promise<ArticleObjectShape> {
    this.shapePromise ??= this.describeShape();
    return this.shapePromise;
  }

  private async describeShape(): Promise<ArticleObjectShape> {
    const { articleObject, channel } = this.config;
    let described: SalesforceObjectDescribe;
    try {
      described = await this.api.describeObject(articleObject);
    } catch (err) {
      throw mapSalesforceError(
        err,
        `Salesforce could not describe ${articleObject} on ${this.hostLabel()} — check that Lightning Knowledge is enabled and the connected user can read the object.`,
      );
    }

    const fieldNames = new Set<string>();
    const bodyFields: SalesforceBodyField[] = [];
    let skippedUnsafeNames = 0;
    let droppedBodyFields = 0;
    for (const raw of described.fields) {
      const name = typeof raw.name === "string" ? raw.name : "";
      if (name === "") continue;
      if (!SOQL_IDENTIFIER.test(name)) {
        // Never interpolate a non-identifier into SOQL — org metadata is data.
        skippedUnsafeNames++;
        continue;
      }
      fieldNames.add(name);
      if (raw.custom === true && raw.type === "textarea") {
        if (bodyFields.length >= MAX_BODY_FIELDS) {
          droppedBodyFields++;
          continue;
        }
        bodyFields.push({ name, rich: raw.extraTypeInfo === "richtextarea" });
      }
    }
    if (skippedUnsafeNames > 0) {
      log.warn(
        { articleObject, skippedUnsafeNames },
        "Skipped Salesforce fields whose names fail the SOQL identifier pattern — not selectable (unexpected describe metadata)",
      );
    }
    if (droppedBodyFields > 0) {
      // Never a silent shrink: documents from this org mirror only the first
      // MAX_BODY_FIELDS custom textarea fields, in describe order.
      log.warn(
        { articleObject, droppedBodyFields, cap: MAX_BODY_FIELDS },
        "Salesforce article object exceeds the custom body-field cap — later textarea fields are not mirrored",
      );
    }

    const missing = REQUIRED_FIELDS.filter((f) => !fieldNames.has(f));
    if (missing.length > 0) {
      throw new Error(
        `Salesforce object ${articleObject} is missing required article-version fields (${missing.join(", ")}) — it does not look like a Knowledge article-version object.`,
      );
    }

    const visibilityField = channel === null ? null : SALESFORCE_KNOWLEDGE_CHANNEL_FIELDS[channel];
    if (visibilityField !== null && !fieldNames.has(visibilityField)) {
      throw new Error(
        `Salesforce object ${articleObject} has no ${visibilityField} field — the "${channel}" channel scope cannot be applied; re-install the collection without it or pick another channel.`,
      );
    }

    const optionalPresent = new Set(OPTIONAL_FIELDS.filter((f) => fieldNames.has(f)));
    const selectFields = [
      ...REQUIRED_FIELDS,
      ...optionalPresent,
      ...(visibilityField !== null ? [visibilityField] : []),
      ...bodyFields.map((f) => f.name),
    ];
    if (bodyFields.length === 0) {
      // Not fatal — Title + Summary can still carry prose — but an operator
      // debugging empty documents needs the breadcrumb.
      log.warn(
        { articleObject },
        "Salesforce article object has no custom textarea body fields — documents will carry only title/summary prose",
      );
    }
    return { selectFields, bodyFields, optionalPresent, visibilityField };
  }

  /** Walk one SOQL result set through `queryMore` batches, bounded. */
  private async enumerate(
    shape: ArticleObjectShape,
    where: string,
  ): Promise<Record<string, unknown>[]> {
    const soql = `SELECT ${shape.selectFields.join(", ")} FROM ${this.config.articleObject} WHERE ${where}`;
    const rows: Record<string, unknown>[] = [];
    let page: SalesforceQueryPage;
    try {
      page = await this.api.queryPage(soql);
    } catch (err) {
      throw mapSalesforceError(
        err,
        `Salesforce Knowledge query against ${this.config.articleObject} on ${this.hostLabel()} failed`,
      );
    }
    for (let pages = 1; ; pages++) {
      if (pages > MAX_QUERY_PAGES) {
        throw new Error(
          `Salesforce Knowledge enumeration of ${this.config.articleObject} did not terminate after ${MAX_QUERY_PAGES} query batches — unexpected vendor pagination.`,
        );
      }
      rows.push(...page.records);
      if (rows.length > MAX_ARTICLES) {
        throw new Error(
          `Salesforce Knowledge on ${this.hostLabel()} exceeds ${MAX_ARTICLES} article versions — narrow the connector's scope. (This is a safety bound, not the ingest cap ATLAS_KNOWLEDGE_INGEST_MAX_DOCS.)`,
        );
      }
      if (page.done || page.nextRecordsUrl === null) break;
      try {
        page = await this.api.queryMorePage(page.nextRecordsUrl);
      } catch (err) {
        throw mapSalesforceError(
          err,
          `Salesforce Knowledge queryMore continuation on ${this.hostLabel()} failed`,
        );
      }
    }
    return rows;
  }

  /** Normalize + convert the fetched set into `ConnectorChanges`. */
  private assemble(
    shape: ArticleObjectShape,
    rawRows: readonly Record<string, unknown>[],
    mode: "incremental" | "reconciliation",
  ): ConnectorChanges {
    let skippedMalformed = 0;
    let observedNotEmitted = 0;
    let highWaterMark: string | null = null;
    const emitted: SalesforceKnowledgeArticle[] = [];

    for (const raw of rawRows) {
      const row = this.normalize(shape, raw);
      if (row === null) {
        skippedMalformed++;
        continue;
      }
      // Every fetched version — emitted or not — advances the mark: its change
      // is what this fetch observed. ISO instants compare chronologically.
      if (highWaterMark === null || row.updatedAt > highWaterMark) {
        highWaterMark = row.updatedAt;
      }
      if (row.publishStatus !== "Online" || !row.visible) {
        // A version flip to Draft/Archived, or out-of-channel visibility:
        // observed, never emitted — reconciliation archives its stale path.
        observedNotEmitted++;
        continue;
      }
      emitted.push({
        versionId: row.versionId,
        knowledgeArticleId: row.knowledgeArticleId,
        articleNumber: row.articleNumber,
        title: row.title,
        summary: row.summary,
        language: row.language,
        versionNumber: row.versionNumber,
        isMasterLanguage: row.isMasterLanguage,
        updatedAt: row.updatedAt,
        url: this.articleUrl(row.versionId),
        bodyParts: row.bodyParts,
      });
    }

    const assembled = assembleSalesforceKnowledgeDocuments(emitted, {
      collectionSlug: this.config.collectionSlug,
      instanceUrl: this.config.instanceUrl,
    });
    if (assembled.degradations.length > 0 || assembled.skippedContentless > 0) {
      log.info(
        {
          host: this.hostLabel(),
          mode,
          degradations: assembled.degradations,
          skippedContentless: assembled.skippedContentless,
          // Bounded article-number breadcrumbs — a reconciliation archives a
          // previously-mirrored doc that converts to empty, so the operator
          // needs the WHICH, not just the count.
          contentlessArticles: assembled.contentlessArticles,
        },
        "Salesforce Knowledge conversion completed with degradations/skips",
      );
    }
    if (observedNotEmitted > 0) {
      log.info(
        { host: this.hostLabel(), mode, observedNotEmitted },
        "Observed Salesforce article versions that are not published/visible in scope — mark advanced, nothing emitted (reconciliation archives stale paths)",
      );
    }
    if (skippedMalformed > 0) {
      // A skipped version is a KNOWN hole in the set: its document would
      // otherwise be archived by a reconciliation off this partial crawl. The
      // flag makes the engine upsert-only and hold the reconcile clock.
      log.warn(
        { host: this.hostLabel(), mode, skippedMalformed },
        "Skipped Salesforce article versions missing id/number/language/timestamp — not ingested (unexpected for published content)",
      );
    }

    return {
      documents: assembled.documents,
      highWaterMark,
      cursor: null,
      coverageIncomplete: skippedMalformed > 0,
    };
  }

  /** Normalize one raw row; null = malformed (skip + count). */
  private normalize(
    shape: ArticleObjectShape,
    raw: Record<string, unknown>,
  ): NormalizedArticleVersion | null {
    const versionId = stringOf(raw.Id);
    const knowledgeArticleId = stringOf(raw.KnowledgeArticleId);
    const articleNumber = stringOf(raw.ArticleNumber);
    const language = stringOf(raw.Language).toLowerCase();
    const publishStatus = stringOf(raw.PublishStatus);
    const updatedAt = toIsoInstant(raw.SystemModstamp);
    if (
      versionId === "" ||
      knowledgeArticleId === "" ||
      articleNumber === "" ||
      language === "" ||
      updatedAt === null
    ) {
      return null;
    }

    const bodyParts: SalesforceArticleBodyPart[] = [];
    for (const field of shape.bodyFields) {
      const value = raw[field.name];
      if (typeof value === "string" && value !== "") {
        bodyParts.push({ field: field.name, value, rich: field.rich });
      }
    }

    const summary = shape.optionalPresent.has("Summary") ? stringOf(raw.Summary) : "";
    const rawVersionNumber = shape.optionalPresent.has("VersionNumber")
      ? stringOf(raw.VersionNumber)
      : "";
    const versionNumber = rawVersionNumber === "" ? null : rawVersionNumber;
    const isMasterLanguage = shape.optionalPresent.has("IsMasterLanguage")
      ? raw.IsMasterLanguage === true
      : null;

    return {
      versionId,
      knowledgeArticleId,
      articleNumber,
      title: stringOf(raw.Title),
      summary: summary === "" ? null : summary,
      language,
      publishStatus,
      versionNumber,
      isMasterLanguage,
      updatedAt,
      visible: shape.visibilityField === null ? true : raw[shape.visibilityField] === true,
      bodyParts,
    };
  }

  /** Canonical Lightning record URL for one article version. */
  private articleUrl(versionId: string): string {
    const base = this.config.instanceUrl.replace(/\/+$/, "");
    return `${base}/lightning/r/${this.config.articleObject}/${encodeURIComponent(versionId)}/view`;
  }

  /** Host-redacted label for logs + error messages. */
  private hostLabel(): string {
    return hostForLog(this.config.instanceUrl);
  }
}

/** Stringify an untrusted scalar (`null`/objects/arrays = absent). */
function stringOf(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number") return String(raw);
  return "";
}

/**
 * Map a jsforce failure to the engine's vocabulary: `REQUEST_LIMIT_EXCEEDED`
 * (org-level API governor exhaustion — Salesforce's throttle signal, not an
 * HTTP 429) becomes {@link ConnectorRateLimitError} so the engine applies its
 * bounded backoff; everything else is wrapped with actionable context, the
 * original riding as `cause`. Reconnect-required errors pass through
 * untouched — their message is already the actionable one.
 */
function mapSalesforceError(err: unknown, context: string): Error {
  if (err instanceof ConnectorRateLimitError) return err;
  // Specific classes before the substring heuristic: a reconnect error whose
  // upstream text happened to contain the governor token must stay a
  // reconnect, not a futile backoff.
  if (err instanceof IntegrationReconnectRequiredError) return err;
  if (isGovernorLimitError(err)) {
    return new ConnectorRateLimitError(
      "Salesforce rejected the request with REQUEST_LIMIT_EXCEEDED — the org's daily API request allocation is exhausted; the sync will back off and retry.",
    );
  }
  return new Error(`${context}: ${err instanceof Error ? err.message : String(err)}`, {
    cause: err,
  });
}

/** Salesforce org-level API governor exhaustion, by errorCode or message. */
function isGovernorLimitError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes("REQUEST_LIMIT_EXCEEDED")) return true;
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return code === "REQUEST_LIMIT_EXCEEDED";
}
