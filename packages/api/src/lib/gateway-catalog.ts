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
import { getSetting } from "./settings";

const log = createLogger("gateway-catalog");

const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
const DEFAULT_TTL_MS = 30 * 60 * 1_000; // 30 minutes
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The shortlist starred at the top of the picker, read from the
 * `ATLAS_RECOMMENDED_MODELS` setting (#4869). IDs must match the gateway model
 * `id` field exactly — the gateway uses dot-version (`anthropic/claude-opus-5`),
 * not hyphen-version.
 *
 * Read per call rather than memoized: the setting is hot-reloadable, and the
 * whole point of moving it out of source was that curation shouldn't wait for a
 * deploy. It shouldn't wait for a cache TTL either, so this is resolved at
 * response time and overlaid onto the cached catalog (which stores only
 * upstream facts — pricing, capability, context window).
 *
 * A blank setting means "no Recommended group", not "fall back to a default" —
 * an operator who clears the list gets an empty group, which is what they asked
 * for. The registry default seeds a sensible starting shortlist.
 */
function recommendedModelIds(): ReadonlySet<string> {
  const raw = getSetting("ATLAS_RECOMMENDED_MODELS");
  if (raw === undefined) return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/**
 * Minimal bundled fallback. Used only when the live fetch fails so the
 * picker still functions; pricing fields are intentionally omitted —
 * the live catalog is authoritative for cost. Every entry is hand-picked
 * and tool-calling, hence `supportsTools: true` rather than `null`: these
 * must survive the picker's capability filter or a gateway outage would
 * leave the admin with an empty picker.
 *
 * `recommended: false` on every entry is not an oversight — the flag is
 * overlaid from `ATLAS_RECOMMENDED_MODELS` by `applyRecommended()` like any
 * other catalog entry, so a fallback model is starred iff the operator listed
 * it. Hardcoding `true` here would put a star on models the operator removed.
 */
const FALLBACK_MODELS: GatewayCatalogModel[] = [
  {
    id: "anthropic/claude-opus-4.8",
    name: "Claude Opus 4.8",
    provider: "anthropic",
    type: "language",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputPrice: null,
    outputPrice: null,
    recommended: false,
    supportsTools: true,
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    type: "language",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPrice: null,
    outputPrice: null,
    recommended: false,
    supportsTools: true,
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
    recommended: false,
    supportsTools: true,
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
    recommended: false,
    supportsTools: true,
  },
];

interface RawCatalogEntry {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  context_window?: unknown;
  max_tokens?: unknown;
  pricing?: unknown;
  supported_parameters?: unknown;
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

/**
 * Whether the entry advertises tool-calling.
 *
 * The gateway publishes two equivalent signals — a `tool-use` member of `tags`
 * and a `tools` member of `supported_parameters`. Measured against the live
 * catalog (2026-07-28, 306 entries) the two agree on 204/204 language models,
 * but `supported_parameters` is present on all 204 while `tags` is missing on
 * 2 — so `supported_parameters` is the one to trust.
 *
 * Returns `null` (unknown) when the field is absent entirely, so a future
 * upstream schema change degrades to "don't filter" instead of hiding the
 * whole catalog. Only an explicit, parseable array yields `false`.
 */
function readToolSupport(raw: RawCatalogEntry): boolean | null {
  if (!Array.isArray(raw.supported_parameters)) return null;
  return raw.supported_parameters.includes("tools");
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
    // Always false here. `recommended` is not an upstream fact — it's local
    // curation from a hot-reloadable setting, so it's overlaid at response
    // time by `applyRecommended()`. Stamping it into the cached entry would
    // pin an operator's edit behind the 30-minute catalog TTL.
    recommended: false,
    supportsTools: readToolSupport(raw),
  };
}

/**
 * Overlay the operator's curated shortlist onto a cached catalog.
 *
 * Returns fresh objects rather than mutating: the cache entry is shared across
 * concurrent callers, and stamping it in place would leak one request's
 * resolved shortlist into the next.
 */
function applyRecommended(models: GatewayCatalogModel[]): GatewayCatalogModel[] {
  const ids = recommendedModelIds();
  if (ids.size === 0) return models;

  // A curated ID the gateway no longer serves can't be caught by a type-check
  // or a unit test — it only shows up against the live catalog, and it fails
  // silently (the Recommended group just renders short). `google/gemini-2.0-flash`
  // sat dead in the old hardcoded list until it was found by hand. Warn so the
  // next one surfaces in logs rather than in a screenshot.
  const liveIds = new Set(models.map((m) => m.id));
  const stale = [...ids].filter((id) => !liveIds.has(id));
  if (stale.length > 0) {
    log.warn(
      { stale, configured: ids.size },
      "gateway-catalog: ATLAS_RECOMMENDED_MODELS names model(s) the gateway does not serve — they are skipped; prune or replace them",
    );
  }

  return models.map((m) => (ids.has(m.id) ? { ...m, recommended: true } : m));
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
    return {
      models: applyRecommended(cache.models),
      fetchedAt: cache.fetchedAt,
      fallback: cache.fallback,
    };
  }
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  const entry = await inflight;
  cache = entry;
  return {
    models: applyRecommended(entry.models),
    fetchedAt: entry.fetchedAt,
    fallback: entry.fallback,
  };
}

/**
 * Synchronous, non-fetching lookup of a model's context window from whatever
 * catalog is already in memory. Returns `null` when the cache is cold, stale,
 * or has no entry for `modelId`.
 *
 * Exists for the compaction trigger, which runs inside `prepareStep` on every
 * agent step and therefore CANNOT await a network fetch. That constraint is why
 * `agent-compaction.ts` carries a static family→window table at all; this lets
 * it prefer the authoritative per-model number when we happen to have it,
 * without changing its sync contract.
 *
 * Deliberately does NOT trigger a refresh: a cold cache must stay cheap and
 * silent on the hot path. Callers fall back to the static table, and the cache
 * warms via {@link warmGatewayCatalog} or the first admin who opens the picker.
 *
 * A stale (TTL-expired) cache is treated as a miss rather than served: a model's
 * context window can change between catalog revisions, and compaction sizing is
 * exactly where a stale number does damage.
 */
export function peekModelContextWindow(modelId: string | undefined): number | null {
  if (!modelId || !cache || cache.expiresAt <= Date.now()) return null;
  const hit = cache.models.find((m) => m.id === modelId);
  return hit?.contextWindow ?? null;
}

/**
 * Fire-and-forget cache warm. Safe to call from a non-async context: it never
 * throws (`load()` resolves even on fetch failure) and concurrent calls share
 * the single inflight promise, so it can't stampede the gateway.
 */
export function warmGatewayCatalog(): void {
  if (cache && cache.expiresAt > Date.now()) return;
  void getGatewayCatalog().catch((err) => {
    // Unreachable in practice — `load()` swallows fetch failures into the
    // bundled fallback — but an unhandled rejection here would be a process
    // -level event, so it stays explicitly handled rather than assumed away.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "gateway-catalog: background warm failed",
    );
  });
}

/** Test-only: clears the cache so each test sees a clean fetch path. */
export function __resetGatewayCatalogCacheForTests(): void {
  cache = null;
  inflight = null;
}

/** Test-only: the shortlist as currently resolved from settings. */
export function __getRecommendedIdsForTests(): ReadonlySet<string> {
  return recommendedModelIds();
}
