/**
 * `shared-spec-cache` — the cross-workspace OpenAPI spec/graph cache (#2970).
 *
 * ## The problem this exists for
 * A REST datasource's **spec shape is workspace-independent**: Stripe's
 * `/openapi.json`, GitHub's spec, and Notion's spec are the SAME document for
 * every workspace that installs them. Slice 2 (#2926) made installs
 * per-workspace and cached the normalized {@link OperationGraph} in-process
 * keyed by `${workspaceId}:${installId}:${probedAt}` (see `probe.ts`
 * {@link import("./probe").snapshotToGraph}). With that key, two workspaces both
 * on `stripe-data` re-download the spec at install AND re-normalize the (often
 * 250KB+) document on resolve — once per workspace — even though the bytes are
 * identical. This module shares that work: the download + normalize happens
 * **once per canonical spec identity** and every workspace on that spec/version
 * reuses it.
 *
 * ## The isolation model (the load-bearing safety property)
 * A spec is shared across tenants ONLY when its fetched document is provably
 * **credential-independent** — i.e. the probe credential is withheld because the
 * spec host differs from the datasource's API host (the #3034 host-match gate).
 * That is exactly the built-in data-candidate case: every candidate pins its
 * spec to a public CDN (`raw.githubusercontent.com`) while its API lives
 * elsewhere (`api.stripe.com`, `api.notion.com`, …), so the spec fetch is
 * unauthenticated and yields the same bytes for every tenant.
 *
 * Two categories are therefore NEVER shared, and the gate
 * ({@link isShareableSpec}) enforces it:
 *   - **Generic `openapi-generic` installs** — the spec URL is admin-supplied and
 *     may point at a tenant's internal microservice (whose API surface is itself
 *     sensitive), and the credential may be sent to the spec host (same-host
 *     authenticated specs). Per-workspace only, via `snapshotToGraph`.
 *   - **A hypothetical same-host authenticated data candidate** — if a future
 *     candidate's spec host equalled its API host, the probe WOULD send the
 *     credential and the document could be tenant-specific. The host-mismatch
 *     test excludes it automatically; it falls back to the per-workspace path.
 *
 * To make the invariant total (not merely "candidates happen to be public
 * today"), {@link probeShared} fetches the shared spec with NO credential at all
 * ({@link import("./probe").conditionalProbe} is credential-free). A shared cache
 * entry can thus never carry one tenant's authenticated view of a spec.
 *
 * ## Canonical spec identity (the cache key)
 * `${catalogId}@${version}#${contentHash}` —
 *   - `catalogId` scopes sharing to one built-in upstream (the stable anchor; a
 *     candidate's spec URL is code-locked 1:1 to its catalog id),
 *   - `version` is the upstream's declared `info.version` — the human-meaningful
 *     pin so two workspaces on DIVERGENT upstream versions never collide (AC6),
 *   - `contentHash` is a fingerprint of the raw document — the exact tiebreaker
 *     when `info.version` doesn't move but the bytes did (a botched upstream
 *     edit), so a stale and a fresh doc at the same version stay distinct.
 *
 * ## What this module is (and isn't)
 * A **process-local** store — the same lifetime + tenancy discipline as the
 * `probe.ts` graph cache it generalizes, with no migration. Each pod downloads a
 * given public spec at most once and keeps it warm via the periodic
 * conditional-GET refresh ({@link refreshSharedSpecsCycle}); a `304` is free and
 * serves every workspace on the pod. A DB-backed shared store (one row per
 * identity, FK'd from installs) is a clean future extension the identity key
 * already anticipates — deliberately out of scope here to keep the change
 * migration-free and orthogonal to the per-install snapshot/diff path (#2976) and
 * the per-install refresh scheduler (#2978).
 *
 * Two cooperating indices:
 *   - {@link byIdentity} — the version-pinned normalized-graph memo. The resolve
 *     path ({@link sharedGraphFromSnapshot}) reads/writes this; it is what makes
 *     "no re-normalize across workspaces" true and what pins divergent versions.
 *   - {@link currentByCatalog} — a pointer to the FRESHEST known entry per
 *     catalog. The network path ({@link probeShared}) and the periodic refresh
 *     own it; it backs "no re-download at install" + the conditional-GET cadence.
 *     Resolve only SEEDS it when absent (post-restart warmth) and never moves it
 *     backwards.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { conditionalProbe, type ConditionalProbeResult } from "./probe";
import type { OpenApiSnapshot } from "./catalog";
import type { OperationGraph } from "./types";
import { buildOperationGraph } from "./spec";

const log = createLogger("openapi.shared-spec-cache");

/**
 * Freshness window (ms) for the install-time short-circuit. Within it,
 * {@link probeShared} returns the cached entry WITHOUT any network call (not even
 * a conditional GET) — a fresh install of an already-installed public upstream is
 * free. Past it, the next access does ONE conditional GET (a `304` keeps the
 * entry and re-arms the window). Configurable via
 * `ATLAS_OPENAPI_SHARED_SPEC_TTL_MS`; default 1h.
 */
function sharedSpecTtlMs(): number {
  const raw = process.env.ATLAS_OPENAPI_SHARED_SPEC_TTL_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
}

// ─────────────────────────────────────────────────────────────────────
//  Canonical identity
// ─────────────────────────────────────────────────────────────────────

/**
 * What makes two installs "the same shareable spec". A spec at a given
 * `catalogId` + upstream `version` + document fingerprint is normalized exactly
 * once and reused by every workspace that lands on the same triple.
 */
export interface SharedSpecIdentity {
  /** The built-in data-candidate catalog id (sharing scope + stable anchor). */
  readonly catalogId: string;
  /** The upstream's declared `info.version` (the version pin — AC6). */
  readonly version: string;
  /** A stable fingerprint of the raw document (the exact-bytes tiebreaker). */
  readonly contentHash: string;
}

/** A cached shared spec: the doc, the normalized graph, and refresh metadata. */
export interface SharedSpecEntry {
  readonly identity: SharedSpecIdentity;
  /** The raw OpenAPI document (credential-independent — see module header). */
  readonly doc: unknown;
  /** The normalized graph — built once per identity, reused cross-workspace. */
  readonly graph: OperationGraph;
  /** Response `ETag`, when the upstream sent one — for `If-None-Match`. */
  readonly etag?: string;
  /** Response `Last-Modified`, when present — for `If-Modified-Since`. */
  readonly lastModified?: string;
  /** Epoch ms the document was last downloaded (a `200`, not a `304`). */
  readonly fetchedAt: number;
  /** Epoch ms freshness was last confirmed (a `200` OR a `304`). Re-arms the TTL. */
  readonly checkedAt: number;
}

/** The `${catalogId}@${version}#${contentHash}` key string for an identity. */
export function canonicalSpecKey(identity: SharedSpecIdentity): string {
  return `${identity.catalogId}@${identity.version}#${identity.contentHash}`;
}

/**
 * A stable fingerprint of a raw OpenAPI document. `JSON.stringify` preserves
 * insertion order in V8/JSC, so two workspaces fetching byte-identical specs
 * produce identical parsed key orders → identical hashes. A doc that can't be
 * stringified (a cycle — never present in a JSON-sourced spec) falls back to a
 * non-colliding sentinel so the caller still keys deterministically rather than
 * throwing on the hot path.
 */
export function contentHashOf(doc: unknown): string {
  try {
    return createHash("sha256").update(JSON.stringify(doc) ?? "null").digest("hex");
  } catch (err) {
    // intentionally logged, not thrown: a spec document is JSON-sourced and
    // acyclic, so this is unreachable in practice; if it ever fires, key on a
    // stable sentinel so identical inputs still collapse rather than crashing
    // the resolve/install path.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not hash a spec document for the shared cache key — using a sentinel",
    );
    return "unhashable";
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Isolation gate
// ─────────────────────────────────────────────────────────────────────

/**
 * A URL's host (`hostname[:port]`, lowercased by the parser), or `null` when the
 * URL is unparseable or host-less. Mirrors `probe.ts::urlHost` — duplicated
 * (not shared) so the gate is self-defending and can't be loosened by a change
 * to the probe's copy.
 */
function urlHost(url: string): string | null {
  try {
    const host = new URL(url).host;
    return host.length > 0 ? host : null;
  } catch {
    // intentionally ignored: an unparseable URL has no comparable host — treated
    // as "not shareable" (fail-safe: an unknown shape never enters the shared cache).
    return null;
  }
}

/**
 * THE isolation gate. A spec is shareable across tenants ONLY when its probe
 * credential is provably withheld — i.e. the spec host and the datasource's API
 * host differ — so the fetched document is credential-independent and identical
 * for every tenant (see the module header's isolation model).
 *
 * Both hosts must parse AND differ. An absent `apiBaseUrl` (a plain
 * `openapi-generic` install never declares one), an unparseable URL, or matching
 * hosts (a same-host authenticated spec) all resolve to `false` — the per-
 * workspace path owns those.
 */
export function isShareableSpec(specUrl: string, apiBaseUrl: string | undefined): boolean {
  if (!apiBaseUrl) return false;
  const specHost = urlHost(specUrl);
  const apiHost = urlHost(apiBaseUrl);
  return specHost !== null && apiHost !== null && specHost !== apiHost;
}

// ─────────────────────────────────────────────────────────────────────
//  Store
// ─────────────────────────────────────────────────────────────────────

/** Version-pinned normalized-graph memo — keyed by {@link canonicalSpecKey}. */
const byIdentity = new Map<string, SharedSpecEntry>();
/** Freshest-known entry per catalog — value is a {@link byIdentity} key. */
const currentByCatalog = new Map<string, string>();

/** Test seam — drop every shared entry for hermetic isolation between tests. */
export function __resetSharedSpecCacheForTests(): void {
  byIdentity.clear();
  currentByCatalog.clear();
}

/**
 * Evict every shared entry for one catalog across all versions, and its
 * "current" pointer. The admin-facing "Rediscover" force path and an uninstall
 * call this so a re-probe re-populates from a clean slate rather than reusing a
 * stale shared doc. Scoped to one `catalogId` so evicting one upstream never
 * touches another's cached graph.
 */
export function invalidateSharedSpec(catalogId: string): void {
  const prefix = `${catalogId}@`;
  for (const key of byIdentity.keys()) {
    if (key.startsWith(prefix)) byIdentity.delete(key);
  }
  currentByCatalog.delete(catalogId);
}

/** Snapshot of the cache for tests/observability (read-only copy). */
export function sharedSpecCacheStats(): {
  readonly identities: number;
  readonly catalogs: number;
} {
  return { identities: byIdentity.size, catalogs: currentByCatalog.size };
}

// ─────────────────────────────────────────────────────────────────────
//  Resolve-time reuse — "no re-normalize across workspaces"
// ─────────────────────────────────────────────────────────────────────

/**
 * Rebuild the {@link OperationGraph} for a SHAREABLE install from its persisted
 * snapshot, memoized by **canonical spec identity** (`catalogId` + the
 * snapshot's `version` + the document fingerprint) rather than per workspace +
 * install. Two workspaces on the same `stripe-data` spec/version therefore
 * normalize the (large) document exactly once between them.
 *
 * Version pinning (AC6) is automatic: a workspace still on `v2` and one already
 * rediscovered to `v3` resolve DIFFERENT identities, so neither serves the
 * other's operation surface. The function also SEEDS {@link currentByCatalog}
 * when that catalog has no "current" pointer yet (post-restart warmth, so the
 * periodic refresh has something to keep fresh) — but never moves an existing,
 * possibly-fresher pointer backwards.
 *
 * Throws {@link OpenApiSpecError} if the cached doc no longer normalizes — fail
 * loud so a corrupt snapshot is diagnosable (the caller skips + logs, same as
 * the per-install `snapshotToGraph`).
 */
export function sharedGraphFromSnapshot(
  catalogId: string,
  snapshot: OpenApiSnapshot,
): OperationGraph {
  const identity: SharedSpecIdentity = {
    catalogId,
    version: snapshot.version,
    contentHash: contentHashOf(snapshot.doc),
  };
  const key = canonicalSpecKey(identity);

  const cached = byIdentity.get(key);
  if (cached) {
    // Seed the "current" pointer if this catalog has none yet (e.g. first resolve
    // after a pod restart, before any install/refresh ran on this pod) so the
    // periodic refresh can keep it warm. Never overwrite an existing pointer —
    // that one came from a network fetch and is authoritative for freshness.
    if (!currentByCatalog.has(catalogId)) currentByCatalog.set(catalogId, key);
    return cached.graph;
  }

  // Let a normalize failure (a corrupt / older-builder snapshot doc) propagate as
  // the descriptive `OpenApiSpecError` from `buildOperationGraph` — the resolver's
  // `buildDatasource` catch logs + skips it, same fail-soft posture as the
  // per-install `snapshotToGraph`.
  const graph = buildOperationGraph(snapshot.doc);
  const now = Date.now();
  const entry: SharedSpecEntry = {
    identity,
    doc: snapshot.doc,
    graph,
    fetchedAt: now,
    checkedAt: now,
  };
  byIdentity.set(key, entry);
  if (!currentByCatalog.has(catalogId)) currentByCatalog.set(catalogId, key);
  return graph;
}

// ─────────────────────────────────────────────────────────────────────
//  Network-time reuse — "no re-download at install" + conditional refresh
// ─────────────────────────────────────────────────────────────────────

/** How {@link probeShared} produced its result — branched on by tests + audit. */
export type SharedProbeSource =
  | "cache" // fresh entry within TTL — no network call at all
  | "network-304" // conditional GET → Not Modified — reused the cached doc
  | "network-200"; // downloaded (first fetch, forced, or upstream changed)

export interface SharedProbeResult {
  readonly doc: unknown;
  readonly graph: OperationGraph;
  readonly source: SharedProbeSource;
  readonly identity: SharedSpecIdentity;
}

/** Injectable conditional-probe seam (production: {@link conditionalProbe}). */
export type ConditionalProbeFn = (
  specUrl: string,
  options: { readonly fetchImpl?: typeof globalThis.fetch; readonly etag?: string; readonly lastModified?: string },
) => Promise<ConditionalProbeResult>;

export interface ProbeSharedParams {
  /** The shareable install's catalog id (the cache anchor). */
  readonly catalogId: string;
  /** The code-locked public spec URL (credential-withheld upstream). */
  readonly specUrl: string;
  /** `fetch` override threaded to the conditional probe (tests). */
  readonly fetchImpl?: typeof globalThis.fetch;
  /**
   * Bypass the TTL short-circuit AND the cached validators — force a fresh
   * unconditional download that replaces the entry. The admin "Rediscover"
   * action on a shared upstream uses this so every workspace gets the new doc.
   */
  readonly force?: boolean;
  /** Conditional-probe seam (tests inject a stub). */
  readonly probe?: ConditionalProbeFn;
  /** Clock override (tests). */
  readonly nowFn?: () => number;
}

/**
 * Resolve the doc + graph for a SHAREABLE upstream, reusing the cross-workspace
 * cache. The install handlers call this instead of {@link
 * import("./probe").probeSpec} so the SECOND workspace installing the same public
 * spec pays no download and no normalize (AC2). Three outcomes:
 *
 *   1. **`cache`** — a "current" entry exists and is within the TTL: returned
 *      verbatim, zero network.
 *   2. **`network-304`** — past the TTL, a conditional GET (`If-None-Match` /
 *      `If-Modified-Since`) returned `304`: the cached doc is reused and its
 *      freshness window re-armed — free for every workspace on the pod (AC4).
 *   3. **`network-200`** — no prior entry, `force`, or the upstream changed: the
 *      doc is downloaded + normalized ONCE and stored under its new identity.
 *
 * Credential-free by construction (the conditional probe sends none), so a
 * shared entry can never carry a tenant's authenticated view. A network failure
 * propagates as the probe's `OpenApiProbeError` (the install handlers already map
 * it to an actionable error) — but only when a fetch is actually attempted; a
 * cache hit can't fail.
 */
export async function probeShared(params: ProbeSharedParams): Promise<SharedProbeResult> {
  const probe = params.probe ?? conditionalProbe;
  const now = params.nowFn ?? Date.now;
  const ttl = sharedSpecTtlMs();

  const currentKey = currentByCatalog.get(params.catalogId);
  const current = currentKey ? byIdentity.get(currentKey) : undefined;

  // 1. Fresh-cache short-circuit — no network at all.
  if (current && !params.force && now() - current.checkedAt < ttl) {
    return { doc: current.doc, graph: current.graph, source: "cache", identity: current.identity };
  }

  // 2. Conditional GET. Send validators only when we have a prior entry and
  //    aren't forcing — a forced refresh downloads unconditionally.
  const conditional =
    current && !params.force
      ? { ...(current.etag ? { etag: current.etag } : {}), ...(current.lastModified ? { lastModified: current.lastModified } : {}) }
      : {};
  const result = await probe(params.specUrl, {
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    ...conditional,
  });

  if (result.notModified && current) {
    // 304 — keep the cached doc, re-arm the freshness window, carry forward any
    // refreshed validators the server echoed.
    const refreshed: SharedSpecEntry = {
      ...current,
      checkedAt: now(),
      ...(result.etag ? { etag: result.etag } : {}),
      ...(result.lastModified ? { lastModified: result.lastModified } : {}),
    };
    byIdentity.set(currentKey!, refreshed);
    return { doc: current.doc, graph: current.graph, source: "network-304", identity: current.identity };
  }

  // A 304 with no prior entry is impossible — `conditional` is empty unless
  // `current` exists, so the server can only 304 a request that carried
  // validators. Treat it as a programming-invariant violation rather than
  // silently fabricating an entry from a body-less response.
  if (result.notModified) {
    throw new Error(
      `Shared spec probe for ${params.catalogId} returned 304 with no cached entry to reuse — ` +
        `a conditional request was sent without a cached doc to fall back to.`,
    );
  }

  // 3. 200 — store the freshly downloaded + normalized doc under its identity.
  const identity: SharedSpecIdentity = {
    catalogId: params.catalogId,
    version: result.graph.info.version,
    contentHash: contentHashOf(result.doc),
  };
  const key = canonicalSpecKey(identity);
  const ts = now();
  const entry: SharedSpecEntry = {
    identity,
    doc: result.doc,
    graph: result.graph,
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.lastModified ? { lastModified: result.lastModified } : {}),
    fetchedAt: ts,
    checkedAt: ts,
  };
  byIdentity.set(key, entry);
  currentByCatalog.set(params.catalogId, key);
  return { doc: result.doc, graph: result.graph, source: "network-200", identity };
}

// ─────────────────────────────────────────────────────────────────────
//  Periodic conditional-GET refresh (Tier-1, this issue's scheduler home)
// ─────────────────────────────────────────────────────────────────────

/** Per-catalog outcome of one refresh cycle — surfaced in logs + tests. */
export type SharedRefreshOutcome =
  | { readonly catalogId: string; readonly kind: "not_modified" }
  | { readonly catalogId: string; readonly kind: "updated"; readonly version: string }
  | { readonly catalogId: string; readonly kind: "failed"; readonly error: string };

export interface SharedRefreshCycleResult {
  readonly inspected: number;
  readonly notModified: number;
  readonly updated: number;
  readonly failed: number;
  readonly outcomes: ReadonlyArray<SharedRefreshOutcome>;
}

export interface RefreshCycleOptions {
  readonly probe?: ConditionalProbeFn;
  readonly nowFn?: () => number;
  /**
   * The spec URL for a catalog id. Production passes a resolver over the
   * data-candidate registry; tests pass a fixture. A catalog with no resolvable
   * URL is skipped (logged) rather than refreshed against a guessed URL.
   */
  readonly specUrlFor: (catalogId: string) => string | undefined;
}

/**
 * Conditional-GET every spec currently warm in the shared cache (the working set
 * — specs at least one workspace installed/resolved on this pod). A `304` re-arms
 * the freshness window and serves every workspace for free; a `200` re-normalizes
 * the changed doc ONCE and advances the catalog's "current" pointer.
 *
 * Deliberately bounded to the working set: it never proactively downloads a
 * public spec no workspace uses. It also never mutates any workspace's PERSISTED
 * snapshot — that per-install re-discovery is the #2978 boundary, kept orthogonal
 * so this Tier-1 refresh can't conflict with the per-install diff/persist path.
 * Per-catalog failures are isolated (logged, counted) so one down upstream can't
 * stall the others.
 */
export async function refreshSharedSpecsCycle(
  options: RefreshCycleOptions,
): Promise<SharedRefreshCycleResult> {
  const catalogIds = [...currentByCatalog.keys()];

  // Probe every cached catalog CONCURRENTLY. The working set is a handful of
  // DISTINCT public hosts (Stripe / GitHub / Notion CDNs), not one host per
  // workspace — so there's no shared upstream rate limit to respect (the reason
  // the BYOT cycle stays serial), and a slow/stuck upstream can't delay the
  // others' refresh (no timeout amplification). Each `probeShared` touches only
  // its own catalog's cache entries (keys are catalog-scoped), so concurrent
  // calls never race on the shared maps. Each closure catches its own error and
  // returns an outcome, so `Promise.all` never rejects; input order is preserved.
  const settled = await Promise.all(
    catalogIds.map(async (catalogId): Promise<SharedRefreshOutcome | null> => {
      const specUrl = options.specUrlFor(catalogId);
      if (!specUrl) {
        // A cached catalog with no resolvable spec URL is a registry drift — skip
        // (no outcome) rather than refresh against a stale/guessed URL.
        log.warn({ catalogId }, "Shared spec refresh: no spec URL for cached catalog — skipping");
        return null;
      }
      try {
        // `force: false` (the default) — a CONDITIONAL GET (cheap 304) rather than
        // an unconditional re-download. With the default cadence (interval ≫ TTL)
        // every cached entry is past its window each cycle, so a real conditional
        // GET fires; a `cache` short-circuit only happens if an operator sets the
        // interval below the TTL, where the entry is genuinely still fresh —
        // counted as "not modified" either way.
        const result = await probeShared({
          catalogId,
          specUrl,
          ...(options.probe ? { probe: options.probe } : {}),
          ...(options.nowFn ? { nowFn: options.nowFn } : {}),
        });
        return result.source === "network-200"
          ? { catalogId, kind: "updated", version: result.identity.version }
          : { catalogId, kind: "not_modified" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ catalogId, err: message }, "Shared spec refresh: per-catalog probe failed");
        return { catalogId, kind: "failed", error: message };
      }
    }),
  );

  const outcomes = settled.filter((o): o is SharedRefreshOutcome => o !== null);
  const notModified = outcomes.filter((o) => o.kind === "not_modified").length;
  const updated = outcomes.filter((o) => o.kind === "updated").length;
  const failed = outcomes.filter((o) => o.kind === "failed").length;

  const result: SharedRefreshCycleResult = {
    inspected: catalogIds.length,
    notModified,
    updated,
    failed,
    outcomes,
  };
  if (catalogIds.length > 0) {
    log.info(
      { inspected: result.inspected, notModified: result.notModified, updated: result.updated, failed: result.failed },
      "Shared spec refresh cycle complete",
    );
  }
  return result;
}
