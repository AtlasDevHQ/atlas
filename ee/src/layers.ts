/**
 * Aggregator for EE-side `Layer.effect` implementations.
 *
 * `buildAppLayer()` in `@atlas/api/lib/effect/layers` lazy-imports this
 * module (the ONLY post-closeout `@atlas/ee` import permitted from core)
 * and merges `EELayer` on top of `NoopEnterpriseDefaultsLayer` when
 * `isEnterpriseEnabled()` is true. Layer.mergeAll resolves duplicate
 * Tags by "last wins", so EE's real implementations override core's
 * no-op defaults.
 *
 * Slice 2/11 (#2564) — added `ResidencyResolverLive`.
 * Slice 3/11 (#2565) — added `ModelRouterLive`.
 * Slice 4/11 (#2566) — added `MaskingPolicyLive` + `ComplianceReportsLive`.
 * Slice 5/11 (#2567) — added `ApprovalGateLive`.
 * Slice 6/11 (#2568) — added `SlaMetricsLive` + `BackupsManagerLive`.
 *
 * Later slices (#2569–#2572) follow the same pattern: one Tag, one
 * Layer entry. See the parent issue (#2017) for the rationale.
 */

import { Layer } from "effect";
import type {
  ApprovalGate,
  BackupsManager,
  ComplianceReports,
  MaskingPolicy,
  ModelRouter,
  ResidencyResolver,
  SlaMetrics,
} from "@atlas/api/lib/effect/services";
import { ResidencyResolverLive } from "./platform/residency";
import { ModelRouterLive } from "./platform/model-routing";
import { MaskingPolicyLive } from "./compliance/masking";
import { ComplianceReportsLive } from "./compliance/reports";
import { ApprovalGateLive } from "./governance/approval";
import { SlaMetricsLive } from "./sla/index";
import { BackupsManagerLive } from "./backups/index";

/**
 * Aggregated EE Layer — typed by the union of every Tag this module
 * binds, so a future regression that drops a binding (or forgets to
 * import a new slice's Layer) surfaces as a `tsgo` error rather than
 * silently falling through to the no-op default at runtime.
 */
export const EELayer: Layer.Layer<
  | ApprovalGate
  | BackupsManager
  | ComplianceReports
  | MaskingPolicy
  | ModelRouter
  | ResidencyResolver
  | SlaMetrics
> = Layer.mergeAll(
  ResidencyResolverLive,
  ModelRouterLive,
  MaskingPolicyLive,
  ComplianceReportsLive,
  ApprovalGateLive,
  SlaMetricsLive,
  BackupsManagerLive,
);
