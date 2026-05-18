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
 * Slice 7/11 (#2569) — added `AuditRetentionLive`.
 * Slice 8/11 (#2570) — added `IpAllowlistPolicyLive` + `SSOPolicyLive`
 *   + `SCIMProvenanceLive` (auth subsystem trio).
 * Slice 9/11 (#2571) — added `RolesPolicyLive` (custom-role CRUD +
 *   F-53 permission chokepoint).
 * Slice 10/11 (#2572) — added `BrandingLive` + `DomainsLive` +
 *                       `ProactiveGateLive` + `DeployModeResolverLive`
 *                       (bundled to avoid four PRs of Tag scaffolding
 *                       overhead for narrow-surface subsystems).
 *
 * Slice 11/11 (#2573 closeout) follows next: CI grep gate + symlink-stub
 * job + back-compat shim cleanup. See the parent issue (#2017) for the
 * rationale.
 */

import { Layer } from "effect";
import type {
  ApprovalGate,
  AuditRetention,
  BackupsManager,
  Branding,
  ComplianceReports,
  DeployModeResolver,
  Domains,
  IpAllowlistPolicy,
  MaskingPolicy,
  ModelRouter,
  ProactiveGate,
  ResidencyResolver,
  RolesPolicy,
  SCIMProvenance,
  SSOPolicy,
  SlaMetrics,
} from "@atlas/api/lib/effect/services";
import { ResidencyResolverLive } from "./platform/residency";
import { ModelRouterLive } from "./platform/model-routing";
import { MaskingPolicyLive } from "./compliance/masking";
import { ComplianceReportsLive } from "./compliance/reports";
import { ApprovalGateLive } from "./governance/approval";
import { SlaMetricsLive } from "./sla/index";
import { BackupsManagerLive } from "./backups/index";
import { AuditRetentionLive } from "./audit/retention";
import { IpAllowlistPolicyLive } from "./auth/ip-allowlist";
import { SSOPolicyLive } from "./auth/sso";
import { SCIMProvenanceLive } from "./auth/scim";
import { RolesPolicyLive } from "./auth/roles";
import { BrandingLive } from "./branding/white-label";
import { DomainsLive } from "./platform/domains";
import { ProactiveGateLive } from "./proactive-gate";
import { DeployModeResolverLive } from "./deploy-mode";

/**
 * Aggregated EE Layer — typed by the union of every Tag this module
 * binds, so a future regression that drops a binding (or forgets to
 * import a new slice's Layer) surfaces as a `tsgo` error rather than
 * silently falling through to the no-op default at runtime.
 */
export const EELayer: Layer.Layer<
  | ApprovalGate
  | AuditRetention
  | BackupsManager
  | Branding
  | ComplianceReports
  | DeployModeResolver
  | Domains
  | IpAllowlistPolicy
  | MaskingPolicy
  | ModelRouter
  | ProactiveGate
  | ResidencyResolver
  | RolesPolicy
  | SCIMProvenance
  | SSOPolicy
  | SlaMetrics
> = Layer.mergeAll(
  ResidencyResolverLive,
  ModelRouterLive,
  MaskingPolicyLive,
  ComplianceReportsLive,
  ApprovalGateLive,
  SlaMetricsLive,
  BackupsManagerLive,
  AuditRetentionLive,
  IpAllowlistPolicyLive,
  SSOPolicyLive,
  SCIMProvenanceLive,
  RolesPolicyLive,
  BrandingLive,
  DomainsLive,
  ProactiveGateLive,
  DeployModeResolverLive,
);
