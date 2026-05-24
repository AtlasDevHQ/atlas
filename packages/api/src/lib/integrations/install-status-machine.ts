/**
 * `resolveInstallStatus` — slice 2 of #2738 (issue #2740).
 *
 * Pure function. Encodes the three orthogonal gates from ADR-0006 and
 * ADR-0007 that determine how a catalog row × workspace install renders
 * in admin UIs. No IO, no Effect Context, no service deps.
 *
 *   1. coming_soon  (Atlas hasn't shipped it)        → trumps everything
 *   2. misconfigured (operator hasn't wired env vars / handler)
 *   3. plan-gate    (existing upsell logic)
 *
 * When all three pass: `accessible` (no install) or `connected` (install
 * present). When the plan gate fails but an install row exists the card
 * resolves to `configured_but_downgraded` so the user can still disconnect.
 *
 * Slice 3 (#2741 — `PillarCatalogQuery`) is the first consumer. Until
 * then this module is intentionally unwired.
 */

export type ImplementationStatus = "available" | "coming_soon";

/**
 * The six mutually exclusive render states for a catalog card.
 *
 * Adding a new variant requires updating the exhaustiveness fixture in
 * `install-status-machine.test.ts` — the `assertNever` switch there will
 * fail to compile until the table is extended.
 */
export type CardState =
  | "connected"
  | "accessible"
  | "coming_soon"
  | "misconfigured"
  | "upgrade_required"
  | "configured_but_downgraded";

/**
 * Minimal catalog-row shape the gate machine reads. The full
 * `plugin_catalog` row carries more (slug, type, install_model, plan,
 * etc.), but the state machine only depends on `implementationStatus`.
 * Callers in slice 3 (`PillarCatalogQuery`) own the precomputation of
 * `planAdmits` / `deployConfigured` / `handlerRegistered`.
 */
export interface CatalogRowInput {
  readonly implementationStatus: ImplementationStatus;
}

/**
 * Marker shape for a `workspace_plugins` row. The state machine only
 * branches on existence (null vs non-null), but `installId` is required
 * to keep the type stable as slice 3 grows the read-side facade.
 */
export interface WorkspaceInstallInput {
  readonly installId: string;
}

export interface ResolveInstallStatusInput {
  readonly catalogRow: CatalogRowInput;
  readonly workspaceInstall: WorkspaceInstallInput | null;
  /** Plan-tier verdict precomputed by the caller (`min_plan` vs workspace plan). */
  readonly planAdmits: boolean;
  /** Operator-side readiness — every env var the `install_model` handler reads is present. */
  readonly deployConfigured: boolean;
  /** Atlas-side readiness — the `install_model` handler is registered in the install registry. */
  readonly handlerRegistered: boolean;
}

export function resolveInstallStatus(input: ResolveInstallStatusInput): CardState {
  if (input.catalogRow.implementationStatus === "coming_soon") {
    return "coming_soon";
  }
  if (!input.handlerRegistered || !input.deployConfigured) {
    return "misconfigured";
  }
  if (!input.planAdmits) {
    return input.workspaceInstall !== null ? "configured_but_downgraded" : "upgrade_required";
  }
  return input.workspaceInstall !== null ? "connected" : "accessible";
}
