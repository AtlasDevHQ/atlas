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
  "Custom Domains",
  "Custom Roles",
  "Data Residency",
  "Delete workspace",
  "Email Provider",
  "Integrations",
  "IP Allowlist",
  "Learned Patterns",
  "Organizations",
  "PII Compliance",
  "Platform Admin",
  "Platform Settings",
  "Plugin Catalog",
  "Plugins",
  "Prompt Library",
  "Query Analytics",
  "Sandbox",
  "SCIM",
  "Schema Diff",
  "Scheduled Tasks",
  "Semantic Layer",
  "Sessions",
  "Settings",
  "SLA Monitoring",
  "SSO",
  "Starter Prompts",
  "Suspend workspace",
  "Token Usage",
  "Usage Dashboard",
  "User Erasure",
  "Users",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
