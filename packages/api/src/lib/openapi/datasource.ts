/**
 * `RestDatasource` — the resolved shape of a REST datasource the agent reads
 * from: the REST analogue of a resolved SQL connection from `ConnectionRegistry`.
 *
 * Slice 1 (#2924) resolved a single env-configured Twenty datasource here; slice
 * 2 (#2926) retired that env path. A REST datasource is now a workspace-resident
 * install in `workspace_plugins` (catalog `openapi-generic`, encrypted at rest),
 * resolved per-workspace by {@link resolveWorkspaceRestDatasources}
 * (`workspace-datasource.ts`) into this exact shape — so the agent loop + tools
 * that consume {@link RestDatasource} needed no change when the source moved from
 * env to DB.
 *
 * This module is intentionally just the type now: the resolution logic, snapshot
 * caching, and credential decryption live in `workspace-datasource.ts` /
 * `probe.ts`. Consumers call the plain async resolver
 * {@link resolveWorkspaceRestDatasources} directly (agent loop, tools, routes) —
 * there is no Effect `Context.Tag` wrapper (the unused one was removed in #3009).
 */
import type { OperationGraph, ResolvedAuth } from "./types";
import type { RepresentationMode } from "./representation";
import type { SpecDriftMode } from "./drift-recovery";
import type { VendorQuirk } from "./vendor-quirk";

/**
 * Normalize a raw `workspace_plugins.config.group_id` JSONB value to its
 * cross-environment scope identity (#3044, [ADR-0010]). Empty / whitespace /
 * non-string ⇒ `null` (**workspace-global**); a non-empty string is trimmed and
 * returned (**scoped** to that connection group).
 *
 * The single definition of "scoped vs workspace-global", so the empty-string
 * exclusion can't be forgotten by a new read path — every site that reads
 * `config.group_id` (the resolver build, the scope filter, the admin summary)
 * funnels through here. Internal callers that prefer the optional idiom
 * (`RestDatasource.groupId?: string`) map the `null` to `undefined` at their own
 * boundary; wire/DTO callers keep the `null` (JSON has no `undefined`).
 */
export function normalizeGroupId(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
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
 *
 * Lives here (not in `workspace-datasource.ts`, its original home) so both the
 * resolver and the #3315 drift-recovery path derive the base URL identically
 * without an import cycle. Callers MUST still pass the result through
 * `assertBaseUrlAllowed` — this function derives, it does not authorize.
 */
export function resolveBaseUrl(
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
 * A resolved REST datasource the agent can read from. The normalized operation
 * graph, the base URL operations execute against, the credential the slice-0
 * client applies, and the representation mode (#2931 bake-off knob, per-install).
 * Workspace-agnostic: {@link resolveWorkspaceRestDatasources} stamps one of these
 * per `workspace_plugins` install row.
 */
export interface RestDatasource {
  /** Stable id used in tool params (`datasourceId`) + trace attributes — the install_id. */
  readonly id: string;
  /** Human-facing name for the prompt header (the install's `display_name` or spec title). */
  readonly displayName: string;
  /**
   * Cross-environment scope (#3044, [ADR-0010]). `undefined` ⇒ **workspace-global**:
   * the datasource is available in every conversation regardless of the env pin
   * (one Stripe/GitHub/Twenty account isn't region-specific). A string ⇒
   * **environment-scoped** to the connection group with this `group_id`: in-scope
   * only when the conversation's active group matches. Resolved from the
   * per-install `workspace_plugins.config.group_id` (the same field SQL
   * connections use). The agent representation frames this so a pinned chat
   * never silently appears constrained while a workspace-global datasource is
   * reachable.
   */
  readonly groupId?: string;
  /** The normalized operation graph (slice-0), rebuilt from the cached snapshot. */
  readonly graph: OperationGraph;
  /** Base URL operations execute against, e.g. `https://crm.example.com/rest`. */
  readonly baseUrl: string;
  /** Credential the slice-0 `executeOperation` applies (decrypted per resolve). */
  readonly auth: ResolvedAuth;
  /**
   * Which representation strategy renders this datasource's prompt context — the
   * bake-off knob (#2931). Resolved from the per-install
   * `workspace_plugins.config.representation_mode`; both Path A ("operation-graph",
   * the default winner) and Path B ("semantic-yaml") stay selectable per install.
   */
  readonly representationMode: RepresentationMode;
  /**
   * The `operationId`s permitted to execute a non-GET (write) method — slice 5's
   * write-side opt-in (#2929). Resolved from the per-install
   * `workspace_plugins.config.write_allowlist`. **Empty = read-only** (the
   * default, default-deny). `validateRestOperation` is the boundary that honors
   * it; a staged write still requires a confirm-before-write step before it fires.
   */
  readonly writeAllowlist: ReadonlySet<string>;
  /**
   * `operationId`s the operator marked side-effecting in install config — forced
   * through the write allowlist + confirm path even though their HTTP method
   * reads (a mutating RPC-over-GET). The `x-atlas-side-effecting: true` spec
   * extension does the same per-op. **Empty = no config-level overrides**
   * (classification is method-only). Resolved from
   * `workspace_plugins.config.side_effecting_operations`. Required (always a Set,
   * possibly empty) so it mirrors {@link writeAllowlist} and callers never branch
   * on `undefined`. See #3008.
   */
  readonly sideEffectingOperations: ReadonlySet<string>;
  /**
   * `operationId`s whose POST is a GENUINE READ (#3035), DEMOTED past the write
   * allowlist — e.g. Notion search, `POST /v1/search`. Present only for a built-in
   * data candidate that declares them ({@link import("./data-candidates").DataCandidate.readSafePostOperations});
   * `undefined` for a plain `openapi-generic` install or a candidate with no
   * read-over-POST surface. Like {@link quirk}, this is CODE-resident — the
   * resolver looks it up from the `DATA_CANDIDATES` registry by catalog id, never
   * from config. Unlike {@link sideEffectingOperations} (which can only ESCALATE),
   * this is the one signal that DROPS a write classification, and it is overridden
   * by any escalation signal. See {@link import("./validate-rest-operation").isSideEffectingOperation}.
   */
  readonly readSafePostOperations?: ReadonlySet<string>;
  /**
   * How the install handles upstream spec DRIFT at query time (#3315).
   * `strict` (the default, also when omitted) — an `operationId` absent from
   * the cached graph is a hard `unknown-operation` reject, exactly the
   * pre-#3315 behavior. `auto-refresh` — the `executeRestOperation` tool may
   * trigger ONE debounced, egress-guarded re-probe (`attemptDriftRecovery`)
   * and retry the call when the fresh graph contains the operation. Resolved
   * from `workspace_plugins.config.spec_drift_mode` (PATCH-only, like
   * `spec_refresh_interval`). Optional so hand-built fixtures default to the
   * safe `strict` posture without naming the field.
   */
  readonly specDriftMode?: SpecDriftMode;
  /**
   * Per-install rate-limit override (calls/min) for the per-operation token
   * bucket. Omitted → {@link import("./validate-rest-operation").DEFAULT_RATE_LIMIT_PER_MINUTE}
   * (60/min). Resolved from `workspace_plugins.config.rate_limit_per_minute`.
   */
  readonly rateLimitPerMinute?: number;
  /**
   * Per-install request-timeout override (ms). Omitted → the `ATLAS_OPENAPI_TIMEOUT`
   * cap. `validateRestOperation` rejects a value above the cap. Resolved from
   * `workspace_plugins.config.request_timeout_ms`.
   */
  readonly requestTimeoutMs?: number;
  /**
   * The vendor's declarative quirk (slice 6a, #3028) — required static headers /
   * query param-shaping the client applies on every request. Present only for a
   * built-in data-candidate install (e.g. `stripe-data` → `expand[]` shaping);
   * `undefined` for a plain `openapi-generic` install. CODE-resident: the resolver
   * looks it up from the `DATA_CANDIDATES` registry by the install's catalog id —
   * it is never stored in (or read from) the encrypted config. The agent tool
   * threads it into `executeOperation` via {@link import("./types").ExecuteOptions.quirk}.
   */
  readonly quirk?: VendorQuirk;
}
