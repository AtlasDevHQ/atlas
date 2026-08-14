/**
 * Workspace data export for cross-region migration.
 *
 * Queries the internal database for the bundle-scoped workspace data (the
 * per-table moves/stays decisions live in `bundle-scope.ts`) and builds an
 * ExportBundle compatible with the import endpoint at
 * POST /api/v1/admin/migrate/import.
 *
 * This is the SINGLE bundle producer: the region-migration executor
 * (migrate.ts) and the `atlas-operator export` CLI both call it, so the
 * bundle scope cannot drift between the two surfaces (#4460). The per-table
 * moves/stays decision registry lives in `bundle-scope.ts`; a new
 * workspace-scoped table must be classified there (its tripwire test fails
 * otherwise) and, when classified as exported, queried here.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import {
  EXPORT_BUNDLE_VERSION,
  type ExportBundle,
  type ExportedConversation,
  type ExportedMessage,
  type ExportedSemanticEntity,
  type ExportedLearnedPattern,
  type ExportedSetting,
  type ExportedDashboard,
  type ExportedDashboardCard,
  type ExportedDashboardUserDraft,
  type ExportedKnowledgeDocument,
  type ExportedKnowledgeLink,
  type ExportedScheduledTask,
  type ExportedAgentSessionMemory,
  type ExportedBrainEpisode,
  type ExportedBrainFact,
  type ExportedBrainEdge,
  type ExportedFactAudienceMember,
  type ExportedBrainVocabularyEdge,
  type ExportedBrainSlackChannelExclusion,
  type ExportedBrainSlackIngestScope,
  type ExportedBrainEnrollment,
  type ExportedVocabularySlotPosition,
} from "@useatlas/types";

const log = createLogger("region-export");

/** Coerce a DB timestamp value to an ISO 8601 string. */
function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  log.warn({ valueType: typeof value }, "Unexpected timestamp value in export — defaulting to current time");
  return new Date().toISOString();
}

/** Nullable variant of {@link toISO} for optional timestamp columns. */
function toISOOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toISO(value);
}

/**
 * Narrow `brain_facts.pre_widening_visible_to` for the bundle — the ACL input
 * that decides whether the TARGET region discloses a claim's first speaker
 * (#4836).
 *
 * Fails CLOSED, and that is the whole reason it is a function rather than a
 * ternary. `null` is a real value here ("never widened", so every reader is an
 * original reader and full attribution is correct). Anything else non-array is
 * the column missing from the projection or the driver no longer decoding it —
 * and folding that into `null` would tell the target region "never widened"
 * about facts that were, disclosing them to the whole org with no error and no
 * way back: the import writes `status` verbatim, so the widening UPDATE that
 * is the column's only deriver never runs again.
 *
 * `[]` is the deny sentinel. This column has no `cardinality > 0` CHECK
 * (unlike `visible_to`, where an empty grant IS a defect), and an empty grant
 * overlaps no reader token, so the target withholds from everyone — visibly
 * wrong to an operator, and recoverable, which disclosure is not.
 */
function preWideningGrant(value: unknown, factId: unknown): string[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value as string[];
  log.warn(
    { factId, actualType: value === undefined ? "undefined" : typeof value },
    "region export: `pre_widening_visible_to` did not decode as an array — exporting an empty grant so the target region WITHHOLDS provenance attribution rather than disclosing it (#4836)",
  );
  return [];
}

/**
 * A nullable `text` column, degraded to `null` for anything that is not a
 * string. The five identity columns (#5035, ADR-0037 §8) go through it.
 *
 * Not a cast, and not decoration. `preWideningGrant` above makes the same call
 * for the same reason: the destination BRANCHES on these values — the slot keys
 * are join arms and `object_cmp` feeds the arm that stamps `valid_to` — so a
 * value of the wrong runtime shape is not inert once it lands. `null` is already
 * a legitimate, common value at all five positions (a surface that norms away
 * has no key; NULL is how `unknown` is spelled at a `_cmp`), so the degraded
 * state is one the destination already handles, and it costs an under-match
 * rather than a false claim of difference.
 *
 * ⚠️ **THREE states, not two, and it warns on the third** — `preWideningGrant`'s
 * structure, one column family over. A SQL `NULL` is an honest abstain and is
 * silent; ANYTHING else non-string means the SELECT dropped the column or the
 * driver stopped decoding it, and that is not evidence of an abstain.
 *
 * The first cut of this function was silent on both, on the reasoning that
 * *"a log line per drift would be indistinguishable from a log line per honest
 * abstain"*. **That reasoning was wrong** (#5035, panel round 1): an abstain
 * arrives as `null` and a dropped column arrives as `undefined`, so the two are
 * trivially separable — and `preWideningGrant`, eight lines up and cited by that
 * comment as making the same call, already separates them. The failure the
 * silence hid is corpus-wide: `f.subject_key` stops arriving → every fact
 * exports `null` → the destination accepts it (null is legitimate) → the whole
 * imported corpus lands UNKEYED, which is the exact pre-#5035 state this slice
 * exists to end, with a green `200` at both ends. The destination's
 * `provisional` marker does not cover it either — that reads only the two `_cmp`
 * positions.
 *
 * ⚠️ It COUNTS rather than logging, and the caller emits one line (#5035, panel
 * round 2). `preWideningGrant`'s per-row warn is affordable because its drift is
 * per-row; this one's is not. The trigger named above is a projection or driver
 * change, so it fires on **every row at every column** — five call sites × a
 * 200k-fact workspace is a million `warn` records inside one export call, which
 * is the "trains an operator to skim" failure the importer's own aggregate warn
 * argues against 400 lines away.
 */
function textOrNull(
  value: unknown,
  // A literal union, not `string`: five call sites pass five spellings that must
  // match the vocabulary an operator reads in the log, and a typo would create a
  // drift counter nobody can find.
  column: "subject_key" | "predicate_key" | "object_key" | "subject_cmp" | "object_cmp",
  drift: Record<string, number>,
): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  // Keyed by column AND decoded type. The message names two causes — the SELECT
  // dropped the column, or the driver stopped decoding it — and they have
  // different remediations (revert a query change vs redeploy). Keyed on the
  // column alone the line cannot tell an operator which, which is what the
  // per-row `actualType` used to carry before this became an aggregate.
  const key = `${column}:${value === undefined ? "undefined" : typeof value}`;
  drift[key] = (drift[key] ?? 0) + 1;
  return null;
}

/**
 * Org scoping for a bundle export. The region-migration executor always
 * passes a concrete org id; the `atlas-operator export` CLI passes `null`
 * for a no-auth self-hosted instance whose rows carry `org_id IS NULL`.
 */
function scopeClause(columnRef: string, orgScope: string | null): string {
  return orgScope === null ? `${columnRef} IS NULL` : `${columnRef} = $1`;
}

/**
 * Export the bundle-scoped data for a given org into an ExportBundle.
 *
 * Bundle scope (v2, #4460 — see `bundle-scope.ts` for the full per-table
 * decision registry and `data-residency.mdx` for the customer-facing table):
 * conversations (with messages), semantic entities, learned patterns,
 * org-scoped settings, dashboards (cards + per-user drafts; share tokens
 * dropped — the owner re-shares in the target), knowledge documents (with
 * link graph + review status), scheduled-task definitions (next run
 * recomputed at import), durable agent session memory, and the company brain
 * (#4767 — episodes with their facts nested, the typed edge graph, audience
 * membership, and since #5022 the curated identity vocabulary's approved alias
 * edges — the derived closure is recomputed at the destination, not carried).
 * The returned bundle is ready to POST to the target region's import endpoint.
 *
 * @param orgScope - Org id to export, or `null` to export rows with
 *   `org_id IS NULL` (no-auth self-hosted instances, CLI path).
 * @param sourceLabel - Human-readable label recorded in the manifest.
 * @param apiUrl - Source API base URL recorded in the manifest, if known.
 */
export async function exportWorkspaceBundle(
  orgScope: string | null,
  sourceLabel?: string,
  apiUrl?: string,
): Promise<ExportBundle> {
  const pool = getInternalDB();
  const params = orgScope === null ? [] : [orgScope];

  // All section queries are independent — one parallel batch, no waterfalls.
  const [
    convResult,
    allMsgResult,
    entityResult,
    patternResult,
    settingResult,
    dashboardResult,
    cardResult,
    draftResult,
    knowledgeDocResult,
    knowledgeLinkResult,
    scheduledTaskResult,
    sessionMemoryResult,
    brainEpisodeResult,
    brainFactResult,
    brainEdgeResult,
    factAudienceResult,
    vocabularyEdgeResult,
    slackExclusionResult,
    slackScopeResult,
    enrollmentResult,
  ] = await Promise.all([
    // --- 1. Conversations + Messages (2 queries, no N+1) ---
    pool.query(
      `SELECT id, user_id, title, surface, connection_id, starred, created_at, updated_at
       FROM conversations WHERE ${scopeClause("org_id", orgScope)} AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      params,
    ),
    pool.query(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${scopeClause("c.org_id", orgScope)} AND c.deleted_at IS NULL
       ORDER BY m.conversation_id, m.created_at ASC`,
      params,
    ),
    // --- 2. Semantic entities ---
    // Group-scoped wire shape (#2340 → #2346). The legacy `connection_id`
    // column survives until #2347 drops it; bundles exclusively carry the
    // group identifier now.
    pool.query(
      `SELECT name, entity_type, yaml_content, connection_group_id
       FROM semantic_entities WHERE ${scopeClause("org_id", orgScope)}
       ORDER BY entity_type, name`,
      params,
    ),
    // --- 3. Learned patterns ---
    // Amendment-identity columns (#4569) + approval provenance (#4571) ride
    // along so an amendment survives as an amendment and the injection
    // eligibility bypass survives the migration.
    pool.query(
      `SELECT pattern_sql, description, source_entity, confidence, status,
              type, amendment_payload, connection_group_id, reviewed_by, reviewed_at,
              repetition_count, auto_promoted
       FROM learned_patterns WHERE ${scopeClause("org_id", orgScope)}
       ORDER BY created_at ASC`,
      params,
    ),
    // --- 4. Org-scoped settings ---
    pool.query(
      `SELECT key, value FROM settings WHERE ${scopeClause("org_id", orgScope)} ORDER BY key`,
      params,
    ),
    // --- 5. Dashboards (v2, #4460) ---
    // Share token + expiry deliberately excluded: share URLs are region-bound,
    // so the owner re-shares from the target region. Refresh bookkeeping +
    // card caches excluded: the importer recomputes next_refresh_at from the
    // schedule, and card data regenerates on first render.
    pool.query(
      `SELECT id, owner_id, title, description, share_mode, refresh_schedule,
              parameters, first_published_at, created_at, updated_at
       FROM dashboards WHERE ${scopeClause("org_id", orgScope)} AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      params,
    ),
    pool.query(
      `SELECT c.id, c.dashboard_id, c.position, c.title, c.sql, c.chart_config,
              c.content, c.annotations, c.connection_group_id, c.layout,
              c.created_at, c.updated_at
       FROM dashboard_cards c
       JOIN dashboards d ON d.id = c.dashboard_id
       WHERE ${scopeClause("d.org_id", orgScope)} AND d.deleted_at IS NULL
       ORDER BY c.dashboard_id, c.position ASC`,
      params,
    ),
    // Per-user drafts are content under ADR-0034's draft-first model, so they
    // move; the draft-card data cache (`dashboard_draft_card_cache`) does not.
    pool.query(
      `SELECT dr.user_id, dr.dashboard_id, dr.draft, dr.baseline,
              dr.published_baseline_at, dr.created_at, dr.updated_at
       FROM dashboard_user_drafts dr
       JOIN dashboards d ON d.id = dr.dashboard_id
       WHERE ${scopeClause("d.org_id", orgScope)} AND d.deleted_at IS NULL
       ORDER BY dr.dashboard_id, dr.user_id ASC`,
      params,
    ),
    // --- 6. Knowledge documents (v2, #4460) ---
    // Review `status` and original UUIDs preserved. The FTS vector is a
    // generated column (rebuilds on insert); sync credentials + sync state are
    // carve-outs (per-region ciphertext — re-enter the secret and re-sync).
    pool.query(
      `SELECT id, collection_id, path, type, title, description, tags,
              "timestamp", resource, body, atlas_source, atlas_ingested_at,
              status, created_at, updated_at
       FROM knowledge_documents WHERE ${scopeClause("workspace_id", orgScope)}
       ORDER BY collection_id, path ASC`,
      params,
    ),
    pool.query(
      `SELECT l.source_document_id, l.target_path, l.anchor_text
       FROM knowledge_links l
       JOIN knowledge_documents kd ON kd.id = l.source_document_id
       WHERE ${scopeClause("kd.workspace_id", orgScope)}
       ORDER BY l.source_document_id, l.created_at ASC`,
      params,
    ),
    // --- 7. Scheduled-task definitions (v2, #4460) ---
    // Run history (`scheduled_task_runs`) is a carve-out; last/next run are
    // not exported — the importer recomputes next_run_at from the cron.
    pool.query(
      `SELECT id, owner_id, name, question, cron_expression, delivery_channel,
              recipients, connection_group_id, approval_mode, enabled, plugin_id,
              created_at, updated_at
       FROM scheduled_tasks WHERE ${scopeClause("org_id", orgScope)}
       ORDER BY created_at ASC`,
      params,
    ),
    // --- 8. Durable agent session memory (v2, #4460, ADR-0020) ---
    // Scoped via the conversations join (not the nullable denormalized
    // org_id) so memory rows travel iff their conversation travels — the
    // import-side FK then resolves by construction. `agent_runs` checkpoints
    // are a carve-out (region-local resume leases).
    pool.query(
      `SELECT m.conversation_id, m.namespace, m.value, m.created_at, m.updated_at
       FROM agent_session_memory m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${scopeClause("c.org_id", orgScope)} AND c.deleted_at IS NULL
       ORDER BY m.conversation_id, m.namespace ASC`,
      params,
    ),
    // --- 9. Company brain: episodes, facts, edges, audiences (#4767, ADR-0036) ---
    // The whole substrate moves. A workspace's brain is the same class of
    // asset as its knowledge base, and everything that makes a fact
    // TRUSTWORTHY travels with it — provenance, BOTH grants, review status,
    // and all four temporal columns. Exporting facts without those would land
    // unprovenanced, ungated claims in the target region, which is strictly
    // worse than not migrating them at all.
    //
    // "Both grants" is the easy one to miss, and missing it is a DISCLOSURE
    // rather than an over-restriction: `visible_to` gates the claim,
    // `pre_widening_visible_to` gates its attribution (#4836). Drop the second
    // and every widened fact lands in the target reading as never-widened,
    // handing its first episode's actor, channel and timestamp to the whole
    // org — irreversibly, since the import writes `status` verbatim so the
    // widening UPDATE that derives the column never runs again.
    //
    // Structurally empty on the `orgScope === null` path (the no-auth
    // self-hosted / CLI export): all four brain tables declare `workspace_id
    // NOT NULL`, so `IS NULL` matches nothing. That differs from
    // `conversations.org_id`, which is nullable and does carry rows there —
    // a no-auth instance has no workspace identity to hang a brain off.
    pool.query(
      `SELECT id, source, source_id, source_actor, body, locator, occurred_at,
              ingested_at, extracted_at, visible_to, created_at
       FROM brain_episodes WHERE ${scopeClause("workspace_id", orgScope)}
       ORDER BY ingested_at, id ASC`,
      params,
    ),
    // Scoped via the episode join rather than the fact's own workspace_id, so
    // a fact travels iff its episode travels — the import-side NOT NULL FK
    // then resolves by construction (same discipline as session memory above).
    // The two scopings agree because `fk_brain_facts_episode` is a composite
    // FK on (workspace_id, source_episode_id): a fact hanging off another
    // workspace's episode is unrepresentable, so the join can't widen scope.
    //
    // ⚠️ The five IDENTITY columns are projected here and NOWHERE ELSE in the
    // tree (#5035, ADR-0037 §8, bundle v3). `keys-not-on-the-wire.test.ts` makes
    // that prohibition structural and names this file as one of the three
    // row-copy sites §8 exempts; read its ROW_COPY_SITES entry before adding a
    // sixth reader.
    //
    // Keys travel VERBATIM. The failure directions are what settle it, not a
    // preference: carrying fails to UNDER-match (an imported row keys to a norm
    // the destination's vocabulary cannot produce, so it collides with nothing
    // until a human curates — #5000 at a region boundary), while re-deriving at
    // the destination fails to OVER-match (a destination alias the source lacks
    // merges imported facts into a slot they never belonged to, and publish then
    // stamps `valid_to` across the merge). Only one of those is recoverable.
    //
    // The `_cmp` columns are projected but NOT unconditionally kept: the
    // importer nulls every `entity:`-tagged value, because a store-local id is
    // counterfeit positive evidence of difference in another region
    // (`regionPortableComparable`). They travel rather than being dropped from
    // the format because the null-out is the IMPORTER's decision, and a bundle
    // that omitted them could not be told from one whose source had no store.
    //
    // `predicate_cardinality` is GONE from v3. #5027 moved cardinality onto the
    // canonical predicate, and the per-row values are LLM guesses — carrying one
    // forward would restore a guess as a curated decision. #5028 phase 2 has
    // since dropped the column itself (migration 0195), so this projection could
    // no longer name it even if someone tried.
    pool.query(
      `SELECT f.id, f.source_episode_id, f.subject, f.predicate, f.object,
              f.subject_key, f.predicate_key, f.object_key,
              f.subject_cmp, f.object_cmp,
              f.valid_from, f.valid_to, f.ingested_at, f.invalidated_at,
              f.extracted_at, f.provenance, f.status, f.visible_to,
              f.pre_widening_visible_to,
              f.created_at, f.updated_at
       FROM brain_facts f
       JOIN brain_episodes e ON e.id = f.source_episode_id
       WHERE ${scopeClause("e.workspace_id", orgScope)}
       ORDER BY f.source_episode_id, f.ingested_at, f.id ASC`,
      params,
    ),
    // Edges are workspace-scoped directly. Safe because the composite
    // endpoint FKs (`fk_brain_edges_*`) pin every endpoint to the edge's own
    // workspace — so this selects the same rows four nullable endpoint joins
    // would, and cannot export an edge whose endpoint is absent from the
    // bundle (which would fail the FK at import).
    pool.query(
      `SELECT edge_type, from_fact_id, from_episode_id, to_fact_id, to_episode_id,
              created_at
       FROM brain_edges WHERE ${scopeClause("workspace_id", orgScope)}
       ORDER BY created_at, edge_type ASC`,
      params,
    ),
    // Audience membership travels or every `audience:` grant silently denies
    // everyone in the target region — a total, invisible loss of access.
    pool.query(
      `SELECT audience_id, user_id, source, created_at
       FROM fact_audience_member WHERE ${scopeClause("workspace_id", orgScope)}
       ORDER BY audience_id, user_id ASC`,
      params,
    ),
    // --- 10. The curated identity vocabulary (#5022, ADR-0037 §6/§8) ---
    // The approved alias edges are the human's decisions and the reason every
    // exported fact's identity key reads the way it does — `alias` is the outer
    // layer of `alias(lexicalNorm(surface))`, and ADR-0037 §8 carries those keys
    // VERBATIM. A workspace that arrived without its vocabulary would hold keys
    // the target region can neither explain nor undo, and 'stays' would DELETE
    // them at source after the grace period (#4458): the decisions destroyed and
    // the keys stranded in one move.
    //
    // No ACL narrowing on the way out, unlike `brain_facts.pre_widening_visible_to`
    // above, and that is derived rather than skipped: neither table has a grant
    // column at all. ADR-0037 §6 makes the vocabulary the one piece of brain
    // state with no ACL, permanently — all three identity consumers are already
    // workspace-scoped with no grant arm, and grant-scoping would need
    // `alias(norm, reader)` at a seam materialized by a fiber that has no reader.
    //
    // Not a key projection. `keys-not-on-the-wire.test.ts` forbids any read
    // surface selecting `subject_key`/`predicate_key`/`object_key`; these are
    // lexical NORMS in the table §8 exports by name.
    //
    // The EDGES only. The derived closure table is classified 'stays' and is
    // deliberately absent: §8 has the import union the approved edges and
    // RECOMPUTE the closure, and a source closure restored into a destination
    // that already holds a vocabulary would be a closure of neither. The
    // reverse-drift arm of `bundle-scope.test.ts` is what keeps a query for it
    // from being added here unnoticed: it greps this file for `FROM <table>` and
    // `JOIN <table>`, so adding a query without reclassifying the table fails
    // the suite. (A bare mention in prose is fine — an earlier version of this
    // comment imposed a naming taboo the tripwire does not actually enforce.)
    pool.query(
      `SELECT slot_position, from_norm, to_norm, approved_by, approved_at
       FROM brain_vocabulary_edge WHERE ${scopeClause("workspace_id", orgScope)}
       ORDER BY slot_position, from_norm ASC`,
      params,
    ),
    // The company brain's Slack ingest-scope NARROWINGS (#5203). Only the rows
    // an admin excluded: the predicate is the section's whole meaning, and a
    // query without it would carry observed membership the destination must
    // re-derive anyway. The projection omits `is_member`/`name`/`is_private`
    // and the health verdicts for the same reason.
    pool.query(
      `SELECT channel_id, excluded_at, exclusion_reason, excluded_by
       FROM brain_slack_channel
       WHERE ${scopeClause("workspace_id", orgScope)} AND excluded_at IS NOT NULL
       ORDER BY channel_id ASC`,
      params,
    ),
    // Present only for a workspace caught mid-reconcile — see the type. The
    // `reconciled_at IS NULL` predicate is what makes it "mid-reconcile" rather
    // than "ever had a legacy scope": a reconciled workspace's narrowing already
    // travels as exclusions above, and carrying its spent allowlist would land a
    // second, contradictory scope authority in the destination.
    pool.query(
      `SELECT legacy_channels
       FROM brain_slack_ingest_scope
       WHERE ${scopeClause("workspace_id", orgScope)} AND reconciled_at IS NULL
       LIMIT 1`,
      params,
    ),
    // The warehouse producer's enrolled reach (#5196, ADR-0039). The WHOLE row,
    // unfiltered — unlike the two sections above there is no observed half to
    // leave behind and no predicate that carries meaning: nothing derives an
    // enrollment, so every row here is a human act and every one of them is the
    // decision.
    pool.query(
      `SELECT entity, dimension, enrolled_at, enrolled_by, note
       FROM brain_enrollment WHERE ${scopeClause("workspace_id", orgScope)}
       ORDER BY entity, dimension ASC`,
      params,
    ),
  ]);

  // Group messages by conversation_id
  const messagesByConv = new Map<string, ExportedMessage[]>();
  for (const m of allMsgResult.rows) {
    const convId = m.conversation_id as string;
    let msgs = messagesByConv.get(convId);
    if (!msgs) {
      msgs = [];
      messagesByConv.set(convId, msgs);
    }
    msgs.push({
      id: m.id as string,
      role: m.role as ExportedMessage["role"],
      content: m.content,
      createdAt: toISO(m.created_at),
    });
  }

  const conversations: ExportedConversation[] = [];
  let totalMessages = 0;

  for (const conv of convResult.rows) {
    const messages = messagesByConv.get(conv.id as string) ?? [];
    totalMessages += messages.length;

    conversations.push({
      id: conv.id as string,
      userId: (conv.user_id as string | null) ?? null,
      title: (conv.title as string | null) ?? null,
      surface: ((conv.surface as string) ?? "web") as ExportedConversation["surface"],
      connectionId: (conv.connection_id as string | null) ?? null,
      starred: (conv.starred as boolean) ?? false,
      createdAt: toISO(conv.created_at),
      updatedAt: toISO(conv.updated_at),
      messages,
    });
  }

  const semanticEntities: ExportedSemanticEntity[] = entityResult.rows.map((e) => ({
    name: e.name as string,
    entityType: e.entity_type as string,
    yamlContent: e.yaml_content as string,
    connectionGroupId: (e.connection_group_id as string | null) ?? null,
  }));

  const learnedPatterns: ExportedLearnedPattern[] = patternResult.rows.map((p) => ({
    patternSql: p.pattern_sql as string,
    description: (p.description as string | null) ?? null,
    sourceEntity: (p.source_entity as string | null) ?? null,
    confidence: p.confidence as number,
    status: p.status as ExportedLearnedPattern["status"],
    // Amendment identity (#4569) — carried so a `semantic_amendment` row lands
    // as an amendment instead of an orphaned query pattern.
    type: (p.type as ExportedLearnedPattern["type"]) ?? "query_pattern",
    amendmentPayload: (p.amendment_payload as Record<string, unknown> | null) ?? null,
    connectionGroupId: (p.connection_group_id as string | null) ?? null,
    reviewedBy: (p.reviewed_by as string | null) ?? null,
    reviewedAt: toISOOrNull(p.reviewed_at),
    repetitionCount: (p.repetition_count as number) ?? 1,
    // Human vs machine approval road (#4571) — carried so the injection
    // eligibility bypass survives region migration. Column is NOT NULL.
    autoPromoted: Boolean(p.auto_promoted),
  }));

  const settings: ExportedSetting[] = settingResult.rows.map((s) => ({
    key: s.key as string,
    value: s.value as string,
  }));

  // --- Dashboards: group cards + drafts by dashboard_id ---
  const cardsByDashboard = new Map<string, ExportedDashboardCard[]>();
  for (const c of cardResult.rows) {
    const dashId = c.dashboard_id as string;
    let cards = cardsByDashboard.get(dashId);
    if (!cards) {
      cards = [];
      cardsByDashboard.set(dashId, cards);
    }
    cards.push({
      id: c.id as string,
      position: (c.position as number) ?? 0,
      title: c.title as string,
      sql: (c.sql as string) ?? "",
      chartConfig: c.chart_config ?? null,
      content: (c.content as string | null) ?? null,
      annotations: c.annotations ?? [],
      connectionGroupId: (c.connection_group_id as string | null) ?? null,
      layout: c.layout ?? null,
      createdAt: toISO(c.created_at),
      updatedAt: toISO(c.updated_at),
    });
  }

  const draftsByDashboard = new Map<string, ExportedDashboardUserDraft[]>();
  for (const d of draftResult.rows) {
    const dashId = d.dashboard_id as string;
    let drafts = draftsByDashboard.get(dashId);
    if (!drafts) {
      drafts = [];
      draftsByDashboard.set(dashId, drafts);
    }
    drafts.push({
      userId: d.user_id as string,
      draft: d.draft,
      baseline: d.baseline,
      publishedBaselineAt: toISO(d.published_baseline_at),
      createdAt: toISO(d.created_at),
      updatedAt: toISO(d.updated_at),
    });
  }

  let totalCards = 0;
  let totalDrafts = 0;
  const dashboards: ExportedDashboard[] = dashboardResult.rows.map((d) => {
    const id = d.id as string;
    const cards = cardsByDashboard.get(id) ?? [];
    const drafts = draftsByDashboard.get(id) ?? [];
    totalCards += cards.length;
    totalDrafts += drafts.length;
    return {
      id,
      ownerId: d.owner_id as string,
      title: d.title as string,
      description: (d.description as string | null) ?? null,
      // NOT NULL column — bound raw. No `?? "public"` fallback: manufacturing
      // a permissive sharing posture here would defeat the importer's refusal
      // to default it (the producer must state the posture).
      shareMode: d.share_mode as ExportedDashboard["shareMode"],
      refreshSchedule: (d.refresh_schedule as string | null) ?? null,
      parameters: d.parameters ?? [],
      firstPublishedAt: toISOOrNull(d.first_published_at),
      createdAt: toISO(d.created_at),
      updatedAt: toISO(d.updated_at),
      cards,
      drafts,
    };
  });

  // --- Knowledge documents: group links by source document ---
  const linksByDocument = new Map<string, ExportedKnowledgeLink[]>();
  for (const l of knowledgeLinkResult.rows) {
    const docId = l.source_document_id as string;
    let links = linksByDocument.get(docId);
    if (!links) {
      links = [];
      linksByDocument.set(docId, links);
    }
    links.push({
      targetPath: l.target_path as string,
      anchorText: (l.anchor_text as string | null) ?? null,
    });
  }

  let totalLinks = 0;
  const knowledgeDocuments: ExportedKnowledgeDocument[] = knowledgeDocResult.rows.map((k) => {
    const links = linksByDocument.get(k.id as string) ?? [];
    totalLinks += links.length;
    return {
      id: k.id as string,
      collectionId: k.collection_id as string,
      path: k.path as string,
      type: (k.type as string | null) ?? null,
      title: (k.title as string | null) ?? null,
      description: (k.description as string | null) ?? null,
      tags: k.tags ?? [],
      docTimestamp: toISOOrNull(k.timestamp),
      resource: (k.resource as string | null) ?? null,
      body: k.body as string,
      atlasSource: (k.atlas_source as string | null) ?? null,
      atlasIngestedAt: toISOOrNull(k.atlas_ingested_at),
      status: k.status as ExportedKnowledgeDocument["status"],
      createdAt: toISO(k.created_at),
      updatedAt: toISO(k.updated_at),
      links,
    };
  });

  const scheduledTasks: ExportedScheduledTask[] = scheduledTaskResult.rows.map((t) => ({
    id: t.id as string,
    ownerId: t.owner_id as string,
    name: t.name as string,
    question: t.question as string,
    cronExpression: t.cron_expression as string,
    deliveryChannel: (t.delivery_channel as string) ?? "webhook",
    recipients: t.recipients ?? [],
    connectionGroupId: (t.connection_group_id as string | null) ?? null,
    // NOT NULL columns — bound raw, no permissive fallbacks (same rationale
    // as `shareMode` above: the approval posture is stated, never defaulted).
    approvalMode: t.approval_mode as string,
    enabled: t.enabled as boolean,
    pluginId: (t.plugin_id as string | null) ?? null,
    createdAt: toISO(t.created_at),
    updatedAt: toISO(t.updated_at),
  }));

  const agentSessionMemory: ExportedAgentSessionMemory[] = sessionMemoryResult.rows.map((m) => ({
    conversationId: m.conversation_id as string,
    namespace: m.namespace as string,
    value: m.value,
    createdAt: toISO(m.created_at),
    updatedAt: toISO(m.updated_at),
  }));

  // Facts nest under their episode, mirroring links-under-documents above:
  // the nesting IS the FK ordering the importer needs, so it can never write a
  // fact before the episode its NOT NULL provenance FK points at.
  // Per-column drift counts for the five identity columns, aggregated across the
  // whole corpus and reported once below — see {@link textOrNull} for why a
  // per-row line is the wrong shape here specifically.
  const identityDrift: Record<string, number> = {};
  const factsByEpisode = new Map<string, ExportedBrainFact[]>();
  for (const f of brainFactResult.rows) {
    const episodeId = f.source_episode_id as string;
    let facts = factsByEpisode.get(episodeId);
    if (!facts) {
      facts = [];
      factsByEpisode.set(episodeId, facts);
    }
    facts.push({
      id: f.id as string,
      subject: f.subject as string,
      predicate: f.predicate as string,
      object: f.object as string,
      validFrom: toISOOrNull(f.valid_from),
      validTo: toISOOrNull(f.valid_to),
      ingestedAt: toISO(f.ingested_at),
      invalidatedAt: toISOOrNull(f.invalidated_at),
      extractedAt: toISOOrNull(f.extracted_at),
      // NOT NULL / CHECK-guarded columns — bound raw with no permissive
      // fallback. A `?? {}` here would manufacture the empty provenance the
      // table refuses to store, and `?? ['org']` would invent a public grant.
      provenance: f.provenance,
      status: f.status as ExportedBrainFact["status"],
      visibleTo: f.visible_to as string[],
      // NULLABLE, unlike every other column in this block — `null` means the
      // fact was never widened, which is the common case and a real value
      // rather than a missing one (#4836).
      //
      // THREE states, not two, for the same reason `attributionDecision` keeps
      // them apart: SQL NULL is "never widened" and discloses in the target
      // region; anything else non-array means the SELECT dropped the column or
      // the driver stopped decoding it, and entitlement is then unknown. An
      // `Array.isArray(x) ? x : null` here would collapse the second into the
      // first and silently disclose every widened fact in the target region —
      // permanently, since the import writes `status` verbatim so the widening
      // UPDATE never re-runs to repair it. Drift degrades to `[]` instead,
      // which overlaps no reader token and therefore withholds from everyone:
      // over-withholding is recoverable, disclosure is not.
      preWideningVisibleTo: preWideningGrant(f.pre_widening_visible_to, f.id),
      // The identity slot and the two comparable values (#5035, ADR-0037 §8).
      //
      // `textOrNull` rather than a cast, and the reason is the same one
      // `preWideningVisibleTo` gives one line up: the importer's behaviour
      // BRANCHES on these, so a value of the wrong runtime shape is not inert
      // here. A cast would put whatever the driver returned into a column the
      // destination's collision join reads with `=` and `<>` — and at
      // `object_cmp` the arm it feeds stamps `valid_to`. Degrading to `null`
      // costs an under-match a human can repair; anything else is the
      // irreversible direction.
      //
      // v3 REQUIRES all five, and `null` is a legitimate value at every one of
      // them: a surface that norms away has no key, permanently, and NULL is how
      // `unknown` is spelled at a `_cmp`.
      subjectKey: textOrNull(f.subject_key, "subject_key", identityDrift),
      predicateKey: textOrNull(f.predicate_key, "predicate_key", identityDrift),
      objectKey: textOrNull(f.object_key, "object_key", identityDrift),
      subjectCmp: textOrNull(f.subject_cmp, "subject_cmp", identityDrift),
      objectCmp: textOrNull(f.object_cmp, "object_cmp", identityDrift),
      createdAt: toISO(f.created_at),
      updatedAt: toISO(f.updated_at),
    });
  }

  // ONE line for the whole corpus, naming the COLUMN and the COUNT — strictly
  // more actionable than a line per row, because the operator's question is
  // *which projection broke and how much of the corpus did it take*, and a
  // million identical lines answer neither.
  if (Object.keys(identityDrift).length > 0) {
    log.warn(
      { orgScope, columns: identityDrift, brainFacts: brainFactResult.rows.length },
      "region export: identity columns did not decode as text — exported `null`, which the target reads as 'no key' / 'unknown'. That is the recoverable direction (an under-match a human can repair) rather than a false claim of difference, but it is DRIFT, not an abstain: a SQL NULL never reaches this counter. A count approaching the fact total means the SELECT dropped the column or the driver stopped decoding it, and the target region will land the whole corpus UNKEYED (#5035)",
    );
  }

  let totalBrainFacts = 0;
  const brainEpisodes: ExportedBrainEpisode[] = brainEpisodeResult.rows.map((e) => {
    const facts = factsByEpisode.get(e.id as string) ?? [];
    totalBrainFacts += facts.length;
    return {
      id: e.id as string,
      source: e.source as string,
      sourceId: e.source_id as string,
      sourceActor: (e.source_actor as string | null) ?? null,
      body: (e.body as string | null) ?? null,
      locator: (e.locator as string | null) ?? null,
      occurredAt: toISOOrNull(e.occurred_at),
      ingestedAt: toISO(e.ingested_at),
      // Preserved, not reset: re-extracting in the target would mint fresh
      // candidates for episodes a human has already reviewed.
      extractedAt: toISOOrNull(e.extracted_at),
      visibleTo: e.visible_to as string[],
      createdAt: toISO(e.created_at),
      facts,
    };
  });

  const brainEdges: ExportedBrainEdge[] = brainEdgeResult.rows.map((e) => ({
    edgeType: e.edge_type as ExportedBrainEdge["edgeType"],
    fromFactId: (e.from_fact_id as string | null) ?? null,
    fromEpisodeId: (e.from_episode_id as string | null) ?? null,
    toFactId: (e.to_fact_id as string | null) ?? null,
    toEpisodeId: (e.to_episode_id as string | null) ?? null,
    createdAt: toISO(e.created_at),
  }));

  const factAudienceMembers: ExportedFactAudienceMember[] = factAudienceResult.rows.map((a) => ({
    audienceId: a.audience_id as string,
    userId: a.user_id as string,
    source: a.source as string,
    createdAt: toISO(a.created_at),
  }));

  const brainVocabularyEdges: ExportedBrainVocabularyEdge[] = vocabularyEdgeResult.rows.map((e) => ({
    // Cast rather than narrowed, unlike the IMPORT side — and the asymmetry is
    // the point. This reads our own table, where
    // `ck_brain_vocabulary_edge_slot_position` is the guarantee; the import
    // reads a foreign region's bundle, where there is none, which is why
    // `isSlotPosition` lives there.
    slotPosition: e.slot_position as ExportedVocabularySlotPosition,
    fromNorm: e.from_norm as string,
    toNorm: e.to_norm as string,
    approvedBy: (e.approved_by as string | null) ?? null,
    approvedAt: toISO(e.approved_at),
  }));

  const brainSlackChannelExclusions: ExportedBrainSlackChannelExclusion[] =
    slackExclusionResult.rows.map((r) => ({
      channelId: r.channel_id as string,
      excludedAt: toISO(r.excluded_at),
      exclusionReason: (r.exclusion_reason as string | null) ?? null,
      // Not defaulted to `""`. `ck_brain_slack_channel_exclusion_attributed`
      // makes an unattributed exclusion unstorable, so a null here means the
      // shape changed out from under this reader — and `""` would land in the
      // destination as an exclusion nobody can be shown to have asked for, on
      // the column an audit of "why did we stop reading that channel?" reads
      // first. Let the import's own validation refuse it.
      excludedBy: r.excluded_by as string,
    }));

  const legacyScopeRow = slackScopeResult.rows[0];
  const brainSlackIngestScope: ExportedBrainSlackIngestScope | undefined =
    legacyScopeRow === undefined
      ? undefined
      : {
          legacyChannels: Array.isArray(legacyScopeRow.legacy_channels)
            ? (legacyScopeRow.legacy_channels as string[])
            : // NOT coerced to "no legacy scope". The column is NOT NULL, so a
              // non-array here is a shape change; landing `[]` would mean
              // "ingest nothing", and landing the section absent would mean
              // "ingest everything". `[]` is the fail-closed reading and the one
              // that matches the column's own three-state contract.
              [],
        };

  const brainEnrollments: ExportedBrainEnrollment[] = enrollmentResult.rows.map((r) => ({
    entity: r.entity as string,
    dimension: r.dimension as string,
    enrolledAt: toISO(r.enrolled_at),
    // Not defaulted to `""`, on `excludedBy`'s reasoning exactly:
    // `ck_brain_enrollment_attributed` makes an unattributed enrollment
    // unstorable, so a null here is a shape change rather than a missing value —
    // and `""` would land in the destination as authority nobody can be shown to
    // have granted. Let the import's own validation refuse it.
    enrolledBy: r.enrolled_by as string,
    note: (r.note as string | null) ?? null,
  }));

  // --- Build bundle ---
  const bundle: ExportBundle = {
    manifest: {
      version: EXPORT_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      source: {
        label: sourceLabel ?? "region-migration",
        ...(apiUrl ? { apiUrl } : {}),
      },
      counts: {
        conversations: conversations.length,
        messages: totalMessages,
        semanticEntities: semanticEntities.length,
        learnedPatterns: learnedPatterns.length,
        settings: settings.length,
        dashboards: dashboards.length,
        dashboardCards: totalCards,
        dashboardUserDrafts: totalDrafts,
        knowledgeDocuments: knowledgeDocuments.length,
        knowledgeLinks: totalLinks,
        scheduledTasks: scheduledTasks.length,
        agentSessionMemory: agentSessionMemory.length,
        brainEpisodes: brainEpisodes.length,
        brainFacts: totalBrainFacts,
        brainEdges: brainEdges.length,
        factAudienceMembers: factAudienceMembers.length,
        brainVocabularyEdges: brainVocabularyEdges.length,
        brainSlackChannelExclusions: brainSlackChannelExclusions.length,
        brainEnrollments: brainEnrollments.length,
      },
    },
    conversations,
    semanticEntities,
    learnedPatterns,
    settings,
    dashboards,
    knowledgeDocuments,
    scheduledTasks,
    agentSessionMemory,
    brainEpisodes,
    brainEdges,
    factAudienceMembers,
    brainVocabularyEdges,
    brainSlackChannelExclusions,
    ...(brainSlackIngestScope !== undefined ? { brainSlackIngestScope } : {}),
    brainEnrollments,
  };

  log.info(
    { orgScope, counts: bundle.manifest.counts },
    "Workspace data exported for migration",
  );

  return bundle;
}
