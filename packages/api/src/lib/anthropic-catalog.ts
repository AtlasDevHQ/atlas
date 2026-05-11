/**
 * Anthropic BYOT `/v1/models` discovery + per-workspace cache.
 *
 * Workspaces using `provider='anthropic'` save their own API key. We fetch
 * the model catalog from Anthropic with that key and cache it per orgId
 * with a configurable TTL (`ATLAS_BYOT_CATALOG_TTL_MS`, default 6h).
 *
 * Failure shape differs from `gateway-catalog`: gateway is anonymous and
 * we fall back to a curated bundle on outage. Anthropic discovery is
 * keyed by the workspace's secret — a 401/403 means the key is bad,
 * surfacing that to the admin is the whole point. Tagged errors carry
 * the classification up to the route layer; the route maps them to the
 * matching HTTP envelope.
 *
 * Cache invalidation: `setWorkspaceModelConfig` calls
 * `invalidateAnthropicCatalog(orgId)` after a successful upsert so a key
 * rotation flushes the stale entry. Otherwise a rotated key would
 * authenticate but the catalog would stay frozen until TTL elapsed —
 * confusing if the rotation was *because* the old key was scoped wrong.
 */

import type { GatewayCatalogModel } from "@useatlas/types";
import {
  deleteFromDB,
  isFresh,
  loadFromDB,
  storeToDB,
} from "./byot-catalog-store";
import { createLogger } from "./logger";

const log = createLogger("anthropic-catalog");

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1_000; // 6 hours
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Curated subset surfaced as "recommended" in the picker. IDs match the
 * Anthropic /v1/models response. Anchor on flagship + cheap-fast pair.
 */
const RECOMMENDED_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

export class AnthropicCatalogUnauthorized extends Error {
  readonly _tag = "AnthropicCatalogUnauthorized";
  constructor(message: string) {
    super(message);
    this.name = "AnthropicCatalogUnauthorized";
  }
}

export class AnthropicCatalogRateLimited extends Error {
  readonly _tag = "AnthropicCatalogRateLimited";
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "AnthropicCatalogRateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AnthropicCatalogUnavailable extends Error {
  readonly _tag = "AnthropicCatalogUnavailable";
  constructor(message: string) {
    super(message);
    this.name = "AnthropicCatalogUnavailable";
  }
}

interface RawAnthropicModel {
  id?: unknown;
  display_name?: unknown;
  type?: unknown;
  created_at?: unknown;
}

export interface AnthropicCatalogResponse {
  models: GatewayCatalogModel[];
  fetchedAt: string;
  source: "cache" | "fresh";
}

interface CacheEntry {
  models: GatewayCatalogModel[];
  fetchedAt: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function ttlMs(): number {
  const raw = process.env.ATLAS_BYOT_CATALOG_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function normalizeEntry(raw: RawAnthropicModel): GatewayCatalogModel | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const id = raw.id;
  const displayName = typeof raw.display_name === "string" && raw.display_name.length > 0
    ? raw.display_name
    : id;
  return {
    id,
    name: displayName,
    provider: "anthropic",
    type: "language",
    contextWindow: null,
    maxOutputTokens: null,
    inputPrice: null,
    outputPrice: null,
    recommended: RECOMMENDED_MODEL_IDS.has(id),
  };
}

async function fetchAnthropicModels(apiKey: string): Promise<GatewayCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_MODELS_URL, {
      signal: controller.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        accept: "application/json",
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new AnthropicCatalogUnauthorized(
        "Anthropic rejected the workspace API key. Verify it on the AI Provider page.",
      );
    }
    if (res.status === 429) {
      // Clamp Retry-After to a non-negative integer. RFC 9110 §10.2.3
      // requires non-negative; emitting a negative seconds value
      // confuses some clients (browsers retry immediately).
      const retryAfterRaw = res.headers.get("retry-after");
      const parsed = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : NaN;
      const retryAfterSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      throw new AnthropicCatalogRateLimited(
        "Anthropic rate-limited the catalog refresh. Try again shortly.",
        retryAfterSeconds,
      );
    }
    if (!res.ok) {
      throw new AnthropicCatalogUnavailable(
        `Anthropic /v1/models returned ${res.status}. Try again shortly.`,
      );
    }

    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) {
      throw new AnthropicCatalogUnavailable(
        "Anthropic /v1/models response missing `data` array.",
      );
    }

    const normalized: GatewayCatalogModel[] = [];
    let dropped = 0;
    for (const entry of body.data) {
      const model = entry && typeof entry === "object"
        ? normalizeEntry(entry as RawAnthropicModel)
        : null;
      if (model) normalized.push(model);
      else dropped += 1;
    }
    if (dropped > 0) {
      log.warn(
        { dropped, kept: normalized.length },
        "anthropic-catalog: dropped malformed entries from upstream",
      );
    }
    return normalized;
  } catch (err) {
    if (
      err instanceof AnthropicCatalogUnauthorized ||
      err instanceof AnthropicCatalogRateLimited ||
      err instanceof AnthropicCatalogUnavailable
    ) {
      throw err;
    }
    // AbortError / network failures land here. Map to unavailable so the
    // route surfaces a 503 with a clean message rather than a 500.
    const message = err instanceof Error ? err.message : String(err);
    throw new AnthropicCatalogUnavailable(`Anthropic /v1/models fetch failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Return the workspace's cached Anthropic catalog if fresh, otherwise
 * fetch from Anthropic with the supplied BYOT key. Concurrent callers
 * for the same orgId share a single inflight fetch.
 *
 * `opts.refresh` bypasses the cache and forces a fresh fetch (used for
 * the explicit "Refresh now" admin action).
 */
export async function getAnthropicCatalog(
  orgId: string,
  apiKey: string,
  opts: { refresh?: boolean; persist?: boolean } = {},
): Promise<AnthropicCatalogResponse> {
  // `persist` defaults to true. Callers that fetch under synthetic
  // orgIds (e.g. `testModelConfig` probes) pass `persist: false` so the
  // L2 cache doesn't accumulate one row per probe attempt keyed by a
  // throwaway identifier.
  const persist = opts.persist !== false;
  if (!opts.refresh) {
    const hit = cache.get(orgId);
    if (hit && hit.expiresAt > Date.now()) {
      return { models: hit.models, fetchedAt: hit.fetchedAt, source: "cache" };
    }
    if (persist) {
      const fromDb = await loadFromDB(orgId, "anthropic");
      if (fromDb && isFresh(fromDb, ttlMs())) {
        const expiresAt = Date.parse(fromDb.fetchedAt) + ttlMs();
        cache.set(orgId, { models: fromDb.models, fetchedAt: fromDb.fetchedAt, expiresAt });
        return { models: fromDb.models, fetchedAt: fromDb.fetchedAt, source: "cache" };
      }
    }
  }

  let pending = inflight.get(orgId);
  if (!pending) {
    pending = (async (): Promise<CacheEntry> => {
      const models = await fetchAnthropicModels(apiKey);
      const now = Date.now();
      const entry: CacheEntry = {
        models,
        fetchedAt: new Date(now).toISOString(),
        expiresAt: now + ttlMs(),
      };
      cache.set(orgId, entry);
      if (persist) {
        await storeToDB(orgId, "anthropic", "", {
          models: entry.models,
          fetchedAt: entry.fetchedAt,
        });
      }
      return entry;
    })().finally(() => {
      inflight.delete(orgId);
    });
    inflight.set(orgId, pending);
  }
  const entry = await pending;
  return { models: entry.models, fetchedAt: entry.fetchedAt, source: "fresh" };
}

/**
 * Drop the cached catalog for an org. Called from
 * `setWorkspaceModelConfig` after a successful upsert so a key rotation
 * doesn't serve a stale catalog from before the rotation. Flushes L1,
 * the inflight promise (any in-progress old-key fetch resolves into a
 * cache it then re-fills — without dropping inflight, the post-rotation
 * cache resurrects the pre-rotation catalog), and L2 (fire-and-forget
 * so synchronous Effect callers don't await it).
 */
export function invalidateAnthropicCatalog(orgId: string): void {
  cache.delete(orgId);
  inflight.delete(orgId);
  void deleteFromDB(orgId, "anthropic");
}

/** Test-only: clear all cached entries. */
export function __resetAnthropicCatalogCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Test-only: inspect the curated recommended list. */
export function __getRecommendedAnthropicIdsForTests(): ReadonlySet<string> {
  return RECOMMENDED_MODEL_IDS;
}
