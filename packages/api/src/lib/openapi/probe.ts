/**
 * `openapi-probe` — the install-time + rediscover spec probe (PRD #2868 slice 2,
 * #2926). Shared by the form install handler (probe-on-install) and the
 * `/admin/openapi-datasources/:id/rediscover` route (re-probe), so both produce
 * an identical {@link OpenApiSnapshot}.
 *
 * Generalizes slice-1's hardcoded Twenty probe (formerly
 * `datasource.ts::probeGraph`, removed when `datasource.ts` collapsed to a pure
 * type module — it hardcoded Twenty's `/rest/open-api/core` path + bearer auth)
 * to any `(openapi_url, auth_kind, auth_value)` install form. The snapshot
 * caches the *raw document* — the
 * canonical `buildOperationGraph` rebuilds the graph from it on resolve, so
 * there's exactly one graph encoding (avoids the "serialized-graph drifts from
 * the doc" failure mode).
 *
 * No agent logic, no DB I/O, no persistence — callers own the write. Probe
 * failures throw {@link OpenApiProbeError} with a machine-readable `reason` so
 * the route layer maps them to actionable 4xx/5xx envelopes instead of a 500.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { assertBaseUrlAllowed, guardedFetch, EgressBlockedError } from "./egress-guard";
import { buildOperationGraph } from "./spec";
import {
  OpenApiSpecError,
  type OperationGraph,
  type ResolvedAuth,
} from "./types";
import {
  narrowSupportedAuthKind,
  type SupportedAuthKind,
  type OpenApiSnapshot,
  type DiscoveredOperationSummary,
} from "./catalog";

const log = createLogger("openapi.probe");

/** Per-probe fetch timeout. Configurable via `ATLAS_OPENAPI_TIMEOUT` (ms). */
function probeTimeoutMs(): number {
  const raw = process.env.ATLAS_OPENAPI_TIMEOUT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

/** Why a probe failed — branched on by the route layer, never the message. */
export type OpenApiProbeErrorReason =
  | "unreachable" // network / DNS / timeout
  | "http_error" // non-2xx fetching the spec URL
  | "unparseable" // body wasn't valid JSON / not an OpenAPI 3.x doc
  | "no_operations"; // parsed, but the graph has zero operations

/**
 * A plain `Error` subclass, not a `Data.TaggedError`: the probe is plain-async
 * machinery (no Effect pipeline), and every consumer branches on `instanceof
 * OpenApiProbeError` + the `reason` discriminant outside Effect (the install
 * handler, the rediscover route). It never flows through `runHandler` /
 * `mapTaggedError`, so the `Data.TaggedError` convention (which exists for
 * Effect's typed-error channel) doesn't apply here — convert only if this ever
 * becomes an Effect failure.
 */
export class OpenApiProbeError extends Error {
  readonly reason: OpenApiProbeErrorReason;
  /** HTTP status when `reason === "http_error"`. */
  readonly httpStatus?: number;
  constructor(reason: OpenApiProbeErrorReason, message: string, httpStatus?: number) {
    super(message);
    this.name = "OpenApiProbeError";
    this.reason = reason;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

/**
 * SSRF guard for the host-side spec fetch. The spec URL is admin-supplied and
 * fetched by the API server itself at install + rediscover, so it must point at
 * a public HTTPS host — otherwise a workspace admin could aim it at
 * cloud-metadata (`169.254.169.254`) or internal services (classic SSRF). The
 * guard is ON in every deploy mode; self-hosted operators who legitimately
 * connect internal OpenAPI services opt OUT explicitly via
 * `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true` (#3006 — no implicit non-SaaS skip).
 *
 * Delegates to the shared {@link assertBaseUrlAllowed} chokepoint and rethrows
 * its {@link EgressBlockedError} as {@link OpenApiProbeError} `unreachable`, so
 * callers surface the same actionable 400 they already map probe failures to.
 *
 * IP/CIDR-based (via `assertBaseUrlAllowed` → `isSafeExternalUrl`): it does not
 * resolve DNS, so a public name that resolves to a private IP is out of scope at
 * this layer — that redirect/rebind case is caught at fetch time by
 * {@link guardedFetch}.
 */
export function assertSpecUrlAllowed(specUrl: string): void {
  try {
    assertBaseUrlAllowed(specUrl);
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      throw new OpenApiProbeError("unreachable", err.message);
    }
    throw err;
  }
}

export interface ProbeOptions {
  /** `fetch` override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /**
   * The datasource's resolved API base URL (or any URL on its API host) — the
   * admin's `base_url_override` if supplied, else a candidate-declared
   * `apiBaseUrl`. Used SOLELY to gate the probe credential (#3034): the
   * credential is attached to the spec fetch iff this URL's host equals the spec
   * URL's host. ABSENT ⇒ the credential is never attached (fail-safe) — so a spec
   * pinned to a public third-party host (raw.githubusercontent.com for
   * stripe-data / notion-data) cannot receive the workspace credential, while a
   * same-host authenticated spec (Twenty's `/open-api/core`) still authenticates.
   */
  readonly apiBaseUrl?: string;
}

/**
 * A URL's host (`hostname[:port]`, already lowercased by the URL parser), or
 * `null` when the URL is unparseable OR has no host (opaque-scheme URLs like
 * `data:` / `javascript:` parse successfully with an empty host). Collapsing both
 * "unparseable" and "empty host" to `null` keeps {@link probeCredentialAllowed}
 * self-defending: two empty hosts must never compare equal and send the
 * credential — the gate fails safe without depending on an upstream scheme check.
 */
function urlHost(url: string): string | null {
  try {
    const host = new URL(url).host;
    return host.length > 0 ? host : null;
  } catch {
    // intentionally ignored: an unparseable URL has no comparable host — the
    // caller treats null as "no host match" and withholds the credential.
    return null;
  }
}

/**
 * The host-match credential gate (#3034). The probe credential may be attached to
 * the spec fetch ONLY when the resolved API host is known AND equals the spec
 * URL's host — so a same-host authenticated spec (Twenty: `/open-api/core` on the
 * API host) still authenticates, while a spec pinned to a public third-party host
 * (stripe-data / notion-data both fetch from raw.githubusercontent.com) never
 * receives the workspace credential. An unknown API host, or either URL
 * unparseable, ⇒ `false` (fail-safe: never send the credential to an un-vetted
 * host). Deliberately NO opt-in flag — the bug was an unsafe default, and the fix
 * must not add a lever that re-enables sending to an arbitrary host.
 *
 * Match is intentionally EXACT host (`hostname[:port]`) — `api.stripe.com` does
 * NOT match `files.stripe.com` or `stripe.com`. Only the host is compared (scheme
 * and path are ignored, so a same-host spec on a sub-path still authenticates).
 * Relaxing this to suffix/subdomain matching would be a security regression.
 */
function probeCredentialAllowed(specUrl: string, apiBaseUrl: string | undefined): boolean {
  if (!apiBaseUrl) return false;
  const specHost = urlHost(specUrl);
  const apiHost = urlHost(apiBaseUrl);
  return specHost !== null && apiHost !== null && specHost === apiHost;
}

/**
 * Build the {@link ResolvedAuth} the slice-0 client applies, from the install
 * form's `auth_kind` + `auth_value` (+ optional header/param name).
 *
 * Total over {@link SupportedAuthKind}: `oauth2` is excluded at the type level
 * (slice 6 owns its flow), so callers narrow via `narrowSupportedAuthKind`
 * before reaching here and there is no runtime "unsupported kind" throw. `basic`
 * splits `auth_value` on the first `:` into user:pass.
 */
export function buildResolvedAuth(
  authKind: SupportedAuthKind,
  authValue: string | undefined,
  authHeaderName: string | undefined,
  authParamName: string | undefined,
): ResolvedAuth {
  switch (authKind) {
    case "none":
      return { kind: "none" };
    case "bearer":
      return { kind: "bearer", token: authValue ?? "" };
    case "basic": {
      const raw = authValue ?? "";
      const idx = raw.indexOf(":");
      const username = idx >= 0 ? raw.slice(0, idx) : raw;
      const password = idx >= 0 ? raw.slice(idx + 1) : "";
      return { kind: "basic", username, password };
    }
    case "apikey-header":
      return {
        kind: "apiKey",
        value: authValue ?? "",
        placement: { in: "header", name: authHeaderName || "X-API-Key" },
      };
    case "apikey-query":
      return {
        kind: "apiKey",
        value: authValue ?? "",
        placement: { in: "query", name: authParamName || "api_key" },
      };
    default: {
      // Exhaustiveness guard: a new SupportedAuthKind must grow a case here.
      const _exhaustive: never = authKind;
      throw new OpenApiProbeError("unparseable", `Unhandled auth kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * The outcome of resolving auth from a decrypted `workspace_plugins.config` row.
 * Discriminated on `ok` so callers handle the deferred/unsupported kind
 * explicitly (skip + log on the resolve path, 400 on the rediscover route)
 * instead of relying on a thrown-and-caught "unsupported kind".
 */
export type DecryptedAuthResult =
  | { readonly ok: true; readonly auth: ResolvedAuth }
  | { readonly ok: false; readonly rawAuthKind: string };

/**
 * Decrypt-glue shared by the two sites that build a {@link ResolvedAuth} from a
 * decrypted install config — the workspace resolver
 * (`workspace-datasource.ts`) and the admin rediscover route
 * (`admin-openapi-datasources.ts`). Both read the same untyped JSONB fields
 * (`auth_kind` / `auth_value` / `auth_header_name` / `auth_param_name`), narrow
 * the kind through {@link narrowSupportedAuthKind}, and call
 * {@link buildResolvedAuth}; the only divergence is how they react to an
 * unsupported/deferred kind (skip vs 400), which is why this returns the
 * discriminated {@link DecryptedAuthResult} rather than throwing.
 *
 * `ok: false` carries the raw kind string so the caller can log/surface it
 * (the value is untyped at the trust boundary — it could be the deferred
 * `oauth2` (slice 6 #2930) OR a drifted/hand-edited garbage value).
 *
 * An ABSENT `auth_kind` is a legitimate no-auth datasource (a public API) and
 * resolves `ok: true` with `{ kind: "none" }`. But a PRESENT-but-non-string
 * value is a drifted/corrupt row — surfaced as `ok: false` (stringified) rather
 * than silently downgraded to no-auth, which would hide a misconfigured
 * credential behind unauthenticated requests (CLAUDE.md: prefer errors over
 * silent fallbacks).
 */
export function resolveAuthFromDecryptedConfig(
  decrypted: Record<string, unknown>,
): DecryptedAuthResult {
  const rawAuthKind = decrypted.auth_kind;
  if (rawAuthKind === undefined) return { ok: true, auth: { kind: "none" } };
  if (typeof rawAuthKind !== "string") return { ok: false, rawAuthKind: String(rawAuthKind) };
  const authKind = narrowSupportedAuthKind(rawAuthKind);
  if (!authKind) return { ok: false, rawAuthKind };
  const authValue = typeof decrypted.auth_value === "string" ? decrypted.auth_value : undefined;
  const authHeaderName =
    typeof decrypted.auth_header_name === "string" ? decrypted.auth_header_name : undefined;
  const authParamName =
    typeof decrypted.auth_param_name === "string" ? decrypted.auth_param_name : undefined;
  return { ok: true, auth: buildResolvedAuth(authKind, authValue, authHeaderName, authParamName) };
}

/**
 * Apply {@link ResolvedAuth} to the spec-fetch request headers. The spec
 * endpoint is usually unauthenticated, but some APIs (Twenty) require the same
 * credential to read `/open-api/core`, so we send it. apiKey-query placement is
 * applied to the URL by {@link probeSpec}; this only handles header-borne auth.
 *
 * Whether the credential is attached at all is decided UPSTREAM by
 * {@link probeSpec}'s host-match gate (#3034) — this helper is called only when
 * the spec host equals the datasource's API host. It always emits the header for
 * the kind it's given.
 */
function authHeadersForProbe(auth: ResolvedAuth): Record<string, string> {
  switch (auth.kind) {
    case "none":
      return {};
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
    case "basic": {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    case "apiKey":
      return auth.placement?.in === "header"
        ? { [auth.placement.name]: auth.value }
        : {};
  }
}

/**
 * Fetch the OpenAPI document from `openapiUrl` (applying `auth`) and normalize
 * it to an {@link OperationGraph}. Throws {@link OpenApiProbeError} on any
 * failure — never returns a partial result.
 */
export async function probeSpec(
  openapiUrl: string,
  auth: ResolvedAuth,
  options: ProbeOptions = {},
): Promise<{ readonly doc: unknown; readonly graph: OperationGraph }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  // SSRF guard (all deploy modes; opt out via ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS):
  // the spec URL is admin-supplied and fetched here, host-side — block
  // private/internal targets before the fetch. #3006.
  assertSpecUrlAllowed(openapiUrl);

  // Host-match credential gate (#3034): the credential is attached to the spec
  // fetch ONLY when the spec is hosted on the datasource's API host. A spec pinned
  // to a public third-party host (raw.githubusercontent.com for stripe-data /
  // notion-data) must NEVER receive the workspace credential; a same-host
  // authenticated spec (Twenty) still does. Gates BOTH the header credential and
  // the apiKey-query string param below.
  const hasCredential = auth.kind !== "none";
  const sendCredential = hasCredential && probeCredentialAllowed(openapiUrl, options.apiBaseUrl);
  if (hasCredential && !sendCredential) {
    log.debug(
      { specHost: urlHost(openapiUrl) ?? "<unparseable>", authKind: auth.kind },
      "Withholding probe credential: spec host does not match the datasource API host (#3034)",
    );
  }

  // apiKey-query placement: the spec endpoint may itself need the key in the
  // query string. Append it only when the host-match gate allows — and without
  // clobbering an existing query.
  let url = openapiUrl;
  if (sendCredential && auth.kind === "apiKey" && auth.placement?.in === "query") {
    try {
      const u = new URL(openapiUrl);
      u.searchParams.set(auth.placement.name, auth.value);
      url = u.toString();
    } catch {
      // intentionally ignored: a malformed openapi_url surfaces below as an
      // "unreachable" fetch failure with the original string — the URL-parse
      // throw here is not independently actionable.
    }
  }

  let doc: unknown;
  try {
    // `guardedFetch` re-validates the URL immediately before the request leaves
    // the box and re-checks every redirect `Location` host — closing the TOCTOU
    // gap where a guarded public spec URL 302-redirects to an internal target.
    const response = await guardedFetch(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(sendCredential ? authHeadersForProbe(auth) : {}),
        },
        signal: AbortSignal.timeout(probeTimeoutMs()),
      },
      { fetchImpl },
    );
    if (!response.ok) {
      throw new OpenApiProbeError(
        "http_error",
        `Fetching the OpenAPI spec returned HTTP ${response.status}. ` +
          `Check the spec URL and credentials.`,
        response.status,
      );
    }
    doc = await response.json();
  } catch (err) {
    if (err instanceof OpenApiProbeError) throw err;
    if (err instanceof EgressBlockedError) {
      // A redirect to a blocked host (the up-front guard passed; the hop didn't).
      throw new OpenApiProbeError("unreachable", err.message);
    }
    throw new OpenApiProbeError(
      "unreachable",
      `Could not fetch the OpenAPI spec: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let graph: OperationGraph;
  try {
    graph = buildOperationGraph(doc);
  } catch (err) {
    if (err instanceof OpenApiSpecError) {
      throw new OpenApiProbeError(
        "unparseable",
        `The OpenAPI document did not parse (${err.reason}). It must be a valid OpenAPI 3.x spec.`,
      );
    }
    throw new OpenApiProbeError(
      "unparseable",
      `The OpenAPI document could not be normalized: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (graph.operations.size === 0) {
    throw new OpenApiProbeError(
      "no_operations",
      "The OpenAPI document parsed but declared no operations — nothing for the agent to query.",
    );
  }

  return { doc, graph };
}

// ─────────────────────────────────────────────────────────────────────
//  Conditional, credential-free probe — the shared-cache fetch primitive
// ─────────────────────────────────────────────────────────────────────

export interface ConditionalProbeOptions {
  /** `fetch` override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Prior `ETag` — sent as `If-None-Match` so an unchanged spec returns `304`. */
  readonly etag?: string;
  /** Prior `Last-Modified` — sent as `If-Modified-Since` (the weaker validator). */
  readonly lastModified?: string;
}

/**
 * The outcome of a {@link conditionalProbe}. Discriminated on `notModified`:
 *   - `true` — the upstream returned `304`; the caller reuses its cached doc and
 *     re-arms freshness from the echoed validators (no body is parsed).
 *   - `false` — a `2xx` with a fresh document, already normalized to a graph.
 */
export type ConditionalProbeResult =
  | { readonly notModified: true; readonly etag?: string; readonly lastModified?: string }
  | {
      readonly notModified: false;
      readonly doc: unknown;
      readonly graph: OperationGraph;
      readonly etag?: string;
      readonly lastModified?: string;
    };

/**
 * Fetch a PUBLIC OpenAPI document with NO credential, optionally conditionally
 * (`If-None-Match` / `If-Modified-Since`). This is the fetch primitive the
 * cross-workspace shared spec cache (#2970, `shared-spec-cache.ts`) is built on:
 * a shared spec is shareable PRECISELY because it is credential-independent, so
 * this function never attaches auth — guaranteeing a cached shared document can
 * never carry one tenant's authenticated view (the isolation invariant).
 *
 * Same SSRF posture as {@link probeSpec}: the up-front {@link assertSpecUrlAllowed}
 * guard plus {@link guardedFetch}'s per-redirect re-validation. On `304` it
 * returns `notModified: true` (the cached doc stays authoritative); on any other
 * non-2xx it throws {@link OpenApiProbeError} `http_error`; on `2xx` it parses +
 * normalizes exactly like the probe and echoes the response validators so the
 * caller can store them for the next conditional check.
 *
 * Conditional headers are plain cache validators (not auth), so — unlike a
 * credential — they survive a cross-origin redirect; a CDN that strips them on a
 * hop merely costs an occasional full re-download (a `200` instead of a `304`),
 * never a correctness problem.
 */
export async function conditionalProbe(
  specUrl: string,
  options: ConditionalProbeOptions = {},
): Promise<ConditionalProbeResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  assertSpecUrlAllowed(specUrl);

  const conditionalHeaders: Record<string, string> = {
    ...(options.etag ? { "If-None-Match": options.etag } : {}),
    ...(options.lastModified ? { "If-Modified-Since": options.lastModified } : {}),
  };

  let response: Response;
  try {
    response = await guardedFetch(
      specUrl,
      {
        method: "GET",
        headers: { Accept: "application/json", ...conditionalHeaders },
        signal: AbortSignal.timeout(probeTimeoutMs()),
      },
      { fetchImpl },
    );
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      throw new OpenApiProbeError("unreachable", err.message);
    }
    throw new OpenApiProbeError(
      "unreachable",
      `Could not fetch the OpenAPI spec: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;

  // Check 304 BEFORE `!response.ok` — a 304 is not in the 2xx range but is the
  // success-by-reuse case, not an error.
  if (response.status === 304) {
    return {
      notModified: true,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    };
  }
  if (!response.ok) {
    throw new OpenApiProbeError(
      "http_error",
      `Fetching the OpenAPI spec returned HTTP ${response.status}. Check the spec URL.`,
      response.status,
    );
  }

  let doc: unknown;
  try {
    doc = await response.json();
  } catch (err) {
    throw new OpenApiProbeError(
      "unparseable",
      `The OpenAPI document body was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let graph: OperationGraph;
  try {
    graph = buildOperationGraph(doc);
  } catch (err) {
    if (err instanceof OpenApiSpecError) {
      throw new OpenApiProbeError(
        "unparseable",
        `The OpenAPI document did not parse (${err.reason}). It must be a valid OpenAPI 3.x spec.`,
      );
    }
    throw new OpenApiProbeError(
      "unparseable",
      `The OpenAPI document could not be normalized: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (graph.operations.size === 0) {
    throw new OpenApiProbeError(
      "no_operations",
      "The OpenAPI document parsed but declared no operations — nothing for the agent to query.",
    );
  }

  return {
    notModified: false,
    doc,
    graph,
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };
}

/**
 * Assemble the persisted {@link OpenApiSnapshot} from a probed doc + graph.
 * `probedAt` is injected (not read from a clock) so the install handler and
 * tests stamp it deterministically.
 */
export function buildSnapshot(
  doc: unknown,
  graph: OperationGraph,
  probedAt: string,
): OpenApiSnapshot {
  return {
    probedAt,
    title: graph.info.title,
    version: graph.info.version,
    openapiVersion: graph.info.openapiVersion,
    operationCount: graph.operations.size,
    doc,
  };
}

/** Flatten a graph's operations into the detail-page table shape. */
export function summarizeOperations(
  graph: OperationGraph,
): ReadonlyArray<DiscoveredOperationSummary> {
  return [...graph.operations.values()]
    .map((op) => ({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      ...(op.summary ? { summary: op.summary } : {}),
    }))
    .toSorted((a, b) => a.operationId.localeCompare(b.operationId));
}

// ─────────────────────────────────────────────────────────────────────
//  Snapshot → graph rebuild, cached per process
// ─────────────────────────────────────────────────────────────────────

/**
 * In-process cache of the rebuilt {@link OperationGraph}, keyed by
 * `${workspaceId}:${installId}:${probedAt}`. The probe + normalize is the
 * expensive, credential-independent part; a 250KB Twenty spec rebuilt on every
 * agent turn would be wasteful. Mirrors the slice-1 `graphCache` rationale
 * (cache the shape, never the credential).
 *
 * **Why the `workspaceId` prefix (#3010):** `install_id` is NOT globally unique
 * — the composite PK is `(workspace_id, catalog_id, install_id)`, and the schema
 * permits human-readable ids (`prod-us`). Keying on `installId:probedAt` alone
 * was safe only because the sole openapi-generic handler mints UUID install ids;
 * a future non-UUID path (an `atlas.config.ts` plugins entry, the CLI seeder
 * extended to REST, slice 6) could collide two workspaces' ids and serve one
 * workspace's operation surface to another. The cached value is shape-only (no
 * credential), so this is defense-in-depth — but it shares the page-L2 cache's
 * workspace-prefixed scoping discipline ({@link installCacheKey} prefixes
 * `${workspaceId}::…`) so neither cache can drift into a cross-tenant assumption.
 * (The literal separators differ — single `:` here, `::` there — because the two
 * are independent in-process namespaces; only the workspace-scoping is shared.)
 *
 * Keying on `probedAt` means a "Rediscover schema" re-probe (which bumps
 * `probedAt`) lands under a fresh key; the now-orphaned prior key is dropped by
 * {@link invalidateInstallGraphCache}, called from the rediscover + delete
 * routes. Without that eviction the map would grow by one entry per rediscover
 * (bounded by install × rediscover count, not install count).
 */
const graphCache = new Map<string, OperationGraph>();

/** The composite cache key prefix for one install — see {@link graphCache}. */
function graphCacheKeyPrefix(workspaceId: string, installId: string): string {
  return `${workspaceId}:${installId}:`;
}

/** Test seam — drop every cached graph for hermetic isolation between tests. */
export function __resetSnapshotGraphCacheForTests(): void {
  graphCache.clear();
}

/**
 * Evict every cached graph for one install across all `probedAt` revisions
 * (prefix-delete on `${workspaceId}:${installId}:`). Called from the rediscover
 * route (a re-probe bumps `probedAt`, orphaning the prior key) and the DELETE
 * route (an uninstalled datasource's graph must not linger). The trailing `:` in
 * the prefix is load-bearing: it stops `ds-1` from also matching `ds-10`.
 *
 * Scoped to `(workspaceId, installId)` so evicting one workspace's install never
 * touches another workspace that happens to share the same (non-unique)
 * `install_id` — the same isolation the {@link graphCache} key enforces (#3010).
 */
export function invalidateInstallGraphCache(workspaceId: string, installId: string): void {
  const prefix = graphCacheKeyPrefix(workspaceId, installId);
  for (const key of graphCache.keys()) {
    if (key.startsWith(prefix)) graphCache.delete(key);
  }
}

/**
 * Rebuild the {@link OperationGraph} from a persisted snapshot, memoized per
 * `(workspaceId, installId, probedAt)`. Throws {@link OpenApiProbeError}
 * `unparseable` if the cached doc no longer parses (e.g. a snapshot written by an
 * older builder) — fail loud so a corrupt cache is diagnosable, never a silently
 * empty surface. `workspaceId` is part of the key (not just `installId`) because
 * `install_id` is not globally unique — see {@link graphCache}.
 */
export function snapshotToGraph(
  workspaceId: string,
  installId: string,
  snapshot: OpenApiSnapshot,
): OperationGraph {
  const key = `${graphCacheKeyPrefix(workspaceId, installId)}${snapshot.probedAt}`;
  const cached = graphCache.get(key);
  if (cached) return cached;

  let graph: OperationGraph;
  try {
    graph = buildOperationGraph(snapshot.doc);
  } catch (err) {
    if (err instanceof OpenApiSpecError) {
      throw new OpenApiProbeError(
        "unparseable",
        `Cached OpenAPI snapshot for install "${installId}" no longer parses (${err.reason}) — rediscover the schema.`,
      );
    }
    throw new OpenApiProbeError(
      "unparseable",
      `Cached OpenAPI snapshot for install "${installId}" could not be rebuilt: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  graphCache.set(key, graph);
  return graph;
}
