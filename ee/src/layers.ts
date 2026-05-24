/**
 * Aggregator for EE-side `Layer.effect` implementations. Lazy-imported
 * by `buildAppLayer()` in `@atlas/api/lib/effect/layers` (the sole
 * permitted runtime `@atlas/ee` import from core) and merged on top of
 * `NoopEnterpriseDefaultsLayer` when `isEnterpriseEnabled()` is true.
 *
 * Every Tag bound here must appear in the union type below — that's the
 * only invariant.
 */

import { Layer } from "effect";
import type {
  ApprovalGate,
  AuditPurgeScheduler,
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
  SaasCrm,
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
import { AuditPurgeSchedulerLive } from "./audit/purge-scheduler";
import { IpAllowlistPolicyLive } from "./auth/ip-allowlist";
import { SSOPolicyLive } from "./auth/sso";
import { SCIMProvenanceLive } from "./auth/scim";
import { RolesPolicyLive } from "./auth/roles";
import { BrandingLive } from "./branding/white-label";
import { DomainsLive } from "./platform/domains";
import { ProactiveGateLive } from "./proactive-gate";
import { DeployModeResolverLive } from "./deploy-mode";
import { SaasCrmLive } from "./saas-crm/index";

/**
 * Aggregated EE Layer — typed by the union of every Tag this module
 * binds, so a future regression that drops a binding (or forgets to
 * import a new slice's Layer) surfaces as a `tsgo` error rather than
 * silently falling through to the no-op default at runtime.
 */
export const EELayer: Layer.Layer<
  | ApprovalGate
  | AuditPurgeScheduler
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
  | SaasCrm
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
  AuditPurgeSchedulerLive,
  IpAllowlistPolicyLive,
  SSOPolicyLive,
  SCIMProvenanceLive,
  RolesPolicyLive,
  BrandingLive,
  DomainsLive,
  ProactiveGateLive,
  DeployModeResolverLive,
  SaasCrmLive,
);
