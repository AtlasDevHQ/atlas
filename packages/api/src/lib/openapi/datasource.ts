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
}
