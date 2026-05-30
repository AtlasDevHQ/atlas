/**
 * `workspace-datasource` — the slice-2 DB-backed REST datasource resolver
 * (#2926). The per-workspace install registry the slice-1 `datasource.ts`
 * header promised would replace its env-driven shortcut: resolves a workspace's
 * installed `openapi-generic` datasources from `workspace_plugins` (decrypted,
 * graph rebuilt from the cached snapshot) into the same {@link RestDatasource}
 * shape the agent loop + tools already consume — so the swap from env to DB
 * needs no consumer change downstream.
 *
 * Multi-instance per ADR-0007: one workspace installs Twenty, Stripe, and an
 * internal service side by side, each its own `install_id` row. This returns
 * the full set; the caller (agent loop) renders each and routes
 * `executeRestOperation` by `datasourceId`.
 *
 * Credential separation: the credential is decrypted per call (the snapshot
 * graph is cached in-process by `probe.ts`, the credential never is) so a
 * rotated `auth_value` takes effect on the next turn without a restart — same
 * cache-the-shape-not-the-secret principle as slice 1.
 *
 * Fail-soft per install: a row whose snapshot can't rebuild (corrupt cache,
 * older builder) or whose config is malformed is logged and SKIPPED, never
 * thrown — one broken datasource must not take the whole chat turn (or the
 * workspace's other datasources) offline. Mirrors the boot loader's
 * skip-and-continue posture.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { decryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { RestDatasource } from "./datasource";
import {
  OPENAPI_GENERIC_CATALOG_ID,
  OPENAPI_GENERIC_CONFIG_SCHEMA,
  coerceRepresentationMode,
  isValidSnapshot,
  parseRateLimitPerMinute,
  parseRequestTimeoutMs,
  parseSideEffectingOperations,
  parseWriteAllowlist,
} from "./catalog";
import {
  DATA_CANDIDATE_CATALOG_IDS,
  DATA_CANDIDATE_CONFIG_SCHEMA,
  findDataCandidateByCatalogId,
} from "./data-candidates";
import { assertBaseUrlAllowed, EgressBlockedError, hostForLog } from "./egress-guard";
import { resolveAuthFromDecryptedConfig, snapshotToGraph } from "./probe";
import type { OperationGraph } from "./types";

const log = createLogger("openapi.workspace-datasource");

/**
 * A `workspace_plugins` row this resolver reads. `config` is the raw (encrypted)
 * JSONB. A `type` (not `interface`) so it satisfies `internalQuery`'s
 * `Record<string, unknown>` row constraint via TS's implicit index signature.
 *
 * `catalog_id` distinguishes a plain `openapi-generic` install from a built-in
 * data-candidate install (e.g. `catalog:stripe-data`, slice 6a #3028) so the
 * resolver can attach the candidate's code-resident quirk + decrypt with the
 * matching config schema. Optional for back-compat: a row that omits it is
 * treated as the generic datasource (no quirk).
 */
export type OpenApiInstallRow = {
  readonly install_id: string;
  readonly catalog_id?: string;
  readonly config: Record<string, unknown> | null;
};

/**
 * Injected query seam — production passes the real `internalQuery`; tests pass a
 * fixture so the resolver is exercised without a DB (AC6: Effect test layers, no
 * top-level `mock.module()`).
 */
export type OpenApiInstallQuery = (
  workspaceId: string,
) => Promise<ReadonlyArray<OpenApiInstallRow>>;

export interface ResolveWorkspaceDeps {
  readonly query?: OpenApiInstallQuery;
}

/**
 * Executor seam for {@link defaultQuery}. Production omits it (the lazily-imported
 * `internalQuery` runs against the real pool); tests pass one to assert the SQL +
 * param binding without a DB — the existing `deps.query` seam injects at the
 * resolver level and so never exercises this function's own scope clause.
 */
export type OpenApiInstallQueryExecutor = (
  sql: string,
  params: unknown[],
) => Promise<ReadonlyArray<OpenApiInstallRow>>;

/**
 * Default query: the workspace's non-archived REST datasource installs — the
 * built-in `openapi-generic` row AND every data candidate (slice 6a, #3028),
 * matched via `catalog_id = ANY($2)` over one code-resident array of catalog ids.
 * Lazily imports `internalQuery` so the resolver's static graph stays free of
 * the DB module (admin-route tests partial-mock it heavily).
 *
 * The `WHERE` clause is the load-bearing tenant-scope guard: every conjunct
 * (`workspace_id = $1`, `catalog_id = ANY($2)`, `pillar = 'datasource'`,
 * `status != 'archived'`) must hold, or the resolver leaks another tenant's
 * datasources / credentials. The `$2` array holds only built-in catalog
 * constants (never client input). Every other test injects `deps.query` and so
 * bypasses this SQL — the `exec` seam lets a unit test drive it directly and
 * fail loudly if the scope or param order regresses (#3011).
 */
export async function defaultQuery(
  workspaceId: string,
  exec?: OpenApiInstallQueryExecutor,
): Promise<ReadonlyArray<OpenApiInstallRow>> {
  // Match the generic datasource AND every built-in data candidate (slice 6a,
  // #3028) — `catalog_id = ANY($2)` over one array keeps the scope a single
  // bind. The per-conjunct tenant guard is otherwise unchanged.
  const sql = `SELECT install_id, catalog_id, config
       FROM workspace_plugins
      WHERE workspace_id = $1
        AND catalog_id = ANY($2)
        AND pillar = 'datasource'
        AND status != 'archived'
      ORDER BY installed_at ASC`;
  const params = [workspaceId, [OPENAPI_GENERIC_CATALOG_ID, ...DATA_CANDIDATE_CATALOG_IDS]];
  if (exec) return exec(sql, params);
  const { internalQuery } = await import("@atlas/api/lib/db/internal");
  return internalQuery<OpenApiInstallRow>(sql, params);
}

const GENERIC_SECRET_SCHEMA = parseConfigSchema(OPENAPI_GENERIC_CONFIG_SCHEMA);
const CANDIDATE_SECRET_SCHEMA = parseConfigSchema(DATA_CANDIDATE_CONFIG_SCHEMA);

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Resolve the operations base URL the client executes against:
 *   1. `base_url_override` wins (the dev/staging escape hatch).
 *   2. else the spec's `servers[0].url`, resolved against the spec URL when
 *      relative (a spec at `https://x/openapi.json` with `servers: ["/rest"]`
 *      → `https://x/rest`).
 *   3. else the spec URL's origin (last-resort fallback).
 */
function resolveBaseUrl(
  openapiUrl: string,
  graph: OperationGraph,
  override: string | undefined,
): string {
  if (override && override.length > 0) return stripTrailingSlash(override);
  const serverUrl = graph.servers[0]?.url;
  if (serverUrl) {
    try {
      return stripTrailingSlash(new URL(serverUrl, openapiUrl).toString());
    } catch {
      // intentionally ignored: fall through to the origin fallback below.
    }
  }
  try {
    return new URL(openapiUrl).origin;
  } catch {
    // intentionally ignored: a malformed openapi_url can't be salvaged here;
    // return it verbatim so the client surfaces a clear transport error.
    return openapiUrl;
  }
}

/** Build a single {@link RestDatasource} from a decrypted install row, or `null` to skip. */
function buildDatasource(
  workspaceId: string,
  installId: string,
  catalogId: string | undefined,
  decrypted: Record<string, unknown>,
): RestDatasource | null {
  // Validate the snapshot read back from JSONB, rather than an unchecked cast: a
  // drifted / older-builder row is treated as "no snapshot" (skip), not a
  // RestDatasource with undefined/NaN denormalized fields in the prompt.
  const snapshot = decrypted.openapi_snapshot;
  if (!isValidSnapshot(snapshot)) {
    log.warn(
      { installId },
      "OpenAPI install has no valid cached snapshot — skipping (rediscover the schema)",
    );
    return null;
  }

  const openapiUrl = typeof decrypted.openapi_url === "string" ? decrypted.openapi_url : "";
  // Narrow + build the credential from the decrypted JSONB via the glue shared
  // with the rediscover route. A drifted / hand-edited row could carry the
  // deferred `oauth2` (slice 6 #2930) OR an outright unrecognized value — both
  // resolve to `ok: false` and skip here, rather than passing a garbage string
  // through to a buildResolvedAuth throw.
  const authResult = resolveAuthFromDecryptedConfig(decrypted);
  if (!authResult.ok) {
    log.warn(
      { installId, authKind: authResult.rawAuthKind },
      "OpenAPI install uses an unsupported or deferred auth kind — skipping (oauth2 lands in slice 6)",
    );
    return null;
  }
  const auth = authResult.auth;
  const baseUrlOverride = typeof decrypted.base_url_override === "string" ? decrypted.base_url_override : undefined;
  const displayName =
    typeof decrypted.display_name === "string" && decrypted.display_name.length > 0
      ? decrypted.display_name
      : snapshot.title;

  let graph: OperationGraph;
  try {
    graph = snapshotToGraph(workspaceId, installId, snapshot);
  } catch (err) {
    log.warn(
      { installId, err: err instanceof Error ? err.message : String(err) },
      "Failed to rebuild OpenAPI datasource from snapshot — skipping",
    );
    return null;
  }

  // Slice 5 (#2929): the write-side opt-in. `write_allowlist` is stored as the
  // form's JSON string; an `atlas.config.ts` plugins entry may pass an array.
  // Both normalize to a Set; anything malformed fails closed to read-only.
  const writeAllowlist = parseWriteAllowlist(decrypted.write_allowlist, installId);
  // #3008: operationIds the operator marks side-effecting (a mutating RPC-over-GET) —
  // forced through the write allowlist + confirm path even though their method reads.
  // A malformed list degrades to empty (classification stays method-only) — note
  // this is NOT the "fails closed to read-only" posture above: an empty side-effecting
  // list LEAVES an intended-to-gate GET running unconfirmed. See parseSideEffectingOperations.
  const sideEffectingOperations = parseSideEffectingOperations(decrypted.side_effecting_operations, installId);
  const rateLimitPerMinute = parseRateLimitPerMinute(decrypted.rate_limit_per_minute, installId);
  const requestTimeoutMs = parseRequestTimeoutMs(decrypted.request_timeout_ms, installId);

  // Resolve-side SSRF chokepoint (#3006): the operations base URL the agent
  // sends requests to — an admin override OR the spec-derived `servers[0].url` — must
  // pass the same guard install/rediscover apply. A public spec that declared an
  // internal `servers[0].url` would otherwise produce a credentialed host-side
  // request to internal infra. Fail-soft (skip + log), matching this resolver's
  // posture: one misconfigured datasource must not sink the workspace's others.
  // `guardedFetch` in the client is the hard execution-time backstop.
  const baseUrl = resolveBaseUrl(openapiUrl, graph, baseUrlOverride);
  try {
    assertBaseUrlAllowed(baseUrl);
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      log.warn(
        { installId, host: hostForLog(baseUrl) },
        "OpenAPI install resolves to a blocked (private/internal) base URL — skipping " +
          "(set ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true to allow internal targets, self-hosted only)",
      );
      return null;
    }
    throw err;
  }

  // Slice 6a (#3028): a built-in data-candidate install carries its declarative
  // quirk in the code-resident registry (keyed by catalog id), never in config —
  // attach it so the agent tool can thread it into the client. A plain
  // openapi-generic install (or an unknown catalog id) has none.
  const candidate =
    catalogId !== undefined ? findDataCandidateByCatalogId(catalogId) : undefined;

  return {
    id: installId,
    displayName,
    graph,
    baseUrl,
    auth,
    representationMode: coerceRepresentationMode(decrypted.representation_mode),
    writeAllowlist,
    sideEffectingOperations,
    ...(rateLimitPerMinute !== undefined ? { rateLimitPerMinute } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(candidate?.quirk !== undefined ? { quirk: candidate.quirk } : {}),
  };
}

/**
 * Decrypt + build the resolvable subset of already-loaded install rows.
 * Per-install failures (decrypt / snapshot / deferred-auth) are skipped and
 * logged — one broken install must never sink the workspace's others. Pure
 * (modulo logging); the query that loads `rows` is the caller's concern, so the
 * strict / soft variants below differ only in how a *query* failure is handled.
 */
function buildDatasourcesFromRows(
  workspaceId: string,
  rows: ReadonlyArray<OpenApiInstallRow>,
): RestDatasource[] {
  const out: RestDatasource[] = [];
  for (const row of rows) {
    // Pick the decryption schema by catalog: a data candidate's config (slice 6a)
    // carries fewer fields than the generic one, but both mark `auth_value` as the
    // sole secret — so decryption is identical in practice; selecting the matching
    // schema keeps the seam correct if a future candidate adds its own secret field.
    const secretSchema =
      row.catalog_id !== undefined && findDataCandidateByCatalogId(row.catalog_id) !== undefined
        ? CANDIDATE_SECRET_SCHEMA
        : GENERIC_SECRET_SCHEMA;
    let decrypted: Record<string, unknown>;
    try {
      decrypted = decryptSecretFields(row.config ?? {}, secretSchema);
    } catch (err) {
      log.warn(
        { workspaceId, installId: row.install_id, err: err instanceof Error ? err.message : String(err) },
        "Failed to decrypt OpenAPI datasource config — skipping",
      );
      continue;
    }
    const ds = buildDatasource(workspaceId, row.install_id, row.catalog_id, decrypted);
    if (ds) out.push(ds);
  }
  return out;
}

/**
 * Strict resolver: a whole-query failure (the install registry itself is
 * unreachable — e.g. an internal-DB outage) **propagates**, so a user-facing
 * caller can distinguish "couldn't load the registry" from "this workspace has
 * none" instead of conflating the two into a false "no REST datasource is
 * connected" (#2929 review). Per-install failures still skip-and-continue.
 *
 * Use this at the sites that make a user-facing claim about datasource presence
 * — the `executeRestOperation` tool and the confirm endpoint. The prompt-build /
 * Effect-registry / python-egress paths want the never-rejects
 * {@link resolveWorkspaceRestDatasources}, which degrades to `[]` on failure.
 */
export async function resolveWorkspaceRestDatasourcesOrThrow(
  workspaceId: string,
  deps: ResolveWorkspaceDeps = {},
): Promise<ReadonlyArray<RestDatasource>> {
  const query = deps.query ?? defaultQuery;
  // A query failure propagates here, on purpose — the caller turns it into a
  // distinct "temporarily unavailable" signal rather than an empty result.
  const rows = await query(workspaceId);
  return buildDatasourcesFromRows(workspaceId, rows);
}

/**
 * Resolve every installed REST datasource for a workspace. Returns `[]` when the
 * workspace has none AND — fail-soft — when the load itself fails (logged). This
 * never-rejects contract is depended on by the prompt-build path (`agent.ts`,
 * which must not fail a chat turn over a datasource blip) and the python egress
 * thunk (`tools/python.ts`). A caller that must tell a load failure apart from an
 * empty workspace uses {@link resolveWorkspaceRestDatasourcesOrThrow} instead.
 */
export async function resolveWorkspaceRestDatasources(
  workspaceId: string,
  deps: ResolveWorkspaceDeps = {},
): Promise<ReadonlyArray<RestDatasource>> {
  try {
    return await resolveWorkspaceRestDatasourcesOrThrow(workspaceId, deps);
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "Failed to load OpenAPI datasource installs — continuing with none",
    );
    return [];
  }
}

/**
 * Resolve the workspace's single "primary" REST datasource (the
 * earliest-installed), or `null`. Adapter for the single-datasource thunk the
 * Python sandbox egress allowlist (`tools/python.ts`) still expects; the
 * multi-datasource fan-out (the agent loop + `executeRestOperation`) uses
 * {@link resolveWorkspaceRestDatasources} directly.
 */
export async function resolveWorkspacePrimaryRestDatasource(
  workspaceId: string,
  deps: ResolveWorkspaceDeps = {},
): Promise<RestDatasource | null> {
  const all = await resolveWorkspaceRestDatasources(workspaceId, deps);
  return all[0] ?? null;
}
