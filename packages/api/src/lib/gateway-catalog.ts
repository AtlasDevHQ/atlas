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
function recommendedModelIds(): readonly string[] {
  const raw = getSetting("ATLAS_RECOMMENDED_MODELS");
  if (raw === undefined) return [];
  // Ordered, not a Set (#4869 review): the Recommended group used to render in
  // CATALOG order, silently discarding the operator's curation order — the
  // setting is a ranked shortlist and the first entry is the house default.
  // De-duplicated while preserving first-seen position.
  return [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0))];
}

/** Terse constructor for {@link FALLBACK_MODELS} — every entry shares 8 of 10 fields. */
function fallbackModel(
  id: string,
  name: string,
  contextWindow: number,
  maxOutputTokens: number,
): GatewayCatalogModel {
  return {
    id,
    name,
    provider: deriveProvider(id),
    type: "language",
    contextWindow,
    maxOutputTokens,
    inputPrice: null,
    outputPrice: null,
    recommended: false,
    supportsTools: true,
  };
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
 *
 * KEEP IN SYNC with the `ATLAS_RECOMMENDED_MODELS` registry default in
 * `settings.ts` (#4869 review). This list previously predated the shipped
 * shortlist entirely — opus-4.8 / sonnet-5 / gpt-4o / gpt-4o-mini against a
 * shortlist of opus-5 / gpt-5.6-* / fable-5 / glm-5.2 / kimi-k3. During an
 * outage an admin on `anthropic/claude-opus-5` saw their own model as a raw ID
 * and every selectable option a generation behind, so the only way to change
 * models was to downgrade. Context windows verified against the live catalog
 * 2026-07-28; a value here that is WRONG is worse than one that is missing,
 * which is why `peekModelContextWindow` refuses to read this manifest at all.
 */
const FALLBACK_MODELS: GatewayCatalogModel[] = [
  fallbackModel("anthropic/claude-opus-5", "Claude Opus 5", 1_000_000, 128_000),
  fallbackModel("anthropic/claude-sonnet-5", "Claude Sonnet 5", 1_000_000, 128_000),
  fallbackModel("anthropic/claude-fable-5", "Claude Fable 5", 1_000_000, 128_000),
  fallbackModel("anthropic/claude-haiku-4.5", "Claude Haiku 4.5", 200_000, 64_000),
  fallbackModel("anthropic/claude-opus-4.8", "Claude Opus 4.8", 1_000_000, 128_000),
  fallbackModel("openai/gpt-5.6-sol", "GPT-5.6 Sol", 1_050_000, 128_000),
  fallbackModel("openai/gpt-5.6-terra", "GPT-5.6 Terra", 1_050_000, 128_000),
  fallbackModel("openai/gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000, 128_000),
  fallbackModel("zai/glm-5.2", "GLM-5.2", 204_800, 128_000),
  fallbackModel("moonshotai/kimi-k3", "Kimi K3", 262_144, 128_000),
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
  // Unrecognized types fail CLOSED to `other`, never to `language` (#4869
  // review). `language` is the one value that passes the picker's type gate, so
  // falling back to it meant a type the gateway adds tomorrow would be offered
  // as a selectable chat model. The capability gate is not a sufficient
  // backstop: `supported_parameters` is absent on 97 of the 101 current
  // non-language entries, so such an entry gets `supportsTools: null`
  // ("unknown") and `null !== false` passes.
  //
  // Unknown types are collected by the caller and logged ONCE per fetch rather
  // than per entry — a new type typically arrives as a whole family at once.
  return (GATEWAY_MODEL_TYPES as readonly string[]).includes(value as string)
    ? (value as GatewayModelType)
    : "other";
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
  // Element shape is checked, not just the array-ness (#4869 review). Without
  // this, an upstream reshape from `["tools"]` to `[{name:"tools"}]` would make
  // `.includes("tools")` return false for EVERY language model — fail-closed,
  // emptying the picker with `fallback: false` so not even the outage banner
  // fires. A non-string element means "shape changed, we can't read it" →
  // `null` (unknown), matching the documented fail-open contract.
  if (!raw.supported_parameters.every((p) => typeof p === "string")) return null;
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
 * Whether a catalog entry can actually drive Atlas's agent loop.
 *
 * Server-side twin of `isSelectable` in
 * `packages/web/src/ui/components/admin/gateway-model-picker.tsx`. Kept in sync
 * by hand and by matching behavior tests on both sides — see the note in
 * `@useatlas/types`' model-config for why this can't be shared from there yet
 * (published-package pinning in the scaffold templates).
 *
 * Two gates:
 *  - `type === "language"` — the gateway also serves embedding, image, video,
 *    reranking, transcription, realtime, speech, and anything it adds next
 *    (normalized to `other`, which is why the type fallback must fail closed).
 *  - `supportsTools !== false` — Atlas is tool-driven. `null` means the catalog
 *    didn't say, which is NOT "no": the BYOT direct-provider catalogs publish
 *    no capability data, so `null` must stay visible.
 */
export function isSelectableGatewayModel(model: GatewayCatalogModel): boolean {
  return model.type === "language" && model.supportsTools !== false;
}

/**
 * Overlay the operator's curated shortlist onto a cached catalog.
 *
 * Returns fresh objects rather than mutating: the cache entry is shared across
 * concurrent callers, and stamping it in place would leak one request's
 * resolved shortlist into the next.
 */
function applyRecommended(
  models: GatewayCatalogModel[],
  fallback: boolean,
): GatewayCatalogModel[] {
  const ids = recommendedModelIds();
  if (ids.length === 0) return models;
  const idSet = new Set(ids);

  // A curated ID the gateway no longer serves can't be caught by a type-check
  // or a unit test — it only shows up against the live catalog, and it fails
  // silently (the Recommended group just renders short). `google/gemini-2.0-flash`
  // sat dead in the old hardcoded list until it was found by hand. Warn so the
  // next one surfaces in logs rather than in a screenshot.
  //
  // NEVER warn off the bundled fallback (#4869 review). It is a small emergency
  // manifest, so during a gateway outage this accused CORRECT ids of being
  // retired and told the operator to "prune or replace them" — once per
  // request, at 60s fallback TTL, for the duration of the incident. An
  // operator who complied would destroy a valid shortlist. Absence from the
  // fallback is not evidence.
  if (!fallback) {
    const byId = new Map(models.map((m) => [m.id, m]));
    const stale = ids.filter((id) => !byId.has(id));
    if (stale.length > 0) warnStaleShortlistOnce(stale, ids.length);

    // Distinct failure, distinct message: the id IS served, but it can't drive
    // the agent loop, so the picker filters it out. Without this the operator
    // sees a short Recommended group and no explanation anywhere.
    const unusable = ids.filter((id) => {
      const hit = byId.get(id);
      return hit !== undefined && !isSelectableGatewayModel(hit);
    });
    if (unusable.length > 0) warnUnusableShortlistOnce(unusable);
  }

  // Recommended entries first, in the operator's configured order, then the
  // rest in catalog order. The picker splits on the `recommended` flag and
  // preserves relative order within each group, so ordering here is what makes
  // the shortlist ranked rather than alphabetical-by-accident.
  const recommended: GatewayCatalogModel[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const hit = models.find((m) => m.id === id);
    if (hit) {
      recommended.push({ ...hit, recommended: true });
      seen.add(id);
    }
  }
  const rest = models.filter((m) => !seen.has(m.id));
  return [...recommended, ...rest];
}

/**
 * De-duplicated stale-shortlist warning.
 *
 * `applyRecommended` runs on every catalog read (several per admin page load),
 * so an un-deduped warn buries the one genuinely-stale ID that matters under
 * repeats. Keyed on the sorted ID set so a CHANGED shortlist warns again.
 * Mirrors `warnInvalidOnce` in `agent-compaction.ts`.
 */
const warnedStaleShortlists = new Set<string>();
const warnedUnusableShortlists = new Set<string>();

/** Same de-dup discipline as {@link warnStaleShortlistOnce}, different fault. */
function warnUnusableShortlistOnce(unusable: string[]): void {
  const sig = [...unusable].sort().join(",");
  if (warnedUnusableShortlists.has(sig)) return;
  warnedUnusableShortlists.add(sig);
  log.warn(
    { unusable },
    "gateway-catalog: ATLAS_RECOMMENDED_MODELS names model(s) the gateway serves but that cannot call tools — the picker hides them, so the Recommended group renders short",
  );
}
function warnStaleShortlistOnce(stale: string[], configured: number): void {
  const sig = [...stale].sort().join(",");
  if (warnedStaleShortlists.has(sig)) return;
  warnedStaleShortlists.add(sig);
  log.warn(
    { stale, configured },
    "gateway-catalog: ATLAS_RECOMMENDED_MODELS names model(s) the live gateway does not serve — they are skipped; prune or replace them",
  );
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
    const droppedIds: string[] = [];
    const unknownTypes = new Set<string>();
    for (const entry of body.data) {
      const raw = entry && typeof entry === "object" ? (entry as RawCatalogEntry) : null;
      const model = raw ? normalizeEntry(raw) : null;
      if (model) {
        normalized.push(model);
        // Recorded from the RAW value: `model.type` has already been collapsed
        // to `other`, so only the pre-normalization value names the new type.
        if (
          model.type === "other" &&
          typeof raw?.type === "string" &&
          !(GATEWAY_MODEL_TYPES as readonly string[]).includes(raw.type)
        ) {
          unknownTypes.add(raw.type);
        }
      } else {
        // The IDs, not just a count (#4869 review) — a count alone can't tell
        // you whether the workspace's own saved model was one of the casualties.
        const id = raw ? asString(raw.id) : null;
        droppedIds.push(id ?? "<no id>");
      }
    }
    if (droppedIds.length > 0) {
      log.warn(
        { dropped: droppedIds.length, droppedIds: droppedIds.slice(0, 20), kept: normalized.length },
        "gateway-catalog: dropped malformed entries from upstream",
      );
    }
    if (unknownTypes.size > 0) {
      log.warn(
        { unknownTypes: [...unknownTypes] },
        "gateway-catalog: upstream published model type(s) Atlas does not know — mapped to `other` and hidden from the picker; add them to GATEWAY_MODEL_TYPES if they should be selectable",
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
      models: applyRecommended(cache.models, cache.fallback),
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
    models: applyRecommended(entry.models, entry.fallback),
    fetchedAt: entry.fetchedAt,
    fallback: entry.fallback,
  };
}

/**
 * Synchronous, non-fetching lookup of a model's context window from whatever
 * catalog is already in memory. Returns `null` when the cache is cold, stale,
 * or has no entry for `modelId`.
 *
 * Exists for the compaction trigger, which resolves its settings once per turn
 * and keeps a sync signature. NOTE: `resolveCompactionSettings` is called from
 * an async scope in `agent.ts`, so awaiting the catalog there IS possible and
 * would make this peek unnecessary — see the tier-2 comment in
 * `agent-compaction.ts`. This stays sync for now as the smaller change.
 *
 * Deliberately does NOT trigger a refresh: a cold cache must stay cheap and
 * silent on the hot path. Callers fall back to the static table, and the cache
 * warms via {@link warmGatewayCatalog} or the first admin who opens the picker.
 *
 * A stale (TTL-expired) cache is treated as a miss rather than served: a model's
 * context window can change between catalog revisions, and compaction sizing is
 * exactly where a stale number does damage.
 *
 * A FALLBACK cache is also a miss (#4869 review). The bundled manifest is four
 * hand-maintained constants that were never fetched from anywhere — strictly
 * worse than a stale real number, and worse still because it reported as
 * `contextWindowSource: "catalog"`. It had `opus-4.8` at 200k against a real
 * 1M, so a gateway outage silently changed a workspace's compaction threshold.
 */
export function peekModelContextWindow(modelId: string | undefined): number | null {
  if (!modelId || !cache || cache.fallback || cache.expiresAt <= Date.now()) return null;
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
    // REACHABLE, despite `load()` swallowing fetch failures (#4869 review):
    // `getGatewayCatalog` runs `applyRecommended()` → `recommendedModelIds()`
    // → `getSetting()` AFTER `await inflight`, entirely outside `load()`'s try.
    // Anything that throws there rejects this promise. The module header's
    // "never rejects" invariant is about `load()` specifically, not this.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "gateway-catalog: background warm failed",
    );
  });
}

/**
 * Test-only: clears the cache so each test sees a clean fetch path.
 *
 * Also clears the stale-shortlist warn dedup — that Set is module-level and
 * would otherwise let one test's warning suppress the next test's assertion.
 */
export function __resetGatewayCatalogCacheForTests(): void {
  cache = null;
  inflight = null;
  warnedStaleShortlists.clear();
  warnedUnusableShortlists.clear();
}

/** Test-only: the shortlist as currently resolved from settings, in order. */
export function __getRecommendedIdsForTests(): readonly string[] {
  return recommendedModelIds();
}
