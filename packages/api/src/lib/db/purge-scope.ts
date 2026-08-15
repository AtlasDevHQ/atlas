/**
 * GDPR hard-delete purge scope — the per-table reachability registry (#5160).
 *
 * The bug this pins: `hardDeleteWorkspace` issued 57 `DELETE FROM` statements
 * and touched none of `brain_facts`, `brain_edges`, `brain_episodes` or
 * `knowledge_documents`, while the purge endpoint answered *"All data has been
 * irreversibly removed"* and `/dpa` promised deletion of all Personal Data.
 * The gap was not one missed pillar — the mechanical sweep behind this registry
 * found **34** workspace-scoped tables the purge never reached — plus
 * `user_trial_grants`, which is scoped, was never reached, and is deliberately
 * `retained`. Among them the encrypted KB sync-connector credentials
 * (`knowledge_sync_credentials`), the same class of miss `integration_credentials`
 * was in #3425, one pillar over.
 *
 * Why a registry rather than a longer DELETE list: **no table in `db/schema.ts`
 * has a foreign key to `organization`.** Not one. `DELETE FROM organization` in
 * the purge transaction therefore cascades to nothing here, so every
 * workspace-scoped table is reachable ONLY by being named explicitly (directly,
 * or through an in-schema FK chain from a table that is). Nothing about the
 * schema makes that true by construction, which is why it kept silently
 * failing to be true. `purge-scope.test.ts` enumerates the Drizzle schema and
 * fails when a table appears with no entry — so the next brain table breaks CI
 * instead of quietly surviving a GDPR purge.
 *
 * This is the same tripwire shape as `lib/residency/bundle-scope.ts` (#4460),
 * and the two registries answer adjacent questions about the same tables:
 * bundle-scope asks "does this move to another region?", this one asks "does
 * this die when the workspace is purged?". A table can legitimately be
 * `stays` + `purged`, or `exported` + `purged`; what it cannot be is
 * workspace-scoped and absent from both.
 *
 * Decision semantics:
 *
 * - `purged` — `hardDeleteWorkspace` issues an explicit `DELETE FROM <table>`.
 *   The tripwire verifies the statement is actually there, so an entry can
 *   never outrun the implementation.
 *
 *   There is deliberately NO "reached by cascade" decision. Every
 *   workspace-scoped table is deleted explicitly — including the TEN with no
 *   scope column of their own, which go via a parent subquery (`messages`,
 *   `slack_threads`, `dashboard_cards`, `dashboard_user_drafts`,
 *   `dashboard_draft_card_cache`, `knowledge_links`, `suggestion_user_clicks`,
 *   `prompt_items`, `scheduled_task_runs`, `stripe_webhook_events`). This said
 *   EIGHT while listing NINE and omitting `stripe_webhook_events`; measured
 *   2026-08-12 by enumerating the Drizzle schema, there are ELEVEN scope-less
 *   `purged` tables — the ten above plus `chat_cache`, which is scoped by an
 *   expression rather than a parent (see its entry). Several SCOPED tables would cascade
 *   too — `agent_runs`, `agent_session_memory`, `learned_pattern_injections` —
 *   and are deleted explicitly all the same.
 *
 *   Two reasons, and the first is the whole bug: an inherited cascade is
 *   exactly the mechanism everyone ASSUMED was removing the brain tables, and
 *   it was not there. The second is that "zero rows
 *   remain in this table" is directly assertable per table, which is what makes
 *   the falsifier in `hard-delete-purge-pg.test.ts` able to fail. `messages`
 *   already carried this reasoning as a "GDPR completeness guarantee"; #5160
 *   makes it the rule rather than one table's local habit.
 * - `user_scoped` — keyed on a user id, not a workspace. Removed by the
 *   orphaned-user arm of the purge (a user with no other org membership), and
 *   deliberately retained for a user who is still a member elsewhere.
 * - `anonymized` — the rows SURVIVE and their personal-data columns are
 *   scrubbed inside the purge transaction. Used where the row is an operator
 *   accountability record: destroying it would erase the history of what was
 *   done TO the workspace before it was purged. NOT, as an earlier draft of this
 *   line said, "the evidence of the erasure itself" — the purge's own audit row
 *   is written after the transaction under a different org, and was never in
 *   scope. See the `admin_action_log` entry below.
 * - `retained` — deliberately survives the purge intact. Every entry here is a
 *   case where deleting the row causes a concrete harm named in its reason;
 *   none of them carry customer personal data.
 * - `platform` — no workspace and no user dimension: operator state, the
 *   global billing/auth spine, or region-wide infrastructure.
 *
 * The customer-facing representations that depend on this being correct are
 * `apps/www/src/app/dpa/page.tsx` (§Return & Deletion) and
 * `apps/www/src/app/privacy/page.tsx` (§Retention).
 */

export type PurgeDecision =
  | "purged"
  | "user_scoped"
  | "anonymized"
  | "retained"
  | "platform";

export interface PurgeTableScope {
  readonly decision: PurgeDecision;
  /** Why this decision is correct — required, non-empty. */
  readonly reason: string;
}

/**
 * Column names that make a table workspace-scoped.
 *
 * `reference_id` is the trap: `oauth_client_rate_limits` and
 * `oauth_client_workspace_scope` scope by it (migration 0051 — *"`reference_id`
 * is the workspace/org id"*), so a guard checking only `org_id`/`workspace_id`
 * reports them unscoped and lets them slip the purge — which is exactly what
 * happened. `referenceId` is the Better-Auth quoted-camel spelling of the same
 * thing, used by the `subscription` table.
 */
export const WORKSPACE_SCOPE_COLUMNS = [
  "org_id",
  "workspace_id",
  "reference_id",
  "referenceId",
] as const;

/** Column names that make a table user-scoped rather than workspace-scoped. */
export const USER_SCOPE_COLUMNS = ["user_id", "userId"] as const;

export const PURGE_TABLE_DECISIONS = {
  // ── Purged: explicit DELETE FROM in hardDeleteWorkspace ───────────────────

  // Chat + agent pillar
  conversations: { decision: "purged", reason: "Core chat pillar — the conversation rows themselves." },
  messages: { decision: "purged", reason: "Message bodies: the highest-volume carrier of customer prose. Cascades from conversations too, but deleted explicitly as a completeness guarantee for deployments predating the FK." },
  slack_threads: { decision: "purged", reason: "Chat-adapter thread mapping. No scope column — deleted via a conversation_id subquery, since there is no FK to cascade from." },
  agent_runs: { decision: "purged", reason: "Per-turn durable checkpoints (ADR-0020) whose `transcript` column holds the full agent trace — verbatim customer prose and query results. Cascades from conversations, but carries org_id, so it is deleted explicitly." },
  agent_session_memory: { decision: "purged", reason: "Long-lived durable working memory (ADR-0020) — model-authored notes about the workspace's data. Cascades from conversations; carries org_id, so explicit." },

  // Company Atlas / brain pillar (ADR-0036/0037) — the #5160 headline gap.
  // NOTE the DELETE ORDER, which is load-bearing: brain_facts→brain_episodes
  // is RESTRICT and brain_vocabulary_target→brain_vocabulary_edge is RESTRICT,
  // so the referencing side must go first or the purge transaction aborts.
  brain_edges: { decision: "purged", reason: "The typed provenance/conflict graph (ADR-0036). Deleted first — it references both facts and episodes." },
  brain_facts: { decision: "purged", reason: "Tier-2 claims (ADR-0036): subject/predicate/object retained VERBATIM, extracted from Slack history, Zoom transcripts and Outlook mail. The single most sensitive table in the internal DB, and the table `schema.ts` documents as 'Nothing DELETEs' — bi-temporal invalidate-never-delete by design, which is why the purge is the only mechanism that may remove it. Must precede brain_episodes (RESTRICT FK)." },
  brain_episodes: { decision: "purged", reason: "Tier-3 raw evidence (ADR-0036) — the source excerpts claims were extracted from. Deleted after brain_facts, which references it under RESTRICT." },
  brain_vocabulary_edge: { decision: "purged", reason: "The curated identity vocabulary's durable half (ADR-0037 §6/§8) — human-approved alias decisions over workspace entity names. Deleted after brain_vocabulary_target, which references it under RESTRICT." },
  brain_vocabulary_target: { decision: "purged", reason: "The vocabulary's derived closure (ADR-0037 §8). Derived, but derived FROM customer entity names and holding them verbatim, so it is purged rather than left to regenerate. Must precede brain_vocabulary_edge (RESTRICT FK)." },
  brain_vocabulary_proposal: { decision: "purged", reason: "The alias queue and its rejection memory (#5023) — carries proposed norms lifted from customer data plus the reviewing user's decision." },
  brain_predicate_cardinality: { decision: "purged", reason: "Curated cardinality on canonical predicates (#5027, ADR-0037 §3), keyed by predicate_key — a workspace-specific vocabulary artifact." },
  brain_slack_channel: { decision: "purged", reason: "The brain's Slack ingest scope (#5203). Carries channel NAMES and ids verbatim — `#project-severance` is customer data on its own, which is the whole reason `oversight.ts` has a label policy — plus `excluded_by`, the user id of whoever narrowed the scope. Purged rather than retained: nothing here is needed after the workspace is gone, and a re-created org must not inherit another org's channel list." },
  brain_slack_ingest_scope: { decision: "purged", reason: "The per-workspace reconcile state (#5203) — `legacy_channels` is the pre-retirement channel id list, same content class as the row above. No FK in either direction, so no ordering constraint against `brain_slack_channel`." },
  brain_enrollment: { decision: "purged", reason: "The `(entity, dimension)` pairs a human named as the warehouse producer's reach (#5196, ADR-0039). Carries the workspace's own semantic-layer entity and column names verbatim — `accounts`/`arr_band` describes the customer's business exactly as `brain_slack_channel`'s channel names do — plus `enrolled_by`, the user id of whoever authorized the Atlas to hold claims about that pair. No FK in either direction, so no ordering constraint; purged rather than retained so a re-created org cannot inherit another org's reach and start emitting against it." },
  brain_entity: { decision: "purged", reason: "The entity store's snapshot entries (#5043, ADR-0037 §5) — `canonical_surface` holds the customer's own entity names verbatim (`Acme Corp`), which is exactly what `brain_vocabulary_edge` is purged for, and `key_surface` holds their warehouse primary keys. Derived from a warehouse read rather than authored, but derived FROM customer data and holding it verbatim, which is the `brain_vocabulary_target` test and it fails it on the retain side. No FK in either direction — the ids reach `brain_facts` as `subject_cmp`/`object_cmp` VALUES, never as a join arm — so no ordering constraint. Purged rather than left to regenerate so a re-created org cannot inherit another org's entity names, and because the producer that would regenerate them needs a datasource connection the new org does not have." },
  brain_audience_reverify_attempt: { decision: "purged", reason: "Fair-share scheduling state for the audience re-verifiers (#4971). Carries no content, but is keyed by workspace_id and audience_id, and a purged workspace must leave no scheduling residue for a re-created org to inherit." },
  fact_audience_member: { decision: "purged", reason: "Audience membership backing the `audience:` ACL arm (ADR-0036) — resolved identities (email-join, SSO-domain narrowing), so squarely personal data." },

  // Knowledge Base pillar (ADR-0028) — the #5160 headline gap's other half.
  knowledge_documents: { decision: "purged", reason: "Every ingested KB document: bodies + frontmatter. Named in #5160 alongside the brain tables." },
  knowledge_links: { decision: "purged", reason: "The KB link graph. No scope column — deleted via a source_document_id subquery before its parent, rather than relying on the cascade." },
  knowledge_sync_credentials: { decision: "purged", reason: "AES-256-GCM ciphertext for KB sync connectors — a SECRET AT REST that survived every purge until #5160. The same class of miss as integration_credentials (#3425) one pillar over." },
  knowledge_sync_state: { decision: "purged", reason: "Per-connector sync cursors and bookkeeping for the purged workspace." },

  // Semantic layer
  semantic_entities: { decision: "purged", reason: "DB-backed semantic layer — the workspace's core modelling asset, carrying customer table/column names and descriptions." },
  semantic_entity_versions: { decision: "purged", reason: "Entity version history — the same content, one revision back." },
  semantic_profile_status: { decision: "purged", reason: "Profiling progress with `failed_tables` — a verbatim list of the customer's table names." },
  connection_profile_state: { decision: "purged", reason: "`baseline_profiles` holds profiled schema and sample-derived statistics of customer tables. Org-scoped and previously unpurged." },
  connection_group_descriptions: { decision: "purged", reason: "LLM- and human-authored descriptions of the customer's datasource groups (ADR-0022 §4)." },
  learned_patterns: { decision: "purged", reason: "Learned query patterns — customer SQL plus the natural-language questions that produced it." },
  learned_pattern_injections: { decision: "purged", reason: "Injection telemetry linking patterns to conversations and request ids. Cascades from learned_patterns; carries org_id, so explicit." },
  query_suggestions: { decision: "purged", reason: "Derived suggestions, phrased in the customer's own domain language." },
  suggestion_user_clicks: { decision: "purged", reason: "Per-user click telemetry on suggestions. No scope column — deleted via a suggestion_id subquery before its parent." },

  // Dashboards (ADR-0029/0034)
  dashboards: { decision: "purged", reason: "Dashboard definitions and their parameters." },
  dashboard_cards: { decision: "purged", reason: "Cards including `cached_columns`/`cached_rows` — snapshots of actual query RESULTS, i.e. customer data at rest in the internal DB." },
  dashboard_user_drafts: { decision: "purged", reason: "Per-user drafts are content under the draft-first model (ADR-0029/0034). No scope column — deleted via a dashboard_id subquery." },
  dashboard_draft_card_cache: { decision: "purged", reason: "Cached draft-card RESULTS — customer data, not just layout. No scope column; deleted via a dashboard_id subquery before its parents." },

  // Prompts
  prompt_collections: { decision: "purged", reason: "Starter-prompt collections authored for the workspace." },
  prompt_items: { decision: "purged", reason: "The prompt text itself. No scope column — deleted via a collection_id subquery." },
  user_favorite_prompts: { decision: "purged", reason: "Per-user favourited prompt text, scoped by org_id. Previously unpurged despite carrying both a user id and customer-authored prose." },

  // Scheduling
  scheduled_tasks: { decision: "purged", reason: "Task definitions including their prompt text and delivery targets." },
  scheduled_task_runs: { decision: "purged", reason: "Run history. No scope column — deleted via a task_id subquery." },

  // Proactive chat (enterprise-gated)
  workspace_proactive_config: { decision: "purged", reason: "Per-workspace proactive configuration. Previously unpurged." },
  channel_proactive_config: { decision: "purged", reason: "Per-channel proactive configuration, carrying customer channel identifiers." },
  proactive_pauses: { decision: "purged", reason: "Per-workspace/channel pause state." },
  proactive_meter_events: { decision: "purged", reason: "Proactive metering events for the purged workspace." },
  proactive_classification_review: { decision: "purged", reason: "Human review verdicts on proactive classifications — carries a message id, a reviewing user id and a free-text note." },
  proactive_public_dataset: { decision: "purged", reason: "Per-workspace entity/metric deny decisions, carrying customer entity names." },

  // Integrations + credential stores
  workspace_plugins: { decision: "purged", reason: "Plugin/datasource installs for the workspace (the post-0096 home of datasource installs)." },
  integration_credentials: { decision: "purged", reason: "Lazy-OAuth credential bundles (ADR-0005) — encrypted secrets at rest." },
  twenty_integrations: { decision: "purged", reason: "Twenty CRM API key — an encrypted secret at rest." },
  discord_installations: { decision: "purged", reason: "BYOT Discord install (the only per-platform installations table left after 0119)." },
  github_installations: { decision: "purged", reason: "GitHub install rows for the workspace." },
  linear_installations: { decision: "purged", reason: "Linear install rows for the workspace." },
  email_installations: { decision: "purged", reason: "Email-channel install rows for the workspace." },
  chat_cache: { decision: "purged", reason: "Holds the Slack installation store (AES-GCM bot tokens under `slack:installation:*`). No org_id column — purged by `key LIKE 'slack:installation:%' AND value->>'orgId' = $1`, matching the partial expression index. The `key LIKE` bound is deliberate and is the one narrowing predicate in the whole purge: the table's other entries (thread subscriptions, conversation ids, OAuth nonces — see migration 0086) carry no orgId to scope by and expire on their own TTL. If one ever gains an orgId, it needs its own DELETE here rather than a widened LIKE." },
  plugin_settings: { decision: "purged", reason: "Per-plugin settings for the workspace." },

  // Auth / access control / compliance config
  settings: { decision: "purged", reason: "Org-scoped runtime settings." },
  custom_roles: { decision: "purged", reason: "Workspace-defined RBAC roles." },
  ip_allowlist: { decision: "purged", reason: "Workspace IP allowlist — carries customer network addresses." },
  sso_providers: { decision: "purged", reason: "SSO provider configuration for the workspace." },
  scim_group_mappings: { decision: "purged", reason: "SCIM group→role mappings. Guarded by a to_regclass probe: an EU/APAC region DB was observed missing this table, and an unprobed DELETE aborted the entire purge transaction." },
  mcp_action_policy: { decision: "purged", reason: "Per-workspace MCP action-category kill-switch (ADR-0016 gate 1). Previously unpurged — a re-created org id would have inherited the deleted workspace's deny list." },
  oauth_client_workspace_grants: { decision: "purged", reason: "Cross-workspace agent grants (#2073) naming this workspace." },
  oauth_client_workspace_scope: { decision: "purged", reason: "Cross-workspace agent identity scope (#2073). Scopes by `reference_id`, not `workspace_id` — the naming trap WORKSPACE_SCOPE_COLUMNS exists to catch." },
  oauth_client_rate_limits: { decision: "purged", reason: "Per-(client, workspace) rate limits (0051). Also scopes by `reference_id`." },
  approval_queue: { decision: "purged", reason: "Pending approvals, carrying the proposed SQL/action payloads." },
  approval_rules: { decision: "purged", reason: "Workspace approval policy." },
  pii_column_classifications: { decision: "purged", reason: "PII classifications naming the customer's tables and columns." },
  sandbox_credentials: { decision: "purged", reason: "Per-workspace sandbox credentials — encrypted secrets at rest." },
  audit_retention_config: { decision: "purged", reason: "Workspace audit-retention policy." },
  admin_action_retention_config: { decision: "purged", reason: "Per-org retention policy for admin_action_log (0035). Pure config with no personal data; previously unpurged, so a purged org's policy row outlived it and a re-created org id would silently inherit it." },
  workspace_branding: { decision: "purged", reason: "Workspace branding — logo/colour customization." },
  workspace_model_config: { decision: "purged", reason: "Per-workspace model selection." },
  workspace_model_catalog: { decision: "purged", reason: "Cached per-workspace provider model catalogue (`payload`). Derived and re-fetchable, but org-scoped, so it is purged rather than left as residue." },
  custom_domains: { decision: "purged", reason: "Custom domain rows — carries the customer's hostname." },

  // Audit + activity
  audit_log: { decision: "purged", reason: "The workspace-facing audit trail: actor emails, IPs, and the queries they ran." },
  action_log: { decision: "purged", reason: "Action execution history for the workspace." },

  // Usage, billing and metering
  usage_events: { decision: "purged", reason: "Per-workspace usage events." },
  usage_summaries: { decision: "purged", reason: "Rolled-up per-workspace usage." },
  token_usage: { decision: "purged", reason: "Per-org token accounting." },
  overage_meter_reports: { decision: "purged", reason: "Overage meter reports carrying the org's Stripe customer id and reported spend. Previously unpurged, so billing linkage outlived the 'no billable Stripe linkage' guarantee #3425 established." },
  abuse_events: { decision: "purged", reason: "Per-workspace abuse events. Deleting these loses abuse memory for a re-created org id — accepted, and the settled precedent this registry follows for user_trial_grants' opposite call: abuse_events is workspace-keyed (a purged org id is not reused by a returning ACTOR), whereas the trial grant is user-keyed and its whole purpose is surviving org deletion." },
  subscription: { decision: "purged", reason: "@better-auth/stripe subscription rows (`referenceId` = org id). Probed with to_regclass — the table only exists post-0152 or on Stripe deployments. The REMOTE teardown runs before this cascade; this removes the local billable linkage (#3425)." },
  stripe_webhook_events: { decision: "purged", reason: "Webhook dedupe-ledger rows for the org's subscription ids, matched via a subscription subquery, so they must go before the subscription rows." },

  // Residency
  region_migrations: { decision: "purged", reason: "Region-migration records for the workspace." },
  sla_metrics: { decision: "purged", reason: "Per-workspace SLA metrics." },
  sla_alerts: { decision: "purged", reason: "Per-workspace SLA alerts." },
  sla_thresholds: { decision: "purged", reason: "Per-workspace SLA thresholds." },

  // Outboxes — pending sends addressed to a workspace that no longer exists
  email_outbox: { decision: "purged", reason: "Encrypted rendered emails (recipient address + a live reset link/OTP for the TTL window), optionally org-scoped. A pending row surviving the purge would DELIVER mail to a purged workspace's users. Only org-scoped rows are purged; NULL-org rows belong to session-less flows (password reset) and are not workspace data." },
  crm_outbox: { decision: "purged", reason: "Lead-capture events whose payload holds email addresses, attributed by workspace_id (0106). Rows attributed to the purged workspace go with it." },
  oauth_state: { decision: "purged", reason: "In-flight OAuth state for the workspace." },
  onboarding_emails: { decision: "purged", reason: "Per-org onboarding email send records." },

  // ── User-scoped: removed with the orphaned-user arm ───────────────────────
  // A user who still belongs to another org keeps these — which is correct, and
  // is why they are not workspace-scoped.
  user_onboarding: { decision: "user_scoped", reason: "Per-user tour state. Explicitly deleted for orphaned users inside the purge transaction." },
  email_preferences: { decision: "user_scoped", reason: "Per-user email preferences. Explicitly deleted for orphaned users inside the purge transaction." },
  trusted_device: { decision: "user_scoped", reason: "Per-user trusted-device records (user_agent + ip_address). Removed by the migration-level `\"user\"(id) ON DELETE CASCADE` FK when the orphaned user row is deleted — the FK lives in SQL, not Drizzle, because `user` is a Better-Auth table." },

  // ── Anonymized: rows survive, personal-data columns scrubbed ──────────────
  admin_action_log: { decision: "anonymized", reason: "The operator accountability trail: the record of what operators DID to this workspace — suspensions, plan changes, MFA resets — which an erasure should not be able to destroy on its way out. NOT, as an earlier draft of this reason claimed, 'including the record of this purge': `logAdminAction` for the purge runs in the route AFTER hardDeleteWorkspace returns and stamps org_id from the acting admin's active organization, so the purge's own row is outside this scope either way, and a DELETE here would never have erased it. The scrub NULLs actor_id, actor_email, ip_address and metadata, and replaces target_id with a sentinel; action_type, target_type, timestamp and org_id survive, so what happened stays auditable and who it happened to does not. `metadata` goes wholesale rather than by key denylist because it is free-form jsonb written from a dozen call sites (admin-mfa-reset writes targetUserEmail into it) and no denylist can be complete by construction. The pre-existing F-36 endpoint (migration 0035, which is why these columns are nullable at all) keys on `actor_id = userId` and is NOT reached by a workspace purge, which is why the purge does its own org-scoped scrub." },

  // ── Retained: deliberately survives, with the harm deleting would cause ───
  stripe_teardown_pending: { decision: "retained", reason: "The durable Stripe teardown outbox (#3679). These rows ARE the retry that still has to cancel a live subscription; deleting them on purge would strand a subscription invoicing a deleted workspace — precisely the bug #3679 exists to prevent. Holds Stripe ids and an error string, no customer personal data. `reconcile-stripe-teardown.ts` removes each row on success or `resource_missing`." },
  stripe_purged_subscriptions: { decision: "retained", reason: "The tombstone the purge transaction WRITES (#3468). Cancellation webhooks arrive after the transaction commits; without the tombstone a completed purge immediately regrows stripe_webhook_events rows. Deleting it in the same transaction that writes it would defeat its only purpose. Stripe subscription ids only, pruned after 30 days." },
  user_trial_grants: { decision: "retained", reason: "One-trial-per-user anti-abuse marker (#3469/#3470), and the deliberate counter-example to abuse_events' opposite call. `schema.ts` documents the row as surviving ORG deletion — org_id is present but is NOT an FK, precisely so the grant outlives the workspace — because deleting it would hand a purged workspace's owner a fresh trial on demand, making the purge an abuse primitive. It is 'retained' rather than 'user_scoped' because it carries a workspace scope column, and the tripwire is right to insist that combination be an explicit decision rather than a by-product of the key it happens to use. Contents are (user_id, org_id, granted_at) — no personal data beyond an id the `\"user\"` row already holds, and the migration-level `\"user\"(id) ON DELETE CASCADE` removes it when the user is genuinely orphaned, so a departing user's grant does not outlive their account." },

  // ── Platform: no workspace and no user dimension ──────────────────────────
  plugin_catalog: { decision: "platform", reason: "Global plugin catalogue — product metadata, identical for every workspace." },
  operator_integration_credentials: { decision: "platform", reason: "Atlas's OWN integration credentials (operator-side), not a tenant's." },
  backups: { decision: "platform", reason: "Region-wide EE backup metadata. No workspace dimension — a backup covers the whole region DB." },
  backup_config: { decision: "platform", reason: "Single-row region-wide backup schedule (`id` defaults to '_default')." },
  demo_leads: { decision: "platform", reason: "Atlas's own marketing-site demo leads — operator pipeline, never tenant data. Erasure runs through the marketing-site path, not a workspace purge." },
  sub_processor_subscriptions: { decision: "platform", reason: "Operator-managed sub-processor notification subscriptions (the compliance mailing list), keyed by URL and created_by_user_id — platform state, not workspace content." },
  sub_processor_snapshots: { decision: "platform", reason: "Published sub-processor list snapshots — a global compliance artifact." },
} as const satisfies Record<string, PurgeTableScope>;

/** Tables the purge deletes with an explicit statement. */
export const PURGED_TABLES: ReadonlySet<string> = new Set(
  Object.entries(PURGE_TABLE_DECISIONS)
    .filter(([, v]) => v.decision === "purged")
    .map(([k]) => k),
);

/** Tables deliberately left intact by the purge. */
export const RETAINED_TABLES: ReadonlySet<string> = new Set(
  Object.entries(PURGE_TABLE_DECISIONS)
    .filter(([, v]) => v.decision === "retained")
    .map(([k]) => k),
);
