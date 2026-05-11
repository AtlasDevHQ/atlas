/**
 * Vercel AI Gateway model catalog — server-side fetch + TTL cache.
 *
 * The catalog is at `GET https://ai-gateway.vercel.sh/v1/models` and is
 * unauthenticated, so any deploy can pull it. We cache the result in
 * memory with a configurable TTL (`ATLAS_GATEWAY_CATALOG_TTL_MS`,
 * default 30 minutes) so the admin picker doesn't hammer the gateway
 * on every page load.
 *
 * On fetch failure we fall back to a small bundled manifest of curated
 * "recommended" entries so the picker UI is never empty, and surface
 * the `fallback: true` flag so the UI can show a banner.
 *
 * `load()` is the inflight-promise pattern's load-bearing invariant —
 * it never rejects (the catch returns a fallback entry). Concurrent
 * callers share a single inflight promise; if `load()` ever starts
 * rejecting, every caller gets the same rejection and the cache
 * remains null. Keep the always-resolves contract or revisit the
 * dedup pattern.
 */

import type {
  GatewayCatalogModel,
  GatewayCatalogResponse,
  GatewayModelType,
} from "@useatlas/types";
import { GATEWAY_MODEL_TYPES } from "@useatlas/types";
import { createLogger } from "./logger";

const log = createLogger("gateway-catalog");

const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
const DEFAULT_TTL_MS = 30 * 60 * 1_000; // 30 minutes
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Curated subset surfaced as "recommended" in the picker. IDs must match the
 * gateway model `id` field exactly (gateway uses dot-version like
 * `anthropic/claude-opus-4.6`, not hyphen-version). Curation policy: anchor on
 * a flagship + a cheap-fast pair per major provider; keep the list under ~10
 * so the recommended group fits without scrolling.
 */
const RECOMMENDED_MODEL_IDS: ReadonlySet<string> = new Set([
  "anthropic/claude-opus-4.7",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "google/gemini-2.0-flash",
]);

/**
 * Minimal bundled fallback. Used only when the live fetch fails so the
 * picker still functions; pricing fields are intentionally omitted —
 * the live catalog is authoritative for cost.
 */
const FALLBACK_MODELS: GatewayCatalogModel[] = [
  {
    id: "anthropic/claude-opus-4.7",
    name: "Claude Opus 4.7",
    provider: "anthropic",
    type: "language",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputPrice: null,
    outputPrice: null,
    recommended: true,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    type: "language",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputPrice: null,
    outputPrice: null,
    recommended: true,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    type: "language",
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    inputPrice: null,
    outputPrice: null,
    recommended: true,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o mini",
    provider: "openai",
    type: "language",
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    inputPrice: null,
    outputPrice: null,
    recommended: true,
  },
];

interface RawCatalogEntry {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  context_window?: unknown;
  max_tokens?: unknown;
  pricing?: { input?: unknown; output?: unknown } | unknown;
}

interface CatalogCacheEntry {
  models: GatewayCatalogModel[];
  fetchedAt: string;
  fallback: boolean;
  expiresAt: number;
}

let cache: CatalogCacheEntry | null = null;
let inflight: Promise<CatalogCacheEntry> | null = null;

function ttlMs(): number {
  const raw = process.env.ATLAS_GATEWAY_CATALOG_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  // Vercel may serialize pricing as numbers — coerce to string so the wire
  // shape stays uniform without us needing a numeric pricing type.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function deriveProvider(id: string): string {
  const slashIdx = id.indexOf("/");
  return slashIdx > 0 ? id.slice(0, slashIdx) : "unknown";
}

function asGatewayModelType(value: unknown): GatewayModelType {
  // Closed set per Vercel docs; fall back to `language` on unknown so a
  // forward-compat schema change doesn't break the picker.
  return (GATEWAY_MODEL_TYPES as readonly string[]).includes(value as string)
    ? (value as GatewayModelType)
    : "language";
}

function normalizeEntry(raw: RawCatalogEntry): GatewayCatalogModel | null {
  const id = asString(raw.id);
  if (!id) return null;
  const pricing = (raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {}) as {
    input?: unknown;
    output?: unknown;
  };
  return {
    id,
    name: asString(raw.name) ?? id,
    provider: deriveProvider(id),
    type: asGatewayModelType(raw.type),
    contextWindow: asPositiveInt(raw.context_window),
    maxOutputTokens: asPositiveInt(raw.max_tokens),
    inputPrice: asString(pricing.input),
    outputPrice: asString(pricing.output),
    recommended: RECOMMENDED_MODEL_IDS.has(id),
  };
}

async function fetchLiveCatalog(): Promise<GatewayCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(GATEWAY_CATALOG_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`gateway catalog returned ${res.status}`);
    }
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) {
      throw new Error("gateway catalog response missing `data` array");
    }
    const normalized: GatewayCatalogModel[] = [];
    let dropped = 0;
    for (const entry of body.data) {
      const model =
        entry && typeof entry === "object" ? normalizeEntry(entry as RawCatalogEntry) : null;
      if (model) normalized.push(model);
      else dropped += 1;
    }
    if (dropped > 0) {
      log.warn(
        { dropped, kept: normalized.length },
        "gateway-catalog: dropped malformed entries from upstream",
      );
    }
    return normalized;
  } finally {
    clearTimeout(timeout);
  }
}

async function load(): Promise<CatalogCacheEntry> {
  const now = Date.now();
  try {
    const models = await fetchLiveCatalog();
    return {
      models,
      fetchedAt: new Date(now).toISOString(),
      fallback: false,
      expiresAt: now + ttlMs(),
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "gateway-catalog: live fetch failed; returning bundled fallback",
    );
    return {
      models: FALLBACK_MODELS,
      fetchedAt: new Date(now).toISOString(),
      fallback: true,
      // Short TTL on fallback so we retry sooner than a healthy cache cycle.
      expiresAt: now + Math.min(ttlMs(), 60_000),
    };
  }
}

/**
 * Return the cached catalog if fresh; refresh asynchronously when stale.
 * Concurrent callers during a refresh share a single inflight promise.
 */
export async function getGatewayCatalog(): Promise<GatewayCatalogResponse> {
  if (cache && cache.expiresAt > Date.now()) {
    return { models: cache.models, fetchedAt: cache.fetchedAt, fallback: cache.fallback };
  }
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  const entry = await inflight;
  cache = entry;
  return { models: entry.models, fetchedAt: entry.fetchedAt, fallback: entry.fallback };
}

/** Test-only: clears the cache so each test sees a clean fetch path. */
export function __resetGatewayCatalogCacheForTests(): void {
  cache = null;
  inflight = null;
}

/** Test-only: inspect the curated recommended list. */
export function __getRecommendedIdsForTests(): ReadonlySet<string> {
  return RECOMMENDED_MODEL_IDS;
}
