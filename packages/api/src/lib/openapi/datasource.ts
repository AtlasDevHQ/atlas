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
 * `probe.ts`, and the Effect-facing registry handle is `registry.ts`.
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
}
