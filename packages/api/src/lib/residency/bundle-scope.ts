/**
 * Region-migration bundle scope — the per-table moves/stays decision registry
 * (#4460).
 *
 * Every table in `db/schema.ts` MUST have an explicit entry here. The tripwire
 * test (`__tests__/bundle-scope.test.ts`) enumerates the Drizzle schema and
 * fails when a table appears with no decision — so a new pillar can never
 * silently miss the export bundle again. It also fails on stale entries and
 * verifies every `exported` table is actually queried by `export.ts`.
 *
 * Decision semantics:
 *
 * - `exported` — workspace rows ride the export bundle to the target region
 *   (see `export.ts` / `admin-migrate.ts`).
 * - `stays` — workspace-scoped data that deliberately does NOT move. Stays is
 *   NOT retained: once the destructive half of source cleanup ships (#4458),
 *   the org's rows in these tables are DELETED from the source region after
 *   the grace period. Each entry's reason records why leaving it behind is
 *   acceptable (cache/derived/history/region-bound ciphertext/recreated
 *   fresh).
 * - `platform` — not workspace content: platform/operator state, the global
 *   auth+billing spine, or transient infrastructure rows. Outside both the
 *   bundle and the #4458 workspace-cleanup scope. (Better-Auth tables — user,
 *   session, organization, member, … — are not in `db/schema.ts` and are
 *   global by ADR-0024; they never enter this registry.)
 *
 * The customer-facing summary of these decisions is the "What moves" table in
 * `apps/docs/content/docs/platform-ops/data-residency.mdx` — keep the two in
 * sync (the maintainer-approved scope decision is recorded on #4460).
 */

export type BundleScopeDecision = "exported" | "stays" | "platform";

export interface BundleTableScope {
  readonly decision: BundleScopeDecision;
  /** Why this decision is correct — required, non-empty. */
  readonly reason: string;
}

export const BUNDLE_TABLE_DECISIONS = {
  // ── Exported: the v2 bundle (#4460 maintainer-approved scope) ──────────────
  conversations: { decision: "exported", reason: "Core chat pillar; original UUIDs preserved so child FKs survive." },
  messages: { decision: "exported", reason: "Ride inline with their conversation." },
  semantic_entities: { decision: "exported", reason: "DB-backed semantic layer — the workspace's core asset." },
  learned_patterns: { decision: "exported", reason: "Learned patterns + semantic amendments (#4569) with approval provenance (#4571)." },
  settings: { decision: "exported", reason: "Org-scoped runtime settings ride the bundle; platform-scoped rows stay." },
  dashboards: { decision: "exported", reason: "Dashboards move with parameters; share tokens dropped (region-bound URLs — the owner re-shares in the target), next_refresh_at recomputed at import." },
  dashboard_cards: { decision: "exported", reason: "Ride inline with their dashboard; cached_* result snapshots stripped (regenerate on first render)." },
  dashboard_user_drafts: { decision: "exported", reason: "Per-user drafts are content under the draft-first model (ADR-0029, amended by ADR-0034), so they move with their dashboard." },
  knowledge_documents: { decision: "exported", reason: "KB pillar — bodies + frontmatter + review status, UUIDs preserved; FTS is a generated column and rebuilds." },
  knowledge_links: { decision: "exported", reason: "Link graph rides inline with its source document (no re-derive step needed at import)." },
  scheduled_tasks: { decision: "exported", reason: "Task definitions move; next_run_at recomputed at import so the target scheduler re-plans. Group/plugin refs dangle until re-install." },
  agent_session_memory: { decision: "exported", reason: "Long-lived durable working memory (ADR-0020); FK resolves against the bundle's conversations." },

  // ── Stays: caches, derived data, history, region-bound state ───────────────
  // (Deleted from the source region by the #4458 cleanup after the grace period.)
  chat_cache: { decision: "stays", reason: "Response cache PLUS the Slack installation store (AES-GCM-encrypted bot tokens under slack:installation:* keys — region-bound ciphertext; Slack is re-installed in the target per the integrations decision). No org_id column: cache keys have no org dimension, Slack rows scope via value->>'orgId' — #4458 cleanup must scope by that expression, not a column." },
  dashboard_draft_card_cache: { decision: "stays", reason: "Draft-card result cache (ADR-0034) — regenerates on first render." },
  scheduled_task_runs: { decision: "stays", reason: "Run history — operational record of source-region executions." },
  agent_runs: { decision: "stays", reason: "Per-turn checkpoints hold region-local resume leases; un-resumable cross-region — an interrupted turn is re-asked (#4460 decision)." },
  knowledge_sync_credentials: { decision: "stays", reason: "Per-region AES-256-GCM ciphertext is not portable; customer re-enters the secret in the target." },
  knowledge_sync_state: { decision: "stays", reason: "Sync bookkeeping for a region-local connector; the target re-syncs from scratch." },
  semantic_entity_versions: { decision: "stays", reason: "Version history — the bundle carries current entity state only." },
  semantic_profile_status: { decision: "stays", reason: "Profiling progress state — re-profiled in the target if needed." },
  connection_profile_state: { decision: "stays", reason: "Profiling operational state tied to source-region connections." },
  learned_pattern_injections: { decision: "stays", reason: "Injection telemetry — usage history, re-accrues in the target." },
  query_suggestions: { decision: "stays", reason: "Derived suggestions — regenerate from migrated conversations/entities." },
  suggestion_user_clicks: { decision: "stays", reason: "Click telemetry on derived suggestions." },
  slack_threads: { decision: "stays", reason: "Chat-adapter thread mapping — region-local operational state; re-established as new threads arrive." },
  action_log: { decision: "stays", reason: "Action execution history — source-region operational record." },
  audit_log: { decision: "stays", reason: "Audit trail records processing that happened IN the source region; it does not retroactively move." },
  admin_action_log: { decision: "stays", reason: "Admin audit trail — same region-local rationale as audit_log." },
  token_usage: { decision: "stays", reason: "Usage accrual history — already reported to global billing." },
  usage_events: { decision: "stays", reason: "Usage event history — already rolled up / reported." },
  usage_summaries: { decision: "stays", reason: "Derived usage rollups." },
  overage_meter_reports: { decision: "stays", reason: "Stripe meter-report bookkeeping for source-region usage." },
  pii_column_classifications: { decision: "stays", reason: "Derived from profiling — regenerated when the datasource is re-profiled in the target." },
  backups: { decision: "stays", reason: "Backup artifacts are region-local by residency design." },
  backup_config: { decision: "stays", reason: "Backup schedule is re-configured against the target region's storage." },
  connection_group_descriptions: { decision: "stays", reason: "Auto rows regenerate at wizard save; manual descriptions are re-entered after datasources are re-installed." },

  // ── Stays: workspace integrations + config recreated fresh in the target ───
  // Forced by architecture for credential rows: *_encrypted columns are
  // AES-256-GCM under per-region keys with independent rotation, and OAuth
  // callbacks/webhooks bind to region-specific hosts. A decrypt/re-encrypt
  // export path was explicitly rejected on #4460 (larger security surface
  // than the UX win). The docs carry a post-migration re-connect checklist.
  workspace_plugins: { decision: "stays", reason: "Datasource/plugin installs are re-created in the target (explicitly separate scope on #4460); configs may embed region-bound secrets/hosts." },
  plugin_settings: { decision: "stays", reason: "Per-plugin settings follow their install — re-created with the plugin." },
  integration_credentials: { decision: "stays", reason: "Per-region ciphertext (INTEGRATION_TABLES) — customer re-connects the integration." },
  twenty_integrations: { decision: "stays", reason: "Per-region ciphertext (INTEGRATION_TABLES) — customer re-connects." },
  discord_installations: { decision: "stays", reason: "OAuth install bound to region-specific callback hosts — re-install." },
  github_installations: { decision: "stays", reason: "OAuth install bound to region-specific callback hosts — re-install." },
  linear_installations: { decision: "stays", reason: "OAuth install bound to region-specific callback hosts — re-install." },
  email_installations: { decision: "stays", reason: "Credentialed install (INTEGRATION_TABLES) — re-install." },
  sandbox_credentials: { decision: "stays", reason: "BYOC sandbox credentials — per-region ciphertext, re-entered in the target." },
  sso_providers: { decision: "stays", reason: "SSO config carries secrets + region-bound redirect URIs — re-configured by the admin." },
  scim_group_mappings: { decision: "stays", reason: "Follows the SSO/SCIM provider config — re-created with it." },
  custom_domains: { decision: "stays", reason: "Domains point DNS at a region-specific host — re-verified against the target region." },
  ip_allowlist: { decision: "stays", reason: "Small admin-owned security config — re-entered in the target (not in the decided bundle scope)." },
  custom_roles: { decision: "stays", reason: "Small admin-owned RBAC config — re-created in the target (not in the decided bundle scope)." },
  workspace_branding: { decision: "stays", reason: "Small admin-owned white-label config — re-entered in the target (not in the decided bundle scope)." },
  workspace_model_config: { decision: "stays", reason: "Model gateway config may reference per-region gateway credentials — re-configured in the target." },
  workspace_model_catalog: { decision: "stays", reason: "Follows workspace_model_config — re-created with it." },
  mcp_action_policy: { decision: "stays", reason: "Small admin-owned MCP kill-switch config — re-entered in the target (default posture is allow)." },
  approval_rules: { decision: "stays", reason: "Small admin-owned approvals config — re-created in the target (not in the decided bundle scope)." },
  approval_queue: { decision: "stays", reason: "In-flight approvals reference region-local parked runs — un-resumable cross-region, like agent_runs." },
  prompt_collections: { decision: "stays", reason: "Prompt library — re-seedable via `atlas-operator seed prompts`; not in the decided bundle scope." },
  prompt_items: { decision: "stays", reason: "Follows prompt_collections." },
  user_favorite_prompts: { decision: "stays", reason: "Per-user favorites over a library that does not move." },
  oauth_client_rate_limits: { decision: "stays", reason: "Per-client operational rate-limit state — re-accrues." },
  oauth_client_workspace_scope: { decision: "stays", reason: "MCP OAuth client scoping — re-established when clients reconnect to the target region." },
  oauth_client_workspace_grants: { decision: "stays", reason: "MCP OAuth grants are region-local authorizations — clients re-authorize against the target." },
  audit_retention_config: { decision: "stays", reason: "Retention config for a log that stays — re-entered in the target." },
  admin_action_retention_config: { decision: "stays", reason: "Retention config for a log that stays — re-entered in the target." },
  sla_thresholds: { decision: "stays", reason: "Small admin-owned SLA config — re-entered in the target." },
  sla_metrics: { decision: "stays", reason: "SLA measurement history of the source region." },
  sla_alerts: { decision: "stays", reason: "SLA alert history of the source region." },
  workspace_proactive_config: { decision: "stays", reason: "Proactive chat config references region-local channel installs — re-configured after re-install." },
  channel_proactive_config: { decision: "stays", reason: "Follows workspace_proactive_config + channel installs." },
  proactive_pauses: { decision: "stays", reason: "Transient pause state for a subsystem that is re-configured." },
  proactive_meter_events: { decision: "stays", reason: "Proactive metering history — already reported." },
  proactive_classification_review: { decision: "stays", reason: "Review queue over region-local proactive traffic." },
  proactive_public_dataset: { decision: "stays", reason: "Per-workspace entity allowlist for proactive — small admin config, re-entered after entities re-sync." },

  // ── Platform: operator/billing/auth-spine/transient — not workspace content ─
  plugin_catalog: { decision: "platform", reason: "Platform-wide plugin catalog, identical in every region." },
  operator_integration_credentials: { decision: "platform", reason: "Operator-tier app credentials — no per-workspace dimension." },
  region_migrations: { decision: "platform", reason: "The migration bookkeeping itself — must survive the migration it describes." },
  oauth_state: { decision: "platform", reason: "Transient OAuth handshake state with short TTL." },
  trusted_device: { decision: "platform", reason: "Per-user device trust — part of the global auth spine (user-keyed, not workspace-keyed)." },
  user_onboarding: { decision: "platform", reason: "Per-user onboarding progress — user-keyed platform state." },
  user_trial_grants: { decision: "platform", reason: "Per-user trial bookkeeping — global billing/abuse spine." },
  email_preferences: { decision: "platform", reason: "Per-user email opt-outs — user-keyed platform state." },
  onboarding_emails: { decision: "platform", reason: "Operator drip-email bookkeeping." },
  email_outbox: { decision: "platform", reason: "Transient delivery queue." },
  abuse_events: { decision: "platform", reason: "Platform abuse telemetry." },
  demo_leads: { decision: "platform", reason: "Operator lead-capture pipeline (www demo) — no workspace dimension." },
  crm_outbox: { decision: "platform", reason: "Operator lead-capture outbox (SaaS CRM)." },
  subscription: { decision: "platform", reason: "Stripe billing spine — global to the org via the auth spine; the #4458 cleanup must never touch it." },
  stripe_webhook_events: { decision: "platform", reason: "Stripe webhook dedupe bookkeeping." },
  stripe_purged_subscriptions: { decision: "platform", reason: "Billing-teardown bookkeeping." },
  stripe_teardown_pending: { decision: "platform", reason: "Billing-teardown work queue." },
  sub_processor_subscriptions: { decision: "platform", reason: "Legal sub-processor notification list — platform-wide." },
  sub_processor_snapshots: { decision: "platform", reason: "Legal sub-processor snapshots — platform-wide." },
} satisfies Readonly<Record<string, BundleTableScope>>;

/** Table names that move in the export bundle (feeds tests + #4458 scoping). */
export const EXPORTED_TABLES: readonly string[] = Object.entries(BUNDLE_TABLE_DECISIONS)
  .filter(([, v]) => v.decision === "exported")
  .map(([k]) => k);

/**
 * Workspace-scoped tables that stay behind — the source-region rows the #4458
 * grace-period cleanup is allowed to delete. Everything NOT in this list is
 * either already exported (safe to delete only because it moved) or platform
 * state the cleanup must not touch.
 */
export const STAYS_TABLES: readonly string[] = Object.entries(BUNDLE_TABLE_DECISIONS)
  .filter(([, v]) => v.decision === "stays")
  .map(([k]) => k);
