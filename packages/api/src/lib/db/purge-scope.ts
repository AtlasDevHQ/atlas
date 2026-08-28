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
 *   expression rather than a parent (see its entry). Since #5176 the SET is
 *   derived rather than declared here — each of those entries carries a
 *   `viaParent`, and `ViaParentTableName` computes the union from them. The
 *   names above are a reading aid and are still hand-written; trust the
 *   declarations, not this sentence.
 *   Several SCOPED tables would cascade
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

/**
 * How a table with NO scope column of its own is reached: through its parent's
 * rows, by subquery.
 *
 * This declaration is the ONLY copy of the child→parent relation (#5176). It was
 * written three independent times — as SQL subqueries in `hardDeleteWorkspace`,
 * as an ordering constraint in `purge-scope.test.ts`, and as a lookup map in
 * `hard-delete-purge-pg.test.ts` — and each copy was internally self-consistent,
 * so a drifted one still passed its own suite. That is the "fixtures that agree
 * by construction" shape: nothing forced the three to agree with each other.
 * All three now read this.
 */
export interface PurgeParentLink {
  /** The child column holding the parent's key. */
  readonly column: string;
  /** The parent table. */
  readonly parent: string;
  /** The parent column the child points at. */
  readonly parentKey: string;
  /** The PARENT's workspace scope column — this is what `$1` is matched against. */
  readonly parentScope: WorkspaceScopeColumn;
  /**
   * True when `parentKey` is NULLABLE, which makes the subquery add
   * `AND <parentKey> IS NOT NULL`.
   *
   * ⚠️ NOT for the DELETE's sake — `x IN (NULL, 'a')` is still TRUE for `'a'`,
   * so a NULL in the list changes nothing there (it is `NOT IN` that three-valued
   * logic breaks). The exclusion is load-bearing for the OTHER consumer of this
   * subquery: the #3468 tombstone INSERT, whose `stripe_purged_subscriptions
   * .stripe_subscription_id` is a PRIMARY KEY and therefore NOT NULL. A
   * subscription row with no Stripe id would abort that INSERT — `ON CONFLICT`
   * covers unique violations, not not-null ones — and take the whole purge
   * transaction with it.
   */
  readonly parentKeyNullable?: boolean;
  /**
   * FURTHER workspace-scoped sources of the same key values, UNIONed into
   * `parentKeySubquery` (#5269).
   *
   * The parent is not always the only place a workspace's keys are recorded,
   * and a child row whose parent row never existed — or was removed before the
   * purge — is reachable from nowhere else. See the `stripe_webhook_events`
   * entry for the case this exists for, and for why the obvious second source
   * was the wrong one.
   */
  readonly additionalKeySources?: readonly PurgeKeySource[];
}

/**
 * A second table that records key values belonging to a workspace.
 *
 * Unlike `PurgeParentLink` this is NOT a parent: nothing about it constrains
 * delete ORDER, because it is read for its ids and is not itself required to
 * survive, to be deleted, or to be deleted in any particular position. What it
 * MUST be is workspace-scoped — a source with no `$1` predicate would union in
 * other tenants' ids and turn a per-workspace purge into a cross-tenant delete,
 * which is exactly what ruled out the obvious candidate in
 * `stripe_webhook_events`'s entry.
 *
 * There is no `nullable` flag: `keyColumn IS NOT NULL` is applied
 * unconditionally. A NULL contributes nothing to the `IN (…)` this feeds and
 * would abort the #3468 tombstone INSERT it also feeds, so there is no reading
 * on which including one is correct — see `parentKeyNullable` just above for
 * why that INSERT is the consumer that decides this.
 */
export interface PurgeKeySource {
  /**
   * The table holding the ids.
   *
   * Deliberately `string`, unlike `scopeColumn`. A hand-written union of table
   * names would be a FOURTH copy of the schema's table list — the exact
   * duplication #5176 removed — and it would not even help: it admits a
   * wrong-but-real table name as readily as `string` does.
   *
   * Deriving one from `schema.ts` would drag `drizzle-orm` into every consumer of
   * this otherwise zero-import data file. Existence is
   * checked instead by the schema enumeration in `purge-scope.test.ts`, which is
   * derived and therefore stronger than any hand-maintained union.
   */
  readonly table: string;
  /** The column holding the child's key value. */
  readonly keyColumn: string;
  /**
   * That table's workspace scope column — this is what `$1` is matched against.
   *
   * Typed, NOT `string`. This is the field whose failure mode is a cross-tenant
   * DELETE plus a permanent tombstone on another tenant's live subscription ids,
   * and the closed set of legal values is declared in this same file — so the
   * compiler can refuse a wrong one outright rather than a test catching it.
   * `parentScope` carries the same type for the same reason, though its failure
   * mode is the gentler one (a subquery matching nothing, leaving residue).
   */
  readonly scopeColumn: WorkspaceScopeColumn;
}

interface PurgeTableScopeBase {
  /** Why this decision is correct — required, non-empty. */
  readonly reason: string;
}

interface PurgedTableScope extends PurgeTableScopeBase {
  readonly decision: "purged";
  /**
   * Present only on `purged` tables with no scope column of their own. It
   * supplies the relation `delViaParent(<table>)` builds its subquery from — the
   * call site is still explicit, and `purge-scope.test.ts` fails a declaration
   * with no call, so this alone does not purge anything. It is also the ORDER
   * constraint: the child must be deleted before the
   * parent, or the subquery finds no parent rows and the child is silently left
   * behind — no error, no count, exactly the shape of #5160's original bug.
   */
  readonly viaParent?: PurgeParentLink;
}

interface UnpurgedTableScope extends PurgeTableScopeBase {
  readonly decision: Exclude<PurgeDecision, "purged">;
  /**
   * Never present. Declared as `undefined` rather than omitted for two reasons:
   * it makes `entry.viaParent` readable across the union without narrowing, and
   * it makes a stray declaration on a non-purged table a compile error at the
   * registry's own `satisfies`.
   *
   * `user_trial_grants` is `retained` precisely so it SURVIVES the purge, and a
   * `viaParent` on it would read as a route to delete it through a parent — the
   * one decision this registry exists to make deliberate.
   */
  readonly viaParent?: undefined;
}

/**
 * A table's purge decision. Discriminated on `decision` so `viaParent` — which
 * only means anything for a table the purge DELETEs — cannot be attached to a
 * `retained`, `anonymized`, `user_scoped` or `platform` entry.
 */
export type PurgeTableScope = PurgedTableScope | UnpurgedTableScope;

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

/**
 * A column name that makes a row workspace-scoped, as a type.
 *
 * Used by `PurgeParentLink.parentScope` and `PurgeKeySource.scopeColumn`, so
 * "the value `$1` is compared against is a workspace scope column" is a compile
 * error to get wrong rather than a runtime assertion. It reads the tuple above,
 * so the two cannot disagree.
 */
export type WorkspaceScopeColumn = (typeof WORKSPACE_SCOPE_COLUMNS)[number];

/** Column names that make a table user-scoped rather than workspace-scoped. */
export const USER_SCOPE_COLUMNS = ["user_id", "userId"] as const;

export const PURGE_TABLE_DECISIONS = {
  // ── Purged: explicit DELETE FROM in hardDeleteWorkspace ───────────────────

  // Chat + agent pillar
  conversations: { decision: "purged", reason: "Core chat pillar — the conversation rows themselves." },
  messages: { decision: "purged", reason: "Message bodies: the highest-volume carrier of customer prose. Cascades from conversations too, but deleted explicitly as a completeness guarantee for deployments predating the FK.", viaParent: { column: "conversation_id", parent: "conversations", parentKey: "id", parentScope: "org_id" } },
  slack_threads: { decision: "purged", reason: "Chat-adapter thread mapping. No scope column — deleted via a conversation_id subquery, since there is no FK to cascade from.", viaParent: { column: "conversation_id", parent: "conversations", parentKey: "id", parentScope: "org_id" } },
  agent_runs: { decision: "purged", reason: "Per-turn durable checkpoints (ADR-0020) whose `transcript` column holds the full agent trace — verbatim customer prose and query results. Cascades from conversations, but carries org_id, so it is deleted explicitly." },
  agent_session_memory: { decision: "purged", reason: "Long-lived durable working memory (ADR-0020) — model-authored notes about the workspace's data. Cascades from conversations; carries org_id, so explicit." },

  // Company Atlas / brain pillar (ADR-0036/0037) — the #5160 headline gap.
  // NOTE the DELETE ORDER, which is load-bearing: brain_facts→brain_episodes
  // is RESTRICT and brain_vocabulary_target→brain_vocabulary_edge is RESTRICT,
  // so the referencing side must go first or the purge transaction aborts.
  brain_edges: { decision: "purged", reason: "The typed provenance/conflict graph (ADR-0036). Deleted first — it references both facts and episodes." },
  brain_facts: { decision: "purged", reason: "Tier-2 claims (ADR-0036): subject/predicate/object retained VERBATIM, extracted from Slack history, Zoom transcripts and Outlook mail. The single most sensitive table in the internal DB, and the table `schema.ts` documents as bi-temporal invalidate-never-delete — which is why the purge was for a long time the only mechanism that could remove it. #5344 added the second and narrower one (the observation reaper, `lib/brain/observation-reap.ts`), which may only ever reach unreviewed warehouse readings; a BELIEF is still removable only here. Must precede brain_episodes (RESTRICT FK)." },
  brain_episodes: { decision: "purged", reason: "Tier-3 raw evidence (ADR-0036) — the source excerpts claims were extracted from. Deleted after brain_facts, which references it under RESTRICT." },
  brain_extraction_batch: { decision: "purged", reason: "The in-flight ledger for batched extraction (#5352, migration 0207). Holds no customer content — a vendor batch handle, a model id, a count — but `brain_episodes` points AT it under a composite FK, so it must be deleted AFTER brain_episodes or the purge transaction aborts; that ordering is the reason it sits here rather than beside the other content-free brain records. `brain_audience_reverify_attempt`'s rule applies on top: a purged workspace leaves no scheduling residue, and an inherited in-flight row would have a re-created org's collect phase polling a vendor batch belonging to a workspace that no longer exists — and, on a shared platform key, one whose results would then be reconciled into the new org." },
  brain_vocabulary_edge: { decision: "purged", reason: "The curated identity vocabulary's durable half (ADR-0037 §6/§8) — human-approved alias decisions over workspace entity names. Deleted after brain_vocabulary_target, which references it under RESTRICT." },
  brain_vocabulary_target: { decision: "purged", reason: "The vocabulary's derived closure (ADR-0037 §8). Derived, but derived FROM customer entity names and holding them verbatim, so it is purged rather than left to regenerate. Must precede brain_vocabulary_edge (RESTRICT FK)." },
  brain_vocabulary_proposal: { decision: "purged", reason: "The alias queue and its rejection memory (#5023) — carries proposed norms lifted from customer data plus the reviewing user's decision." },
  brain_predicate_cardinality: { decision: "purged", reason: "Curated cardinality on canonical predicates (#5027, ADR-0037 §3), keyed by predicate_key — a workspace-specific vocabulary artifact." },
  brain_slack_channel: { decision: "purged", reason: "The brain's Slack ingest scope (#5203). Carries channel NAMES and ids verbatim — `#project-severance` is customer data on its own, which is the whole reason `oversight.ts` has a label policy — plus `excluded_by`, the user id of whoever narrowed the scope. Purged rather than retained: nothing here is needed after the workspace is gone, and a re-created org must not inherit another org's channel list." },
  brain_slack_ingest_scope: { decision: "purged", reason: "The per-workspace reconcile state (#5203) — `legacy_channels` is the pre-retirement channel id list, same content class as the row above. No FK in either direction, so no ordering constraint against `brain_slack_channel`." },
  brain_enrollment: { decision: "purged", reason: "The `(entity, dimension)` pairs a human named as the warehouse producer's reach (#5196, ADR-0039). Carries the workspace's own semantic-layer entity and column names verbatim — `accounts`/`arr_band` describes the customer's business exactly as `brain_slack_channel`'s channel names do — plus `enrolled_by`, the user id of whoever authorized the Atlas to hold claims about that pair. No FK in either direction, so no ordering constraint; purged rather than retained so a re-created org cannot inherit another org's reach and start emitting against it." },
  brain_entity: { decision: "purged", reason: "The entity store's snapshot entries (#5043, ADR-0037 §5) — `canonical_surface` holds the customer's own entity names verbatim (`Acme Corp`), which is exactly what `brain_vocabulary_edge` is purged for, and `key_surface` holds their warehouse primary keys. Derived from a warehouse read rather than authored, but derived FROM customer data and holding it verbatim, which is the `brain_vocabulary_target` test and it fails it on the retain side. No FK in either direction — the ids reach `brain_facts` as `subject_cmp`/`object_cmp` VALUES, never as a join arm — so no ordering constraint. Purged rather than left to regenerate so a re-created org cannot inherit another org's entity names, and because the producer that would regenerate them needs a datasource connection the new org does not have." },
  brain_audience_reverify_attempt: { decision: "purged", reason: "Fair-share scheduling state for the audience re-verifiers (#4971). Carries no content, but is keyed by workspace_id and audience_id, and a purged workspace must leave no scheduling residue for a re-created org to inherit." },
  brain_coverage_snapshot: { decision: "purged", reason: "The Coverage Surface's dated survey-unit roster (#5213, ADR-0041). Carries channel NAMES verbatim in `unit_label` and the workspace's own entity and column names in the warehouse rows — `brain_slack_channel`'s and `brain_enrollment`'s asset class exactly, and both are purged. The counts alone would already fail the test: a roster of ids is a map of a customer's Slack workspace. No FK in either direction, so no ordering constraint. Purged rather than left to regenerate so a re-created org cannot inherit another org's channel roster, and because the cycle that would regenerate it needs vendor credentials the new org does not have — which would leave the inherited rows standing, dated, and read as current." },
  brain_coverage_cycle: { decision: "purged", reason: "The per-(workspace, class) enumeration record (#5213, ADR-0041). Holds no customer content, but `last_error` carries vendor-facing text about the workspace's own connection and `last_success_at` is what the page renders as 'as of <date>' — a re-created org inheriting it would be told Atlas enumerated its sources on a date before it existed. `brain_audience_reverify_attempt`'s rule: a purged workspace leaves no scheduling residue." },
  brain_warehouse_entity_success: { decision: "purged", reason: "One row per (workspace, entity, successful warehouse producer run) (#5317). Holds no customer content in its VALUES, but `entity` is the workspace's own semantic-layer entity name verbatim (`accounts`, `arr_band`) — exactly `brain_enrollment`'s asset class, and that is purged for it. `brain_audience_reverify_attempt`'s rule applies on top: a purged workspace leaves no scheduling residue, and this record is what #5233's reaper schedules against, so a re-created org inheriting it would license reaping `brain_entity` rows against runs that happened before it existed. No FK in either direction — nothing joins it yet, because this slice adds no reader — so no ordering constraint." },
  brain_actor_identity: { decision: "purged", reason: "The human NAME behind each claim's vendor handle (#5440, ADR-0036 §T5). `display_name`, `real_name` and `email` hold the customer's own people verbatim — including people who are NOT Atlas users and never agreed to anything, which makes it the most sensitive personal data in the internal DB per row. `fact_audience_member` is purged for holding resolved identities; this holds the identities AND the names AND the addresses, so the same call is easier here rather than harder. No FK in either direction — the join to `brain_facts` is `provenance ->> 'actor'` to `actor`, a VALUE join with no constraint — so no ordering constraint against the brain tables above. Purged rather than left to regenerate for `brain_entity`'s reason, sharpened: a re-created org must not inherit another org's people, and the capture pass that would regenerate these needs a Slack connection the new org does not have. ⚠️ This DELETES erasure tombstones along with the names, which is safe only because it deletes the CLAIMS too — nothing survives for a re-captured name to attach to. If a future purge ever spares `brain_facts`, this entry has to be revisited first." },
  fact_audience_member: { decision: "purged", reason: "Audience membership backing the `audience:` ACL arm (ADR-0036) — resolved identities (email-join, SSO-domain narrowing), so squarely personal data." },

  // Knowledge Base pillar (ADR-0028) — the #5160 headline gap's other half.
  knowledge_documents: { decision: "purged", reason: "Every ingested KB document: bodies + frontmatter. Named in #5160 alongside the brain tables." },
  knowledge_links: { decision: "purged", reason: "The KB link graph. No scope column — deleted via a source_document_id subquery before its parent, rather than relying on the cascade.", viaParent: { column: "source_document_id", parent: "knowledge_documents", parentKey: "id", parentScope: "workspace_id" } },
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
  suggestion_user_clicks: { decision: "purged", reason: "Per-user click telemetry on suggestions. No scope column — deleted via a suggestion_id subquery before its parent.", viaParent: { column: "suggestion_id", parent: "query_suggestions", parentKey: "id", parentScope: "org_id" } },

  // Dashboards (ADR-0029/0034)
  dashboards: { decision: "purged", reason: "Dashboard definitions and their parameters." },
  dashboard_cards: { decision: "purged", reason: "Cards including `cached_columns`/`cached_rows` — snapshots of actual query RESULTS, i.e. customer data at rest in the internal DB.", viaParent: { column: "dashboard_id", parent: "dashboards", parentKey: "id", parentScope: "org_id" } },
  dashboard_user_drafts: { decision: "purged", reason: "Per-user drafts are content under the draft-first model (ADR-0029/0034). No scope column — deleted via a dashboard_id subquery.", viaParent: { column: "dashboard_id", parent: "dashboards", parentKey: "id", parentScope: "org_id" } },
  dashboard_draft_card_cache: { decision: "purged", reason: "Cached draft-card RESULTS — customer data, not just layout. No scope column; deleted via a dashboard_id subquery before its parents.", viaParent: { column: "dashboard_id", parent: "dashboards", parentKey: "id", parentScope: "org_id" } },

  // Prompts
  prompt_collections: { decision: "purged", reason: "Starter-prompt collections authored for the workspace." },
  prompt_items: { decision: "purged", reason: "The prompt text itself. No scope column — deleted via a collection_id subquery.", viaParent: { column: "collection_id", parent: "prompt_collections", parentKey: "id", parentScope: "org_id" } },
  user_favorite_prompts: { decision: "purged", reason: "Per-user favourited prompt text, scoped by org_id. Previously unpurged despite carrying both a user id and customer-authored prose." },

  // Scheduling
  scheduled_tasks: { decision: "purged", reason: "Task definitions including their prompt text and delivery targets." },
  scheduled_task_runs: { decision: "purged", reason: "Run history. No scope column — deleted via a task_id subquery.", viaParent: { column: "task_id", parent: "scheduled_tasks", parentKey: "id", parentScope: "org_id" } },

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
  stripe_webhook_events: { decision: "purged", reason: "Webhook dedupe-ledger rows for the subscription ids that belonged to this workspace, matched via a UNION of two workspace-scoped sources and deleted in the same statement that tombstones those ids. #5269 asked that the choice between widening this delete and accepting the residue be RECORDED rather than made by omission; it is widened. THE ORPHAN: the table declares no FK to `subscription` by design — webhook handlers may see an event before the subscription row syncs — so a ledger row whose subscription row never existed for this org was matched by neither the delete nor the #3468 tombstone, and the response still reported `complete: true`. NOT `stripe_purged_subscriptions`, which #5269 named as the obvious second source: it carries no org column (schema.ts), so 'tombstoned FOR THIS ORG' is not expressible from it, and the rows it does hold for this org are inserted from the very subquery the delete already uses — an identical id set. What remains in it belongs to OTHER purged workspaces, so matching on it would be a cross-tenant delete. `stripe_teardown_pending` works because it is keyed on `workspace_id` and `detectCustomerSubscriptionDrift` (#3679) enqueues subscriptions live in Stripe with no local `subscription` row — the ids that go missing — before this cascade runs. ACCEPTED RESIDUE, two classes, because drift detection is gated on `!hasActiveLocalSubscription(rows) && stripeCustomerId` (workspace-teardown.ts): an orphan already terminal in Stripe at teardown, and an orphan alongside an ACTIVE local subscription, which never reaches drift detection at all. Both are billing bookkeeping rather than a DPA gap — the columns are event_id, event_type, stripe_subscription_id and applied_plan_tier, no personal data — and `pruneStripeEventLedger` removes them after STRIPE_EVENT_LEDGER_RETENTION_DAYS (30).", viaParent: { column: "stripe_subscription_id", parent: "subscription", parentKey: "stripeSubscriptionId", parentScope: "referenceId", parentKeyNullable: true, additionalKeySources: [{ table: "stripe_teardown_pending", keyColumn: "stripe_sub_id", scopeColumn: "workspace_id" }] } },

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

/**
 * How much of a `viaParent` declaration the builders should honour.
 *
 * `omitSources` drops named `additionalKeySources` from the generated SQL, for
 * the one case where a source's relation is ABSENT from a drifted region (#5269
 * review). A source is an OPTIONAL widening, not a delete target: reading it
 * cannot be a precondition for erasing a workspace's data, because its absence
 * only returns the purge to its pre-widening — correct but incomplete — reach.
 * Letting a missing billing outbox refuse a GDPR erasure outright is the worse
 * of the two failures, so the caller probes and degrades instead.
 */
export interface KeySourceOptions {
  readonly omitSources?: readonly PurgeKeySourceTableName[];
}

/**
 * Every table declared as an `additionalKeySources` entry anywhere in the
 * registry, as a literal union.
 *
 * `omitSources` was `readonly string[]`, and the intuition that a typo there
 * fails safe is INVERTED for the only caller that exists: the option is
 * populated exclusively on the branch where the relation is known ABSENT, so a
 * name that matches nothing keeps the wide subquery and emits SQL against a
 * missing relation — 42P01, and the erasure refused outright, which is the very
 * failure the degrade was added to prevent. Derived rather than hand-written so
 * it cannot become a second copy of the declarations.
 */
export type PurgeKeySourceTableName = {
  [K in keyof typeof PURGE_TABLE_DECISIONS]: (typeof PURGE_TABLE_DECISIONS)[K] extends {
    readonly viaParent: { readonly additionalKeySources: readonly { readonly table: infer T }[] };
  }
    ? T
    : never;
}[keyof typeof PURGE_TABLE_DECISIONS];

/**
 * The `purged` tables reached through a parent subquery — the keys carrying a
 * `viaParent` declaration, as a literal union.
 *
 * `hardDeleteWorkspace`'s `delViaParent()` takes this rather than `string`, so a
 * call naming a table with no declaration does not compile and cannot fall back
 * to an undefined link at runtime.
 */
export type ViaParentTableName = {
  [K in keyof typeof PURGE_TABLE_DECISIONS]: (typeof PURGE_TABLE_DECISIONS)[K] extends {
    readonly viaParent: PurgeParentLink;
  }
    ? K
    : never;
}[keyof typeof PURGE_TABLE_DECISIONS];

/**
 * The subquery that selects a parent's keys for the purged workspace, with `$1`
 * bound to the org id.
 *
 * Exported for `purge-scope.test.ts`, which asserts the emitted subquery scopes
 * every key source to `$1`. Both in-file builders read it, so a table's key set is
 * defined once — a fourth hand-written copy of the subscription relation is exactly
 * what #5176 removed.
 *
 * Takes a registry KEY, not a link. Both builders interpolate identifiers into
 * SQL, and taking the key means the only values they can ever interpolate are
 * `as const` literals from this file — the injection state is unrepresentable
 * rather than rejected. An earlier version took the link and validated it with a
 * runtime regex; that guard was measured to be unreachable from anywhere in the
 * tree (neutering it left every suite green), which makes it exactly the
 * "deletable with zero test failures" shape #5176 is about.
 */
export function parentKeySubquery(table: ViaParentTableName, opts: KeySourceOptions = {}): string {
  const link: PurgeParentLink = PURGE_TABLE_DECISIONS[table].viaParent;
  const notNull = link.parentKeyNullable ? ` AND "${link.parentKey}" IS NOT NULL` : "";
  const fromParent = `SELECT "${link.parentKey}" FROM "${link.parent}" WHERE "${link.parentScope}" = $1${notNull}`;
  // A UNION rather than a second statement, so every consumer widens together
  // (#5269). Splitting the extra ids into their own DELETE would leave the
  // tombstone INSERT reading the narrow set, and the invariant
  // `tombstoneAndDeleteViaParentSql` documents — the tombstone records exactly the
  // ids whose child rows are removed — would break silently, one webhook later.
  //
  // `UNION` (not `UNION ALL`) because the sources overlap by design: a
  // subscription that is both live locally and pending teardown appears in
  // both, and the tombstone's PRIMARY KEY has no interest in the duplicate.
  const fromExtras = (link.additionalKeySources ?? [])
    // `omitSources` is typed to the declared source names, but `source.table` is
    // `string` (see `PurgeKeySource.table`), so the membership test is widened
    // rather than the option. The narrowing that matters happens at the CALLER,
    // where an undeclared name is now a compile error.
    .filter((source) => !(opts.omitSources as readonly string[] | undefined ?? []).includes(source.table))
    .map(
      (source) =>
        `SELECT "${source.keyColumn}" FROM "${source.table}" ` +
        `WHERE "${source.scopeColumn}" = $1 AND "${source.keyColumn}" IS NOT NULL`,
    );
  return [fromParent, ...fromExtras].join(" UNION ");
}

/**
 * The DELETE for a table reached through its parent, including `RETURNING 1` so
 * the caller can count rows.
 *
 * Identifiers are quoted unconditionally. For the snake_case names that is a
 * no-op; for `subscription`'s camelCase Better-Auth columns it is required, and
 * one uniform rule beats a per-name judgement in a string builder. Quoting is
 * not escaping — see `parentKeySubquery` for why taking the key rather than a
 * link is what makes that safe.
 *
 * There is no room in this template for a status/kind/state predicate, which is
 * the narrowing `purge-scope.test.ts` forbids for every DELETE but `chat_cache`'s
 * expression scope: a purge must remove ALL of a workspace's rows in a table,
 * not the ones in one state.
 */
export function viaParentDeleteSql(table: ViaParentTableName, opts: KeySourceOptions = {}): string {
  const link: PurgeParentLink = PURGE_TABLE_DECISIONS[table].viaParent;
  return `DELETE FROM "${table}" WHERE "${link.column}" IN (${parentKeySubquery(table, opts)}) RETURNING 1`;
}

/**
 * ONE statement that tombstones a workspace's key values and deletes the child
 * rows holding them, over a single evaluation of the id set (#5269 review).
 *
 * ⚠️ THIS EXISTS BECAUSE "BOTH CONSUMERS READ ONE DECLARATION" WAS NOT ENOUGH.
 * The tombstone INSERT and the ledger DELETE were two statements built from the
 * same `parentKeySubquery`, which made their SQL TEXT identical but not their
 * RESULT: under READ COMMITTED each takes its own snapshot, and
 * `stripe_teardown_pending` has concurrent writers (`enqueueStripeTeardownOps`
 * inserts, the reconcile sweep deletes). A row appearing between the two
 * statements lands in the DELETE's set but not the tombstone's — so the ledger
 * row is removed with no tombstone, and the next cancellation webhook regrows
 * exactly the row #3468 exists to prevent. Silent, post-commit, and invisible to
 * the purge response.
 *
 * Every sub-statement in a `WITH` runs against one snapshot, so the tombstone's id
 * set and the delete's cannot diverge. That turns the invariant above — *the
 * tombstone records exactly the ids whose child rows are removed* — from an
 * argument into a property of the statement. It also removes
 * the ordering dependency the call site used to have to explain in prose, and the
 * `KeySourceOptions` hazard of handing two builders different options: there is
 * one builder and one call.
 *
 * Returns a single row: `removed_count` (the child rows deleted) and
 * `tombstoned_ids` (the ids newly stamped — `ON CONFLICT DO NOTHING` means
 * previously-tombstoned ids are absent, which is what makes it an attribution of
 * THIS purge's writes rather than a re-listing of the table).
 *
 * `tombstoneRelation` is typed to the one literal it may ever be, so this stays
 * inside the same "only `as const` literals from this file reach the
 * interpolation" guarantee as its siblings.
 */
export function tombstoneAndDeleteViaParentSql(
  table: ViaParentTableName,
  tombstoneRelation: "stripe_purged_subscriptions",
  tombstoneColumn: "stripe_subscription_id",
  opts: KeySourceOptions = {},
): string {
  const link: PurgeParentLink = PURGE_TABLE_DECISIONS[table].viaParent;
  return (
    `WITH ids AS (${parentKeySubquery(table, opts)}), ` +
    `tombstoned AS (` +
    `INSERT INTO "${tombstoneRelation}" ("${tombstoneColumn}") SELECT * FROM ids ` +
    `ON CONFLICT ("${tombstoneColumn}") DO NOTHING RETURNING "${tombstoneColumn}"` +
    `), ` +
    `removed AS (` +
    `DELETE FROM "${table}" WHERE "${link.column}" IN (SELECT * FROM ids) RETURNING 1` +
    `) ` +
    `SELECT (SELECT count(*) FROM removed)::int AS removed_count, ` +
    `(SELECT coalesce(array_agg("${tombstoneColumn}"), ARRAY[]::text[]) FROM tombstoned) AS tombstoned_ids`
  );
}

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

// ═════════════════════════════════════════════════════════════════════
// Better Auth tables (#5515) — the registry the schema enumeration
// CANNOT reach.
// ═════════════════════════════════════════════════════════════════════
//
// `purge-scope.test.ts` enumerates the Drizzle schema, and Better Auth
// tables are absent from `db/schema.ts` by design (their DDL is owned by
// better-auth's schema-diff auto-migrate, which runs on every boot before
// the Atlas runner). So the #5160 tripwire never sees them, and the 1.7
// `scim*` catalog (#5505) arrived with zero entries in either registry and
// nothing failing — the blind spot #5515 is about. This registry is the
// closure: `better-auth-purge-scope.test.ts` enumerates the LIVE plugin
// roster via `getAuthTables({ plugins: buildPlugins() })` — the same
// source better-auth's own migrator reads — and fails when a table appears
// with no entry here, so the next plugin bump that adds a table breaks CI
// instead of quietly surviving a GDPR purge.
//
// Decision semantics (deliberately NOT the Drizzle registry's set —
// these tables have different reachability mechanics):
//
// - `purged` — `hardDeleteWorkspace` issues an explicit workspace-scoped
//   DELETE. For the plugin-owned `scim*` relations the DELETE is gated on
//   a to_regclass presence probe, because they exist only where EE SCIM
//   has been enabled: an absent class means "never enabled — nothing to
//   purge", NOT an incomplete purge, which is why they do not ride
//   `tableExists` (whose absence semantics are region drift).
// - `user_scoped` — keyed on a user id. `orphanArm` names the mechanism:
//   `"explicit-delete"` is a statement in the orphaned-user arm;
//   `"user-fk-cascade"` is the FK better-auth's migrator creates — every
//   `references` without an explicit `onDelete` gets ON DELETE CASCADE
//   (get-migration.mjs: `onDelete(field.references.onDelete || "cascade")`),
//   so deleting the orphaned `"user"` row removes these. The tripwire
//   verifies the claimed reference actually exists in the plugin schema.
// - `platform` — no workspace and no user erasure dimension: the global
//   auth spine, config-seeded rows, or transient TTL state.
// - `unreached` — a RECORDED gap: the table has a user or workspace
//   dimension and no mechanism removes it. Every entry here must name a
//   follow-up; the tripwire pins the exact set so it can only grow
//   deliberately. This arm exists so closing the enumeration blind spot
//   cannot be blocked on fixing every gap it reveals — an invisible gap
//   became a named one, which is the registry's whole job.
//
// `subscription` (@better-auth/stripe) is deliberately ABSENT: it is the
// one Better Auth table mirrored into `db/schema.ts` (so the drift gates
// see it), which puts it in BOTH Drizzle registries already. An entry here
// too would be a second decision for the same table.

/** How a `user_scoped` Better Auth table is removed for an orphaned user. */
export type BetterAuthOrphanArm = "explicit-delete" | "user-fk-cascade";

interface BetterAuthPurgedScope {
  readonly decision: "purged";
  readonly reason: string;
  readonly orphanArm?: undefined;
}

interface BetterAuthUserScope {
  readonly decision: "user_scoped";
  readonly reason: string;
  readonly orphanArm: BetterAuthOrphanArm;
}

interface BetterAuthPlatformScope {
  readonly decision: "platform";
  readonly reason: string;
  readonly orphanArm?: undefined;
}

interface BetterAuthUnreachedScope {
  readonly decision: "unreached";
  readonly reason: string;
  readonly orphanArm?: undefined;
}

export type BetterAuthTableScope =
  | BetterAuthPurgedScope
  | BetterAuthUserScope
  | BetterAuthPlatformScope
  | BetterAuthUnreachedScope;

export const BETTER_AUTH_PURGE_DECISIONS = {
  // ── The org spine ──────────────────────────────────────────────────
  organization: { decision: "purged", reason: "The workspace row itself — deleted last (Phase 5), after every table that scopes through it." },
  member: { decision: "purged", reason: "Membership rows for the purged org, deleted by organizationId. Also what the orphaned-user computation reads, so it goes AFTER that read." },
  invitation: { decision: "purged", reason: "Pending invitations carry invitee EMAIL addresses. Deleted explicitly by organizationId; the migrator-level FK to organization would cascade too, but explicit is the completeness rule (#5160)." },

  // ── The user spine (orphaned-user arm) ─────────────────────────────
  user: { decision: "user_scoped", reason: "Deleted only when the purge orphans the user (no membership in any other org). A user surviving in another workspace keeps their account — that is the correct reading of a WORKSPACE erasure.", orphanArm: "explicit-delete" },
  session: { decision: "user_scoped", reason: "Deleted explicitly for orphaned users; also cascades from the user row. Explicit as a completeness guarantee for deployments predating the FK, like `messages`.", orphanArm: "explicit-delete" },
  account: { decision: "user_scoped", reason: "Credential/OAuth account rows for orphaned users. Same explicit-plus-cascade posture as session.", orphanArm: "explicit-delete" },
  twoFactor: { decision: "user_scoped", reason: "TOTP secrets + backup codes, keyed on userId. Removed by the migrator's default ON DELETE CASCADE from the user row.", orphanArm: "user-fk-cascade" },
  passkey: { decision: "user_scoped", reason: "WebAuthn credentials, keyed on userId. Removed by the user-FK cascade.", orphanArm: "user-fk-cascade" },

  // ── OAuth / OIDC provider (ADR-0016 surface) ───────────────────────
  oauthClient: { decision: "user_scoped", reason: "DCR client registrations, owned by the registering user (userId → user.id, migrator-default cascade). Workspace linkage lives in the Drizzle-side oauth_client_workspace_* tables, which are `purged` in the main registry.", orphanArm: "user-fk-cascade" },
  oauthAccessToken: { decision: "user_scoped", reason: "Bearer tokens: userId → user.id cascade removes an orphaned user's tokens. A multi-workspace user's token whose `referenceId` names the purged org dies functionally (the org row is gone, so audience/workspace resolution fails) and expires on its own TTL.", orphanArm: "user-fk-cascade" },
  oauthRefreshToken: { decision: "user_scoped", reason: "Refresh tokens — same shape and same cascade as oauthAccessToken, same TTL argument for the multi-workspace residue.", orphanArm: "user-fk-cascade" },
  oauthConsent: { decision: "user_scoped", reason: "Per-(client, user) consent records, removed by the user-FK cascade. Carries no content beyond scopes granted.", orphanArm: "user-fk-cascade" },
  oauthResource: { decision: "platform", reason: "Resource registrations seeded from resolveOAuthValidAudiences() at boot (#5505) — deployment config, identical for every workspace." },
  oauthClientResource: { decision: "platform", reason: "Client→resource links (#5505). No user or workspace column of its own; follows its client by declared ON DELETE CASCADE when the client goes." },
  oauthClientAssertion: { decision: "platform", reason: "JTI replay-guard rows: a single expiresAt column, self-expiring. No user or workspace dimension." },
  jwks: { decision: "platform", reason: "The region's token-signing keys. Global infrastructure." },
  deviceCode: { decision: "platform", reason: "Device-flow codes (RFC 8628) with a minutes-scale TTL, self-expiring. `userId` is an unconstrained string that only points at a user mid-flow; by the time a purge runs, live rows for the workspace's users are gone or moments from it." },

  // ── Agent auth (@better-auth/agent-auth) ───────────────────────────
  agentHost: { decision: "user_scoped", reason: "Agent host enrollments, userId → user.id with declared ON DELETE CASCADE.", orphanArm: "user-fk-cascade" },
  agent: { decision: "user_scoped", reason: "Agent identities under a host — declared cascade from both user and host.", orphanArm: "user-fk-cascade" },
  agentCapabilityGrant: { decision: "user_scoped", reason: "Capability grants — declared cascade from agent and from the granting/denying user.", orphanArm: "user-fk-cascade" },
  approvalRequest: { decision: "user_scoped", reason: "CIBA approval requests — declared cascade from agent, host and user.", orphanArm: "user-fk-cascade" },

  // ── Misc core ──────────────────────────────────────────────────────
  verification: { decision: "platform", reason: "TTL token store for in-flight verifications (email OTP, reset). `identifier` can hold an email for the minutes a flow is live; rows self-expire and better-auth prunes them. No workspace dimension and no durable user key." },
  apikey: { decision: "unreached", reason: "A RECORDED GAP, found by this registry's own tripwire on its first run. Workspace API keys (ADR-0027 §6) carry the owning user in `referenceId` and the workspace binding in `metadata.orgId` — and the 1.7 table declares NO foreign key at all, so neither the orphaned-user arm nor any cascade reaches them: an erased user's key rows (name, prefix, hashed secret, per-key metadata) survive the purge. Mitigation today: the key is useless after the purge — validateManaged re-resolves the LIVE member, which is gone. The fix is #5525; when it lands this becomes `user_scoped`/`purged` and the tripwire's pinned unreached set shrinks to empty." },

  // ── @better-auth/scim 1.7 catalog (#5505 → #5515) ──────────────────
  // The repo owner's recorded decision on #5515: when a workspace is
  // purged, ALL scim* data for its provisioning domain is deleted — no
  // retention arm. The provisioning domain IS the organization (server.ts
  // passes the org id), so `provisioningDomainId = $1` is the scope.
  // The purge COMPOSES with the decommission lifecycle rather than
  // replacing it: the purge route decommissions each active connection
  // through the plugin (reconciling provisioned users) BEFORE the
  // transaction, and these deletes are the GDPR completeness guarantee
  // that removes what the lifecycle deliberately keeps for audit.
  scimManagedConnection: { decision: "purged", reason: "The connection catalog root (provisioningDomainId = org). Deleted for ALL statuses — a decommissioned connection keeps its row for audit in normal operation, but a GDPR purge is exactly the event that audit trail does not survive. Deleted AFTER its credential and event children, whose only scope is a subquery through this table." },
  scimManagedCredential: { decision: "purged", reason: "HMAC digests of the connection's bearer tokens — credential material at rest. No domain column; reached via connectionRecordId through scimManagedConnection, so it must be deleted BEFORE the connection rows or the subquery matches nothing (#5160's shape)." },
  scimManagedConnectionEvent: { decision: "purged", reason: "The connection's audit trail, carrying actorId per event. Same via-connection scope and same child-before-parent order as scimManagedCredential." },
  scimConnectionBinding: { decision: "purged", reason: "The plugin's per-connection lifecycle record (decommission cursor/lease), keyed by provisioningDomainId. Scheduling-shaped state: a purged workspace leaves no lifecycle residue." },
  scimIdentityTombstone: { decision: "purged", reason: "Deprovisioned-identity tombstones whose `profile` column holds a serialized SCIM profile — names and emails of people the IdP removed. The owner's no-retention decision applies with extra force here: these are erasure records that themselves carry the personal data." },
  scimUser: { decision: "purged", reason: "THE #5515 headline row: the provisioned-user projection carries primaryEmail, displayName, givenName/familyName and serializedEmails verbatim. Its userId FK cascades only when the USER is deleted, and the orphaned-user arm spares anyone still in another workspace — so without this domain-keyed DELETE, a multi-workspace user's identity data survives the purge of the workspace that provisioned it. Deleted after scimProjectionGrant and scimGroupMember, which reference it." },
  scimProjectionGrant: { decision: "purged", reason: "Role grants attached to provisioned users (sourceKind/sourceId/role), keyed by provisioningDomainId. Deleted before scimUser, which its scimUserId references." },
  scimGroup: { decision: "purged", reason: "IdP group projections — displayName is the customer's own directory structure, the same asset class as brain_slack_channel's channel names. Deleted after scimGroupMember, which references it." },
  scimGroupMember: { decision: "purged", reason: "Group membership rows. No domain column; reached through BOTH parents (groupId via scimGroup, scimUserId via scimUser) so a row is removed whichever parent attributes it. First of the scim deletes — both parents must still exist for the subqueries to match." },
  scimSubject: { decision: "user_scoped", reason: "One row per SCIM-managed user ACROSS domains (userId → user.id), not per provisioning domain — deleting it by domain would break another workspace's provisioning for a shared user. Deleted explicitly for orphaned users (probed: the relation exists only where EE SCIM ran); the migrator-default cascade covers deployments that predate the statement.", orphanArm: "explicit-delete" },
} as const satisfies Record<string, BetterAuthTableScope>;

/** Better Auth tables the purge deletes with an explicit workspace-scoped statement. */
export const BETTER_AUTH_PURGED_TABLES: ReadonlySet<string> = new Set(
  Object.entries(BETTER_AUTH_PURGE_DECISIONS)
    .filter(([, v]) => v.decision === "purged")
    .map(([k]) => k),
);

/** Better Auth tables the orphaned-user arm deletes with an explicit statement. */
export const BETTER_AUTH_ORPHAN_DELETE_TABLES: ReadonlySet<string> = new Set(
  Object.entries(BETTER_AUTH_PURGE_DECISIONS)
    .filter(([, v]) => v.decision === "user_scoped" && v.orphanArm === "explicit-delete")
    .map(([k]) => k),
);

/**
 * The @better-auth/scim plugin's tables, as a literal union + value list.
 *
 * `hardDeleteWorkspace` probes exactly this set in one round trip before its
 * scim deletes: the relations are plugin-owned (created by better-auth's
 * schema-diff only where EE SCIM has been enabled), so unlike every other
 * relation the purge names, "absent" is a NORMAL state meaning "nothing was
 * ever provisioned" rather than region drift. Derived from the registry so the
 * probe list, the deletes and the decisions cannot disagree; the enumeration
 * tripwire additionally pins this set against the plugin's own live schema, so
 * an upstream bump that adds a scim table fails there by name.
 */
export type ScimPluginTableName = Extract<
  keyof typeof BETTER_AUTH_PURGE_DECISIONS,
  `scim${string}`
>;

export const SCIM_PLUGIN_TABLES: readonly ScimPluginTableName[] = Object.keys(
  BETTER_AUTH_PURGE_DECISIONS,
).filter((k): k is ScimPluginTableName => k.startsWith("scim"));
