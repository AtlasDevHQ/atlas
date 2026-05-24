/**
 * `resolveInstallStatus` — pure state machine that maps a catalog row ×
 * workspace install to a `CardState` for admin-UI rendering.
 *
 * Encodes the three orthogonal gates from ADR-0006 and ADR-0007:
 *
 *   1. coming_soon  (Atlas hasn't shipped it)        → trumps everything
 *   2. misconfigured (operator hasn't wired env vars / handler)
 *   3. plan-gate    (existing upsell logic)
 *
 * When all three pass: `accessible` (no install) or `connected` (install
 * present). When the plan gate fails but an install row exists the card
 * resolves to `configured_but_downgraded` so the user can still disconnect.
 *
 * Pure function. No IO, no Effect Context, no service deps.
 *
 * TODO(#2741): If the first consumer (`PillarCatalogQuery`) needs
 * state-specific payloads — e.g. which env var the operator must set for
 * `misconfigured`, or the required plan tier for `upgrade_required` —
 * promote `CardState` from a bare string union to a discriminated object
 * union (`{ kind: "misconfigured", missing: readonly string[] } | …`)
 * before more consumers attach parallel detail maps. Doing it later is
 * a multi-consumer rewrite; doing it now is a ~20-line change.
 */

import { type ImplementationStatus } from "@useatlas/types";

export { type ImplementationStatus };

/**
 * The six mutually exclusive render states for a catalog card.
 *
 * `configured_but_downgraded` is the orthogonal-to-presence companion to
 * `upgrade_required` — same plan-gate verdict, but a workspace install row
 * exists, so the card must keep offering disconnect. That's why this
 * machine ships six states rather than the five named in PRD #2738.
 *
 * Adding a new variant: extend the `ALL_CARD_STATES` table in
 * `install-status-machine.test.ts`. The `satisfies Record<CardState, …>`
 * on that table forces the compile to fail until the new variant has a key.
 */
export type CardState =
  | "connected"
  | "accessible"
  | "coming_soon"
  | "misconfigured"
  | "upgrade_required"
  | "configured_but_downgraded";

/**
 * Minimal catalog-row shape the gate machine reads. The full `plugin_catalog`
 * row carries many more columns; the state machine only depends on
 * `implementationStatus`. `PillarCatalogQuery` (slice 3 / #2741) does the
 * projection at the call site so the gate logic stays decoupled from the
 * catalog schema.
 */
export interface CatalogRowInput {
  readonly implementationStatus: ImplementationStatus;
}

/**
 * `workspace_plugins` row passed by reference (or `null` if no install
 * exists for this workspace × catalog row). The state machine only branches
 * on null-vs-non-null; `installId` is included because slice 3's
 * `PillarCatalogQuery` returns full install records and accepting them
 * here avoids a mapping step at the call site. Multi-instance datasource
 * installs (#2743 / #2744) call the machine once per install row.
 */
export interface WorkspaceInstallInput {
  readonly installId: string;
}

/**
 * Evaluated in priority order: `coming_soon` > `misconfigured` >
 * plan-gate > {`accessible` | `connected`}. Each boolean gate is
 * precomputed by the caller so the state machine stays pure.
 */
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
  // TODO(#2741): slice 3 may need to distinguish `handler not registered`
  // (Atlas-side) from `deploy not configured` (operator-side) to drive
  // different remediation copy. Split this into two `CardState` variants
  // (or carry a reason payload when CardState becomes discriminated).
  if (!input.handlerRegistered || !input.deployConfigured) {
    return "misconfigured";
  }
  if (!input.planAdmits) {
    return input.workspaceInstall !== null ? "configured_but_downgraded" : "upgrade_required";
  }
  return input.workspaceInstall !== null ? "connected" : "accessible";
}
