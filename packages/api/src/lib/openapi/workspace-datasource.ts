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
import { normalizeGroupId, type RestDatasource } from "./datasource";
import {
  OPENAPI_GENERIC_CONFIG_SCHEMA,
  coerceRepresentationMode,
  isValidSnapshot,
  parseRateLimitPerMinute,
  parseRequestTimeoutMs,
  parseSideEffectingOperations,
  parseWriteAllowlist,
} from "./catalog";
import {
  DATA_CANDIDATE_CONFIG_SCHEMA,
  REST_DATASOURCE_CATALOG_IDS,
  findDataCandidateByCatalogId,
  isOAuthDatasourceCandidate,
  type DataCandidate,
} from "./data-candidates";
import { GITHUB_APP_SECRET_FIELDS_SCHEMA } from "@atlas/api/lib/integrations/install/github-oauth-secret-schema";
import { getGitHubInstallationToken } from "@atlas/api/lib/github/installation-token";
import { assertBaseUrlAllowed, EgressBlockedError, hostForLog } from "./egress-guard";
import { resolveAuthFromDecryptedConfig, snapshotToGraph } from "./probe";
import { isShareableSpec, sharedGraphFromSnapshot } from "./shared-spec-cache";
import type { OperationGraph, ResolvedAuth } from "./types";

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

/**
 * Mint a GitHub App installation token for a github-data datasource's stored
 * `installation_id` (v0.0.2 slice 6c, #3030). Injected so the resolver is tested
 * without the network / App private key; production defaults to
 * {@link getGitHubInstallationToken} (App-JWT mint, cached + re-minted on expiry).
 */
export type MintInstallationTokenFn = (installationId: string) => Promise<string>;

/**
 * Thrown by {@link resolveWorkspaceRestDatasourcesOrThrow} when a workspace HAS
 * REST datasource installs but EVERY one resolved to a recoverable credential
 * failure (e.g. a github-data install whose GitHub App access was revoked, or a
 * drifted row missing its `installation_id`) — so the usable set is empty for a
 * reason that is NOT "the workspace has none". User-facing callers surface this
 * as "reconnect needed", distinct from `no_datasource`, so the agent never
 * tells the user nothing is connected when something just needs reconnecting.
 * The never-rejects {@link resolveWorkspaceRestDatasources} swallows it (degrades
 * to `[]`, since prompt-build makes no presence claim).
 */
export class RestDatasourceReconnectError extends Error {
  readonly reconnectableCount: number;
  constructor(reconnectableCount: number) {
    super(
      `${reconnectableCount} REST datasource install(s) need reconnecting — their credentials could not be resolved.`,
    );
    this.name = "RestDatasourceReconnectError";
    this.reconnectableCount = reconnectableCount;
  }
}

/**
 * #3067 (Codex P1) — a REST-only focus matched an install row that is PRESENT
 * but could not be built (decrypt failure, unsupported/unhandled auth, blocked
 * base URL — the non-reconnectable skips inside `buildDatasourcesFromRows`;
 * reconnectable ones already surface as {@link RestDatasourceReconnectError}).
 *
 * This is distinct from "the focus matched no install at all" (which resolves to
 * `[]` — the agent's safe fall-back-to-default-scope signal). A present-but-
 * unusable focus must NOT look empty, or the agent re-enables SQL for a
 * datasource the user deliberately narrowed to — a REST-only focus contract
 * violation. The strict resolver throws this so the focus path fails CLOSED; the
 * never-rejects {@link resolveWorkspaceRestDatasources} degrades it to `[]` (its
 * callers — python egress — then deny rather than widen).
 */
export class RestDatasourceFocusUnusableError extends Error {
  readonly focusId: string;
  constructor(focusId: string) {
    super(
      `Focused REST datasource "${focusId}" is installed but could not be built (bad credential, unsupported auth, or blocked URL).`,
    );
    this.name = "RestDatasourceFocusUnusableError";
    this.focusId = focusId;
  }
}

export interface ResolveWorkspaceDeps {
  readonly query?: OpenApiInstallQuery;
  /**
   * Override the github-data credential minter. Production omits it (the real
   * App-JWT minter runs); tests inject a stub so no network / key is needed.
   */
  readonly mintInstallationToken?: MintInstallationTokenFn;
  /**
   * Cross-environment scope filter (#3044, [ADR-0010]). Tri-state:
   *   - **omitted (`undefined`)** — no scoping; resolve every install. The
   *     authorized confirm-replay path (`tools/rest-operation.ts`'s
   *     `resolveFromContext`) relies on this: a staged write is bound by a
   *     signed token and must replay regardless of the request's group context.
   *   - **`null`** — the conversation has no active connection group; resolve
   *     ONLY workspace-global datasources (those with no `group_id`). A scoped
   *     datasource never leaks into a context whose group can't be confirmed.
   *   - **`string`** — the active group id; resolve workspace-global datasources
   *     PLUS those scoped to this exact group.
   * The agent loop always passes an explicit value (string or null) so the
   * prompt + tool see a strictly-scoped set; only the workspace-global default
   * carries over the legacy "always available" behaviour.
   */
  readonly activeGroupId?: string | null;
  /**
   * Per-conversation REST datasource exclude-set (#3066, S2a). Holds the
   * `install_id`s the conversation has excluded — the id the scope picker
   * surfaces (`GET /api/v1/me/connection-groups`). Dropped AFTER the
   * {@link activeGroupId} scope filter and BEFORE credential build, so an
   * excluded datasource never reaches decryption and the reconnect tally is
   * computed only over the surviving set. Omitted / empty = exclude nothing
   * (every in-scope datasource stays queryable, so a newly-installed one is
   * reachable with no action). The authorized confirm-replay path
   * (`tools/rest-operation.ts`'s `resolveFromContext`) intentionally omits
   * this — a staged write replays regardless of the conversation's scope.
   */
  readonly excluded?: ReadonlyArray<string>;
  /**
   * Per-conversation REST-only focus (#3067, S2b). When set to an
   * `install_id`, resolve ONLY that datasource — the focus SHORT-CIRCUITS
   * both {@link activeGroupId} group-scope and the {@link excluded}
   * exclude-set (ADR-0011: those fields are inert while focused). A focus
   * id that matches no install in the workspace's tenant-scoped rows yields
   * `[]`, so the caller falls back safely to default scope (the agent loop
   * keeps `executeSQL` active). Omitted / null / empty = not focused (apply
   * group-scope + exclude-set as normal). The confirm-replay path omits this
   * — like {@link excluded}, a staged write replays regardless of focus.
   */
  readonly focus?: string | null;
}

/**
 * Tenant + cross-environment row filter. Keeps a row iff it is in scope for the
 * caller's `activeGroupId` (see {@link ResolveWorkspaceDeps.activeGroupId}). Pure
 * — operates on the raw `config.group_id` (plain, non-secret JSONB), so it runs
 * before credential decryption / build and the reconnect tally is computed only
 * over in-scope rows.
 */
function rowsInActiveGroup(
  rows: ReadonlyArray<OpenApiInstallRow>,
  activeGroupId: string | null | undefined,
): ReadonlyArray<OpenApiInstallRow> {
  // Omitted ⇒ no scoping (confirm-replay + any non-opted-in caller).
  if (activeGroupId === undefined) return rows;
  return rows.filter((row) => {
    const rowGroupId = normalizeGroupId(row.config?.group_id);
    // Workspace-global (no group) is always in scope.
    if (rowGroupId === null) return true;
    // Scoped: in scope only when the active group matches. `null` activeGroupId
    // (no active group) admits no scoped datasource.
    return activeGroupId !== null && rowGroupId === activeGroupId;
  });
}

/**
 * Per-conversation exclude-set filter (#3066, S2a). Drops every install whose
 * `install_id` the conversation has excluded. Pure over the raw `install_id`
 * (no config / credential access), mirroring {@link rowsInActiveGroup}, so it
 * runs BEFORE credential build and an excluded datasource never reaches
 * decryption. An omitted / empty set excludes nothing.
 */
function rowsNotExcluded(
  rows: ReadonlyArray<OpenApiInstallRow>,
  excluded: ReadonlyArray<string> | undefined,
): ReadonlyArray<OpenApiInstallRow> {
  if (!excluded || excluded.length === 0) return rows;
  const excludeSet = new Set(excluded);
  return rows.filter((row) => !excludeSet.has(row.install_id));
}

/**
 * REST-only focus filter (#3067, S2b). Keeps ONLY the install whose
 * `install_id` matches the focus target — operating over the already
 * tenant-scoped rows (`workspace_id = $1` in {@link defaultQuery}), so a focus
 * can never resolve another workspace's datasource. Returns `[]` when the focus
 * matches no install (the datasource was uninstalled), which the agent loop
 * reads as "fall back to default scope". Pure over the raw `install_id`, so it
 * too runs before credential build.
 */
function rowsFocused(
  rows: ReadonlyArray<OpenApiInstallRow>,
  focus: string,
): ReadonlyArray<OpenApiInstallRow> {
  return rows.filter((row) => row.install_id === focus);
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
  const params = [workspaceId, [...REST_DATASOURCE_CATALOG_IDS]];
  if (exec) return exec(sql, params);
  const { internalQuery } = await import("@atlas/api/lib/db/internal");
  return internalQuery<OpenApiInstallRow>(sql, params);
}

const GENERIC_SECRET_SCHEMA = parseConfigSchema(OPENAPI_GENERIC_CONFIG_SCHEMA);
const CANDIDATE_SECRET_SCHEMA = parseConfigSchema(DATA_CANDIDATE_CONFIG_SCHEMA);

/**
 * Pick the selective-encryption schema for a row's config by candidate. The
 * three shapes differ only in WHICH field is the secret:
 *   - github-data (oauth-datasource): `installation_id` — reuse the App schema.
 *   - other data candidates / generic: `auth_value`.
 * Selecting the matching schema keeps decrypt in lockstep with the handler's
 * encrypt (a write that encrypts more than the read decrypts corrupts the value).
 */
function secretSchemaFor(candidate: DataCandidate | undefined) {
  if (candidate && isOAuthDatasourceCandidate(candidate)) return GITHUB_APP_SECRET_FIELDS_SCHEMA;
  return candidate ? CANDIDATE_SECRET_SCHEMA : GENERIC_SECRET_SCHEMA;
}

/**
 * The outcome of resolving one install's credential. `skip` distinguishes a
 * **reconnectable** miss (a connected datasource whose credential is temporarily
 * unresolvable — a github-data mint failure or a drifted row missing its
 * `installation_id`; an admin reconnect fixes it) from a non-reconnectable one
 * (an unsupported / deferred static auth kind — re-installing won't help). The
 * caller uses this to tell "this workspace has no datasource" apart from "its
 * datasource needs reconnecting" instead of conflating both into an empty set.
 */
type AuthResolution =
  | { readonly kind: "ok"; readonly auth: ResolvedAuth }
  | { readonly kind: "skip"; readonly reconnectable: boolean };

/**
 * Resolve the executable credential for one install. Two paths:
 *   - **github-data (oauth-datasource):** mint a GitHub App installation token
 *     from the decrypted `installation_id` (cached + re-minted on ~1hr expiry) →
 *     `bearer`. A mint failure or a missing `installation_id` is a
 *     **reconnectable** skip (App access revoked, key drift, transient GitHub
 *     outage) — fail-soft so it doesn't sink the workspace's other datasources,
 *     but flagged so an all-reconnectable workspace surfaces "reconnect needed".
 *   - **everything else:** the static credential from config via the shared
 *     decrypt-glue — `oauth2` / unrecognized kinds are a NON-reconnectable skip
 *     (slice-6 deferred for the generic row; github-data uses the mint path).
 */
async function resolveInstallAuth(
  installId: string,
  candidate: DataCandidate | undefined,
  decrypted: Record<string, unknown>,
  mint: MintInstallationTokenFn,
): Promise<AuthResolution> {
  if (candidate && isOAuthDatasourceCandidate(candidate)) {
    const installationId =
      typeof decrypted.installation_id === "string" ? decrypted.installation_id : "";
    if (installationId.length === 0) {
      log.warn(
        { installId, catalogId: candidate.catalogId },
        "github-data install has no installation_id — skipping (reconnect the datasource)",
      );
      return { kind: "skip", reconnectable: true };
    }
    try {
      const token = await mint(installationId);
      return { kind: "ok", auth: { kind: "bearer", token } };
    } catch (err) {
      log.warn(
        { installId, catalogId: candidate.catalogId, err: err instanceof Error ? err.message : String(err) },
        "Failed to mint a GitHub installation token — skipping this datasource (reconnect may be needed)",
      );
      return { kind: "skip", reconnectable: true };
    }
  }

  // Static-credential path (generic + form candidates). A drifted / hand-edited
  // row could carry the deferred `oauth2` (generic) or a garbage value — both
  // resolve to skip rather than passing a bad string to buildResolvedAuth. This
  // is NOT reconnectable: it's a config/spec gap, not an expired credential.
  const authResult = resolveAuthFromDecryptedConfig(decrypted);
  if (!authResult.ok) {
    log.warn(
      { installId, authKind: authResult.rawAuthKind },
      "OpenAPI install uses an unsupported or deferred auth kind — skipping",
    );
    return { kind: "skip", reconnectable: false };
  }
  return { kind: "ok", auth: authResult.auth };
}

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

/**
 * Build a single {@link RestDatasource} from a decrypted install row + its
 * already-resolved credential, or `null` to skip. The credential is resolved by
 * the caller ({@link resolveInstallAuth}) because it can be async (a github-data
 * install mints an installation token), so this stays a synchronous assembler.
 */
function buildDatasource(
  workspaceId: string,
  installId: string,
  candidate: DataCandidate | undefined,
  decrypted: Record<string, unknown>,
  auth: ResolvedAuth,
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
  const baseUrlOverride = typeof decrypted.base_url_override === "string" ? decrypted.base_url_override : undefined;
  // #3044 — cross-environment scope. A non-empty `group_id` scopes this
  // datasource to that connection group; absent/empty = workspace-global. The
  // field is plain (non-secret) JSONB so it survives `decryptSecretFields`
  // untouched. `normalizeGroupId` centralizes the empty-string exclusion; the
  // domain object prefers the optional idiom, so `null` maps to `undefined`.
  const groupId = normalizeGroupId(decrypted.group_id) ?? undefined;
  const displayName =
    typeof decrypted.display_name === "string" && decrypted.display_name.length > 0
      ? decrypted.display_name
      : snapshot.title;

  // #2970: a SHAREABLE install (a built-in data candidate whose public spec is
  // fetched credential-free — spec host ≠ API host) normalizes its graph ONCE
  // per canonical spec identity (`catalogId@version#hash`), reused across every
  // workspace on that spec/version, instead of once per (workspace, install).
  // A plain `openapi-generic` install — admin-supplied URL, possibly tenant-
  // private, credential possibly sent to the spec host — stays strictly per-
  // workspace via `snapshotToGraph`. The shareability gate is the credential-
  // withheld host-mismatch test, derived from the candidate's CODE-resident URLs
  // (never config), so the isolation boundary can't be moved by a hand-edited row.
  const shareable = candidate !== undefined && isShareableSpec(candidate.openapiUrl, candidate.apiBaseUrl);
  let graph: OperationGraph;
  try {
    graph = shareable
      ? sharedGraphFromSnapshot(candidate.catalogId, snapshot)
      : snapshotToGraph(workspaceId, installId, snapshot);
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

  // #3035: a candidate's declared read-safe POSTs (e.g. notion-data's `post-search`)
  // are CODE-resident like the quirk — resolved from the registry, never config.
  // Threaded onto the datasource so the validator demotes those POSTs to reads.
  // Omitted when the candidate declares none (or it's a plain generic install) so a
  // datasource with no read-over-POST surface carries no field, mirroring `quirk`.
  const readSafePostOperations =
    candidate?.readSafePostOperations && candidate.readSafePostOperations.length > 0
      ? new Set(candidate.readSafePostOperations)
      : undefined;

  // Slice 6a (#3028): a built-in data-candidate install carries its declarative
  // quirk in the code-resident registry (resolved by the caller, passed in here),
  // never in config — attach it so the agent tool can thread it into the client.
  // A plain openapi-generic install (or an unknown catalog id) has none.
  return {
    id: installId,
    displayName,
    ...(groupId !== undefined ? { groupId } : {}),
    graph,
    baseUrl,
    auth,
    representationMode: coerceRepresentationMode(decrypted.representation_mode),
    writeAllowlist,
    sideEffectingOperations,
    ...(rateLimitPerMinute !== undefined ? { rateLimitPerMinute } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(candidate?.quirk !== undefined ? { quirk: candidate.quirk } : {}),
    ...(readSafePostOperations !== undefined ? { readSafePostOperations } : {}),
  };
}

/**
 * Decrypt + build the resolvable subset of already-loaded install rows.
 * Per-install failures (decrypt / snapshot / deferred-auth / mint) are skipped
 * and logged — one broken install must never sink the workspace's others. Async
 * because a github-data install mints its credential per resolve; the per-row
 * resolution is sequential (a workspace has a handful of datasources, and the
 * minter caches, so serial keeps the code simple without meaningful latency).
 *
 * Throws {@link RestDatasourceReconnectError} when the resolved set is empty but
 * ≥1 install was skipped for a **reconnectable** credential reason — so a
 * user-facing caller can say "reconnect needed" instead of "none connected".
 * (A partial success — some resolve, one needs reconnect — still returns the
 * healthy ones; the throw fires only when nothing usable remains.)
 */
async function buildDatasourcesFromRows(
  workspaceId: string,
  rows: ReadonlyArray<OpenApiInstallRow>,
  mint: MintInstallationTokenFn,
): Promise<RestDatasource[]> {
  const out: RestDatasource[] = [];
  let reconnectableSkips = 0;
  for (const row of rows) {
    const candidate =
      row.catalog_id !== undefined ? findDataCandidateByCatalogId(row.catalog_id) : undefined;
    let decrypted: Record<string, unknown>;
    try {
      decrypted = decryptSecretFields(row.config ?? {}, secretSchemaFor(candidate));
    } catch (err) {
      log.warn(
        { workspaceId, installId: row.install_id, err: err instanceof Error ? err.message : String(err) },
        "Failed to decrypt OpenAPI datasource config — skipping",
      );
      continue;
    }
    const resolution = await resolveInstallAuth(row.install_id, candidate, decrypted, mint);
    if (resolution.kind === "skip") {
      // unsupported/deferred kind, missing credential, or mint failure (logged)
      if (resolution.reconnectable) reconnectableSkips++;
      continue;
    }
    const ds = buildDatasource(workspaceId, row.install_id, candidate, decrypted, resolution.auth);
    if (ds) out.push(ds);
  }
  // Nothing usable resolved, but at least one install is merely awaiting a
  // reconnect — signal that distinctly so callers don't claim "none connected".
  if (out.length === 0 && reconnectableSkips > 0) {
    throw new RestDatasourceReconnectError(reconnectableSkips);
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
  const mint = deps.mintInstallationToken ?? ((id: string) => getGitHubInstallationToken(id));
  // A query failure propagates here, on purpose — the caller turns it into a
  // distinct "temporarily unavailable" signal rather than an empty result.
  const rows = await query(workspaceId);
  // #3067 — REST-only focus short-circuits both filters below: a focused
  // conversation resolves ONLY the focus target, with group-scope and the
  // exclude-set inert (ADR-0011). A focus that matches no install yields []
  // here, so the agent loop falls back to default scope. Guard on length so a
  // stray empty string can't be a "focus on nothing".
  if (deps.focus && deps.focus.length > 0) {
    const focusedRows = rowsFocused(rows, deps.focus);
    const built = await buildDatasourcesFromRows(workspaceId, focusedRows, mint);
    // #3067 (Codex P1) — distinguish "focus matched no install" (genuinely
    // uninstalled → `[]`, the agent's safe fall-back-to-default-scope case) from
    // "focus matched an install row that built to nothing" (present but unusable:
    // decrypt failure, unsupported auth, blocked URL). Returning `[]` for the
    // latter would let the agent read it as uninstalled and re-enable SQL,
    // violating the REST-only focus contract — fail CLOSED instead. Reconnectable
    // skips already threw inside buildDatasourcesFromRows, so this covers the
    // non-reconnectable remainder.
    if (built.length === 0 && focusedRows.length > 0) {
      throw new RestDatasourceFocusUnusableError(deps.focus);
    }
    return built;
  }
  // #3044 — drop out-of-scope datasources BEFORE build, so the reconnect tally
  // (and the never-rejects `[]` contract) is computed only over the in-scope set.
  const scopedRows = rowsInActiveGroup(rows, deps.activeGroupId);
  // #3066 — then drop the conversation's per-conversation exclude-set. Order
  // matters: exclusion is over the already-group-scoped set, and both filters
  // run before build so an excluded/off-scope datasource never reaches
  // credential decryption.
  const inScopeRows = rowsNotExcluded(scopedRows, deps.excluded);
  return buildDatasourcesFromRows(workspaceId, inScopeRows, mint);
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
    // A reconnect-needed signal isn't a load failure — the rows loaded fine, the
    // credential just needs refreshing. Degrade to `[]` either way (this path
    // makes no presence claim), but log accurately.
    if (err instanceof RestDatasourceReconnectError) {
      log.warn(
        { workspaceId, reconnectableCount: err.reconnectableCount },
        "OpenAPI datasource install(s) need reconnecting — continuing with none for this non-claiming path",
      );
      return [];
    }
    // #3067 (Codex P1) — a present-but-unusable focus isn't a load failure
    // either. This non-claiming path can't fail closed (it has no SQL tool to
    // suspend), so it degrades to `[]`; its callers (python egress) then deny
    // egress rather than widen. The strict resolver is where focus fails closed.
    if (err instanceof RestDatasourceFocusUnusableError) {
      log.warn(
        { workspaceId, focus: err.focusId },
        "Focused REST datasource is installed but unusable — continuing with none for this non-claiming path",
      );
      return [];
    }
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
