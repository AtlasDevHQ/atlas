/**
 * `openapi-datasource` — slice-1 resolver for the hardcoded Twenty REST
 * datasource (PRD #2868 slice 1, #2924).
 *
 * END STATE (the thing this is becoming): a REST datasource is a *queryable
 * connection that lives in the workspace*, exactly like a Postgres / MySQL
 * connection. SQL connections are resolved per-workspace from
 * `workspace_plugins WHERE pillar = 'datasource'` via `ConnectionRegistry`
 * (ADR-0006 / ADR-0007); a REST datasource is the parallel adapter (PRD #2868
 * "Option B"), resolved per-workspace from the SAME table with its credentials
 * encrypted at rest. It does NOT live in env, and it is NOT an operator-global
 * thing — each workspace installs its own at `/admin/connections`.
 *
 * This module is the deliberately-thin, env-driven *transitional shortcut* the
 * slice-1 issue scoped ("no admin UX yet, hardcoded bearer + base URL"). It
 * wires ONE datasource — Twenty — behind the `ATLAS_OPENAPI_TWENTY` flag, probes
 * its `/rest/open-api/core` spec once, normalizes it to the slice-0
 * {@link OperationGraph}, and caches it. Slice 2 (#2926) replaces this whole
 * module with the per-workspace install registry (resolving by the request's
 * workspaceId from the DB); the {@link RestDatasource} shape it returns is what
 * the agent wiring + tool consume, and they already resolve at execute time, so
 * that swap is contained — no consumer changes.
 *
 * Credential separation: this reads `ATLAS_OPENAPI_TWENTY_TOKEN` /
 * `ATLAS_OPENAPI_TWENTY_BASE_URL`, NOT `TWENTY_API_KEY` / `TWENTY_BASE_URL`.
 * The latter belong to Atlas's own lead-capture pipeline (`ee/src/saas-crm/`,
 * see #2850) and must never be conflated with a user-facing datasource
 * credential. A distinct namespace keeps the two structurally separate.
 *
 * Fail-soft: a flag that's on but misconfigured (missing creds, unreachable
 * spec, unparseable document) logs and returns `null` rather than throwing —
 * the agent loop degrades to "no REST datasource", same as the semantic-layer
 * and learned-patterns preflight loaders. The operator sees a warning; chat
 * keeps working.
 */
import { buildOperationGraph } from "./spec";
import { OpenApiSpecError, type OperationGraph, type ResolvedAuth } from "./types";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("openapi.datasource");

/**
 * A resolved REST datasource the agent can read from — the REST analogue of a
 * resolved SQL connection from `ConnectionRegistry`: the normalized operation
 * graph, the base URL operations execute against, and the credential the
 * slice-0 client applies. Shape is stable across slices and workspace-agnostic
 * — slice 2's per-workspace install registry returns exactly this, resolved
 * from `workspace_plugins` (encrypted) by the request's workspaceId.
 */
export interface RestDatasource {
  /** Stable id used in tool params + trace attributes. Slice 1: always "twenty". */
  readonly id: string;
  /** Human-facing name for the prompt header. */
  readonly displayName: string;
  /** The normalized operation graph (slice-0). */
  readonly graph: OperationGraph;
  /** Base URL operations execute against, e.g. `https://crm.example.com/rest`. */
  readonly baseUrl: string;
  /** Credential the slice-0 {@link executeOperation} applies. */
  readonly auth: ResolvedAuth;
}

export interface ResolveOptions {
  /** `fetch` override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Bypass the module cache and re-probe the spec. */
  readonly reload?: boolean;
}

// Module-level cache of the normalized GRAPH only (not the datasource), keyed by
// base URL. The spec probe + normalize is the expensive, credential-independent
// part; the Twenty workspace schema is operator-managed and changes rarely (same
// caching rationale as `getPersonRestSchema`'s "cache for the process lifetime").
// The credential is NEVER cached — `resolveTwentyDatasource` stamps the CURRENT
// token onto a fresh `RestDatasource` on every call, so a rotated
// `ATLAS_OPENAPI_TWENTY_TOKEN` takes effect immediately without a restart.
//
// This split — cache the shape, build the credential per call — is exactly the
// principle the cross-workspace shared-spec cache (#2970) generalizes: the
// normalized graph is shareable, the credential is not. SLICE-2 (#2926) makes
// the credential per-workspace (DB-backed) rather than per-env; because it's
// already rebuilt per call, that swap needs no change here. The graph key should
// also gain spec identity (URL + version/ETag) when cross-workspace sharing lands.
const graphCache = new Map<string, OperationGraph>();

/** Reset the cache. Test-only seam — production never evicts (single long-lived spec). */
export function __resetTwentyDatasourceCacheForTests(): void {
  graphCache.clear();
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim().length > 0 ? v.trim() : undefined;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Resolve the Twenty REST datasource, or `null` when the flag is off or the
 * configuration is incomplete/unreachable. Probes + caches the spec on first
 * success.
 */
export async function resolveTwentyDatasource(
  options: ResolveOptions = {},
): Promise<RestDatasource | null> {
  if (readEnv("ATLAS_OPENAPI_TWENTY") !== "true") return null;

  const token = readEnv("ATLAS_OPENAPI_TWENTY_TOKEN");
  const rawBaseUrl = readEnv("ATLAS_OPENAPI_TWENTY_BASE_URL");
  if (!token || !rawBaseUrl) {
    log.warn(
      { hasToken: !!token, hasBaseUrl: !!rawBaseUrl },
      "ATLAS_OPENAPI_TWENTY=true but ATLAS_OPENAPI_TWENTY_TOKEN and/or " +
        "ATLAS_OPENAPI_TWENTY_BASE_URL are unset — Twenty REST datasource unavailable.",
    );
    return null;
  }

  const base = stripTrailingSlash(rawBaseUrl);
  const operationsBaseUrl = `${base}/rest`;

  let graph = options.reload ? undefined : graphCache.get(operationsBaseUrl);
  if (!graph) {
    const probed = await probeGraph(base, token, options.fetchImpl);
    if (!probed) return null;
    graph = probed;
    graphCache.set(operationsBaseUrl, probed);
    log.info(
      { operationCount: probed.operations.size, baseUrl: operationsBaseUrl },
      "Twenty REST datasource resolved",
    );
  }

  // Build the datasource fresh with the CURRENT token every call — the graph is
  // cached, the credential never is (so a rotated token applies immediately).
  return {
    id: "twenty",
    displayName: graph.info.title || "Twenty",
    graph,
    baseUrl: operationsBaseUrl,
    auth: { kind: "bearer", token },
  };
}

/**
 * Probe `{base}/rest/open-api/core`, normalize, and return the graph — or `null`
 * (fail-soft, logged) on an unreachable/non-2xx/unparseable spec.
 */
async function probeGraph(
  base: string,
  token: string,
  fetchOverride: typeof globalThis.fetch | undefined,
): Promise<OperationGraph | null> {
  const fetchImpl = fetchOverride ?? globalThis.fetch;
  const specUrl = `${base}/rest/open-api/core`;

  let doc: unknown;
  try {
    const response = await fetchImpl(specUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      log.error(
        { status: response.status },
        `Twenty OpenAPI probe failed (HTTP ${response.status}) — REST datasource unavailable. ` +
          `Check ATLAS_OPENAPI_TWENTY_BASE_URL / _TOKEN.`,
      );
      return null;
    }
    doc = await response.json();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Twenty OpenAPI probe threw — REST datasource unavailable.",
    );
    return null;
  }

  try {
    return buildOperationGraph(doc);
  } catch (err) {
    if (err instanceof OpenApiSpecError) {
      log.error(
        { reason: err.reason, location: err.location },
        `Twenty OpenAPI spec did not parse (${err.reason}) — REST datasource unavailable.`,
      );
    } else {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Twenty OpenAPI spec normalization threw — REST datasource unavailable.",
      );
    }
    return null;
  }
}
