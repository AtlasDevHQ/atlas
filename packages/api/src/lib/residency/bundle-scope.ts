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
  brain_slack_channel: { decision: "exported", reason: "The company brain's Slack ingest scope (#5203). ONLY THE EXCLUSION HALF RIDES — `export.ts` projects `channel_id`/`excluded_at`/`exclusion_reason`/`excluded_by` under `excluded_at IS NOT NULL`, and the observed columns (`is_member`, `name`, `is_private`, the health-probe verdicts) are deliberately left behind because the target re-derives them from `users.conversations` on its first sync; carrying a stale membership would have the destination poll channels its bot may not be in. `dashboard_cards` is the precedent for a partial projection. 'stays' is wrong here in the direction that matters, and this is the entry to read before changing it: since #5203 the target's scope is 'every channel the bot is in, MINUS exclusions', so a lost exclusion does not degrade the destination — it makes the destination ingest a channel a human deliberately removed. That is over-DISCLOSURE and unrecoverable, unlike `brain_vocabulary_proposal`'s rejection memory whose cost is under-supersession and is recoverable by re-authoring (deferred when this entry was written; exported since #5113). Note stays is also DELETION (#4458), so the source's decisions would be destroyed in the same move." },
  brain_slack_ingest_scope: { decision: "exported", reason: "The same narrowing intent one step earlier (#5203). A workspace that migrates between upgrading and its FIRST post-#5203 sync has its pre-retirement channel allowlist here with `reconciled_at` still NULL, and while it is NULL that allowlist IS the scope. `export.ts` carries it only under `reconciled_at IS NULL`: a reconciled workspace's narrowing already travels as `brain_slack_channel` exclusions, and shipping its spent allowlist would land a second, contradictory scope authority in the destination. Dropping the section would land such a workspace looking like one that never had a `slack-history` install — which, by the three-state contract in migration 0198, promotes it to 'every channel the bot is in'. The empty array is a REAL state ('had an install, no usable scope') and must survive the round trip as `[]` rather than as an absent section." },
  brain_vocabulary_edge: { decision: "exported", reason: "The curated identity vocabulary's durable half (ADR-0037 §6/§8, #5022) — the human's approved alias decisions, and the same asset class as the facts they key. Workspace-scoped with NO ACL arm, so unlike `visible_to` there is no grant to narrow on the way out: it travels as ordinary workspace data. `stays` would be a double loss here, since stays is DELETION (#4458): the curated aliases are destroyed at source AND the keys that travel verbatim on the bundle become permanently un-re-derivable, because the function that produced them is gone. #5036 owns the merge semantics when the destination already holds a vocabulary." },
  brain_enrollment: { decision: "exported", reason: "The `(entity, group, dimension)` triples a human named as the tier-1 warehouse producer's reach (#5196, ADR-0039; the connection group joined the key in #5286, and it travels for the same reason the rest of the row does — dropped, a multi-group source region's two enrollments arrive as one) — the warehouse class's AUTHORITY arm (ADR-0040), and the same asset class as `brain_vocabulary_edge`: deliberate human decisions about the brain's shape, not derived state. The failure direction on 'stays' is under-emission rather than over-disclosure — the destination's producer would simply reach nothing — but that is the direction ADR-0039 warns is INVISIBLE: a producer nobody enrolled anything into leaves the whole tier-1 arc dead with every test green, so the loss announces itself as a working, silent system. And 'stays' is DELETION (#4458), so the source's copy goes too. The merge is a plain union with no semantics to defer, unlike the vocabulary's: the pair plus its connection group IS the primary key, every part of it is a human act, and enrolling twice was already a no-op — so `admin-migrate.ts` restores it inline with `ON CONFLICT DO NOTHING` rather than delegating, and there is no #5036-shaped blocker to wait for. Only the enrollment travels: what it authorized the producer to emit rides separately as `brain_facts`, already reviewed." },
  brain_actor_identity: { decision: "exported", reason: "The human NAME behind each claim's vendor handle (#5440, ADR-0036 §T5's `Amendment (2026-08-25, #5440)`) — the row that turns `slack:U0AQW6KF2EM` into a person, which is what finish condition 2 asks every authoritative claim to carry. `stays` fails in ADR-0039's INVISIBLE direction and does so completely: `admin-migrate.ts` enumerates brain tables explicitly, so a table left out simply does not travel — the bundle imports clean, every count reads fine, and every migrated claim comes out `opaque`. A workspace that could name its authors before the cutover cannot afterwards, with no error anywhere. That is the same argument #5424 used when it refused to let migration strand attribution. All three states travel, each for its own reason: an `atlas` row carries the Better-Auth user id and no name (the destination joins `\"user\"` live, and Better-Auth's tables are global by ADR-0024, so the id resolves there without being carried); a `directory` row carries the dated snapshot, which for someone who has left both the vendor and the company is the ONLY record that will ever name them; and an `opaque` row carrying `erased_at` is an OPERATOR'S ERASURE, which — dropped — the destination's first audience cycle would silently undo, the one outcome an erasure must survive. `snapshot_at` and `erased_at` travel VERBATIM and are never re-stamped at import: they say when the vendor named this person and when a human removed the name, and a destination that re-stamped either would assert a reading it never took — `brain_coverage_snapshot`'s fabrication, which is why THAT table is `stays`. The merge is `ON CONFLICT DO NOTHING`, on `brain_entity`'s reasoning sharpened by one more case: an older arriving snapshot must not overwrite a newer local one, and must not overwrite a local ERASURE. The rows hold the customer's people's names and work emails verbatim, which is `brain_entity`'s asset class (`canonical_surface` is `Acme Corp`) at its most sensitive — and the ADR is explicit that this is not a people directory: nothing may query these rows to FIND a person, they are readable only as the rendering of a specific claim's `actor`, under that claim's own attribution gate. And `stays` is DELETION (#4458), so the source's copy would go in the same move." },
  brain_vocabulary_proposal: { decision: "exported", reason: "The alias queue and its PERMANENT REJECTION MEMORY (#5023, ADR-0037 §6), reclassified from the deferral #5113 closed: both named preconditions have landed (#5035 keys imported facts; #5036 owns the vocabulary merge this memory is ABOUT). The half that cannot re-derive is the decision half — a `rejected` row is a human's decision that two norms are NOT the same slot, and it is exactly the state that stops a producer re-writing what a human removed. 'stays' is DELETION (#4458), so a cutover would destroy it at source while the destination re-proposes the pair and — for a warehouse-derived entity edge — AUTO-APPROVES it, which is precisely the #4507 failure the memory exists to prevent. MERGE RULE, stated against a destination that already holds its own rows (identity is the UNORDERED pair): a pair absent there lands verbatim; the same decision twice is `skipped`; an arriving DECIDED row (approved/rejected) beats a destination `pending` — a decision outranks a queue entry, and the rejected arm is the one that closes #4507 across a migration; two CONTRADICTORY decisions keep the destination's, and the arriving human decision is REFUSED — surfaced with a counter and a per-row log line on `mergeApprovedEdges`' destination-wins reasoning, never silently overwritten. ⚠️ The edge merge (#5036) deliberately does not consult this memory, so a source-approved edge over a destination-rejected pair still lands in section 9; the refusal line here is what surfaces that tension, and `removeAliasEdge` is the destination admin's remedy. `applying` never commits (claim/apply/stamp share one transaction) and is filtered at export anyway; `claimed_at` is a region-local claim token and does not travel. SHIPPED (#5533): a refused arriving decision now travels back as a capped `refusalDetails` payload on the `brainVocabularyProposals` import section, exactly as a refused edge does — the pair, both sides' statuses and the source's reviewer stamps, screened entry-by-entry by `migrate.ts` and persisted to the source's own `region_migrations.vocabulary_proposal_refusals`, which is platform-classified and so outlives the cleanup that deletes the rows it describes. `VocabularyProposalRefusalDetail` has the #5303 treatment (one definition in `@useatlas/schemas` carrying both a `satisfies` and a key-set pin), and the cap contract is stated the same way everywhere: `refusalDetails.length < refused` means truncated, with no separate flag." },
  brain_predicate_cardinality: { decision: "exported", reason: "Cardinality on the canonical predicate (#5027, ADR-0037 §3) — curated human decisions in `brain_vocabulary_edge`'s asset class, reclassified from the deferral #5113 closed: #5035 keys imported facts and #5036 specified the vocabulary merge, the two preconditions the old entry named. The cost of 'stays' was stated there and is now real from the moment a producer runs: a cutover loses the curated `single` entries AND the `rejected` rows that are the producers' memory, so the destination UNDER-supersedes until a human re-authors them — and 'stays' is DELETION (#4458), so the source's copy goes in the same move. The direction the old entry called unaffordable — an entry keying onto the destination's own canonicalization and making an UNRELATED slot destructively supersedable, with no preview — is handled at import rather than deferred: an arriving entry whose `predicate_key` the destination's POST-MERGE predicate closure aliases onto a different norm is REFUSED with a per-row outcome (counted + logged), never re-keyed silently and never applied to the re-canonicalized slot. Refusal is the recoverable direction (under-supersession, repaired by re-authoring at the destination); a silent re-key is not. MERGE RULE on the shared key otherwise follows `brain_vocabulary_proposal`'s: absent lands verbatim, identical decisions are `skipped`, an arriving decision beats a destination `pending`, and two contradictory decisions keep the destination's with the arriving one surfaced as refused. SHIPPED (#5533): refusals here now carry persisted `refusalDetails` too, on `brain_vocabulary_proposal`'s entry above — the key, both sides' values and statuses, the source's reviewer stamps, and on the re-canonicalization arm the destination's own canonical norm (`canonicalHere`), which is that arm's whole re-authoring instruction. Persisted to `region_migrations.predicate_cardinality_refusals`." },
  brain_entity: { decision: "exported", reason: "The entity store's snapshot entries (#5043, ADR-0037 §5) — `surface → stable id` for `subject_cmp`/`object_cmp`, plus the canonical surface the vocabulary edge points at. It LOOKS like `brain_vocabulary_target`, which stays, and the difference is what the re-derivation needs: a closure is a pure function of edges that travel on the same bundle, while an entry is a function of a WAREHOUSE READ the destination cannot repeat until its datasource credentials are re-established and a human re-runs the producer. ⚠️ The ids do NOT travel on the facts, and an earlier version of this entry said they were the decisive reason — they are not: `regionPortableComparable` classifies the `entity:` tag `store-local`, so the importer NULLS `subject_cmp`/`object_cmp` on every entity-valued row, deliberately (T5's correction — a foreign id is counterfeit positive evidence of difference). What the entries actually buy the destination is a BRIDGE: they resolve surfaces by name from the moment the bundle lands until the destination has warehouse credentials again and a human re-runs the producer, which is exactly the window in which nothing else can. The ids in them are digests over the SOURCE workspace, so the first producer run replaces them wholesale. ⚠️ NOT harmless, and an earlier version of this entry said it was: extraction consults the store, so facts written during the bridge window carry the imported ids and the first producer run retires them. At `subject_cmp` a proven difference SUPPRESSES, so the cost is unmatched corroboration — recoverable and invisible; the `object_cmp` question is untraced and recorded rather than asserted (#5233). And because the replacement is keyed on `(workspace_id, entity)`, two regions naming the entity differently leaves both sets live and poisons every shared norm permanently — the run report's `entityEdges.ambiguous` surfaces it on every arm that got far enough to count it, including a FAILED pass that reached the `proposing` phase — only a failure at `store-read` or `planning` reports no count — and #5233's reaper is the fix. And `stays` is DELETION (#4458), so the source's copy goes at the same moment. The rows also hold the customer's own entity names verbatim (`canonical_surface` is `Acme Corp`), which is `brain_vocabulary_edge`'s asset class rather than a cache's. Failure direction if dropped is ADR-0039's invisible one: the cutover reports clean, every lookup abstains, and every test stays green. The merge is a union on `entity_id`, which is a digest of `(workspace, entity, primary key)` — two regions holding one id hold one warehouse row — so `admin-migrate.ts` restores it inline with `ON CONFLICT DO NOTHING` and there is no #5036-shaped blocker. DO NOTHING and not DO UPDATE: an older arriving snapshot must never overwrite a newer local one, or a week-old bundle re-keys the destination's corpus onto a name that has since changed." },

  // ── Stays: caches, derived data, history, region-bound state ───────────────
  // (Deleted from the source region by the #4458 cleanup after the grace period.)
  chat_cache: { decision: "stays", reason: "Response cache PLUS the Slack installation store (AES-GCM-encrypted bot tokens under slack:installation:* keys — region-bound ciphertext; Slack is re-installed in the target per the integrations decision). No org_id column: cache keys have no org dimension, Slack rows scope via value->>'orgId' — #4458 cleanup must scope by that expression, not a column." },
  brain_vocabulary_target: { decision: "stays", reason: "The vocabulary's DERIVED half — the transitive closure of `brain_vocabulary_edge`, which is exported (#5022). Not carried, because ADR-0037 §8 has the import UNION the approved edges and RECOMPUTE the closure: a source closure restored verbatim into a destination that already holds a vocabulary would be a closure of neither. This is the `dashboard_draft_card_cache` case — derived, regenerated at the destination from inputs that do move — so 'stays' destroys nothing, and it is the reading of #5022's 'classify the vocabulary tables exported' that matches §8's own merge. NOTE the deletion ORDER: `fk_brain_vocabulary_target_edge` is RESTRICT, so these rows must go before the edges (see the cleanup rule, which is `expression`-kind for exactly that phase reason)." },
  brain_audience_reverify_attempt: { decision: "stays", reason: "Fair-share scheduling state for the audience re-verifiers (#4971) — 'this audience has had its turn', read by nothing but the scan's ORDER BY. Deliberately NOT the same call as fact_audience_member, which is exported because losing it denies everyone: losing THIS costs the target one uniformly-NULL first cycle, after which token order breaks the tie and rotation re-establishes itself. It carries no membership, no grant and no content, so 'stays' destroys nothing." },
  demo_anonymous_sessions: { decision: "stays", reason: "The anonymous demo principal's ledger (#5604) — one row per minted MCP demo identity, pinned to the demo workspace by `workspace_id`. Region-local telemetry: the token that names a row is minted against, and verified by, one region's process, and the launch-cycle count that reads `created_at` is a count of what THIS region served. Nothing at a destination could use a row from here — the demo workspace is the operator's own and is not a tenant that migrates — so 'stays' destroys nothing that can be used. Deliberately not 'platform': the column IS a workspace scope, and the pinned org-scoped-platform exemption set is for tables that carry the column for attribution only." },
  brain_coverage_snapshot: { decision: "stays", reason: "The Coverage Surface's dated survey-unit roster (#5213, ADR-0041) — one row per channel or (entity, dimension) pair the granted credentials can see. 'stays' because every column is a reading OF THE SOURCE REGION'S credentials at a source-region instant, and the whole statement the page makes is 'as of <date>, of what Atlas's credentials can see'. Carried across, that date would describe a cycle the destination never ran, against scopes the destination's token may not hold — a denominator that looks established and is not, which is the fabrication ADR-0041 refuses. Regenerates on the destination's first successful cycle. Until then NEITHER table has a row, so the class is absent from the coverage read entirely — #5214 owns rendering that as 'never enumerated here', which is the honest reading of a region that has not re-established its vendor credentials. (Note the absent row is a DIFFERENT state from 'enumeration unavailable since <date>', which needs a cycle row carrying a `last_error`; that one is what a live region's failure produces.) NOT the `brain_entity` case, which is exported because an entity entry BRIDGES the window before the destination can re-run its producer: a bridge is only worth carrying when nothing else can answer, and here the honest answer 'we have not looked yet' is available and is better than a stale one. The rows also hold channel names verbatim (`#project-severance`), which is `brain_slack_channel`'s asset class — but that table exports only its EXCLUSION half, the durable human decision, and there is no human decision in this one at all." },
  brain_coverage_cycle: { decision: "stays", reason: "The per-(workspace, class) enumeration record behind the roster above (#5213, ADR-0041) — last attempt, last success, and the map-edge marks. 'stays' for the roster's reason and one more: `last_success_at` is what the page renders in 'as of <date>' and in 'enumeration unavailable since <date>', so carrying it would have the destination assert it looked at a workspace's Slack on a date it did not exist in that region. `degraded_arms` is the same shape one level up — a map edge is a fact about which scopes THIS deployment's token holds. Absent rows are the correct post-migration state: no cycle has run here, and the surface says so." },
  brain_warehouse_entity_success: { decision: "stays", reason: "One row per (workspace, entity, successful warehouse producer run) (#5317) — the input to #5233's entity-store reaper, and nothing else reads it yet. 'stays' for `brain_coverage_cycle`'s reason, sharpened by what the rows AUTHORIZE: each one asserts that Atlas successfully read this workspace's warehouse at a source-region instant, using datasource credentials the destination does not hold until a human re-establishes them. Carried across, the reaper would read a history of successes that never happened HERE and delete `brain_entity` entries the destination has no way to regenerate — a deletion licensed by a fabricated reading, which is the direction #5233 exists to make safe. Absent rows are the correct post-migration state and the SAFE one: no successful run is recorded, so the reach rule has no evidence and reaps nothing until the destination's producer has actually run. NOT the `brain_entity` case beside it, which is exported because an entry BRIDGES the window before the destination can re-run its producer — a bridge is worth carrying when nothing else can answer, and here doing nothing is not merely honest but is the outcome we want." },
  brain_extraction_batch: { decision: "stays", reason: "The in-flight ledger for batched extraction (#5352, migration 0207) — one row per batch submitted to the vendor. 'stays' for the reason `knowledge_sync_state` does, sharpened by what the row POINTS AT: `provider_batch_id` is a handle at Anthropic that only the SOURCE region's key can poll, and the destination's key — the workspace's own on BYO, the region's platform key otherwise — cannot read it. Carried across, the destination's collect phase would poll a handle it has no credentials for, fail, and (past the carried `expires_at`) abandon a batch whose episodes it does not have. Absent rows are the correct post-migration state, and the episode side already agrees BY CONSTRUCTION rather than by coincidence: `export.ts`'s `brain_episodes` projection is an explicit column list that does not name `extraction_batch_id`, so an episode that was in flight at export time arrives unstamped and unpointed and simply re-drains in the destination. That is the whole recovery, with no repair verb. What is lost is the source region's outstanding batch spend — one tick's worth of extraction — and no claim goes with it, because nothing in an in-flight batch was ever stamped. ⚠️ If that projection is ever widened to `SELECT *`, this row must become `exported` or the import will violate `fk_brain_episodes_extraction_batch`." },
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
  plugin_grant_revocation_failures: { decision: "stays", reason: "Operator worklist of failed onUninstall revocations (#3777). The un-revoked grants were provisioned by THIS region's installs (which stay), and the origin operator is the one who can still act on them — a row exported to the target region points at nothing it can revoke." },
  integration_credentials: { decision: "stays", reason: "Per-region ciphertext (INTEGRATION_TABLES) — customer re-connects the integration." },
  twenty_integrations: { decision: "stays", reason: "Per-region ciphertext (INTEGRATION_TABLES) — customer re-connects." },
  workspace_action_credentials: { decision: "stays", reason: "Per-region ciphertext (INTEGRATION_TABLES) — the workspace's own action-target credentials (#3766, ADR-0046); the admin re-enters them in the target, same as every other credentialed integration. Workspace-keyed, so NOT the `operator_integration_credentials` platform case one tier up." },
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

// ═════════════════════════════════════════════════════════════════════
// Better Auth tables (#5515) — the half the schema enumeration misses.
// ═════════════════════════════════════════════════════════════════════
//
// The header above says Better-Auth tables "never enter this registry", and
// that was the blind spot: nothing ENFORCED that their absence was a decision
// rather than an omission, so the 1.7 `scim*` catalog (#5505) — nine tables,
// several carrying customer names and emails verbatim — was invisibly absent
// from both this registry and the purge one. This block makes the class
// explicit: one entry per Better Auth table, enforced complete against the
// live plugin roster by `lib/db/__tests__/better-auth-purge-scope.test.ts`
// (the same tripwire that covers `BETTER_AUTH_PURGE_DECISIONS`).
//
// The decisions reuse this file's vocabulary. None is `exported` — nothing
// here rides the bundle, so `export.ts` needs no new sections:
//
// - `platform` — the global auth spine (ADR-0024): identity, sessions,
//   credentials, OAuth/agent infrastructure. Region migration re-establishes
//   these by re-authentication, not by data movement.
// - `stays` — the `scim*` catalog, on `sso_providers`/`scim_group_mappings`'
//   exact reasoning: directory-sync config and its provisioned projections
//   follow the IdP connection, which is re-created in the target region (the
//   admin mints a fresh token, the IdP re-syncs, the projections rebuild).
//   Carrying them would land credential digests and sync state that no
//   target-region connection owns.
//
// `subscription` is deliberately absent here for the same reason it is absent
// from BETTER_AUTH_PURGE_DECISIONS: it is mirrored into `db/schema.ts`, so it
// already carries its decision in BUNDLE_TABLE_DECISIONS above (`platform`).

export const BETTER_AUTH_BUNDLE_DECISIONS = {
  organization: { decision: "platform", reason: "The org row is the global auth spine's anchor (ADR-0024) — region routing reads it, so it must not ride a bundle that presumes it." },
  member: { decision: "platform", reason: "Membership — auth spine." },
  invitation: { decision: "platform", reason: "Pending invitations — auth spine; short-lived." },
  user: { decision: "platform", reason: "Identity is global (ADR-0024); users are not moved per-workspace." },
  session: { decision: "platform", reason: "Live sessions are region-local by construction; users re-authenticate against the target." },
  account: { decision: "platform", reason: "Credential/OAuth account rows — auth spine." },
  twoFactor: { decision: "platform", reason: "TOTP secrets follow the user, not the workspace." },
  passkey: { decision: "platform", reason: "WebAuthn credentials follow the user." },
  verification: { decision: "platform", reason: "Transient TTL token store." },
  apikey: { decision: "platform", reason: "API keys are minted against a region's host and die with their member binding; re-minted in the target." },
  jwks: { decision: "platform", reason: "Region signing keys — must NOT move between regions." },
  oauthClient: { decision: "platform", reason: "DCR clients re-register against the target region's issuer." },
  oauthResource: { decision: "platform", reason: "Config-seeded resource registrations, rebuilt at boot." },
  oauthClientResource: { decision: "platform", reason: "Follows oauthClient/oauthResource — both platform." },
  oauthAccessToken: { decision: "platform", reason: "Tokens are issuer-bound and TTL'd; never portable across regions." },
  oauthRefreshToken: { decision: "platform", reason: "Same issuer-bound argument as access tokens." },
  oauthConsent: { decision: "platform", reason: "Consent is per-issuer; re-granted in the target." },
  oauthClientAssertion: { decision: "platform", reason: "JTI replay guard — transient." },
  deviceCode: { decision: "platform", reason: "Minutes-TTL device-flow codes — transient." },
  agentHost: { decision: "platform", reason: "Agent enrollments are user-keyed auth spine; re-enrolled against the target." },
  agent: { decision: "platform", reason: "Follows agentHost." },
  agentCapabilityGrant: { decision: "platform", reason: "Follows agent." },
  approvalRequest: { decision: "platform", reason: "Transient CIBA approval state." },
  scimManagedConnection: { decision: "stays", reason: "Directory-sync connection config — `sso_providers`' reasoning: re-created in the target, where the admin mints a fresh credential for the IdP." },
  scimManagedCredential: { decision: "stays", reason: "HMAC digests under the source region's derivation — credential material is never bundled (the `knowledge_sync_credentials` rule, one secret scheme over)." },
  scimManagedConnectionEvent: { decision: "stays", reason: "Audit trail of a connection that does not move." },
  scimConnectionBinding: { decision: "stays", reason: "Plugin lifecycle state for a connection that does not move." },
  scimIdentityTombstone: { decision: "stays", reason: "Deprovisioning tombstones are records of what the SOURCE region's connection did; the target's fresh connection starts with none." },
  scimUser: { decision: "stays", reason: "Provisioned-user projections rebuild from the IdP's own re-sync against the target's fresh connection — the IdP is the source of truth, so carrying a projection would race it." },
  scimProjectionGrant: { decision: "stays", reason: "Follows scimUser — rebuilt by the re-sync." },
  scimGroup: { decision: "stays", reason: "Group projections rebuild from the IdP re-sync, like scimUser." },
  scimGroupMember: { decision: "stays", reason: "Follows scimGroup/scimUser." },
  scimSubject: { decision: "platform", reason: "Per-user cross-domain SCIM subject record — follows the user (global spine), not any one workspace's connection." },
} satisfies Readonly<Record<string, BundleTableScope>>;
