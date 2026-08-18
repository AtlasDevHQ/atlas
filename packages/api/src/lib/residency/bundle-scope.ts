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
  brain_episodes: { decision: "exported", reason: "Company brain tier-3 (ADR-0036) — raw evidence, UUIDs preserved so fact/edge references survive. extracted_at rides along so the target doesn't re-queue episodes a human already reviewed." },
  brain_facts: { decision: "exported", reason: "Company brain tier-2 (ADR-0036) — the workspace's reviewed knowledge, same asset class as the KB. Provenance, `visible_to`, review status and all four temporal columns travel with the claim; a fact stripped of any of them would land unprovenanced and ungated. `pre_widening_visible_to` travels too, for the opposite reason: it gates the claim's ATTRIBUTION (#4836), and stripping it lands every widened fact reading as never-widened — over-DISCLOSED, not ungated." },
  brain_edges: { decision: "exported", reason: "The typed provenance/conflict graph (ADR-0036). Imported last, once every fact/episode endpoint exists." },
  fact_audience_member: { decision: "exported", reason: "Audience membership backing the `audience:` grant arm (ADR-0036). Without it every audience-granted fact denies everyone in the target — a silent total loss of access, not a visible error." },
  brain_slack_channel: { decision: "exported", reason: "The company brain's Slack ingest scope (#5203). ONLY THE EXCLUSION HALF RIDES — `export.ts` projects `channel_id`/`excluded_at`/`exclusion_reason`/`excluded_by` under `excluded_at IS NOT NULL`, and the observed columns (`is_member`, `name`, `is_private`, the health-probe verdicts) are deliberately left behind because the target re-derives them from `users.conversations` on its first sync; carrying a stale membership would have the destination poll channels its bot may not be in. `dashboard_cards` is the precedent for a partial projection. 'stays' is wrong here in the direction that matters, and this is the entry to read before changing it: since #5203 the target's scope is 'every channel the bot is in, MINUS exclusions', so a lost exclusion does not degrade the destination — it makes the destination ingest a channel a human deliberately removed. That is over-DISCLOSURE and unrecoverable, unlike `brain_vocabulary_proposal`'s deferred rejection memory whose cost is under-supersession and is recoverable by re-authoring. Note stays is also DELETION (#4458), so the source's decisions would be destroyed in the same move." },
  brain_slack_ingest_scope: { decision: "exported", reason: "The same narrowing intent one step earlier (#5203). A workspace that migrates between upgrading and its FIRST post-#5203 sync has its pre-retirement channel allowlist here with `reconciled_at` still NULL, and while it is NULL that allowlist IS the scope. `export.ts` carries it only under `reconciled_at IS NULL`: a reconciled workspace's narrowing already travels as `brain_slack_channel` exclusions, and shipping its spent allowlist would land a second, contradictory scope authority in the destination. Dropping the section would land such a workspace looking like one that never had a `slack-history` install — which, by the three-state contract in migration 0198, promotes it to 'every channel the bot is in'. The empty array is a REAL state ('had an install, no usable scope') and must survive the round trip as `[]` rather than as an absent section." },
  brain_vocabulary_edge: { decision: "exported", reason: "The curated identity vocabulary's durable half (ADR-0037 §6/§8, #5022) — the human's approved alias decisions, and the same asset class as the facts they key. Workspace-scoped with NO ACL arm, so unlike `visible_to` there is no grant to narrow on the way out: it travels as ordinary workspace data. `stays` would be a double loss here, since stays is DELETION (#4458): the curated aliases are destroyed at source AND the keys that travel verbatim on the bundle become permanently un-re-derivable, because the function that produced them is gone. #5036 owns the merge semantics when the destination already holds a vocabulary." },
  brain_enrollment: { decision: "exported", reason: "The `(entity, group, dimension)` triples a human named as the tier-1 warehouse producer's reach (#5196, ADR-0039; the connection group joined the key in #5286, and it travels for the same reason the rest of the row does — dropped, a multi-group source region's two enrollments arrive as one) — the warehouse class's AUTHORITY arm (ADR-0040), and the same asset class as `brain_vocabulary_edge`: deliberate human decisions about the brain's shape, not derived state. The failure direction on 'stays' is under-emission rather than over-disclosure — the destination's producer would simply reach nothing — but that is the direction ADR-0039 warns is INVISIBLE: a producer nobody enrolled anything into leaves the whole tier-1 arc dead with every test green, so the loss announces itself as a working, silent system. And 'stays' is DELETION (#4458), so the source's copy goes too. The merge is a plain union with no semantics to defer, unlike the vocabulary's: the pair plus its connection group IS the primary key, every part of it is a human act, and enrolling twice was already a no-op — so `admin-migrate.ts` restores it inline with `ON CONFLICT DO NOTHING` rather than delegating, and there is no #5036-shaped blocker to wait for. Only the enrollment travels: what it authorized the producer to emit rides separately as `brain_facts`, already reviewed." },
  brain_entity: { decision: "exported", reason: "The entity store's snapshot entries (#5043, ADR-0037 §5) — `surface → stable id` for `subject_cmp`/`object_cmp`, plus the canonical surface the vocabulary edge points at. It LOOKS like `brain_vocabulary_target`, which stays, and the difference is what the re-derivation needs: a closure is a pure function of edges that travel on the same bundle, while an entry is a function of a WAREHOUSE READ the destination cannot repeat until its datasource credentials are re-established and a human re-runs the producer. ⚠️ The ids do NOT travel on the facts, and an earlier version of this entry said they were the decisive reason — they are not: `regionPortableComparable` classifies the `entity:` tag `store-local`, so the importer NULLS `subject_cmp`/`object_cmp` on every entity-valued row, deliberately (T5's correction — a foreign id is counterfeit positive evidence of difference). What the entries actually buy the destination is a BRIDGE: they resolve surfaces by name from the moment the bundle lands until the destination has warehouse credentials again and a human re-runs the producer, which is exactly the window in which nothing else can. The ids in them are digests over the SOURCE workspace, so the first producer run replaces them wholesale. ⚠️ NOT harmless, and an earlier version of this entry said it was: extraction consults the store, so facts written during the bridge window carry the imported ids and the first producer run retires them. At `subject_cmp` a proven difference SUPPRESSES, so the cost is unmatched corroboration — recoverable and invisible; the `object_cmp` question is untraced and recorded rather than asserted (#5233). And because the replacement is keyed on `(workspace_id, entity)`, two regions naming the entity differently leaves both sets live and poisons every shared norm permanently — the run report's `entityEdges.ambiguous` surfaces it on every arm that got far enough to count it, including a FAILED pass that reached the `proposing` phase — only a failure at `store-read` or `planning` reports no count — and #5233's reaper is the fix. And `stays` is DELETION (#4458), so the source's copy goes at the same moment. The rows also hold the customer's own entity names verbatim (`canonical_surface` is `Acme Corp`), which is `brain_vocabulary_edge`'s asset class rather than a cache's. Failure direction if dropped is ADR-0039's invisible one: the cutover reports clean, every lookup abstains, and every test stays green. The merge is a union on `entity_id`, which is a digest of `(workspace, entity, primary key)` — two regions holding one id hold one warehouse row — so `admin-migrate.ts` restores it inline with `ON CONFLICT DO NOTHING` and there is no #5036-shaped blocker. DO NOTHING and not DO UPDATE: an older arriving snapshot must never overwrite a newer local one, or a week-old bundle re-keys the destination's corpus onto a name that has since changed." },

  // ── Stays: caches, derived data, history, region-bound state ───────────────
  // (Deleted from the source region by the #4458 cleanup after the grace period.)
  chat_cache: { decision: "stays", reason: "Response cache PLUS the Slack installation store (AES-GCM-encrypted bot tokens under slack:installation:* keys — region-bound ciphertext; Slack is re-installed in the target per the integrations decision). No org_id column: cache keys have no org dimension, Slack rows scope via value->>'orgId' — #4458 cleanup must scope by that expression, not a column." },
  brain_vocabulary_target: { decision: "stays", reason: "The vocabulary's DERIVED half — the transitive closure of `brain_vocabulary_edge`, which is exported (#5022). Not carried, because ADR-0037 §8 has the import UNION the approved edges and RECOMPUTE the closure: a source closure restored verbatim into a destination that already holds a vocabulary would be a closure of neither. This is the `dashboard_draft_card_cache` case — derived, regenerated at the destination from inputs that do move — so 'stays' destroys nothing, and it is the reading of #5022's 'classify the vocabulary tables exported' that matches §8's own merge. NOTE the deletion ORDER: `fk_brain_vocabulary_target_edge` is RESTRICT, so these rows must go before the edges (see the cleanup rule, which is `expression`-kind for exactly that phase reason)." },
  brain_vocabulary_proposal: { decision: "stays", reason: "The alias queue and its rejection memory (#5023, ADR-0037 §6). 'stays' is a DEFERRAL with a named cost, not the genuinely derived-and-regenerable call `brain_vocabulary_target` and `dashboard_draft_card_cache` get. What legitimately stays is the QUEUE: an undecided proposal is re-derivable, because the destination's producer re-runs and re-emits it. What does NOT re-derive is the REJECTION half — a `rejected` row is a human's decision that two norms are not the same slot, and it is exactly the state that stops a producer re-writing what a human removed. So a cutover today loses it, and the failure that returns is the one #4507's memory exists to prevent: a warehouse-derived entity edge a human removed is re-proposed in the destination and AUTO-APPROVES. Deferred rather than accepted because nothing can trigger it yet — #5034 owns the first producer, and #5036 owns the vocabulary's import merge, which is where this belongs (with the edges it is memory ABOUT, not as a fourth ad-hoc section). Reclassify to 'exported' there; the cost is live from the moment #5034 lands, whichever ships first." },
  brain_predicate_cardinality: { decision: "stays", reason: "Cardinality on the canonical predicate (#5027, ADR-0037 §3) — the vocabulary's SECOND property, and a DEFERRAL with a named cost on `brain_vocabulary_proposal`'s exact model, not the derived-and-regenerable call `brain_vocabulary_target` gets. It is curated human decisions, so §8's asset-class argument for exporting `brain_vocabulary_edge` reaches it too; what it does not yet have is a destination the rows would MEAN anything in. The key is `predicate_key`, and until #5035 the importer landed its facts UNKEYED by design (`admin-migrate.ts` named no key column) — so a carried entry would have sat beside rows it could not match, silently, and 'silently' is the operative word: an entry that matches nothing produces no error and no supersession, which is indistinguishable from a workspace nobody has curated. **That blocker is gone**: imported facts are keyed now, carried verbatim on a v3 bundle or computed once from a legacy one. What remains is the reason the deferral still stands — the MERGE semantics against a destination that already holds its own entries are unspecified, and they are #5036's, the same issue that owns the alias half. The cost of staying, stated rather than implied: a cutover loses the curated `single` entries AND the `rejected` rows that are the producers' memory, so the destination UNDER-supersedes until they are re-authored. That is the recoverable direction, which is why the deferral is affordable and the reverse (carrying entries that might key onto the destination's own canonicalization and make an unrelated slot destructively supersedable, with no preview) is not. Reclassify to 'exported' in #5036, with the edges this is a property OF — #5035 has landed, so that is the only remaining precondition." },
  brain_audience_reverify_attempt: { decision: "stays", reason: "Fair-share scheduling state for the audience re-verifiers (#4971) — 'this audience has had its turn', read by nothing but the scan's ORDER BY. Deliberately NOT the same call as fact_audience_member, which is exported because losing it denies everyone: losing THIS costs the target one uniformly-NULL first cycle, after which token order breaks the tie and rotation re-establishes itself. It carries no membership, no grant and no content, so 'stays' destroys nothing." },
  brain_coverage_snapshot: { decision: "stays", reason: "The Coverage Surface's dated survey-unit roster (#5213, ADR-0041) — one row per channel or (entity, dimension) pair the granted credentials can see. 'stays' because every column is a reading OF THE SOURCE REGION'S credentials at a source-region instant, and the whole statement the page makes is 'as of <date>, of what Atlas's credentials can see'. Carried across, that date would describe a cycle the destination never ran, against scopes the destination's token may not hold — a denominator that looks established and is not, which is the fabrication ADR-0041 refuses. Regenerates on the destination's first successful cycle. Until then NEITHER table has a row, so the class is absent from the coverage read entirely — #5214 owns rendering that as 'never enumerated here', which is the honest reading of a region that has not re-established its vendor credentials. (Note the absent row is a DIFFERENT state from 'enumeration unavailable since <date>', which needs a cycle row carrying a `last_error`; that one is what a live region's failure produces.) NOT the `brain_entity` case, which is exported because an entity entry BRIDGES the window before the destination can re-run its producer: a bridge is only worth carrying when nothing else can answer, and here the honest answer 'we have not looked yet' is available and is better than a stale one. The rows also hold channel names verbatim (`#project-severance`), which is `brain_slack_channel`'s asset class — but that table exports only its EXCLUSION half, the durable human decision, and there is no human decision in this one at all." },
  brain_coverage_cycle: { decision: "stays", reason: "The per-(workspace, class) enumeration record behind the roster above (#5213, ADR-0041) — last attempt, last success, and the map-edge marks. 'stays' for the roster's reason and one more: `last_success_at` is what the page renders in 'as of <date>' and in 'enumeration unavailable since <date>', so carrying it would have the destination assert it looked at a workspace's Slack on a date it did not exist in that region. `degraded_arms` is the same shape one level up — a map edge is a fact about which scopes THIS deployment's token holds. Absent rows are the correct post-migration state: no cycle has run here, and the surface says so." },
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
