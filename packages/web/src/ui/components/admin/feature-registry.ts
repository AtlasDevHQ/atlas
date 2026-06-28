/**
 * Canonical list of admin feature names rendered in user-facing copy by
 * `<MutationErrorSurface>`, `<EnterpriseUpsell>`, and `<FeatureGate>`.
 *
 * Constraining `feature` to this literal union catches typos at compile time
 * — a `feature="sso"` (lowercase) would otherwise render
 * "sso requires an enterprise plan" in the upsell copy. The tuple is
 * additive: adding a new admin surface means adding its canonical name
 * here first, then TS guides every call site into agreement.
 *
 * Casing: whatever appears verbatim in the banner copy. "SSO" not "sso",
 * "AI Model" not "ai-model". When two variants exist for the same feature
 * (e.g. workspace-level singular and platform-level plural of the same
 * concept), consolidate to one canonical form so banner copy stays
 * consistent across surfaces.
 */
export const FEATURE_NAMES = [
  "Abuse Prevention",
  "Action Log",
  "Actions",
  "Activate workspace",
  "Admin Action Log",
  "Admin Action Retention",
  "AI Agents",
  "AI Model",
  "AI Provider",
  "API Keys",
  "Approval Workflows",
  "Audit Log",
  "Audit Retention",
  "Backups",
  "Billing",
  "Billing Portal",
  "Branding",
  "BYOT",
  "Cache",
  "Change plan",
  "Connections",
  "CRM Outbox",
  "Custom Domains",
  "Custom Roles",
  "Data Residency",
  "Delete workspace",
  "Demo Tracking",
  "Email Provider",
  "Environments",
  "Integrations",
  "IP Allowlist",
  "Learned Patterns",
  "MCP Action Policy",
  "MCP Settings",
  "OAuth Clients",
  "Operator Integrations",
  "Organizations",
  "PII Compliance",
  "Platform Admin",
  "Platform Settings",
  "Plugin Catalog",
  "Plugins",
  "Proactive Chat",
  "Prompt Library",
  "Query Analytics",
  "Sandbox",
  "SCIM",
  "Scheduled Tasks",
  "Scheduler",
  "Security Adoption",
  "Security Posture",
  "Semantic Layer",
  "Session Memory",
  "Sessions",
  "Settings",
  "SLA Monitoring",
  "SSO",
  "Starter Prompts",
  "Suspend workspace",
  "Token Usage",
  "Usage Dashboard",
  "User Auth Revoke",
  "User Erasure",
  "User MFA Reset",
  "Users",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/**
 * Features that are **hosted-SaaS-only** — available on Atlas Cloud but denied
 * on *every* self-hosted deployment, including self-hosted enterprise. Unlike
 * the ordinary enterprise features (SSO, SCIM, …), no plan upgrade unlocks
 * these on a self-hosted box, so the generic "requires an enterprise plan /
 * contact sales" upsell copy is wrong for them; `<EnterpriseUpsell>` renders
 * hosted-only copy instead when the deployment is self-hosted.
 *
 * Membership mirrors the server-side `deployMode === "saas"` gate (e.g.
 * `admin-proactive.ts:gateProactiveAvailable` / `ee/src/proactive-gate.ts`).
 * Add a feature here when its server gate keys on deploy mode, not licensing.
 * See #3999 (proactive monitoring is the first such feature).
 */
const SAAS_EXCLUSIVE_FEATURES: ReadonlySet<FeatureName> = new Set([
  "Proactive Chat",
]);

/** True iff `feature` is denied on self-hosted regardless of plan/license. */
export function isSaasExclusiveFeature(feature: FeatureName): boolean {
  return SAAS_EXCLUSIVE_FEATURES.has(feature);
}
