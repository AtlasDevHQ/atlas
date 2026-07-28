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
import { createLogger, getRequestContext } from "./logger";
import { getSetting } from "./settings";

const log = createLogger("gateway-catalog");

const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
const DEFAULT_TTL_MS = 30 * 60 * 1_000; // 30 minutes
const FETCH_TIMEOUT_MS = 10_000;

/**
 * How long a HOT PATH (an agent turn, an operator page load) will wait for a
 * cold catalog before giving up and proceeding on its own static fallback.
 *
 * Deliberately far below {@link FETCH_TIMEOUT_MS} (#4872). The 10s fetch ceiling
 * is the right bound for the ADMIN picker, which has nothing to render without
 * the catalog and a spinner to show meanwhile; it is much too long to sit in
 * front of an agent turn. So hot-path callers race the load against this budget:
 * whichever finishes first wins, and losing the race is never an error — the
 * caller falls through to its static table exactly as if the cache were cold.
 *
 * The abandoned load is NOT cancelled. It keeps running against the full 10s
 * fetch timeout and populates the shared cache, so the next caller reads it for
 * free.
 *
 * The cost is therefore once per CACHE FILL, not once per turn: once per cold
 * start, once per TTL expiry (30 minutes by default, `ATLAS_GATEWAY_CATALOG_TTL_MS`),
 * and — during a sustained outage — once per 60s fallback TTL (`load()` shortens
 * the TTL on failure so it retries sooner). Note the cache is only written when a load LANDS, so every turn that
 * starts while a cold load is still in flight pays its own budget; on a busy
 * process with a slow gateway that is every turn in the window, not one.
 */
const HOT_PATH_BUDGET_MS = 1_500;

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
 * which is why `lookupModelContextWindow` refuses to read this manifest at all.
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

/**
 * USD per MILLION tokens — a branded number, not a bare one (#4869 review).
 *
 * This module handles the same fact in two units six lines apart: the wire
 * fields `inputPrice`/`outputPrice` are per-TOKEN strings straight from the
 * gateway, while `CatalogModelPricing` is per-MILLION-token numbers. The
 * conversion is a factor of 1e6, and with both sides typed `number` a
 * per-token value assigned into a per-MTok slot type-checks cleanly and
 * under-reports cost by a million times.
 *
 * The brand makes that assignment a compile error. `asPerMTok` is the only
 * constructor, so the multiplication happens exactly once and anything that
 * skips it can't reach a `CatalogModelPricing` field.
 *
 * Consumers do arithmetic on it normally (a branded number IS a number); only
 * ASSIGNMENT into a per-MTok slot is gated.
 */
export type UsdPerMTok = number & { readonly __brand: "UsdPerMTok" };

/**
 * Per-model rates in USD per MILLION tokens, normalized from the catalog's
 * per-token strings.
 *
 * Server-side only — deliberately NOT part of `GatewayCatalogModel` and never
 * on the wire. The picker needs the headline input/output price it already
 * gets; this is the fuller breakdown the operator cost estimator needs, and
 * keeping it off the response holds to this module's original line that
 * "pricing tiers and architecture detail stay on the server".
 *
 * Only the BASE rate is read. The gateway also publishes `regional` overrides,
 * `*_tiers` (long-context step pricing) and `service_tiers` (priority/flex) —
 * all real, all refinements on top of a number that is already an estimate for
 * an operator dashboard. Modelling them would imply a precision this signal
 * doesn't have; `token-pricing.ts` is explicit that it is not a billing source
 * of truth (`gateway_cost_usd` is).
 */
export interface CatalogModelPricing {
  /** USD per million fresh (uncached) input tokens. */
  readonly inputPerMTok: UsdPerMTok;
  /** USD per million output tokens. */
  readonly outputPerMTok: UsdPerMTok;
  /** USD per million cache-read input tokens; `null` when unpublished. */
  readonly cacheReadPerMTok: UsdPerMTok | null;
  /** USD per million cache-write input tokens; `null` when unpublished. */
  readonly cacheWritePerMTok: UsdPerMTok | null;
}

interface CatalogCacheEntry {
  models: GatewayCatalogModel[];
  /** Model id → normalized rates. Empty on the bundled fallback. */
  prices: Map<string, CatalogModelPricing>;
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

const TOKENS_PER_MILLION = 1_000_000;

/**
 * A per-token price string/number → USD per million tokens.
 *
 * `0` is a REAL price, not a missing one (#4869 review). Three live language
 * models publish `input: "0", output: "0"` — `inclusionai/ling-3.0-flash-free`,
 * `poolside/laguna-s-2.1-free`, `zai/glm-4.6v-flash` — and they are genuinely
 * free. Folding them into "unpriced" made the demo page render "—" when the
 * true answer is $0.00, and permanently flipped `costComplete: false` on any
 * rollup containing one. Only a NEGATIVE rate is nonsense; absence is absence.
 */
function asPerMTok(value: unknown): UsdPerMTok | null {
  const raw = asString(value);
  if (raw === null) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  // The ONE place the per-token → per-MTok conversion happens, and the only
  // place the brand is minted.
  return (parsed * TOKENS_PER_MILLION) as UsdPerMTok;
}

/**
 * Normalized rates for one entry, or `null` when the catalog publishes no
 * usable input/output pair (3 of 204 language models — the `perplexity/sonar*`
 * trio, which publish no `pricing` values at all — plus the non-language
 * types). Both base rates are required: a half-priced model would silently
 * under-report, which is worse than falling back.
 *
 * Measured 2026-07-28: NO live model publishes exactly one of input/output, so
 * this guard costs nothing today. It stays as a forward guard. (An earlier
 * version of this comment said "3 of 204" while also counting the three
 * zero-priced models as unpriced — those are now correctly priced at $0.)
 */
function normalizePricing(raw: RawCatalogEntry): CatalogModelPricing | null {
  if (!raw.pricing || typeof raw.pricing !== "object") return null;
  const p = raw.pricing as Record<string, unknown>;
  const inputPerMTok = asPerMTok(p.input);
  const outputPerMTok = asPerMTok(p.output);
  if (inputPerMTok === null || outputPerMTok === null) return null;
  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: asPerMTok(p.input_cache_read),
    cacheWritePerMTok: asPerMTok(p.input_cache_write),
  };
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

interface LiveCatalog {
  models: GatewayCatalogModel[];
  prices: Map<string, CatalogModelPricing>;
}

async function fetchLiveCatalog(): Promise<LiveCatalog> {
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
    const prices = new Map<string, CatalogModelPricing>();
    for (const entry of body.data) {
      const raw = entry && typeof entry === "object" ? (entry as RawCatalogEntry) : null;
      const model = raw ? normalizeEntry(raw) : null;
      if (model && raw) {
        normalized.push(model);
        // Priced separately from the wire entry: `prices` carries the cache
        // read/write split the estimator needs and the picker doesn't.
        const rate = normalizePricing(raw);
        if (rate) prices.set(model.id, rate);
        // Recorded from the RAW value: `model.type` has already been collapsed
        // to `other`, so only the pre-normalization value names the new type.
        if (
          model.type === "other" &&
          typeof raw.type === "string" &&
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
    return { models: normalized, prices };
  } finally {
    clearTimeout(timeout);
  }
}

async function load(): Promise<CatalogCacheEntry> {
  const now = Date.now();
  try {
    const { models, prices } = await fetchLiveCatalog();
    return {
      models,
      prices,
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
      // The bundled fallback carries no pricing on purpose (the live catalog is
      // authoritative for cost), so the estimator falls back to its static
      // family rates rather than pricing off stale bundled numbers.
      prices: new Map(),
      fetchedAt: new Date(now).toISOString(),
      fallback: true,
      // Short TTL on fallback so we retry sooner than a healthy cache cycle.
      expiresAt: now + Math.min(ttlMs(), 60_000),
    };
  }
}

/** The cached entry if it hasn't aged past its TTL, else `null`. */
function unexpiredEntry(): CatalogCacheEntry | null {
  return cache && cache.expiresAt > Date.now() ? cache : null;
}

/**
 * Bumped by {@link __resetGatewayCatalogCacheForTests}. An abandoned load (see
 * {@link catalogWithinBudget}) keeps running after the caller walked away, so
 * without this its `cache = entry` write can land AFTER a reset and resurrect a
 * previous test's catalog into the next one. Racing the load made abandoned
 * loads routine where they used to be rare, so the hazard is real rather than
 * theoretical (#4872 review).
 */
let cacheGeneration = 0;

/**
 * Resolve the cache entry, fetching only when it's cold or stale. Concurrent
 * callers during a refresh share the single inflight promise.
 *
 * Never rejects — `load()` resolves even on fetch failure, and this function
 * adds nothing that can throw. That is what lets hot-path callers race it
 * without an error branch. Note this is strictly narrower than
 * {@link getGatewayCatalog}, which additionally runs `applyRecommended()` →
 * `getSetting()` and therefore CAN reject. Callers on the agent turn path must
 * use this one; routing them through `getGatewayCatalog` would put a settings
 * fault on the critical path of every turn.
 */
async function ensureCatalogEntry(): Promise<CatalogCacheEntry> {
  const fresh = unexpiredEntry();
  if (fresh) return fresh;
  const generation = cacheGeneration;
  if (!inflight) {
    const started = load();
    inflight = started;
    // `if (inflight === started)` rather than a bare `inflight = null` (#4872
    // review): an abandoned load's `finally` can fire AFTER a reset has already
    // cleared the slot and a successor has claimed it, and would otherwise null
    // out that successor — breaking the dedup and letting a third fetch start.
    void started.finally(() => {
      if (inflight === started) inflight = null;
    });
  }
  const entry = await inflight;
  if (generation === cacheGeneration) cache = entry;
  return entry;
}

/** How {@link catalogWithinBudget} resolved — distinguishable so callers can log. */
type CatalogOutcome =
  | { readonly kind: "entry"; readonly entry: CatalogCacheEntry }
  /** The budget elapsed before a cold load landed. Normal, but worth a warn. */
  | { readonly kind: "budget-elapsed" }
  /** The load rejected — the "never rejects" invariant is broken. */
  | { readonly kind: "broken" };

/**
 * The load whose budget-elapsed warn has already been emitted.
 *
 * Deduped per CACHE-FILL ATTEMPT, not per caller (#4872 review). Every turn that
 * starts while a cold load is in flight loses its own race, so an undeduped warn
 * is one line per turn — and because a failed fill gets a 60s TTL, that repeats
 * every 60s for the length of an outage. The operator wants one line per failed
 * fill. Keyed on the promise identity so the NEXT attempt warns again; mirrors
 * the warn-once discipline of {@link warnStaleShortlistOnce}.
 */
let warnedBudgetForLoad: Promise<CatalogCacheEntry> | null = null;

/**
 * The cache entry, waiting at most `budgetMs` for a cold one.
 *
 * Distinguishes the abnormal outcomes rather than collapsing them to `null`
 * (#4872 review). Retiring `warmGatewayCatalog` left this path — the CALLER side
 * of the load, as opposed to `load()`'s own catch — with no warn at all, and a
 * gateway that is merely SLOW (healthy enough that `load()` never warns, slow
 * enough to lose every race) would otherwise reinstate the exact bug this change
 * fixes with no signal anywhere.
 */
async function catalogWithinBudget(budgetMs: number): Promise<CatalogOutcome> {
  const fresh = unexpiredEntry();
  // The common (warm) path touches neither the network nor a timer; the
  // caller's `await` costs one microtask tick and nothing more.
  if (fresh) return { kind: "entry", entry: fresh };

  // Normalized for `setTimeout`, which coerces a negative delay to 0 and NaN to
  // 0 — either of which would make every call return `budget-elapsed` on the
  // next tick, i.e. the fire-and-forget semantics #4872 retired. No caller
  // computes this today; the guard is for the first one that does.
  const wait = Number.isFinite(budgetMs) ? Math.max(1, budgetMs) : HOT_PATH_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), wait);
  });
  const pending = ensureCatalogEntry();
  // Read AFTER the call, BEFORE the first await: `ensureCatalogEntry` runs
  // synchronously up to its own `await inflight`, so the slot is populated by
  // now — and it is cleared again once the load settles, so reading it after
  // the race would give null or already the next attempt.
  const attempt = inflight;
  try {
    // `Promise.race` subscribes to the load even when the budget wins, so
    // abandoning it can never surface as an unhandled rejection.
    const won = await Promise.race([pending, budget]);
    if (won === null) {
      if (attempt !== warnedBudgetForLoad) {
        warnedBudgetForLoad = attempt;
        const ctx = getRequestContext();
        log.warn(
          {
            budgetMs: wait,
            requestId: ctx?.requestId,
            // Whether a TTL-EXPIRED entry was available and deliberately not
            // served. That trade (refresh rather than serve stale, so compaction
            // is never sized off a superseded window) is invisible otherwise,
            // and it is the one worth revisiting if these warns are frequent.
            discardedExpiredEntry: cache !== null && !cache.fallback,
          },
          "gateway-catalog: hot-path budget elapsed before the catalog landed; callers fall back to their static tables until this fill completes. Repeated warns mean the gateway is slow enough to defeat the live tier on every cache fill",
        );
      }
      return { kind: "budget-elapsed" };
    }
    return { kind: "entry", entry: won };
  } catch (err) {
    // Defence in depth. `ensureCatalogEntry` is documented never to reject and
    // doesn't today — but this now sits on the agent turn path, outside every
    // `try` in `runAgent`, so a future break of that invariant would fail live
    // turns for a tier whose entire contract is "degrade to the static table".
    // An unenforced invariant on a hot path is worth one catch block.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "gateway-catalog: catalog resolution rejected — the never-rejects invariant is broken; falling back to the static table",
    );
    return { kind: "broken" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether an id is gateway-shaped (`provider/model`) and so worth a catalog
 * lookup at all.
 *
 * This is the air-gap gate (#4869 review, #4872). Direct/BYOT and self-hosted
 * deploys use hyphen-format ids with no slash, so gating every catalog entry
 * point on it means an air-gapped install never makes an outbound call no
 * matter which hot path runs.
 */
function isGatewayModelId(modelId: string | null | undefined): boolean {
  return typeof modelId === "string" && modelId.includes("/");
}

/**
 * Return the cached catalog if fresh; refresh when stale. Concurrent callers
 * during a refresh share a single inflight promise.
 *
 * This is the ADMIN-picker entry point: it waits for the full
 * {@link FETCH_TIMEOUT_MS} because the picker has nothing to render without a
 * catalog. Hot paths must use {@link lookupModelContextWindow} /
 * {@link primeGatewayCatalog}, which bound their wait.
 */
export async function getGatewayCatalog(): Promise<GatewayCatalogResponse> {
  const entry = await ensureCatalogEntry();
  return {
    models: applyRecommended(entry.models, entry.fallback),
    fetchedAt: entry.fetchedAt,
    fallback: entry.fallback,
  };
}

/**
 * A model's context window from the live catalog, fetching it if needed but
 * never waiting longer than `budgetMs`. Returns `null` when the id isn't
 * gateway-shaped, the budget elapsed, the gateway is unreachable, or the
 * catalog carries no window for `modelId` — the caller falls back to its own
 * static table in every one of those cases. The operator-actionable ones are
 * logged before the `null`: the budget elapsing (in `catalogWithinBudget`), and
 * the active model being absent from the live catalog entirely.
 *
 * The compaction trigger's tier 2 (#3760, #4869), called ONCE PER TURN from
 * `resolveCompactionSettings` (`agent-compaction.ts`) — which `agent.ts` awaits
 * in the turn setup, well outside `prepareStep`. This replaces the sync
 * `peekModelContextWindow` + fire-and-forget `warmGatewayCatalog` pair (#4872):
 * that pair only ever answered from turn 2 onward, made the live value depend on
 * whether some earlier turn happened to warm the cache, and put the warm and the
 * read in two different places — so it was possible (and it happened) for a
 * static-table tier to sit between them and make the warm unreachable.
 *
 * A TTL-EXPIRED entry is refreshed rather than served, even though it is sitting
 * right there and the refresh costs up to `budgetMs`: a model's context window
 * changes between catalog revisions, and compaction sizing is exactly where a
 * stale number does damage. Losing the race just falls through to the static
 * table, which is the same floor an air-gapped deploy runs on permanently.
 *
 * A FALLBACK catalog reads as a miss (#4869 review). The bundled manifest is a
 * handful of hand-maintained constants that were never fetched from anywhere,
 * and unlike the static family table nothing marks them as a floor — so a
 * gateway OUTAGE would silently change a workspace's compaction threshold to
 * whatever this file was last edited to say. It once had `opus-4.8` at 200k
 * against a real 1M.
 */
export async function lookupModelContextWindow(
  modelId: string | null | undefined,
  budgetMs: number = HOT_PATH_BUDGET_MS,
): Promise<number | null> {
  if (!isGatewayModelId(modelId)) return null;
  const outcome = await catalogWithinBudget(budgetMs);
  // `budget-elapsed` and `broken` already warned inside `catalogWithinBudget`;
  // a `fallback` entry already warned inside `load()`.
  if (outcome.kind !== "entry" || outcome.entry.fallback) return null;

  const hit = outcome.entry.models.find((m) => m.id === modelId);
  if (hit === undefined) {
    // The workspace's CONFIGURED, active model is not in the live catalog at
    // all — a typo, a retired id, or an entry `normalizeEntry` dropped. That is
    // permanent and silent: every turn thereafter sizes compaction off the
    // coarse static floor. Warn (deduped on the id, since it repeats per turn),
    // matching how the shortlist treats the same fault.
    warnUncataloguedModelOnce(modelId as string);
    return null;
  }
  if (hit.contextWindow === null) {
    // Distinct, milder fault: the gateway serves this model but publishes no
    // window for it. Nothing for an operator to fix, so debug rather than warn.
    log.debug(
      { modelId },
      "gateway-catalog: live catalog serves the active model but publishes no context window; falling back to the static family table",
    );
    return null;
  }
  return hit.contextWindow;
}

/** Same warn-once discipline as {@link warnStaleShortlistOnce}, different fault. */
const warnedUncataloguedModels = new Set<string>();
function warnUncataloguedModelOnce(modelId: string): void {
  if (warnedUncataloguedModels.has(modelId)) return;
  warnedUncataloguedModels.add(modelId);
  log.warn(
    { modelId },
    "gateway-catalog: the active model is absent from the live gateway catalog — compaction is sized from the coarse static family table instead; check the configured model id",
  );
}

/**
 * Fetch the catalog into memory for a caller that is about to read it
 * synchronously many times, waiting at most `budgetMs`. A no-op unless at least
 * one of `modelIds` is gateway-shaped, so an air-gapped deploy still never
 * reaches the network. Never throws.
 *
 * `readonly []` rather than `Iterable` on purpose: the scan below returns on the
 * first gateway-shaped id, which would leave a generator partially drained for a
 * caller that has no way to know how far.
 *
 * Pairs with {@link peekModelPricing}: await this once, then read per row.
 */
export async function primeGatewayCatalog(
  modelIds: readonly (string | null | undefined)[],
  budgetMs: number = HOT_PATH_BUDGET_MS,
): Promise<void> {
  if (!modelIds.some(isGatewayModelId)) return;
  await catalogWithinBudget(budgetMs);
}

/**
 * Synchronous, non-fetching lookup of a model's rates from whatever catalog is
 * already in memory. Returns `null` when the cache is cold, stale, or has no
 * priced entry for `modelId`.
 *
 * Deliberately left SYNC where the context-window lookup was made async
 * (#4872), because it has the opposite profile: `resolveRate` runs per ROW
 * inside `foldUsage`'s loop over the operator spend page's usage rows, so an
 * async reader would mean either an await per row or restructuring a pure fold
 * into an async one. Its caller awaits {@link primeGatewayCatalog} ONCE before
 * the loop instead, which buys the same "authoritative on the first render"
 * property with one await rather than hundreds.
 *
 * That leaves a prime-then-read seam a future caller could forget, which the
 * context-window path no longer has. It is a deliberate trade, not an
 * oversight — but see {@link resolveRate} for the honest failure story: a
 * forgotten prime costs precision for Anthropic ids and the whole figure for
 * everything else. Both are visible; neither is a wrong number presented as
 * right. If a third consumer appears, close the seam with a reader closure
 * rather than adding a third place to remember.
 *
 * A stale cache reads as a miss because a price that moved between catalog
 * revisions is worse than no price. `cache.fallback` is checked explicitly even
 * though the fallback's `prices` map is empty today, so it already returns
 * null: stating it stops a future "let's ship prices in the fallback too" from
 * silently pricing off redeploy-gated constants (#4869 review).
 */
export function peekModelPricing(modelId: string | null | undefined): CatalogModelPricing | null {
  if (!modelId) return null;
  // Shares `unexpiredEntry` with the context-window path rather than
  // re-implementing the freshness predicate, so a future change to what counts
  // as fresh can't silently diverge the two (#4872 review).
  const entry = unexpiredEntry();
  if (!entry || entry.fallback) return null;
  return entry.prices.get(modelId) ?? null;
}

/**
 * Test-only: clears the cache so each test sees a clean fetch path.
 *
 * Also clears the stale-shortlist warn dedup — that Set is module-level and
 * would otherwise let one test's warning suppress the next test's assertion.
 */
export function __resetGatewayCatalogCacheForTests(): void {
  // Invalidates in-flight loads too, so a load abandoned at the budget by an
  // earlier test can't write its entry into a later one (#4872 review).
  cacheGeneration += 1;
  cache = null;
  inflight = null;
  warnedBudgetForLoad = null;
  warnedStaleShortlists.clear();
  warnedUnusableShortlists.clear();
  warnedUncataloguedModels.clear();
}

/** Test-only: the shortlist as currently resolved from settings, in order. */
export function __getRecommendedIdsForTests(): readonly string[] {
  return recommendedModelIds();
}
