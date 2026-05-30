/**
 * `openapi-paginator` — follow multi-page REST responses transparently so the
 * agent loop sees ONE merged result, not per-page bookkeeping (PRD #2868 slice
 * 4, #2928).
 *
 * The shape: pagination is a *pluggable strategy registry*. A strategy is the
 * single decision "given the response to this page and the request that
 * produced it, what is the request for the NEXT page (or are we done)?" —
 * `next(response, request) → {@link PageDecision}`. The driver ({@link paginate})
 * runs the loop the PRD describes:
 *
 * ```
 *   let req = first;
 *   while (req !== null) {
 *     const resp = await execute(req);                 // one page per executeOperation call
 *     accumulate(resp);
 *     const decision = strategy.next(resp, req);
 *     req = decision.kind === "continue" ? decision.request : null;  // "done"/"error" stop
 *   }
 * ```
 *
 * accumulates each page's items, and returns a single {@link MergedPages}. The
 * client-layer entry is `executeOperationPaged` in `client.ts`, which binds the
 * slice-0 {@link executeOperation} primitive as the `execute` callback — the
 * primitive stays pure (no pagination/caching); this module composes it.
 *
 * ## Four built-in strategies (one file each, see `strategies/`)
 *  - `cursor`      — opaque next-cursor token (Twenty `starting_after`, Stripe-like)
 *  - `offset`      — numeric `offset` + `limit` window
 *  - `page`        — 1-based `page` number
 *  - `link-header` — RFC 8288 `Link: <…>; rel="next"` (GitHub-style)
 *
 * Each lives in `strategies/<name>.ts` and exports a {@link PaginationStrategyFactory}.
 * The default registry is assembled in `strategies/index.ts`.
 *
 * ## Adding a fifth strategy is ONE new file (#2928 acceptance)
 *  1. Create `strategies/<flavor>.ts` exporting a `PaginationStrategyFactory`
 *     (mirror `strategies/cursor.ts` — read your config fields with the
 *     `requireString`/`optionalNumber`/… helpers, return `{ name, itemsPath, next }`).
 *  2. Add it to the `BUILT_IN_STRATEGIES` array in `strategies/index.ts`.
 *  No edit to this engine, no fork of the driver. The `next` contract is the
 *  whole seam. (Stripe's `starting_after`/`ending_before` is the canonical
 *  fifth — it is a `cursor` variant, so it may not even need a new file.)
 *
 * ## Where the config comes from
 * A {@link PaginationConfig} (which strategy + its field paths) is supplied two
 * ways, both resolving through {@link PaginatorRegistry.resolve}:
 *  - **install config** — slice 2 (#2926) stores it per-operation on the
 *    workspace-resident REST datasource record.
 *  - **auto-detect** — {@link detectPaginationConfig} reads an `x-pagination`
 *    vendor extension from a known-dialect spec. (Wiring `spec.ts` to surface
 *    operation `x-` extensions is the slice-2 step that lights this up; the
 *    detector is pure and testable now over a raw extension bag.)
 *
 * This module is pure: no HTTP, no logger, no Effect runtime. The page cache is
 * an injected {@link PageCacheStore} abstraction — an {@link InMemoryPageCacheStore}
 * ships here; the cross-pod Postgres-backed store (the true L2, keyed on the
 * real `plugin_install_id`) is the slice-2 swap, mirroring `byot-catalog-store.ts`.
 */
import { createHash } from "node:crypto";
import { Data } from "effect";

import type { OperationParams, OperationResult } from "./types";

// ─────────────────────────────────────────────────────────────────────
//  Request + strategy contract (the SPI strategy files implement)
// ─────────────────────────────────────────────────────────────────────

/**
 * One page's request: the operation to call and its bucketed params. Pagination
 * varies only the params (a cursor/offset/page query value); the `operationId`
 * is constant across a sequence. This is the unit the slice-0 client executes.
 */
export interface PageRequest {
  readonly operationId: string;
  readonly params: OperationParams;
}

/**
 * A strategy's decision about the next page, returned by {@link PaginationStrategy.next}.
 * Three outcomes a bare `PageRequest | null` conflated:
 *  - `done`     — the sequence is exhausted. A CLEAN completion; the merge is complete.
 *  - `continue` — there is another page; fetch `request` next.
 *  - `error`    — the response was 2xx but the next request could not be computed
 *                 (e.g. a malformed `Link` header). The driver STOPS and marks the
 *                 merge `truncated` with reason `"strategy-error"`, so a partial
 *                 result is never mistaken for a clean completion.
 */
export type PageDecision =
  | { readonly kind: "done" }
  | { readonly kind: "continue"; readonly request: PageRequest }
  | { readonly kind: "error"; readonly reason: string };

/** The shared "sequence exhausted" decision (clean completion). */
export const PAGE_DONE: PageDecision = { kind: "done" };

/** Decision constructor: fetch `request` as the next page. */
export function continueWith(request: PageRequest): PageDecision {
  return { kind: "continue", request };
}

/**
 * Decision constructor: a 2xx page from which the next request could not be
 * derived. Distinct from `done` — the walk stops AND the merge is flagged
 * truncated, so the consumer learns the data may be incomplete.
 */
export function pageError(reason: string): PageDecision {
  return { kind: "error", reason };
}

/**
 * A config-bound pagination strategy. `next` is pure — given the response to
 * `request` and `request` itself, it returns a {@link PageDecision}: the request
 * for the next page (`continue`), a clean end (`done`), or `error` when an
 * otherwise-2xx page yields no computable next request. `itemsPath` is the
 * dot-path to the array of records in each page body; the driver reads it to
 * merge pages (and most strategies read it to decide "a short page means the
 * last page").
 */
export interface PaginationStrategy {
  readonly name: string;
  /** Dot-path to the item array in a page body, e.g. `"data.people"` or `"items"`. */
  readonly itemsPath: string;
  next(response: OperationResult, request: PageRequest): PageDecision;
}

/**
 * A strategy factory: binds a {@link PaginationConfig} to a {@link PaginationStrategy}.
 * `create` validates the config and fails loud ({@link PaginationConfigError}) on a
 * missing/ill-typed field — a silently mis-bound paginator would truncate results,
 * which is worse than a clear error. This is the one type a new strategy file exports.
 */
export interface PaginationStrategyFactory {
  readonly name: string;
  create(config: PaginationConfig): PaginationStrategy;
}

/**
 * Per-operation pagination config. A flat bag: `strategy` selects the registered
 * factory, the rest are that strategy's field paths (`itemsPath`, `cursorParam`,
 * …). Loose by design so the registry stays open to new strategies — each
 * factory reads (and validates) only the fields it needs.
 */
export type PaginationConfig = { readonly strategy: string } & Readonly<Record<string, unknown>>;

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/** Thrown by a factory's `create` (or `resolve`) when config is invalid/unknown. */
export class PaginationConfigError extends Data.TaggedError("PaginationConfigError")<{
  readonly message: string;
  readonly strategy: string;
  /** The offending config field, when the fault is a missing/ill-typed field. */
  readonly field?: string;
}> {}

// ─────────────────────────────────────────────────────────────────────
//  Config readers (shared by every strategy factory)
// ─────────────────────────────────────────────────────────────────────

/** Read a required non-empty string config field, or fail loud. */
export function requireString(config: PaginationConfig, field: string): string {
  const value = config[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new PaginationConfigError({
      strategy: config.strategy,
      field,
      message: `Pagination strategy "${config.strategy}" requires a non-empty string config field "${field}".`,
    });
  }
  return value;
}

/** Read an optional string config field; throws only if present-but-not-a-string. */
export function optionalString(config: PaginationConfig, field: string): string | undefined {
  const value = config[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PaginationConfigError({
      strategy: config.strategy,
      field,
      message: `Pagination strategy "${config.strategy}" config field "${field}" must be a string when present.`,
    });
  }
  return value;
}

/** Read a required finite-number config field, or fail loud. */
export function requireNumber(config: PaginationConfig, field: string): number {
  const value = config[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PaginationConfigError({
      strategy: config.strategy,
      field,
      message: `Pagination strategy "${config.strategy}" requires a finite number config field "${field}".`,
    });
  }
  return value;
}

/** Read an optional finite-number config field; throws only if present-but-not-a-number. */
export function optionalNumber(config: PaginationConfig, field: string): number | undefined {
  const value = config[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PaginationConfigError({
      strategy: config.strategy,
      field,
      message: `Pagination strategy "${config.strategy}" config field "${field}" must be a finite number when present.`,
    });
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers strategy files reuse
// ─────────────────────────────────────────────────────────────────────

/**
 * Read `obj` at a dot-path (`"pageInfo.endCursor"`). Returns `undefined` when any
 * segment is missing or a non-object is traversed. Never throws — a paginator
 * reading a field the upstream didn't send should stop, not crash.
 */
export function dotGet(obj: unknown, path: string): unknown {
  if (path.length === 0) return obj;
  let cursor: unknown = obj;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * The item array at `itemsPath` in a page body, or `[]` when it is absent / not
 * an array. Tolerant by design: a page whose item path doesn't resolve to an
 * array contributes nothing to the merge (and reads as a "short page" that ends
 * count-based strategies) rather than throwing mid-walk.
 */
export function extractItems(body: unknown, itemsPath: string): unknown[] {
  const at = itemsPath.length === 0 ? body : dotGet(body, itemsPath);
  return Array.isArray(at) ? at : [];
}

/** Coerce a query value (string or number) to a finite number, or `undefined`. */
export function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Clone a {@link PageRequest} with the given query values merged in (overriding
 * existing keys). Path / header / body buckets pass through unchanged.
 * `undefined` patch values are kept as-is so the slice-0 client drops them. Array
 * values are preserved (the client explodes them into repeated query keys) so a
 * strategy can carry repeated filters across pages.
 */
export function withQuery(
  request: PageRequest,
  patch: Readonly<
    Record<string, string | number | boolean | ReadonlyArray<string | number | boolean> | undefined>
  >,
): PageRequest {
  return {
    operationId: request.operationId,
    params: {
      ...request.params,
      query: { ...(request.params.query ?? {}), ...patch },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Registry
// ─────────────────────────────────────────────────────────────────────

/**
 * The pluggable strategy registry. Built once from the four built-ins
 * ({@link defaultPaginatorRegistry} in `strategies/index.ts`); a fifth strategy
 * is registered by adding its file to that array — this class never changes.
 */
export class PaginatorRegistry {
  private readonly factories = new Map<string, PaginationStrategyFactory>();

  constructor(factories: ReadonlyArray<PaginationStrategyFactory> = []) {
    for (const factory of factories) this.register(factory);
  }

  /** Register a strategy. Duplicate names are a programming error (fail loud). */
  register(factory: PaginationStrategyFactory): void {
    if (this.factories.has(factory.name)) {
      throw new Error(
        `Pagination strategy "${factory.name}" is already registered — names must be unique. ` +
          `Registered: ${this.list().join(", ")}.`,
      );
    }
    this.factories.set(factory.name, factory);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  /** Registered strategy names, in registration order. */
  list(): string[] {
    return [...this.factories.keys()];
  }

  /**
   * Resolve a config to a bound strategy. Throws {@link PaginationConfigError}
   * when the named strategy isn't registered, and the factory throws the same
   * when a required field is missing.
   */
  resolve(config: PaginationConfig): PaginationStrategy {
    const factory = this.factories.get(config.strategy);
    if (factory === undefined) {
      throw new PaginationConfigError({
        strategy: config.strategy,
        message:
          `Unknown pagination strategy "${config.strategy}". ` +
          `Registered: ${this.list().join(", ") || "(none)"}.`,
      });
    }
    return factory.create(config);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Auto-detection from x-extensions
// ─────────────────────────────────────────────────────────────────────

/** The OpenAPI vendor extension key carrying pagination config for a dialect. */
export const PAGINATION_EXTENSION_KEY = "x-pagination";

/**
 * Read a {@link PaginationConfig} from an operation's vendor extensions, or
 * `null` when none is present. The convention: an `x-pagination` object whose
 * `strategy` (or `type`) names a registered strategy plus its field paths, e.g.
 *
 * ```jsonc
 * "x-pagination": { "type": "cursor", "itemsPath": "data.people",
 *                   "cursorParam": "starting_after", "cursorPath": "pageInfo.endCursor",
 *                   "hasMorePath": "pageInfo.hasNextPage" }
 * ```
 *
 * Pure over a raw extension bag so it's testable today; `spec.ts` capturing
 * operation-level `x-` keys (slice 2) is what feeds it in production. Returns
 * the config unresolved — {@link PaginatorRegistry.resolve} validates the name
 * and required fields.
 */
export function detectPaginationConfig(
  extensions: Readonly<Record<string, unknown>> | undefined,
): PaginationConfig | null {
  if (extensions === undefined) return null;
  const raw = extensions[PAGINATION_EXTENSION_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const strategy =
    typeof obj.strategy === "string"
      ? obj.strategy
      : typeof obj.type === "string"
        ? obj.type
        : undefined;
  if (strategy === undefined) return null;
  return { ...obj, strategy };
}

// ─────────────────────────────────────────────────────────────────────
//  Page cache (page-level L2)
// ─────────────────────────────────────────────────────────────────────

/**
 * Default page-cache TTL: 5 minutes (PRD OQ2). A page cached longer than this is
 * treated as stale and re-fetched. Per-operation TTL is a recognized future need
 * — the hook is {@link PageCacheBinding.ttlMs} (a caller may pass a different
 * value per operation); we deliberately do NOT build per-op TTL declaration
 * plumbing until a workload demands it.
 */
export const DEFAULT_PAGE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Hard cap on pages followed in one walk — a safety bound, not a feature limit. */
export const DEFAULT_MAX_PAGES = 50;

/** A cached page: the full {@link OperationResult} (headers included, so the
 * `link-header` strategy can recompute `next` from a cached page) plus when it
 * was stored. */
export interface CachedPage {
  readonly cachedAt: number;
  readonly result: OperationResult;
}

/** Identifies the install whose cache an entry belongs to (and the flush scope). */
export interface PageCacheIdentity {
  readonly workspaceId: string;
  readonly pluginInstallId: string;
}

/**
 * The page-cache store contract. Dumb storage — TTL + watermark freshness is
 * policy decided by {@link isPageFresh}, so a Postgres-backed store (slice 2) is
 * trivial CRUD. Async so that DB-backed implementation fits without a signature
 * change. Best-effort by convention: a store that throws should be caught by the
 * caller and treated as a miss (the cache is performance, never correctness).
 */
export interface PageCacheStore {
  get(key: string): Promise<CachedPage | undefined>;
  set(key: string, entry: CachedPage): Promise<void>;
  /**
   * The install's `cache_invalidated_at` watermark (epoch ms); `0` if never set.
   * `scopeKey` is the COMPOSITE flush scope {@link installCacheKey} mints —
   * `${workspaceId}::${pluginInstallId}`, NOT a bare `install_id` (which is not
   * globally unique). A Postgres-backed store (slice 2) MUST therefore key its
   * watermark table on the composite (a composite PK or a `(workspace_id,
   * plugin_install_id)` unique index) — keying on a bare `install_id` would let
   * one workspace's "Rediscover schema" flush another workspace's pages.
   */
  getWatermark(scopeKey: string): Promise<number>;
  /** Advance the watermark — entries cached at/before `at` become stale. See {@link getWatermark} on `scopeKey`. */
  bumpWatermark(scopeKey: string, at: number): Promise<void>;
}

/**
 * The flush-scope key (the `scopeKey` watermark methods take): one watermark per
 * `(workspace, install)`. Composite because `install_id` is not globally unique —
 * see {@link PageCacheStore.getWatermark}.
 */
export function installCacheKey(identity: PageCacheIdentity): string {
  return `${identity.workspaceId}::${identity.pluginInstallId}`;
}

/**
 * The documented page-cache key: `(workspace_id, plugin_install_id, operationId,
 * sorted_params_hash)`. The params hash is a SHA-256 over a canonical JSON of the
 * request params with object keys sorted (array order preserved — query arrays
 * are order-significant), so `{a,b}` and `{b,a}` collapse to one entry while a
 * value change (a different cursor/offset) is a distinct page entry. This is why
 * a 5-page walk caches each page independently and a follow-up needing page 3
 * doesn't re-fetch 1–2.
 */
export function derivePageCacheKey(
  identity: PageCacheIdentity,
  operationId: string,
  params: OperationParams,
): string {
  const hash = createHash("sha256").update(canonicalJson(params)).digest("hex").slice(0, 32);
  return `${identity.workspaceId}::${identity.pluginInstallId}::${operationId}::${hash}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key]);
    return out;
  }
  return value;
}

/**
 * Freshness policy: a cached page is fresh iff it was stored AFTER the install's
 * invalidation watermark AND within the TTL window. The `<=` against the
 * watermark means a "Rediscover schema" bump to `now` flushes everything cached
 * at-or-before that instant — an O(1) flush with no row deletes.
 */
export function isPageFresh(
  entry: CachedPage,
  opts: { readonly ttlMs: number; readonly watermark: number; readonly now: number },
): boolean {
  if (entry.cachedAt <= opts.watermark) return false;
  if (opts.now - entry.cachedAt >= opts.ttlMs) return false;
  return true;
}

/**
 * The default in-memory store. Single-pod, lost on restart — fine as the default
 * (the cache is performance, not correctness). Slice 2 (#2926) provides the
 * cross-pod Postgres-backed store keyed on the real `plugin_install_id`,
 * mirroring `byot-catalog-store.ts`; nothing else changes because callers depend
 * on the {@link PageCacheStore} interface, not this class.
 */
export class InMemoryPageCacheStore implements PageCacheStore {
  private readonly pages = new Map<string, CachedPage>();
  private readonly watermarks = new Map<string, number>();

  get(key: string): Promise<CachedPage | undefined> {
    return Promise.resolve(this.pages.get(key));
  }

  set(key: string, entry: CachedPage): Promise<void> {
    this.pages.set(key, entry);
    return Promise.resolve();
  }

  getWatermark(scopeKey: string): Promise<number> {
    return Promise.resolve(this.watermarks.get(scopeKey) ?? 0);
  }

  bumpWatermark(scopeKey: string, at: number): Promise<void> {
    // Monotonic: a stale clock can never lower an existing watermark.
    this.watermarks.set(scopeKey, Math.max(this.watermarks.get(scopeKey) ?? 0, at));
    return Promise.resolve();
  }

  /** Inspection seam (tests / metrics). Not part of {@link PageCacheStore}. */
  size(): number {
    return this.pages.size;
  }

  /** Drop all entries + watermarks. Test seam. */
  clear(): void {
    this.pages.clear();
    this.watermarks.clear();
  }
}

/**
 * Bump an install's invalidation watermark to `at`, effectively flushing every
 * page cached at/before that instant. This is the seam the admin "Rediscover
 * schema" action (slice 2 UX) calls after re-probing the spec — re-discovering
 * the operation surface must not serve pages cached against the old shape.
 */
export async function invalidateInstallCache(
  store: PageCacheStore,
  identity: PageCacheIdentity,
  at: number,
): Promise<void> {
  await store.bumpWatermark(installCacheKey(identity), at);
}

// ─────────────────────────────────────────────────────────────────────
//  The driver
// ─────────────────────────────────────────────────────────────────────

/** A page cache bound to one install for a single {@link paginate} walk. */
export interface PageCacheBinding {
  readonly store: PageCacheStore;
  readonly identity: PageCacheIdentity;
  /** TTL override (per-op TTL hook). Defaults to {@link DEFAULT_PAGE_CACHE_TTL_MS}. */
  readonly ttlMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * When `false`, the walk bypasses the cache entirely. `executeOperationPaged`
   * sets this from the operation's method so WRITES ARE NEVER CACHED.
   */
  readonly cacheable?: boolean;
  /**
   * Called (best-effort) when a store operation throws. The cache is performance,
   * never correctness, so a store fault degrades to a live fetch rather than
   * aborting the walk — this hook is how the otherwise logger-free engine lets a
   * caller (e.g. `executeOperationPaged`) record the fault via `log.warn`. A
   * throwing hook is itself swallowed so it can never break a walk.
   */
  readonly onCacheFault?: (err: Error) => void;
}

export interface PaginateOptions {
  readonly strategy: PaginationStrategy;
  /** Hard page cap (safety). Defaults to {@link DEFAULT_MAX_PAGES}. */
  readonly maxPages?: number;
  /** Optional hard cap on merged item count; the result is sliced + marked truncated. */
  readonly maxItems?: number;
  /** Optional page cache. Omit for an always-fetch walk. */
  readonly cache?: PageCacheBinding;
}

/**
 * Why a walk stopped before the strategy reported a clean `done`. Lets a consumer
 * tell the user *what kind* of partial result they have — "hit your 50-page cap",
 * "upstream returned 401", and "the pagination field was malformed" are very
 * different messages. Present iff {@link MergedPages.truncated} is `true`.
 */
export type TruncationReason = "max-pages" | "max-items" | "error-status" | "strategy-error";

/** The single merged result the agent loop sees in place of N pages. */
export interface MergedPages {
  /** Items concatenated across every page, in order. */
  readonly items: ReadonlyArray<unknown>;
  /** Number of page requests served (fetched or from cache). */
  readonly pageCount: number;
  /**
   * True when the walk stopped before the strategy reported a clean completion —
   * hit `maxPages` / `maxItems`, a non-2xx page, or a strategy `error` decision.
   * A consumer surfacing the merged result should tell the user the data is
   * partial when this is set; {@link truncationReason} says why.
   */
  readonly truncated: boolean;
  /** Why the walk truncated. Present iff {@link truncated} is `true`. */
  readonly truncationReason?: TruncationReason;
  /** HTTP status of the last page fetched (the error status when truncated by one). */
  readonly lastStatus: number;
  /**
   * The last page's parsed `Retry-After` (ms), surfaced when truncated by an
   * `error-status` page that carried one (typically a 429 / 503). Lets a consumer
   * honor the upstream's backoff without re-reading the raw response.
   */
  readonly retryAfterMs?: number;
  /** How many pages were served from the cache (observability). */
  readonly servedFromCache: number;
}

/**
 * Walk a paginated sequence and merge it into one {@link MergedPages}. Runs the
 * PRD loop: fetch a page (cache-aware), accumulate its items, ask the strategy
 * for the next request, repeat until the strategy decides `done`/`error` or a
 * safety bound trips. A single non-paginated response (strategy returns `done`
 * after page one) comes back as a one-page merge — so this is safe for any GET.
 *
 * `execute` is the page fetcher (the slice-0 client, bound in
 * `executeOperationPaged`). Pure aside from `execute` + the injected cache/clock.
 */
export async function paginate(
  first: PageRequest,
  execute: (request: PageRequest) => Promise<OperationResult>,
  options: PaginateOptions,
): Promise<MergedPages> {
  const { strategy, cache } = options;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxItems = options.maxItems;

  const items: unknown[] = [];
  let pageCount = 0;
  let servedFromCache = 0;
  let truncated = false;
  let truncationReason: TruncationReason | undefined;
  let retryAfterMs: number | undefined;
  let lastStatus = 0;
  let request: PageRequest | null = first;

  while (request !== null) {
    if (pageCount >= maxPages) {
      truncated = true;
      truncationReason = "max-pages";
      break;
    }

    const { result, fromCache } = await fetchPage(request, execute, cache);
    pageCount++;
    if (fromCache) servedFromCache++;
    lastStatus = result.status;

    const ok = result.status >= 200 && result.status < 300;
    if (!ok) {
      // Don't follow `next` past an error — the merged result is incomplete.
      truncated = true;
      truncationReason = "error-status";
      retryAfterMs = result.retryAfterMs;
      break;
    }

    items.push(...extractItems(result.body, strategy.itemsPath));

    // `>` not `>=`: a walk that reaches exactly `maxItems` and is then reported
    // `done` by the strategy is COMPLETE, not truncated. Only an overflow (the
    // strategy would have continued past the cap) marks the merge truncated.
    if (maxItems !== undefined && items.length > maxItems) {
      truncated = true;
      truncationReason = "max-items";
      break;
    }

    const decision = strategy.next(result, request);
    if (decision.kind === "error") {
      // 2xx page, but the strategy couldn't compute the next request (e.g. a
      // malformed Link header). Stop loud — never mistaken for a clean `done`.
      truncated = true;
      truncationReason = "strategy-error";
      break;
    }
    request = decision.kind === "continue" ? decision.request : null;
  }

  const finalItems =
    maxItems !== undefined && items.length > maxItems ? items.slice(0, maxItems) : items;

  return {
    items: finalItems,
    pageCount,
    truncated,
    ...(truncationReason !== undefined ? { truncationReason } : {}),
    lastStatus,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    servedFromCache,
  };
}

/** Fetch one page, consulting the cache when bound + cacheable. Only 2xx GET-style
 * responses are stored; the `cacheable` flag (set from the op's method upstream)
 * keeps writes out of the cache. A store fault degrades to a fetch (best-effort)
 * — the cache is performance, never correctness, so a throwing store reads as a
 * miss (and a write fault is swallowed) rather than aborting the walk. */
async function fetchPage(
  request: PageRequest,
  execute: (request: PageRequest) => Promise<OperationResult>,
  cache: PageCacheBinding | undefined,
): Promise<{ result: OperationResult; fromCache: boolean }> {
  if (cache === undefined || cache.cacheable === false) {
    return { result: await execute(request), fromCache: false };
  }

  const now = cache.now ?? Date.now;
  const ttlMs = cache.ttlMs ?? DEFAULT_PAGE_CACHE_TTL_MS;
  const key = derivePageCacheKey(cache.identity, request.operationId, request.params);
  const scopeKey = installCacheKey(cache.identity);

  let lookup: [CachedPage | undefined, number];
  try {
    lookup = await Promise.all([cache.store.get(key), cache.store.getWatermark(scopeKey)]);
  } catch (err) {
    // Best-effort: a store read fault degrades to a live fetch (cache miss).
    reportCacheFault(cache, err);
    return { result: await execute(request), fromCache: false };
  }
  const [entry, watermark] = lookup;

  if (entry !== undefined && isPageFresh(entry, { ttlMs, watermark, now: now() })) {
    return { result: entry.result, fromCache: true };
  }

  const result = await execute(request);
  if (result.status >= 200 && result.status < 300) {
    try {
      await cache.store.set(key, { cachedAt: now(), result });
    } catch (err) {
      // Best-effort: failing to cache must not fail the walk — we already have
      // the page. Report and carry on.
      reportCacheFault(cache, err);
    }
  }
  return { result, fromCache: false };
}

/** Hand a store fault to the caller's `onCacheFault` hook, normalized to an
 * `Error`. A throwing hook is itself swallowed — observability must never break
 * a walk. */
function reportCacheFault(cache: PageCacheBinding, err: unknown): void {
  if (cache.onCacheFault === undefined) return;
  try {
    cache.onCacheFault(err instanceof Error ? err : new Error(String(err)));
  } catch {
    // intentionally ignored: a faulty fault-reporter cannot be allowed to abort
    // pagination — the cache is performance, never correctness.
  }
}
