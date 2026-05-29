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
  narrowSupportedAuthKind,
  type OpenApiAuthKind,
} from "./catalog";
import { buildResolvedAuth, snapshotToGraph } from "./probe";
import type { OperationGraph, ResolvedAuth } from "./types";

const log = createLogger("openapi.workspace-datasource");

/**
 * A `workspace_plugins` row this resolver reads. `config` is the raw (encrypted)
 * JSONB. A `type` (not `interface`) so it satisfies `internalQuery`'s
 * `Record<string, unknown>` row constraint via TS's implicit index signature.
 */
export type OpenApiInstallRow = {
  readonly install_id: string;
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
 * Default query: the workspace's non-archived `openapi-generic` installs.
 * Lazily imports `internalQuery` so the resolver's static graph stays free of
 * the DB module (admin-route tests partial-mock it heavily).
 */
async function defaultQuery(workspaceId: string): Promise<ReadonlyArray<OpenApiInstallRow>> {
  const { internalQuery } = await import("@atlas/api/lib/db/internal");
  return internalQuery<OpenApiInstallRow>(
    `SELECT install_id, config
       FROM workspace_plugins
      WHERE workspace_id = $1
        AND catalog_id = $2
        AND pillar = 'datasource'
        AND status != 'archived'
      ORDER BY installed_at ASC`,
    [workspaceId, OPENAPI_GENERIC_CATALOG_ID],
  );
}

const SECRET_SCHEMA = parseConfigSchema(OPENAPI_GENERIC_CONFIG_SCHEMA);

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
  installId: string,
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
  const rawAuthKind = (typeof decrypted.auth_kind === "string" ? decrypted.auth_kind : "none") as OpenApiAuthKind;
  // A drifted row could carry the deferred `oauth2` kind — skip it explicitly
  // (slice 6 #2930) rather than relying on buildResolvedAuth to throw.
  const authKind = narrowSupportedAuthKind(rawAuthKind);
  if (!authKind) {
    log.warn(
      { installId, authKind: rawAuthKind },
      "OpenAPI install uses a deferred auth kind (oauth2) — skipping until slice 6",
    );
    return null;
  }
  const authValue = typeof decrypted.auth_value === "string" ? decrypted.auth_value : undefined;
  const authHeaderName = typeof decrypted.auth_header_name === "string" ? decrypted.auth_header_name : undefined;
  const authParamName = typeof decrypted.auth_param_name === "string" ? decrypted.auth_param_name : undefined;
  const baseUrlOverride = typeof decrypted.base_url_override === "string" ? decrypted.base_url_override : undefined;
  const displayName =
    typeof decrypted.display_name === "string" && decrypted.display_name.length > 0
      ? decrypted.display_name
      : snapshot.title;

  let graph: OperationGraph;
  let auth: ResolvedAuth;
  try {
    graph = snapshotToGraph(installId, snapshot);
    auth = buildResolvedAuth(authKind, authValue, authHeaderName, authParamName);
  } catch (err) {
    log.warn(
      { installId, err: err instanceof Error ? err.message : String(err) },
      "Failed to rebuild OpenAPI datasource from snapshot — skipping",
    );
    return null;
  }

  return {
    id: installId,
    displayName,
    graph,
    baseUrl: resolveBaseUrl(openapiUrl, graph, baseUrlOverride),
    auth,
    representationMode: coerceRepresentationMode(decrypted.representation_mode),
  };
}

/**
 * Resolve every installed REST datasource for a workspace. Returns `[]` when
 * the workspace has none. Per-install failures are skipped (logged), never
 * thrown.
 */
export async function resolveWorkspaceRestDatasources(
  workspaceId: string,
  deps: ResolveWorkspaceDeps = {},
): Promise<ReadonlyArray<RestDatasource>> {
  const query = deps.query ?? defaultQuery;

  let rows: ReadonlyArray<OpenApiInstallRow>;
  try {
    rows = await query(workspaceId);
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "Failed to load OpenAPI datasource installs — continuing with none",
    );
    return [];
  }

  const out: RestDatasource[] = [];
  for (const row of rows) {
    let decrypted: Record<string, unknown>;
    try {
      decrypted = decryptSecretFields(row.config ?? {}, SECRET_SCHEMA);
    } catch (err) {
      log.warn(
        { workspaceId, installId: row.install_id, err: err instanceof Error ? err.message : String(err) },
        "Failed to decrypt OpenAPI datasource config — skipping",
      );
      continue;
    }
    const ds = buildDatasource(row.install_id, decrypted);
    if (ds) out.push(ds);
  }
  return out;
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
