/**
 * OpenAI BYOT `/v1/models` discovery + per-workspace cache.
 *
 * Mirrors `anthropic-catalog.ts`. OpenAI's `/v1/models` endpoint
 * returns the workspace's full model entitlement (chat + embeddings +
 * whisper + tts + dall-e + moderation + image), so we filter to
 * chat-capable models before surfacing them in the picker — non-chat
 * IDs would just lead to confusing test-call failures downstream.
 *
 * The cache is per-orgId with a configurable TTL
 * (`ATLAS_BYOT_CATALOG_TTL_MS`, shared with the Anthropic catalog —
 * direct-provider discovery is the same threat model).
 */

import type { GatewayCatalogModel } from "@useatlas/types";
import {
  deleteFromDB,
  isFresh,
  loadFromDB,
  storeToDB,
} from "./byot-catalog-store";
import { createLogger } from "./logger";
import { getSettingAuto } from "@atlas/api/lib/settings";

const log = createLogger("openai-catalog");

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1_000; // 6 hours, matching anthropic-catalog
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Recommended subset surfaced in the picker. Anchored on the flagship
 * (gpt-4o), the cheap-fast pair (gpt-4o-mini), and the reasoning family
 * representative (o3-mini). The set is conservative on purpose — the
 * full catalog is dozens of entries deep, and a flat "everything is
 * equally recommended" payload defeats the picker's grouping affordance.
 */
const RECOMMENDED_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-4o",
  "gpt-4o-mini",
  "o3-mini",
]);

/**
 * Filters /v1/models entries to chat-capable models. OpenAI does not
 * surface a "capability" field on /v1/models, so we filter by ID prefix:
 *   - `gpt-*` — chat completions
 *   - `o*` — reasoning family (o1, o3, …)
 *   - `chatgpt-*` — chat-tuned variants
 * Excludes:
 *   - `text-embedding-*`, `text-search-*` (embeddings)
 *   - `whisper-*` (transcription)
 *   - `tts-*` (text-to-speech)
 *   - `dall-e-*` (image generation)
 *   - `omni-moderation-*`, `text-moderation-*` (moderation)
 *   - `babbage-*`, `davinci-*`, `gpt-3.5-turbo-instruct*` (legacy completion)
 *   - `*-realtime-preview*` (Realtime API; not standard chat)
 */
function isChatCapable(id: string): boolean {
  const normalized = id.toLowerCase();
  if (normalized.includes("realtime")) return false;
  if (normalized.includes("audio")) return false;
  if (normalized.includes("instruct")) return false;
  if (normalized.includes("transcribe")) return false;
  if (normalized.includes("search")) return false;
  if (normalized.includes("moderation")) return false;
  if (normalized.includes("embedding")) return false;
  if (normalized.startsWith("whisper")) return false;
  if (normalized.startsWith("tts-")) return false;
  if (normalized.startsWith("dall-e")) return false;
  if (normalized.startsWith("babbage")) return false;
  if (normalized.startsWith("davinci")) return false;
  // gpt-image / gpt-4o-image variants — image generation surface, not chat.
  if (normalized.startsWith("gpt-image")) return false;
  return normalized.startsWith("gpt-") || normalized.startsWith("o") || normalized.startsWith("chatgpt-");
}

export class OpenAICatalogUnauthorized extends Error {
  readonly _tag = "OpenAICatalogUnauthorized";
  constructor(message: string) {
    super(message);
    this.name = "OpenAICatalogUnauthorized";
  }
}

export class OpenAICatalogRateLimited extends Error {
  readonly _tag = "OpenAICatalogRateLimited";
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "OpenAICatalogRateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class OpenAICatalogUnavailable extends Error {
  readonly _tag = "OpenAICatalogUnavailable";
  constructor(message: string) {
    super(message);
    this.name = "OpenAICatalogUnavailable";
  }
}

interface RawOpenAIModel {
  id?: unknown;
  object?: unknown;
  created?: unknown;
  owned_by?: unknown;
}

export interface OpenAICatalogResponse {
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
  // Platform-scoped settings registry (#3705): DB override > env > default.
  const raw = getSettingAuto("ATLAS_BYOT_CATALOG_TTL_MS");
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function normalizeEntry(raw: RawOpenAIModel): GatewayCatalogModel | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const id = raw.id;
  if (!isChatCapable(id)) return null;
  return {
    id,
    name: id,
    provider: "openai",
    type: "language",
    contextWindow: null,
    maxOutputTokens: null,
    inputPrice: null,
    outputPrice: null,
    recommended: RECOMMENDED_MODEL_IDS.has(id),
  };
}

async function fetchOpenAIModels(apiKey: string): Promise<GatewayCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new OpenAICatalogUnauthorized(
        "OpenAI rejected the workspace API key. Verify it on the AI Provider page.",
      );
    }
    if (res.status === 429) {
      // RFC 9110 §10.2.3 — Retry-After is non-negative. Clamp to keep
      // the response header lawful and avoid client-side immediate-retry
      // bugs on negative values.
      const retryAfterRaw = res.headers.get("retry-after");
      const parsed = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : NaN;
      const retryAfterSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      throw new OpenAICatalogRateLimited(
        "OpenAI rate-limited the catalog refresh. Try again shortly.",
        retryAfterSeconds,
      );
    }
    if (!res.ok) {
      throw new OpenAICatalogUnavailable(
        `OpenAI /v1/models returned ${res.status}. Try again shortly.`,
      );
    }

    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) {
      throw new OpenAICatalogUnavailable(
        "OpenAI /v1/models response missing `data` array.",
      );
    }

    const normalized: GatewayCatalogModel[] = [];
    let dropped = 0;
    let filtered = 0;
    for (const entry of body.data) {
      if (!entry || typeof entry !== "object") {
        dropped += 1;
        continue;
      }
      const raw = entry as RawOpenAIModel;
      const idMaybe = typeof raw.id === "string" ? raw.id : null;
      const model = normalizeEntry(raw);
      if (model) normalized.push(model);
      else if (idMaybe) filtered += 1;
      else dropped += 1;
    }
    if (dropped > 0 || filtered > 0) {
      log.debug(
        { dropped, filtered, kept: normalized.length },
        "openai-catalog: drop+filter applied to upstream response",
      );
    }
    return normalized;
  } catch (err) {
    if (
      err instanceof OpenAICatalogUnauthorized ||
      err instanceof OpenAICatalogRateLimited ||
      err instanceof OpenAICatalogUnavailable
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new OpenAICatalogUnavailable(`OpenAI /v1/models fetch failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Return the workspace's cached OpenAI catalog if fresh, otherwise fetch
 * from OpenAI with the supplied BYOT key. Concurrent callers for the
 * same orgId share a single inflight fetch (matches anthropic-catalog).
 */
export async function getOpenAICatalog(
  orgId: string,
  apiKey: string,
  opts: { refresh?: boolean; persist?: boolean } = {},
): Promise<OpenAICatalogResponse> {
  // See anthropic-catalog for `persist` rationale — synthetic-orgId
  // probes pass `false` to keep L2 free of test-only rows.
  const persist = opts.persist !== false;
  if (!opts.refresh) {
    const hit = cache.get(orgId);
    if (hit && hit.expiresAt > Date.now()) {
      return { models: hit.models, fetchedAt: hit.fetchedAt, source: "cache" };
    }
    if (persist) {
      const fromDb = await loadFromDB(orgId, "openai");
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
      const models = await fetchOpenAIModels(apiKey);
      const now = Date.now();
      const entry: CacheEntry = {
        models,
        fetchedAt: new Date(now).toISOString(),
        expiresAt: now + ttlMs(),
      };
      cache.set(orgId, entry);
      if (persist) {
        await storeToDB(orgId, "openai", "", {
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
 * Drop the cached catalog for an org (L1 + inflight + L2). Called from
 * `setWorkspaceModelConfig` on a successful openai upsert. The inflight
 * drop is what makes a key rotation safe under concurrent in-flight
 * fetches — see anthropic-catalog for the race scenario.
 */
export function invalidateOpenAICatalog(orgId: string): void {
  cache.delete(orgId);
  inflight.delete(orgId);
  void deleteFromDB(orgId, "openai");
}

/** Test-only: clear all cached entries. */
export function __resetOpenAICatalogCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Test-only: inspect the curated recommended list. */
export function __getRecommendedOpenAIIdsForTests(): ReadonlySet<string> {
  return RECOMMENDED_MODEL_IDS;
}
