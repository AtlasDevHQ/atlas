/**
 * Exotic adapter for the `brain_facts` table — the fact class's review gate
 * (#4769, ADR-0036 §Temporal, conflict & provenance).
 *
 * ## Why exotic, when the READ semantics are the plain ones
 *
 * `brain_facts` reads exactly like a simple entry (`status = 'published'`, or
 * `IN ('published','draft')` in developer mode), and `readFilter` below says
 * so. It is exotic entirely because of the WRITE: a `SimpleModeTable` promotes
 * with one blanket `UPDATE … WHERE status='draft'`, which has no per-row
 * opinion and therefore cannot refuse a fact or say which one it refused.
 * ADR-0036 states no-provenance-no-promotion and no-grant-no-promotion as
 * absolutes, and "refuse with an actionable error" is per-row by definition —
 * so the promote path has to be able to name a row. See `lib/brain/promotion.ts`
 * for WHICH of those rules is live and which is defense in depth.
 *
 * #4823 added a second per-row opinion on the same seam: the grant a fact is
 * published WITH. ADR-0036 §T5 permits a grant to widen only at the review
 * gate, and publish is the review gate — so a draft whose evidence includes an
 * episode granted more widely than the fact itself is promoted with the union
 * (`widenGrantFromEvidence`). Both opinions are per-row and neither is
 * expressible as a blanket UPDATE, which is the same reason twice. Both are
 * grep-guarded: `check-brain-fact-promotion.sh` refuses an `UPDATE brain_facts
 * … SET … status` OR `… visible_to` outside its allowlist. The `visible_to` arm
 * is UPDATE-only on purpose — `reconcile.ts` writes the column at INSERT, which
 * IS the derive-at-ingest grant and must stay legal.
 *
 * The alternative considered and rejected was widening `SimpleModeTable` with a
 * `refuse` SQL fragment. That restates the grant grammar in SQL — a second
 * source of truth for the thing `acl.ts` exists to be the only source of truth
 * for — and it would put table-specific machinery in the shape four other
 * tables share. Exotic keeps the cost local.
 *
 * ## Refuse the row, never the workspace
 *
 * A refused fact is left `draft` and the transaction commits. Failing the
 * shared publish transaction was considered and rejected: facts arrive
 * continuously from #4771's extraction fiber, so a single deriver bug would
 * wedge a tenant's ENTIRE publish — every prompt, entity, and connection — until
 * somebody hand-edited the database. Quarantining the row keeps the blast
 * radius at one claim, and the row stays counted in `draftCounts`, listed in
 * the publish preview, and re-offered next publish, so the refusal is a visible
 * backlog rather than a silent drop.
 */

import { Effect } from "effect";
import type { AtlasMode } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";
import { isUnknownArray, logGrantAnomalies } from "@atlas/api/lib/brain/acl";
import {
  IDENTITY_MUTATION_LOCK_NAMESPACE,
  IDENTITY_MUTATION_LOCK_SQL,
  IDENTITY_MUTATION_LOCK_RESET_SQL,
  IDENTITY_MUTATION_LOCK_TIMEOUT_SQL,
  isLockTimeout,
} from "@atlas/api/lib/brain/identity";
// *Provably different*, spelled once (#5030). The reconcile stage negates the
// SAMENESS half of the same module, so the two seams cannot drift into
// disagreeing about which pairs are merely `unknown`.
import { comparableDifferentSql } from "@atlas/api/lib/brain/object-cmp";
// Cardinality as a property of the canonical predicate (#5027), replacing the
// both-sides row comparison this file used to spell inline. Imported for the
// same reason as the arm above: one place says what collides.
import { cardinalitySingleSql } from "@atlas/api/lib/brain/cardinality";
// The tier vocabulary (#5033). Derived from `EPISODE_SOURCE_SPECS`'s declared
// classes, so a future warehouse-class member inherits the guard below without
// touching this file.
import { NON_WAREHOUSE_SOURCES } from "@atlas/api/lib/brain/sources";
import {
  classifyFactForPromotion,
  isJsonObject,
  widenGrantFromEvidence,
  type DraftFactRow,
  type StoredGrant,
} from "@atlas/api/lib/brain/promotion";
import {
  PublishPhaseError,
  type FactSupersession,
  type GrantWidening,
  type ModeTxClient,
  type PromotionRefusal,
  type PromotionReport,
} from "@atlas/api/lib/content-mode/port";

const log = createLogger("brain-facts-publish");

/**
 * The physical table — the report's `table` and the lookup key non-registry
 * callers (e.g. `admin-publish.ts`) use to find this adapter's report.
 *
 * `tables.ts` deliberately spells the same string as a LITERAL rather than
 * importing this. `port.ts → tables.ts → adapters/* → port.ts` is a live ESM
 * cycle, and whether this module has finished initializing when the tuple is
 * constructed DEPENDS ON WHICH MODULE THE GRAPH IS ENTERED THROUGH: enter via
 * `port.ts` and the adapter body has already run, so a `const` resolves fine;
 * enter via this adapter (as `adapters/__tests__/brain-facts.test.ts` does) and
 * the tuple is built while this module is mid-initialization, putting a `const`
 * in its temporal dead zone. That entry order is not something a caller
 * controls, so the tuple may reference only hoisted function DECLARATIONS from
 * here. Do not "verify" this by importing `port.ts` first and concluding the
 * comment is wrong — that is the order that happens to work.
 *
 * (`semantic-entities.ts` also spells its key literally, but that is not
 * evidence either way: it exports no key const to import in the first place.)
 *
 * `adapters/__tests__/brain-facts.test.ts` asserts the two spellings agree,
 * which is what makes the duplication safe — a test is the only pin available
 * once the import is off the table.
 */
export const BRAIN_FACTS_TABLE = "brain_facts" as const;

/**
 * The read gate, stated once. `readFilter` below is built from it, and
 * non-Effect callers can use it directly — `resolveStatusClause` refuses exotic
 * entries by design (an exotic table's read semantics are usually an overlay
 * CTE it can't guess), so this is the fact class's equivalent seam.
 *
 * `alias` is interpolated, so callers must pass a plain identifier they control
 * — same contract as `resolveStatusClause` and `aclVisibilityClause`.
 *
 * ## It gates REVIEW STATUS ONLY — retraction is a separate axis
 *
 * This clause deliberately does NOT filter `invalidated_at`, unlike the four
 * promotion-side paths (`DRAFT_FACTS_SQL`, `PROMOTE_FACTS_SQL`,
 * `brainFactsCountSql`, and the publish preview), which all exclude retracted
 * rows. The asymmetry is intentional and load-bearing in both directions:
 * ADR-0036 keeps a retracted fact READABLE so "what we believed on Monday"
 * still answers correctly, and supersession is explicitly not deletion — so a
 * content-mode filter that also swallowed tombstones would break as-of reads.
 * Promotion is the opposite case: stamping "reviewed and trusted" on a claim
 * already withdrawn is never right.
 *
 * THE CONSEQUENCE FOR CALLERS, stated because composing the two advertised
 * seams is the obvious thing to do and is not sufficient: a CURRENT-BELIEF read
 * (#4773's `searchBrain`) must AND `invalidated_at IS NULL` itself, on top of
 * this clause and `aclVisibilityClause`. Omit it and the agent is served
 * retracted claims. (An earlier version of this note offered
 * `idx_brain_facts_subject`'s partial predicate as evidence the index was built
 * for that read. It was not — retrieval rides the FTS GIN index, and 0187
 * repointed `idx_brain_facts_subject` onto the identity keys, where it is the
 * slot index and nothing else.)
 */
export function brainFactStatusClause(mode: AtlasMode | undefined, alias: string): string {
  return mode === "developer"
    ? `${alias}.status IN ('published', 'draft')`
    : `${alias}.status = 'published'`;
}

/**
 * The SUPERSESSION half of a current-belief read (#4912) — hides facts whose
 * `valid_to` has passed, exactly as `invalidated_at IS NULL` hides tombstones.
 *
 * A third axis, deliberately separate from both the clause above and the
 * tombstone filter: `valid_to` is VALID time ("when the claim held in the
 * world"), stamped only by a human promotion superseding the fact, and it never
 * touches `status` or `invalidated_at`. A superseded fact is still `published`
 * (its review verdict stands) and still not retracted (nobody withdrew it) —
 * it is simply no longer the current belief, so an as-of-NOW read must skip it
 * while the as-of reads M2 adds can still serve it.
 *
 * `> now()`, not `IS NULL` alone: the stamp writes `now()` so an in-region
 * `valid_to` is always past by read time, but a region import restores the
 * column verbatim and a future bound is "still valid", not "superseded".
 *
 * Spelled once here, beside the status clause, because the same composition
 * trap applies (see `brainFactStatusClause`'s header): a current-belief read
 * now composes FOUR predicates — ACL, status, tombstone, and this — and a
 * caller that forgets this one serves superseded claims as current belief.
 * `alias` is interpolated; callers pass a plain identifier they control.
 */
export function brainFactCurrentClause(alias: string): string {
  return `(${alias}.valid_to IS NULL OR ${alias}.valid_to > now())`;
}

/**
 * Draft facts awaiting review, with exactly the columns
 * `classifyFactForPromotion`'s refusal rules read.
 *
 * It used to also select `predicate_cardinality`, and this docstring used to
 * say that column WAS the supersession input (#4912). Since #5027 it is not:
 * cardinality is a property of the canonical predicate, read live from
 * `brain_predicate_cardinality` inside the collision predicate itself
 * ({@link cardinalitySingleSql}). Nothing on the draft row decides whether it
 * may supersede, which is why nothing here has to carry it.
 *
 * `FOR UPDATE` because this adapter is read-then-write, which the simple
 * entries are not: it serializes two concurrent publishes on the same
 * workspace, so the second one classifies the state the first COMMITTED rather
 * than a snapshot taken mid-flight. The lock is workspace-scoped and held only
 * for the rest of the caller's transaction.
 *
 * Be precise about what it buys, because the obvious claim is wrong and was
 * written here first: it is NOT the only thing standing between two publishers
 * and a double-promote. The promote UPDATE's own `status = 'draft'` predicate
 * is re-evaluated against the committed row version after it unblocks, so it
 * independently matches zero rows the second time. The two are REDUNDANT — a
 * live-PG race (`promotion-pg.test.ts`) confirms that removing either one alone
 * still promotes each draft exactly once, and only removing BOTH double-counts.
 * Both are kept: the guard makes the UPDATE correct standalone, and the lock
 * makes the read-then-write actually serial rather than correct-by-coincidence
 * of the guard — which also stops both publishers logging grant anomalies for
 * the same rows.
 *
 * Unbounded by design: the row set is exactly what `draftCounts.brainFacts`
 * already reports, and what the publish preview accounts for in full — since
 * #4825 that is `brainFacts` PLUS `brainFactsWithheld`, because the preview
 * scoped its LABELS to the reader while leaving its arithmetic workspace-wide.
 * So a LIMIT here would silently promote a prefix — the one outcome a review
 * gate must never produce.
 */
export const DRAFT_FACTS_SQL = `
  SELECT id::text AS id,
         subject,
         predicate,
         object,
         source_episode_id::text AS source_episode_id,
         provenance,
         visible_to
    FROM brain_facts
   WHERE workspace_id = $1
     AND status = 'draft'
     AND invalidated_at IS NULL
   ORDER BY ingested_at
     FOR UPDATE
`;

/**
 * Promote the classified-promotable subset, by explicit id.
 *
 * The `status = 'draft'` predicate is kept alongside the id list even though
 * `FOR UPDATE` already pins the rows: it makes the statement correct on its own
 * terms, so a future refactor that drops the lock cannot turn this into a
 * republish of archived facts.
 */
export const PROMOTE_FACTS_SQL = `
  UPDATE brain_facts
     SET status = 'published', updated_at = now()
   WHERE workspace_id = $1
     AND status = 'draft'
     AND invalidated_at IS NULL
     AND id = ANY($2::uuid[])
`;

/**
 * Every episode that is already EVIDENCE for one of these drafts, with its
 * grant — the input to publish-time grant widening (#4823).
 *
 * Restricted to `provenance` edges, which is the fact class's evidence pointer.
 * Be precise about whose decision that is: ADR-0036 constrains WHEN a grant may
 * widen (only at the review gate), not which edge feeds it — and its one worked
 * example, T9 lock 3, is a `derives-from` edge. Narrowing to `provenance` is
 * #4823's own choice, because "that episode SAYS this" is a stronger warrant
 * than "this was DERIVED FROM that", and widening off a derivation would let a
 * lineage relationship move an ACL field. The consequence, stated because it is
 * easy to miss: an M5 write-back fact whose only evidence edge is `derives-from`
 * will not widen here.
 *
 * Workspace-scoped on BOTH sides of the join, not just the edge. The composite
 * FKs make a cross-tenant edge unstorable today, so the second predicate is
 * defense in depth — but it is defense in depth on the one query in this file
 * whose output WIDENS an ACL, where the failure mode is disclosure rather than
 * the fail-closed over-restriction everything else here degrades to.
 *
 * Ordered so the stored token order does not depend on the query plan. It is
 * NOT a meaningful chronology: `ingested_at` defaults to the inserting
 * transaction's timestamp, so episodes written in one ingest batch tie and
 * break by random uuid — and `occurred_at`, which would be the honest
 * chronology, is nullable. Determinism is all that is claimed, and all that is
 * needed.
 */
export const EVIDENCE_GRANTS_SQL = `
  SELECT e.from_fact_id::text AS fact_id,
         ep.id::text          AS episode_id,
         ep.visible_to        AS visible_to
    FROM brain_edges e
    JOIN brain_episodes ep
      ON ep.workspace_id = e.workspace_id
     AND ep.id = e.to_episode_id
   WHERE e.workspace_id = $1
     AND e.edge_type = 'provenance'
     AND e.from_fact_id = ANY($2::uuid[])
   ORDER BY ep.ingested_at, ep.id
`;

/**
 * Promote the subset whose grant the evidence widened, each with its own new
 * `visible_to` (#4823).
 *
 * Separate from {@link PROMOTE_FACTS_SQL} rather than folded into it, even
 * though one statement with a `FROM (…) w` would cover both: widening is rare
 * (it needs the same claim stated across two differently-granted sources) and
 * a single statement would rewrite `visible_to` on EVERY promoted fact,
 * round-tripping thousands of grants through jsonb to change none of them. The
 * blast radius of the write that touches an ACL should be exactly the rows
 * whose ACL changed.
 *
 * `$2` is a jsonb array of `{id, grant}` for the BATCH episode insert's reason
 * (`ingest/episodes.ts`), not `INSERT_FACT_SQL`'s — per-row grants of differing
 * length would otherwise need a ragged `text[][]`, which POSTGRES requires to
 * be rectangular, so a batch mixing a 1-principal and a 2-principal grant could
 * not be bound at all.
 *
 * The `status = 'draft'` predicate is kept for {@link PROMOTE_FACTS_SQL}'s
 * reason — it makes the statement correct on its own terms. `DRAFT_FACTS_SQL`
 * is what actually keeps a published id out of the payload; this is the second
 * lock on the same door, and on this statement the door is an immutable grant.
 *
 * ## `pre_widening_visible_to` — the reason this statement is now load-bearing
 * ## twice (#4836)
 *
 * This is the only place the pre-widening grant is DERIVED, and the only
 * chance to capture it: the next expression in the same SET list destroys it.
 * (It is not the only writer — the region import restores the column verbatim
 * from the bundle, `admin-migrate.ts`. That path carries a value; this one
 * computes it.) Postgres evaluates every SET expression against the OLD row, so
 * `f.visible_to` here is the grant before this statement's own overwrite — no
 * ordering dependency between the two assignments, and none is available to
 * depend on.
 *
 * Without it, nothing at rest could tell "visible to org because it always was"
 * from "visible to org because evidence widened it", and `projectProvenance`
 * would have no input for the narrowing #4836 requires. `EvidenceWidenedGrant`
 * knows the answer in memory and is discarded one statement later.
 *
 * `COALESCE` keeps the FIRST pre-widening grant rather than the latest. The
 * `status = 'draft'` predicate plus the `status = 'published'` write make a
 * second widening unreachable on the normal path — but a region import writes
 * `status` verbatim (ADR-0024) and can legitimately land an already-widened
 * fact back in `draft`. Overwriting would then record the WIDER grant as the
 * original and disclose attribution to readers the first widening admitted;
 * COALESCE degrades to over-withholding instead, which is the direction this
 * column exists to fail in.
 */
export const WIDEN_AND_PROMOTE_FACTS_SQL = `
  UPDATE brain_facts f
     SET status = 'published',
         pre_widening_visible_to = COALESCE(f.pre_widening_visible_to, f.visible_to),
         visible_to = ARRAY(SELECT jsonb_array_elements_text(w.grant)),
         updated_at = now()
    FROM (
      SELECT (entry->>'id')::uuid AS id,
             entry->'grant'       AS grant
        FROM jsonb_array_elements($2::jsonb) AS entry
    ) AS w
   WHERE f.workspace_id = $1
     AND f.status = 'draft'
     AND f.invalidated_at IS NULL
     AND f.id = w.id
`;

/**
 * The tier vocabulary as a SQL array literal, built ONCE at module load.
 *
 * Spliced unquoted, and safe because `sources.ts` enforces
 * `EPISODE_SOURCE_SLUG` over the whole vocabulary at ITS module load — the
 * validation lives beside the values rather than beside this consumer, so the
 * next seam that splices the list inherits it and the rule cannot be spelled
 * two ways. Nothing user-supplied reaches here: every element is a
 * compile-time key of `EPISODE_SOURCE_SPECS`.
 *
 * An EMPTY list (every member warehouse-class) yields `ARRAY[]::text[]` — valid
 * SQL, false for every row, so the guard degrades to "only a `source`-less row
 * may supersede". Fail-closed, and `brain/__tests__/sources.test.ts` asserts
 * non-emptiness so the degradation is a red test rather than a quiet narrowing.
 */
const NON_WAREHOUSE_SOURCE_ARRAY_SQL = `ARRAY[${NON_WAREHOUSE_SOURCES.map(
  (source) => `'${source}'`,
).join(", ")}]::text[]`;

/**
 * The TIER GUARD (#5033, ADR-0037 §4) — *identity is source-agnostic;
 * consequence is tier-ordered.*
 *
 * True when this row's stored provenance is evidence that the row is not
 * tier-1 — **or names no source at all**, which is the deliberate carve-out
 * below and the one population that passes on no evidence.
 *
 * A warehouse-derived fact is authoritative by construction and has no
 * correction path at all (`brain/correction.ts` refuses every verb on one), so
 * an LLM-extracted draft stamping its `valid_to` retires an authoritative belief
 * that no verb can restore: `supersede` refuses a target whose window is already
 * closed, and every as-of-now read then hides the row it touched.
 *
 * ⚠️ **What happens instead is not "the join matches and the stamp is skipped".**
 * The guard is inside the predicate, so the pair drops out of the join
 * ENTIRELY: the will-supersede preview returns 0 for it and the transaction
 * discloses and stamps nothing. What survives is a DIFFERENT record, written by
 * a different statement at a different time — the advisory `in-tension-with`
 * edge `reconcile.ts` mints at ingest — and that is where a human arbitrates.
 * Because those are two separate mechanisms, the edge is not guaranteed to
 * exist for every held-back pair (a post-ingest re-key can create a collision
 * that never existed at ingest, and `TENSION_EDGE_CAP` bounds the fan-out), which
 * is why `promoteBrainFacts` counts the held-back pairs and warns rather than
 * trusting the edge to be the trace.
 *
 * ## It reads as a REFUSAL to claim a tier, not as "is not warehouse"
 *
 * Four populations, and the third is why this is an allowlist:
 *
 *   - `source` names a member of {@link NON_WAREHOUSE_SOURCES} → TRUE. The
 *     ordinary case: every stored kind not declared `class: "warehouse"`. Not
 *     spelled out here on purpose — the list is DERIVED, and a docstring naming
 *     today's four members would go stale on the fifth.
 *   - `source` resolves to a WAREHOUSE-class member → FALSE. The case the guard
 *     exists for. Listed separately from the one below because
 *     `unrecognizedSourceKind()` returns `null` for it — `correction.ts` refuses
 *     it under `warehouseTarget`, a different reason with different prose — so
 *     folding the two together would break that mapping.
 *   - `source` is PRESENT and does not resolve — `warehouse:prod`, `snowflake`,
 *     `null`, `42` → NOT TRUE, so the pair is excluded. (`false` for a value;
 *     SQL `NULL` for a JSON `null`, since `NULL = ANY (…)` is unknown. The
 *     distinction costs nothing while every STAMPING OR DISCLOSING caller uses
 *     this predicate positively — an `ON` arm or an `EXISTS`. There is exactly
 *     one negative caller, {@link TIER_HELD_BACK_COUNT_SQL}, and it is why
 *     `IS NOT TRUE` is mandatory there and a bare `NOT (…)` wrapper is
 *     forbidden everywhere: `NOT (NULL)` is NULL, which would drop this very
 *     population out of the count that exists to see it.) This is #4964's conclusion applied
 *     one seam over. `isWarehouseDerivedSource` answers `false` for an
 *     unrecognised kind, and that used to be called the safe direction; it is
 *     precisely wrong for the ONE lane that produces such values, the region
 *     import, which restores a bundle's `source` verbatim with no vocabulary
 *     gate. `correction.ts` quarantines the correction path of such a fact
 *     rather than pretending it is tier-2 — `unrecognizedSourceKind()`, whose
 *     two refusal reasons (`unrecognizedSourceKind` for a resolvable string,
 *     `malformedSourceKind` for a non-string) are exactly the two shapes this
 *     arm excludes — and the same reasoning is stronger here: a lost correction
 *     refusal is recoverable by a deploy, a `valid_to` stamp is recoverable by
 *     nothing.
 *   - `source` is ABSENT entirely → TRUE, and this carve-out is deliberate.
 *     `correction.ts` makes exactly the same one, in as many words: *that shape
 *     predates this lane, nothing structurally guarantees the key, and
 *     quarantining it would retire the correction path for facts no import ever
 *     touched — a regression dressed as a fix.* Read `retire the supersession
 *     path` for the same sentence here. `reconcile.ts` spreads
 *     `source: episode.source` — a `string` — after the producer's detail, so a
 *     row it wrote always has the key; a row without one predates that or came
 *     through the import. The residual is the same one the record already
 *     accepts: DELETING `source` from a bundle evades both gates. The lane is
 *     narrowed, not sealed.
 *
 * `NOT jsonb_exists(…)` is also TRUE for any provenance that is not an OBJECT
 * at all — a jsonb scalar or array has no `source` key either. That would be a
 * fail-OPEN reading of the first disjunct, and it is unrepresentable rather than
 * handled: `chk_brain_facts_provenance_nonempty` requires
 * `jsonb_typeof(provenance) = 'object'`, and the column is NOT NULL. The guard's
 * fail-closed property therefore DEPENDS on that CHECK — named here so a
 * migration relaxing it trips over the dependency. `correction.ts`'s
 * `unrecognizedSourceKind` short-circuits on the same condition
 * (`if (!isJsonObject(provenance)) return null`), so the two seams agree.
 *
 * ## Both sides, and warehouse↔warehouse too
 *
 * The caller applies this to the published row AND the draft, because
 * ADR-0037 §4 is symmetric: a newly-produced warehouse fact colliding with a
 * published extracted fact is *also* tension-only. Auto-stamping there is
 * autonomous supersession by ADR-0036's own definition with merely the
 * sympathetic side winning — and the warehouse row is a snapshot that may
 * already be hours old, while a stale extracted fact in visible tension is
 * recoverable.
 *
 * That makes warehouse↔warehouse re-emission tension-only as well: the producer
 * re-runs, a price moves, and the new snapshot does NOT retire its own
 * predecessor. Recorded as open Fog in #5008's resolution, not overlooked — the
 * escape (the producer stamps its own previous snapshot) is a machine
 * invalidating a fact, which #4759 §2 forbids by name. The weakening that
 * re-opens it is the one that blocks only when EXACTLY ONE side is warehouse —
 * i.e. warehouse↔warehouse may stamp. `warehouse-both` in
 * `brain/__tests__/identity-corpus.ts` exists to pin that single sentence.
 *
 * `alias` is interpolated; callers pass a plain identifier they control — same
 * contract as {@link supersessionCollisionPredicate} itself.
 */
function supersedableTierSql(alias: string): string {
  // Continuation indented to match `comparableDifferentSql`'s, so the two arms
  // of the join read as siblings rather than as one nested inside the other.
  return `(NOT jsonb_exists(${alias}.provenance, 'source')
      OR ${alias}.provenance->>'source' = ANY (${NON_WAREHOUSE_SOURCE_ARRAY_SQL}))`;
}

/**
 * The supersession collision (#4912, ADR-0036 §Temporal), spelled ONCE.
 *
 * Joins a draft alias `d` to every already-published fact it would supersede:
 * the same WORKSPACE, the same SLOT — `(subject_key, predicate_key)` — a
 * PROVABLY DIFFERENT object, a shared canonical predicate DECLARED
 * `single`-cardinality, and BOTH sides
 * either carrying positive evidence that they are NOT tier-1 or naming no
 * source at all ({@link supersedableTierSql}, #5033). Read that arm's three
 * other three populations before summarizing it as "below tier-1": an
 * UNRESOLVABLE kind is excluded despite proving nothing either way, and an
 * ABSENT `source` is admitted on no evidence at all. The published side must be live (not tombstoned) and
 * current (`valid_to IS NULL`) — a fact some earlier promotion already
 * superseded is settled history, and stamping it twice would rewrite when the
 * belief ended.
 *
 * ## ⚠️ The object arm is `object_cmp`, NOT `object_key <>` (#5030, ADR-0037 §2)
 *
 * This is the single largest behaviour change the identity map makes, and it is
 * a NARROWING that will read as a regression to anyone who finds it by watching
 * supersessions stop happening.
 *
 * *same* and *different* are not complements. `object_key <> object_key` proves
 * only that two surfaces did not normalize together — which is true of `$499`
 * and `499 USD`, one belief spelled twice, and stamping `valid_to` there
 * destroys a fact nothing contradicted. Supersession is the one operation in
 * this product with NO inverse: there is no un-supersede verb, and both of
 * `correct_fact`'s vouching verbs refuse a target whose window has closed
 * (`brain/correction.ts`). So it now requires POSITIVE evidence of difference —
 * both sides carrying a comparable value, of the same type, that disagree.
 *
 * Everything else is `unknown` and falls to the advisory tension edge
 * `reconcile.ts` already wrote. Nothing is lost from a reviewer's view; what is
 * lost is the unattended stamp behind it.
 *
 * **The consequence, stated plainly because it is permanent:** with
 * `passthroughEntityResolver` shipped as the default, an entity-valued object
 * (`Ada / reports to / Grace` vs `Alan`) has no comparable value on either side
 * and NEVER supersedes. Only parseable values do — money with an explicit
 * currency, plain numbers, dates, instants, booleans — plus resolved entity ids,
 * for which #5031 built the batched seam and which arrive the day a workspace
 * injects a real store. That is `passthroughEntityResolver` behaving
 * honestly rather than pretending: with no entity store the system genuinely
 * cannot prove `Grace` and `Alan` are different people, and inferring it from
 * two strings failing to match is the guess that costs a belief.
 *
 * **And it is permanently two-tier.** Migration 0191 does not backfill, so every
 * row written before it keeps `object_cmp` NULL forever and can never prove
 * difference — with nothing on the row saying so. Backfilling would retroactively
 * manufacture positive evidence on pairs a reviewer already saw as `unknown`,
 * and unlike a cardinality flip there is no gate to hang a preview on. Recorded
 * as an accepted cost in #5030, in 0191's header, and in the ADR.
 *
 * ## Why the keys and not the surfaces (#5020, ADR-0037 §1)
 *
 * This is a column-to-column join, so BOTH sides are the materialized identity
 * `alias(lexicalNorm(surface))`, written at ingest by `reconcile.ts` and never
 * re-derived here. On the surfaces it silently no-op'd on a phrasing mismatch: a
 * draft saying `Ships On` never collided with a published `ships_on`, so publish
 * left two current `single` values standing and the disclosure showed nothing to
 * disclose. Same index either way — 0187 repointed `idx_brain_facts_subject`
 * onto the key columns with a partial predicate this join already satisfies.
 *
 * A NULL on EITHER side of ANY arm excludes the pair, since `=` and `<>` are
 * both unknown against NULL. That is fail-closed and the direction this join
 * must fail in — no collision means no `valid_to` stamp, which is the
 * recoverable outcome — but it is not free, and the cost is symmetric: such a
 * row can neither BE superseded nor supersede anything, so an unkeyed draft
 * publishes beside a live rival and an unkeyed published fact survives one.
 * Three populations reach it through the KEY arms, and only two of them are
 * transient (`object_cmp` NULL is a fourth and is not a defect at all — it is
 * `unknown` doing its job, per the ⚠️ above):
 *
 *   - Rows written between migration 0187 and #5020 — closed by 0188, which
 *     repeats 0187's re-runnable backfill in #5020's own deploy.
 *   - Rows a region import lands, until #5035 carries keys verbatim on the v3
 *     bundle (`admin-migrate.ts`'s 18-column INSERT names no key column). A
 *     backfill cannot own this one: it runs at boot, the import runs on demand.
 *   - A surface that norms away (`-`, `___`) — PERMANENT and legal, per
 *     `identityKey`'s ⚠️. No backfill repairs it; `reconcile.ts` warns at
 *     ingest, which is the only signal such a claim ever produces.
 *
 * `valid_to IS NULL`, deliberately NOT `brainFactCurrentClause`'s wider
 * `IS NULL OR > now()`: a FUTURE-dated `valid_to` (reachable only via a region
 * import restoring a closed window verbatim) is a fact still answering
 * as-of-now reads whose end a human already decided. Superseding it would
 * overwrite that recorded end with `now()` — rewriting an imported validity
 * decision from an unrelated promotion — so a colliding draft COEXISTS with it
 * until the window closes on its own. Accepted, not overlooked: the same
 * choice, for the same reason, in `TENSION_CANDIDATES_SQL` (`reconcile.ts`),
 * which likewise leaves such a row alone. The cost is a briefly tension-less
 * coexistence of two current values; the alternative destroys an import.
 *
 * ## The both-sides cardinality clause is DELETED, not weakened (#5027, §3)
 *
 * This arm used to read `p.predicate_cardinality = 'single' AND
 * d.predicate_cardinality = 'single'`, and the reason given was that the two
 * rows could disagree about the predicate. They could — because each carried
 * its own opinion, and each opinion was an independent LLM guess against a
 * prompt biased toward `multi`, so the conjunction fired at roughly
 * P(model says `single`)². A column everyone believed unpopulated was in fact a
 * STOCHASTIC gate on an irreversible operation.
 *
 * {@link cardinalitySingleSql} is ONE lookup on the shared `predicate_key`. Two
 * rows in one slot can no longer disagree about cardinality, because they no
 * longer each carry an opinion — the fourth cause of #5000's symptom is made
 * UNREPRESENTABLE rather than repaired. Absent from the vocabulary means
 * `multi`, so an uncurated predicate never supersedes: the same conservative
 * outcome as before, now deterministic instead of a coin flip.
 *
 * `d`, not `p`, and either would do — the identity arms above already equate
 * both sides' `workspace_id` and `predicate_key`, which is exactly what makes
 * one lookup sufficient.
 *
 * A builder rather than a constant because THREE statements need the identical
 * join and must never drift: the promote-time targets SELECT below, the
 * oversight disclosure's pair listing (`lib/brain/oversight.ts`), and the
 * publish preview's will-supersede count. Two spellings of "what collides" is
 * a disclosure that lists one set while the transaction stamps another —
 * silent supersession through drift, the exact thing #4912 forbids.
 *
 * `d` / `p` are interpolated; callers pass plain identifiers they control —
 * same contract as `brainFactStatusClause`.
 */
export function supersessionCollisionJoin(d: string, p: string): string {
  return `JOIN brain_facts ${p}
      ON ${supersessionCollisionPredicate(d, p)}`;
}

/**
 * The same collision, as a bare predicate rather than a JOIN's `ON` clause.
 *
 * Extracted by #5024 because the stamp now re-checks the collision from inside
 * an `EXISTS`, where a `JOIN` cannot go — and the docstring above already
 * forbids the alternative in as many words: *two spellings of "what collides" is
 * a disclosure that lists one set while the transaction stamps another*. There
 * were three statements that had to agree; there are four now, and they agree
 * because there is still exactly one place the arms are written.
 *
 * {@link supersessionCollisionJoin} is the only reason this is not simply
 * inlined everywhere: three of the four callers want the `JOIN` spelling, and
 * building the `JOIN` from the predicate keeps that convenience without letting
 * it become a second copy.
 */
export function supersessionCollisionPredicate(d: string, p: string): string {
  return `${collisionIdentityPredicate(d, p)}
     AND ${supersedableTierSql(p)}
     AND ${supersedableTierSql(d)}`;
}

/**
 * The collision MINUS the tier guard — every arm about identity, cardinality and
 * the published row's live-and-current state, and nothing about consequence.
 *
 * Exists for exactly one reason: {@link TIER_HELD_BACK_COUNT_SQL} has to ask
 * *"which pairs would have collided but for the tier?"*, and the only two
 * spellings of that available were (a) copy the arms, which
 * {@link supersessionCollisionJoin}'s header forbids at length, or (b) split the
 * predicate at the one seam that makes the question expressible. This is (b) —
 * so the shipped guard is `core AND card AND tier(p) AND tier(d)` and the
 * diagnostic is `core AND card AND (tier(p) AND tier(d)) IS NOT TRUE`, both
 * built from ONE spelling of each piece. (`core` became a real function name in
 * #5027 — {@link collisionCorePredicate}, which EXCLUDES the cardinality arm —
 * so this formula names `card` separately where an earlier version folded it
 * into an informal "core".) The negation is spelled `IS NOT TRUE` and never
 * `NOT (…)` — see {@link TIER_HELD_BACK_COUNT_SQL}'s ⚠️, which is not a style
 * note.
 *
 * ⚠️ **Private, and it must stay that way.** A caller reaching for this instead
 * of {@link supersessionCollisionPredicate} gets a collision rule with the tier
 * guard silently absent — which, applied to any of the four stamping or
 * disclosing statements, is #5033 deleted while looking like a refactor. The
 * name says `identity` rather than `collision` for that reason: what collides
 * is the exported predicate, and this is only the half of it that is not about
 * CONSEQUENCE. (It is not "the identity arms" narrowly — it also carries
 * cardinality and the published row's live-and-current state. What it excludes
 * is the tier, and nothing else.)
 *
 * The cardinality arm is a correlated EXISTS rather than a column comparison
 * since #5027, which changes nothing about this split: it is still one arm,
 * still evaluated inside the predicate, and still on the identity side of the
 * seam — {@link TIER_HELD_BACK_COUNT_SQL} must ask "which pairs would have
 * collided but for the TIER", and a pair the cardinality arm excluded never
 * collided at all.
 */
function collisionIdentityPredicate(d: string, p: string): string {
  return `${collisionCorePredicate(d, p)}
     AND ${cardinalitySingleSql(d)}`;
}

/**
 * The collision minus BOTH consequence gates — identity, provable difference,
 * and the published row's live-and-current state, and nothing about whether the
 * pair may act.
 *
 * Split off for {@link CARDINALITY_HELD_BACK_COUNT_SQL}, on exactly the argument
 * {@link collisionIdentityPredicate} makes for the tier: there are now two
 * questions of the form *"which pairs would have collided but for X?"*, and the
 * only two spellings available were to copy the arms — which this file's header
 * forbids at length — or to split at the seam that makes each question
 * expressible. Every statement is still built from ONE spelling of the core, ONE
 * of the tier, and ONE of the cardinality.
 *
 * ⚠️ **Private, and more dangerous than its sibling.** A caller reaching for
 * this instead of {@link supersessionCollisionPredicate} gets a collision rule
 * with the tier guard AND the cardinality gate silently absent — #5033 and
 * #5027 both deleted, while looking like a refactor.
 */
function collisionCorePredicate(d: string, p: string): string {
  return `${p}.workspace_id = ${d}.workspace_id
     AND ${p}.subject_key = ${d}.subject_key
     AND ${p}.predicate_key = ${d}.predicate_key
     AND ${comparableDifferentSql(`${p}.object_cmp`, `${d}.object_cmp`)}
     AND ${p}.status = 'published'
     AND ${p}.invalidated_at IS NULL
     AND ${p}.valid_to IS NULL`;
}

/**
 * How many provable collisions this publish is holding back because the
 * predicate is UNCURATED (#5027) — the operator-visible trace of a refusal that
 * is otherwise total and silent.
 *
 * ## Why this is required rather than symmetrical decoration
 *
 * {@link TIER_HELD_BACK_COUNT_SQL} exists because a tier-blocked pair leaves no
 * trace, and its docstring calls a warning *"required rather than nice to
 * have"*. Everything it says is true here and MORE so, in two ways:
 *
 *   - It withholds strictly more. `single` requires positive evidence and there
 *     is no backfill, so on the day this ships EVERY workspace has an empty
 *     vocabulary and the publish gate supersedes NOTHING, anywhere, until a
 *     human curates a predicate (#5025's UI). "Supersession stopped completely"
 *     with no log line is indistinguishable from "the cardinality read is
 *     broken".
 *   - It silently neutralized the diagnostic that shipped one commit earlier.
 *     The cardinality arm sits INSIDE {@link collisionIdentityPredicate}, which
 *     the tier count also joins on — so a pair excluded by cardinality never
 *     reaches the tier count either, and `heldBack` reads a constant `0` for as
 *     long as the vocabulary is empty. Adding this statement is what stops
 *     #5033's line from becoming decoration.
 *
 * And unlike the tier case it is ACTIONABLE, which is the reason it earns its
 * own round trip rather than a "no entries" flag: the number answers *"how many
 * beliefs would this publish retire if you curated their predicates?"*, which is
 * the prompt that makes a vocabulary get curated at all. A count, never labels —
 * `oversight.ts`'s rule.
 *
 * ## The two diagnostics partition, with one named gap
 *
 * Stamped is `core ∧ card ∧ tier`; the tier count is `core ∧ card ∧ ¬tier`; this
 * is `core ∧ ¬card ∧ tier`. A pair blocked by BOTH (`core ∧ ¬card ∧ ¬tier`)
 * appears in neither, deliberately: the tier refusal is permanent and the
 * curation one is not, so reporting such a pair as *"curate this and it will
 * supersede"* would be false. It stays invisible until the tier stops being the
 * reason, which is the conservative direction for a number an operator acts on.
 *
 * ⚠️ A bare `NOT (…)` is correct HERE and forbidden on the tier arm, and the
 * difference is worth stating because the file's other ⚠️ says the opposite.
 * `EXISTS` is a two-valued operator — it is never SQL NULL — so `NOT EXISTS`
 * cannot drop a row into the three-valued hole `supersedableTierSql`'s
 * `{"source": null}` provenance falls into. {@link cardinalitySingleSql} is an
 * `EXISTS`; {@link supersedableTierSql} is a comparison.
 */
export const CARDINALITY_HELD_BACK_COUNT_SQL = `
  SELECT COUNT(*)::int AS held_back
    FROM brain_facts d
    JOIN brain_facts p
      ON ${collisionCorePredicate("d", "p")}
   WHERE d.workspace_id = $1
     AND ${supersedingDraftPredicate("d")}
     AND d.id = ANY($2::uuid[])
     AND ${supersedableTierSql("p")}
     AND ${supersedableTierSql("d")}
     AND NOT ${cardinalitySingleSql("d")}
`;

/**
 * How many provable collisions this publish is HOLDING BACK on tier grounds
 * (#5033) — the operator-visible trace of a refusal that is otherwise silent.
 *
 * ## Why a warning is required rather than nice to have
 *
 * The tier guard filters inside the collision predicate, so a held-back pair
 * never reaches `supersessionPairs` and therefore never reaches the shortfall
 * warning below (`stamped.size !== oldIds.length` is unreachable for it). Without
 * this statement the publish reports `superseded: []`, a preview total of 0, and
 * NOT ONE log line — an operator cannot tell "no collision existed" from "a
 * provable collision was found and its consequence was permanently withheld".
 * The de-merge case one slice earlier got a line for a strictly weaker reason:
 * it is a transient race, where this is permanent.
 *
 * The obvious objection is that the pair is already visible as the
 * `in-tension-with` edge `reconcile.ts` writes. That is the DESIGN, and it is
 * not a guarantee: the edge is minted at INGEST, by a different statement, and
 * two reachable paths produce a held-back pair with no edge behind it — a
 * vocabulary re-key (`vocabulary-decide.ts`) merges two slots after ingest and
 * runs no tension rescan, and `TENSION_EDGE_CAP` bounds the fan-out at ten
 * rivals. So the edge is where a human ARBITRATES; this line is how an operator
 * learns there was something to arbitrate.
 *
 * ## Cost
 *
 * One extra `COUNT(*)` per publish that has at least one promotable draft — the
 * same guard the targets SELECT already sits behind. It used to say "at least
 * one promotable `single` draft", which was true while the adapter could tell
 * from the ROWS whether anything in the batch could supersede; since #5027 it
 * cannot, and the question is asked whenever there is anything to promote.
 * Publish is an admin action, not a hot path, and this reads no claim content:
 * a number, never a label, on `oversight.ts`'s rule.
 *
 * ⚠️ `IS NOT TRUE`, not `NOT (…)`, and the repo has already paid for this
 * distinction once. {@link supersedableTierSql} is SQL `NULL` — not `false` —
 * for a `{"source": null}` provenance, so `NOT (…)` is NULL there and the row
 * drops out of the count: the single most subtle held-back population would
 * become the one this warning cannot see. `objectNotSameSql` carries the
 * identical note in `brain/object-cmp.ts`, and its mutation row records that
 * weakening it to `NOT (…)` is caught by exactly one test.
 *
 * Run BEFORE the promote UPDATEs, beside {@link SUPERSESSION_TARGETS_SQL} and
 * carrying its draft-side predicate, so the two statements ask the same question
 * of the same rows and their answers partition the collisions.
 */
export const TIER_HELD_BACK_COUNT_SQL = `
  SELECT COUNT(*)::int AS held_back
    FROM brain_facts d
    JOIN brain_facts p
      ON ${collisionIdentityPredicate("d", "p")}
   WHERE d.workspace_id = $1
     AND ${supersedingDraftPredicate("d")}
     AND d.id = ANY($2::uuid[])
     AND (${supersedableTierSql("p")} AND ${supersedableTierSql("d")}) IS NOT TRUE
`;

/**
 * The draft side of the same collision: what the publish gate offers for
 * promotion, restated so the disclosure statements (which cannot reuse
 * `DRAFT_FACTS_SQL`'s id list) target exactly the rows the transaction will.
 */
export function supersedingDraftPredicate(d: string): string {
  return `${d}.status = 'draft' AND ${d}.invalidated_at IS NULL`;
}

/**
 * Which published facts each about-to-be-promoted draft supersedes.
 *
 * Run BEFORE the promote UPDATEs, deliberately: `status = 'published'` in the
 * join must mean "published before this publish began". Two colliding
 * `single` drafts promoted in the SAME batch have no temporal order between
 * them — `reconcile.ts` already recorded their `in-tension-with` edge — and a
 * collision rule evaluated post-promote (one without this statement's
 * draft-side predicate) would see each as the other's published rival and
 * stamp `valid_to` on both, destroying both beliefs. They coexist, in visible
 * tension, until a human retracts one. (As literally written, running this
 * after the promote would instead match NOTHING — the drafts are no longer
 * `draft` — which is the other failure: zero supersession. Either way the
 * ordering is load-bearing, and the unit test pins it.)
 *
 * `$2` is the classified-promotable ids, so a refused draft never supersedes
 * anything: the collision only fires for rows the transaction will actually
 * promote.
 *
 * It used to be the `single`-cardinality SUBSET of them, filtered in TypeScript
 * off each draft row's own `predicate_cardinality`. Since #5027 there is no such
 * column to filter on — cardinality belongs to the canonical predicate — and the
 * join's own {@link cardinalitySingleSql} arm is the whole test rather than a
 * re-check of a caller's pre-filter. Nothing widened: a draft whose predicate is
 * uncurated matches no entry and supersedes nothing.
 */
export const SUPERSESSION_TARGETS_SQL = `
  SELECT d.id::text AS draft_id, p.id::text AS superseded_id
    FROM brain_facts d
    ${supersessionCollisionJoin("d", "p")}
   WHERE d.workspace_id = $1
     AND ${supersedingDraftPredicate("d")}
     AND d.id = ANY($2::uuid[])
   ORDER BY d.ingested_at, d.id, p.ingested_at, p.id
`;

/**
 * Stamp the end of a superseded fact's validity — the ONE spelling of the
 * `valid_to` write (#4912), executed by exactly two allowlisted callers, each
 * with its own ARBITRATION: this adapter (a human promotion, inside the publish
 * transaction — {@link SUPERSEDE_STAMP_SQL}) and `correct_fact`'s supersede verb
 * (#4915, `lib/brain/correction.ts` — a human correction, inside the correction
 * transaction — {@link SUPERSEDE_STAMP_EXPLICIT_SQL}). Nothing autonomous ever
 * writes it, and `check-brain-fact-promotion.sh` refuses UPDATE-shape writes to
 * the column outside its allowlist (this file, `correction.ts`, plus
 * `admin-migrate.ts` — the region import restores an already-closed window
 * verbatim, a restore rather than a new arbitration).
 *
 * ONE builder, so the SET clause and the three target predicates are written
 * once and the two callers cannot drift. #5024 split the constants rather than
 * the statement: until then `correction.ts` imported the publish gate's string
 * verbatim, which stopped being possible the moment publish grew a predicate
 * that is FALSE for every human correction.
 *
 * Every predicate is re-checked even though the targets SELECT just evaluated
 * them: the published rows are NOT covered by `DRAFT_FACTS_SQL`'s `FOR
 * UPDATE` (that locks drafts), so a concurrent retraction can land between
 * the SELECT and this UPDATE. Re-checking makes the statement correct on its
 * own terms — it degrades to stamping fewer rows, and the caller warns on the
 * shortfall. `RETURNING id` is how the caller learns which pairs actually
 * superseded, so the `supersedes` edges and the report can never claim a
 * stamp that did not happen.
 */
function supersedeStampSql(arbitration: "collision" | "explicit"): string {
  // The collision arm is a THIRD conjunct on top of the two the explicit arm
  // already carries, never a replacement for either — so "the explicit statement
  // is the collision statement minus one predicate" is true by construction, and
  // `brain-facts.test.ts` pins it by comparing the two strings.
  //
  // NOTE what the EXISTS deliberately does NOT carry:
  // `supersedingDraftPredicate("d")`. This statement runs AFTER the promote
  // UPDATEs — `SUPERSESSION_TARGETS_SQL`'s header explains why the TARGETS read
  // must precede them — so by stamp time every id in `$3` is `published` and the
  // draft-side predicate would match zero rows, silently disabling the whole
  // guard. Draft-ness is historical here and `$3` is what records it: the list
  // IS `promotable`, so membership already means "was a promotable draft when
  // this transaction began". (It used to be `promotable` filtered to `single`;
  // since #5027 there is no per-row cardinality to filter on, which changes what
  // the list contains and not what membership MEANS — the premise this note
  // rests on is untouched.) What the re-check re-asks is the part an alias
  // decision can still have changed underneath it — the SLOT, and now also the
  // cardinality entry, which a `decideAmendment` can retract between the two
  // statements.
  //
  // An exhaustive SWITCH, not `arbitration === "explicit" ? "" : recheck`. The
  // ternary's open `else` means a third arm silently inherits the collision
  // re-check instead of failing to compile. #5033 was named here as a coming
  // third arm and turned out NOT to be one — see the `explicit` arm below,
  // which is where that answer is recorded.
  const collisionRecheck = ((): string => {
    switch (arbitration) {
      case "explicit":
        // NO TIER GUARD HERE, and that is #5033's answer rather than an
        // omission. The guard rides `supersessionCollisionPredicate`, so the
        // collision arm inherits it and this one does not — correct, because
        // `correctFact` refuses a warehouse-derived target for EVERY verb
        // before it reaches the stamp (`CORRECTION_REFUSAL_REASONS.warehouseTarget`),
        // and refuses an unresolvable source kind immediately after
        // (`unrecognizedSourceKind()`, #4964, whose two reasons —
        // `unrecognizedSourceKind` and `malformedSourceKind` — cover the string
        // and non-string halves). Both refusals cover the same two populations
        // `supersedableTierSql` excludes on the PUBLISHED side, evaluated one
        // layer up and earlier in the SAME transaction, against a row-locked
        // target — so there is no check-then-stamp window for a SQL re-check to
        // close. There is no draft-side equivalent because there is no draft:
        // the superseding row is the replacement `correctFact` installs, which
        // enters through `reconcileFacts` carrying `HUMAN_SOURCE`.
        //
        // Restating them here would be strictly worse, not merely redundant: a
        // SQL arm cannot say WHY it refused, so a target that reached the stamp
        // would stamp zero rows and trip `correction.ts`'s own zero-rows throw,
        // which reports statement DRIFT and surfaces to the agent as a
        // transient-sounding retry suggestion (`lib/tools/correct-fact.ts`).
        // That is advice that loops forever on a permanent tier-1 condition. A tier-1
        // correction has to fail as an actionable refusal naming the warehouse,
        // which is what it already does. The two arbitrations differ in their
        // WARRANT, and the switch is what makes that a decision rather than an
        // inheritance.
        return "";
      case "collision":
        return `
     AND EXISTS (
       SELECT 1
         FROM brain_facts d
        WHERE d.workspace_id = $1
          AND d.id = ANY($3::uuid[])
          AND ${supersessionCollisionPredicate("d", "p")})`;
      default: {
        // THROWS rather than returning `exhaustive`. At runtime that spelling
        // returns the argument itself and splices it into the statement text —
        // of the two available forms the fix first picked the one whose failure
        // mode is "unvalidated string into SQL". Every other exhaustive default
        // in this codebase throws.
        const exhaustive: never = arbitration;
        throw new Error(`supersedeStampSql: unhandled arbitration ${JSON.stringify(exhaustive)}`);
      }
    }
  })();
  return `
  UPDATE brain_facts p
     SET valid_to = now(), updated_at = now()
   WHERE p.workspace_id = $1
     AND p.id = ANY($2::uuid[])
     AND p.status = 'published'
     AND p.invalidated_at IS NULL
     AND p.valid_to IS NULL${collisionRecheck}
   RETURNING p.id::text AS id
`;
}

/**
 * The publish gate's stamp — the collision arbitration, RE-CHECKED (#5024).
 *
 * `$3` is the same promotable-draft id list `SUPERSESSION_TARGETS_SQL` was
 * given, so the statement re-asks the exact question that produced `$2` rather
 * than trusting the answer. (No longer filtered to `single` before it gets here
 * — #5027 moved cardinality off the row, so the re-check's own
 * {@link cardinalitySingleSql} arm is where that question is asked, on both
 * statements, from one spelling.)
 *
 * ## Why re-checking is not redundant with the lock, and both are kept
 *
 * #5024 also puts publish and alias approval under one advisory namespace
 * (`IDENTITY_MUTATION_LOCK_NAMESPACE`), which is what actually makes the
 * read-then-write serial. This predicate is the OTHER half of the pattern
 * `DRAFT_FACTS_SQL` argues for at length: *the guard makes the UPDATE correct
 * standalone, and the lock makes the read-then-write actually serial rather than
 * correct-by-coincidence of the guard.* A future refactor that drops the lock
 * cannot silently turn this into a stamp on a pair that no longer collides.
 *
 * The race it closes: alias ADDITION only creates collisions, so a pair that
 * starts colliding mid-publish is simply not stamped this round — safe. Alias
 * REMOVAL de-merges keys, and landing between the targets SELECT and this UPDATE
 * would stamp `valid_to` on a pair that no longer collides. That retires a
 * belief no arbitration supports, and every as-of-now read then hides the row it
 * touched, so the damage is invisible in both directions.
 *
 * Degrades to stamping FEWER rows, never more — and the caller already warns on
 * the shortfall, because `RETURNING` is how it learns which pairs actually
 * superseded. The `supersedes` edges and the report can never claim a stamp that
 * did not happen.
 *
 * ## It re-checks per TARGET, not per PAIR — recorded, not overlooked
 *
 * The `EXISTS` asks *"does ANY draft in `$3` still collide with this published
 * row?"*. With two same-slot `single` drafts in one batch and one rival — a case
 * `SUPERSESSION_TARGETS_SQL`'s header discusses as real — a de-merge that breaks
 * one pair while leaving the other still stamps the rival, and the `supersedes`
 * edge recorded for the broken pair claims an arbitration that no longer holds.
 *
 * Accepted, because the failure directions are not comparable: that is a stamp
 * that happened with the WRONG attribution, where what this guard exists to
 * prevent is a stamp that should not have happened at all — a belief retired
 * with no live collision, invisible to every as-of-now read. Closing the
 * attribution half needs the caller's one-array `oldIds` shape to become
 * per-pair, which is a change to `promoteBrainFacts`'s report contract rather
 * than to this statement.
 *
 * The outer `p.status` / `p.invalidated_at` / `p.valid_to` predicates are kept
 * even though {@link supersessionCollisionPredicate} repeats all three. They are
 * not duplication for its own sake: the shared builder has since grown arms that
 * narrow it further (#5033's tier guard), and this statement must keep refusing
 * to stamp a tombstoned or already-superseded row on its own terms whatever
 * happens to the collision rule.
 */
export const SUPERSEDE_STAMP_SQL = supersedeStampSql("collision");

/**
 * `correct_fact`'s supersede verb (#4915) — the EXPLICIT arbitration.
 *
 * Split out by #5024 rather than given the collision re-check, because a human
 * correction has no colliding draft and never did. Its superseding row is the
 * replacement `correctFact` installs, which is `published` (not `draft`, so
 * {@link supersedingDraftPredicate} excludes it) and which supersedes whatever
 * the human named regardless of `predicate_cardinality` — the reviewer IS the
 * arbitration. Applying the publish gate's predicate here would stamp nothing
 * and trip `correction.ts`'s own zero-rows throw on every correction.
 *
 * ONE spelling of the `valid_to` write survives that split, which is #4912's
 * actual requirement: both constants come out of {@link supersedeStampSql}, so
 * the SET clause and the three target predicates cannot drift between the two
 * arbitrations. What differs is the WARRANT, and naming the two warrants is
 * strictly more honest than one statement whose guard a caller switches off with
 * a NULL parameter — a guard nothing can falsify reads as protection without
 * being any.
 *
 * Still gated: `check-brain-fact-promotion.sh` refuses `valid_to` UPDATEs
 * outside its allowlist, and `correction.ts` is on it for this write.
 */
export const SUPERSEDE_STAMP_EXPLICIT_SQL = supersedeStampSql("explicit");

/**
 * The arbitration record, new → old (#4912): `supersedes` is the M2 edge the
 * type enum reserved from day one (`BRAIN_EDGE_TYPES`). Batch jsonb pairs for
 * `WIDEN_AND_PROMOTE_FACTS_SQL`'s reason; `WHERE NOT EXISTS` for
 * `INSERT_PROVENANCE_EDGE_SQL`'s — 0180 puts no unique index on the edge
 * tuple, and a region import can legitimately land a draft that already
 * carries the edge from its source region.
 */
export const INSERT_SUPERSEDES_EDGES_SQL = `
  INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
  SELECT $1, 'supersedes', (pair->>'newId')::uuid, (pair->>'oldId')::uuid
    FROM jsonb_array_elements($2::jsonb) AS pair
   WHERE NOT EXISTS (
     SELECT 1 FROM brain_edges e
      WHERE e.workspace_id = $1
        AND e.edge_type = 'supersedes'
        AND e.from_fact_id = (pair->>'newId')::uuid
        AND e.to_fact_id = (pair->>'oldId')::uuid)
   RETURNING id
`;

/** Draft count for the `brainFacts` segment of `/api/v1/mode` `draftCounts`. */
export function brainFactsCountSql(orgParam: string): string {
  return `SELECT 'brainFacts' AS key, COUNT(*)::int AS n FROM brain_facts WHERE workspace_id = ${orgParam} AND status = 'draft' AND invalidated_at IS NULL`;
}

/**
 * The publish preview's label projection — the drafts about to be promoted,
 * rendered as the SPO claim, GATED BY THE READER'S GRANTS (#4825).
 *
 * ## Why it is gated when the promote beside it is not
 *
 * The label IS the claim. `DRAFT_FACTS_SQL` above promotes every draft in the
 * workspace and that is deliberate — a reader-scoped promote would strand a
 * private channel's facts forever, with no resolvable reviewer to publish them.
 * But an unscoped LABEL query is a different thing entirely: it hands an admin
 * the exact claims `/admin/brain/facts` had just refused to show them, one
 * modal over. That is what this SQL used to be, and it is what `aclVisibilityClause`
 * on the caller's side now stops.
 *
 * The count the preview pairs it with comes from {@link brainFactsCountSql} —
 * the SAME statement `/api/v1/mode` `draftCounts.brainFacts` uses. Anchoring the
 * unscoped half there makes the modal's arithmetic (`shown + withheld` equals
 * the pending badge) true by construction rather than by two queries that
 * happen to agree.
 *
 * `aclSql` must alias the fact table `f` and is interpolated, so callers pass a
 * clause they built — same contract as `brainFactStatusClause`.
 *
 * Lives here rather than in the route so the `-pg` suite runs THIS string
 * against the live schema. It used to be hand-copied into the test, which is
 * how a projection with no unit test drifts from the one that ships.
 */
export function brainFactPreviewSql(aclSql: string): string {
  return `SELECT f.id::text AS id,
                f.subject || ' ' || f.predicate || ' ' || f.object AS label,
                f.updated_at
           FROM brain_facts f
          WHERE ${aclSql}
            AND f.status = 'draft'
            AND f.invalidated_at IS NULL
          ORDER BY f.updated_at DESC`;
}

/**
 * Narrow one `pg` row to the classifier's input.
 *
 * Returns `null` when the row has no usable `id`, which would make a refusal
 * unattributable and an UPDATE target unnameable. That is query drift, not
 * data: `id` is the PK and cast to text in the SELECT above. It fails the whole
 * phase rather than skipping the row, because skipping would leave a draft
 * silently unpromoted with no refusal recorded — indistinguishable from success.
 */
function toDraftFactRow(row: unknown): DraftFactRow | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return null;
  // SPO columns are `text NOT NULL`, so the fallback is unreachable from the
  // database — it exists so a shape change degrades the refusal MESSAGE rather
  // than throwing from inside a publish transaction.
  const text = (value: unknown): string => (typeof value === "string" ? value : "?");
  return {
    id: r.id,
    subject: text(r.subject),
    predicate: text(r.predicate),
    object: text(r.object),
    source_episode_id: typeof r.source_episode_id === "string" ? r.source_episode_id : null,
    provenance: r.provenance,
    visible_to: r.visible_to,
  };
}

/**
 * Bound on any id list this file spells out in a log line.
 *
 * The four uses have DIFFERENT backstops, which is worth knowing before raising
 * or lowering it:
 *
 *   - `widened` — a convenience on the two seams that sweep it (the complete
 *     list rides `PromotionReport.widened` to the REST route's and the MCP
 *     seam's durable records). NOT a convenience on
 *     `knowledge/ingest-bundle.ts`, which discards the report: there this cap
 *     IS the record, so lowering it silently narrows the only surviving
 *     account of an ACL change.
 *   - `superseded` — a convenience on all three publish surfaces since #4937;
 *     every one of them now sweeps `PromotionReport.superseded`.
 *   - the evidence-drift `factIds`, and the `missing` list when
 *     `SUPERSEDE_STAMP_SQL` stamps fewer rows than asked — NO complete record
 *     anywhere. The sample plus the count is all that exists, so the count is
 *     the number to act on, and these are the two that argue against lowering.
 */
const LOGGED_ID_SAMPLE_CAP = 20;

/**
 * Run a statement whose ONLY product is telemetry, so that its failure costs
 * the telemetry and never the transaction.
 *
 * `SAVEPOINT` → statement → on failure `ROLLBACK TO SAVEPOINT` and report 0.
 * Extracted rather than inlined because the shape is subtle in a way a reader
 * will otherwise "simplify": the obvious `Effect.catchAll` around the query
 * looks equivalent and is not, since Postgres aborts the whole transaction on
 * any statement error and every later statement then fails with `25P02`. The
 * savepoint is what makes the recovery real.
 *
 * `onFailure` is called with the cause and is REQUIRED — never silent, per
 * CLAUDE.md, and the caller supplies the message because only it knows which
 * signal was lost.
 *
 * ## `null` means "could not be computed", and it is not the same as 0
 *
 * Returning 0 on a failure would write a confident "nothing was held back" into
 * whatever durable record the caller keeps, which is exactly the ambiguity the
 * count exists to remove — and worse than the original, because a statement
 * that has DRIFTED fails on every publish thereafter, so the durable record
 * lies persistently rather than once. `null` makes the unknown state
 * representable; the caller decides how to render it.
 *
 * ## Every statement here is guarded, including `SAVEPOINT` itself
 *
 * An earlier cut left the two transaction-control statements unguarded, on the
 * reasoning that a failing `SAVEPOINT` means an already-dead connection. That
 * is FALSE for `25P01 no_active_sql_transaction`, which Postgres raises on a
 * perfectly healthy connection when there is no transaction block — and
 * `ModeTxClient` is a one-method interface that a bare pool satisfies
 * structurally, with nothing enforcing transactionality. So the reasoning would
 * have re-created the very failure this helper exists to prevent, one statement
 * earlier: a publish rolled back because its DIAGNOSTIC could not open a
 * savepoint. A failed `SAVEPOINT` is therefore also just a lost count, and the
 * `ROLLBACK` is skipped because there is nothing to roll back to.
 */
function advisoryCount(
  tx: ModeTxClient,
  opts: {
    readonly savepoint: string;
    readonly sql: string;
    readonly params: readonly unknown[];
    /** `null` for a row the reader cannot make sense of — drift, not data. */
    readonly read: (row: unknown) => number | null;
    readonly onFailure: (cause: unknown) => void;
  },
): Effect.Effect<number | null, never, never> {
  // `Effect.either` on each step rather than a `catch` that constructs a
  // `PublishPhaseError`: this helper has NO failure channel by design, so
  // there is no path by which a diagnostic can fail the phase.
  const attempt = (sql: string, params: readonly unknown[] = []) =>
    Effect.tryPromise({ try: () => tx.query(sql, [...params]), catch: (cause) => cause }).pipe(
      Effect.either,
    );
  return Effect.gen(function* () {
    // The name is a compile-time literal at every call site, never tenant data.
    const opened = yield* attempt(`SAVEPOINT ${opts.savepoint}`);
    if (opened._tag === "Left") {
      opts.onFailure(opened.left);
      return null;
    }
    const result = yield* attempt(opts.sql, opts.params);
    if (result._tag === "Left") {
      // ROLLBACK FIRST, report second. The recovery is the load-bearing half:
      // if a reporter ever threw — a serializer on a hostile cause, or an
      // `onFailure` that grows beyond logging — reporting first would leave the
      // transaction aborted (`25P02`) and every later statement, including the
      // promote UPDATEs, would fail.
      yield* attempt(`ROLLBACK TO SAVEPOINT ${opts.savepoint}`);
      opts.onFailure(result.left);
      return null;
    }
    // `rows?.[0]` — the same driver-shape defence `read` applies to the row's
    // CONTENTS, applied to the row's existence. A client wrapper reporting only
    // `rowCount` would otherwise throw a `TypeError` out of `Effect.gen`, which
    // is a DEFECT rather than a failure and escapes this helper's no-failure
    // contract entirely.
    return opts.read(result.right.rows?.[0]);
  });
}

/**
 * Read a held-back count's single column — {@link TIER_HELD_BACK_COUNT_SQL}
 * (#5033) or {@link CARDINALITY_HELD_BACK_COUNT_SQL} (#5027). WHICH one is the
 * `statement` parameter's business; see it for why that is not decoration.
 *
 * Degrades to `null` — *unknown* — never to 0. Throwing would fail the publish
 * over a diagnostic (CLAUDE.md's *prefer errors over silent fallbacks* governs
 * security checks that must not degrade to a false negative; this is
 * telemetry), and returning 0 would write "nothing was held back" into a
 * durable audit row on no evidence. Drift is PERSISTENT — a renamed column
 * fails every publish thereafter — so a confident 0 here would not be one bad
 * record but a standing lie. The drift is also never silent: it gets its own
 * warning, because a diagnostic that quietly stopped diagnosing is the failure
 * this statement exists to prevent, one level up.
 *
 * The accepted shape is a NON-NEGATIVE INTEGER, not merely "finite". `-1` would
 * otherwise pass, fail `> 0`, and produce neither the info line nor the warn —
 * a drifted statement reading exactly like "nothing was held back", which is
 * the one silence this whole statement exists to remove.
 *
 * `COUNT(*)::int` cannot return NULL or a non-numeric, so every arm here is
 * query drift rather than data. The string arm is kept for the reason
 * `oversight.ts`'s will-supersede total keeps one: driver-shape defence on a
 * number no caller can re-derive.
 */
function readHeldBackCount(
  raw: unknown,
  workspaceId: string,
  // PARAMETERIZED since #5027, and it is not decoration: there are two
  // statements shaped like this now, and a reader hard-coded to one of them
  // reports a drift in the CARDINALITY count as a tier-guard problem — sending
  // an operator to diff a statement that is provably fine, at the moment the
  // only trace of supersession having stopped workspace-wide has gone missing.
  // The `onFailure` messages were parameterized per call site from the start;
  // this one was the half that got left behind.
  statement: { readonly name: string; readonly withheldBecause: string },
): number | null {
  const value = isJsonObject(raw) ? raw.held_back : undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  log.warn(
    // `heldBackRaw`, deliberately NOT `heldBack`: that key carries a number on
    // the info line, and one field with two types is a structured alert that
    // mis-fires or silently no-ops.
    { workspaceId, heldBackRaw: value, statement: statement.name },
    `brain publish: a held-back count did not read back as a non-negative integer — pairs may have been withheld from supersession ${statement.withheldBecause} with no trace; diff ${statement.name}`,
  );
  return null;
}

/** One promotable draft, carried past the classifier so its grant can be widened. */
interface PromotableDraft {
  readonly id: string;
  /**
   * `visible_to` narrowed to what a `text[]` can hold. Narrowed HERE rather
   * than left `unknown` because this value is written back into the ACL column:
   * `jsonb_array_elements_text` would coerce a stray JSON number into a
   * principal, and this is the last point at which the type can say it cannot.
   */
  readonly grant: StoredGrant;
}

/**
 * Bucket {@link EVIDENCE_GRANTS_SQL}'s rows by fact, preserving the SQL's order.
 *
 * Also the seam where an evidence grant's own anomalies are reported. A
 * malformed token in an EPISODE's grant is the quiet way a widening comes out
 * short: `parseGrant` drops the token, the fact publishes narrower than the
 * author intended, and nothing else notices — `reconcile.ts`'s
 * `logGrantAnomalies` fired at a different row, at a different time, and could
 * not know it would later cost a fact readers. Reported through the same seam
 * so the anomaly lands at the moment it changed an outcome.
 *
 * ONCE PER EPISODE, not once per row. One episode can be evidence for many
 * drafts, and N byte-identical warnings for one bad grant makes a single
 * mistyped `audience:` prefix read as a fleet-wide problem.
 *
 * The two `unusable*` results are QUERY DRIFT — every column is non-null by the
 * schema — and they are kept apart for `acl.ts`'s reason: they send an
 * investigation to opposite places. `unusableRows` means the SELECT's shape
 * changed (diff the SQL); `unusableGrantFor` means `brain_episodes.visible_to`
 * stopped arriving as an array (diff the column). It is a SET, so the cap on
 * the caller's sample spends its slots on distinct facts.
 *
 * Both are skipped rather than fatal, and the trade is worth stating exactly.
 * Skipping is fail-CLOSED — the fact publishes with whatever evidence DID load,
 * so nothing is over-shared and nothing goes uncounted. But unlike a refusal it
 * is NOT re-offered: the fact is published, so no later publish revisits it and
 * the widening opportunity is spent. Failing the phase instead would wedge a
 * tenant's entire publish on an evidence-side bug, which this adapter exists to
 * avoid; the price is that the caller's warning is the only chance to notice,
 * which is why it names ids.
 */
function groupEvidenceGrants(
  rows: readonly unknown[],
  meta: { readonly workspaceId: string },
): {
  readonly byFact: ReadonlyMap<string, readonly (readonly unknown[])[]>;
  /** Rows with no usable `fact_id` — unattributable, so not even countable per fact. */
  readonly unusableRows: number;
  /** DISTINCT facts whose evidence row carried a non-array `visible_to`. */
  readonly unusableGrantFor: ReadonlySet<string>;
} {
  const byFact = new Map<string, (readonly unknown[])[]>();
  const unusableGrantFor = new Set<string>();
  const inspectedEpisodes = new Set<string>();
  let unusableRows = 0;
  for (const raw of rows) {
    if (!isJsonObject(raw) || typeof raw.fact_id !== "string" || raw.fact_id === "") {
      unusableRows++;
      continue;
    }
    if (!isUnknownArray(raw.visible_to)) {
      unusableGrantFor.add(raw.fact_id);
      continue;
    }
    // `episode_id` is only ever used to attribute this warning and to dedupe
    // it, so a shape change there costs the message its precision — never the
    // widening. `"?"` is one bucket, which is the right degradation: an
    // unattributable anomaly said once beats it said N times.
    const episodeId = typeof raw.episode_id === "string" ? raw.episode_id : "?";
    if (!inspectedEpisodes.has(episodeId)) {
      inspectedEpisodes.add(episodeId);
      logGrantAnomalies(raw.visible_to, {
        table: "brain_episodes",
        rowId: episodeId,
        workspaceId: meta.workspaceId,
      });
    }
    const bucket = byFact.get(raw.fact_id);
    if (bucket) bucket.push(raw.visible_to);
    else byFact.set(raw.fact_id, [raw.visible_to]);
  }
  return { byFact, unusableRows, unusableGrantFor };
}

/**
 * Narrow `visible_to` off the driver to what the column can hold.
 *
 * `classifyFactForPromotion` refuses a non-array grant under
 * `GRANT_NOT_AN_ARRAY`, so a promotable row always reaches here as an array and
 * the `[]` arm is unreachable. The per-element coercion is likewise unreachable
 * from a `text[]` — it exists so that if the query ever did return something
 * else, the value written back into an ACL column is still only tokens or
 * NULLs, never a coerced number.
 */
function toStoredGrant(visibleTo: unknown): StoredGrant {
  if (!isUnknownArray(visibleTo)) return [];
  return visibleTo.map((token) => (typeof token === "string" ? token : null));
}

/**
 * Promote reviewed facts inside the caller's transaction, refusing any draft
 * that breaks a structural rule.
 *
 * This phase writes `visible_to`, not only `status`: it also decides the grant
 * each fact is published WITH — its own, unioned with those of the episodes on
 * a `provenance` edge to it (#4823). Publish is the review gate, and ADR-0036
 * §T5 permits a grant to widen there and nowhere else.
 *
 * The returned `PromotionReport` carries `refused` so `admin-publish.ts` can
 * surface the refusals to the admin instead of reporting an unqualified
 * success — a refused fact that only appeared in the server log would be a
 * silent partial publish from the admin's side — and `widened` so the ACL
 * change can reach a record its caller controls: `admin-publish.ts` puts it in
 * `logAdminAction`'s durable jsonb; the MCP seam, which audits nothing, at
 * least logs the same swept list rather than a different one.
 */
export function promoteBrainFacts(
  tx: ModeTxClient,
  orgId: string,
): Effect.Effect<PromotionReport, PublishPhaseError, never> {
  return Effect.gen(function* () {
    // IDENTITY LOCK FIRST — before the drafts are read, because what this phase
    // reads is a set of COLLISIONS and an alias decision is what changes them
    // (#5024, ADR-0037 §7). `DRAFT_FACTS_SQL`'s `FOR UPDATE` locks drafts only;
    // the published rivals this phase stamps `valid_to` on are unlocked, so
    // until now a concurrent alias REMOVAL could de-merge a pair between the
    // targets SELECT and the stamp and retire a belief whose collision no longer
    // held.
    //
    // Namespace 5024, deliberately NOT reconcile's 4771: this file's own
    // argument is that publish must never be wedged by ingest ("Refuse the row,
    // never the workspace"), and sharing a namespace with the extraction fiber
    // is exactly that. `lib/brain/identity.ts` carries the full lock-order note;
    // the short version is that publish takes 5024 and nothing else, so nothing
    // it holds can participate in a cycle.
    //
    // Taken here rather than in `admin-publish.ts` so the MCP publish seam and
    // every other `runPublishPhases` caller inherits it — a lock a route has to
    // remember is a lock one route will forget.
    //
    // BOUNDED. `pg_advisory_xact_lock` never errors on contention — it waits,
    // forever — so an unbounded acquisition here is a publish request that hangs
    // with no log line and no `requestId`, which is the one outcome
    // `admin-publish.ts`'s 500 path cannot report because it is never reached.
    // `SET LOCAL` reverts at COMMIT and cannot leak onto the pooled connection.
    yield* Effect.tryPromise({
      try: () => tx.query(IDENTITY_MUTATION_LOCK_TIMEOUT_SQL),
      catch: (cause) =>
        new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
    });
    yield* Effect.tryPromise({
      try: () =>
        tx.query(IDENTITY_MUTATION_LOCK_SQL, [IDENTITY_MUTATION_LOCK_NAMESPACE, orgId]),
      catch: (cause) => {
        // Named rather than passed through as a raw `55P03`: this is the one
        // failure in the phase that is TRANSIENT and worth retrying, and an
        // operator reading "lock_not_available" has no way to know an alias
        // decision is what they are queued behind. Logged as well as returned —
        // the returned message is the caller's copy, not a server-side record.
        if (isLockTimeout(cause)) {
          log.warn(
            { workspaceId: orgId, namespace: IDENTITY_MUTATION_LOCK_NAMESPACE },
            "brain publish: timed out taking the identity-mutation lock — an alias approval or removal is re-keying this workspace",
          );
          return new PublishPhaseError({
            table: BRAIN_FACTS_TABLE,
            phase: "promote",
            cause: new Error(
              "Publish could not start: an alias approval or removal is re-keying this workspace's " +
                "facts, and publish must not read the collision set while that is in flight. " +
                "Nothing was changed. Retry in a few seconds.",
            ),
          });
        }
        return new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause });
      },
    });
    // RESET, immediately, and BEFORE the drafts are read. `SET LOCAL` reverts at
    // COMMIT, not at the next statement, so leaving it set bounds every later
    // lock wait in this transaction: the promote UPDATEs and the supersede
    // stamp, which contend for `brain_facts` rows with `reconcile.ts` and
    // `correction.ts` (namespace 4771 — NOT serialized by the lock above), and
    // `admin-publish.ts`'s phase-4 archive loop, which runs after
    // `runPublishPhases` returns. A publish that used to block and commit would
    // instead roll back everything already promoted, on a transient class, under
    // a generic message.
    //
    // Not `DRAFT_FACTS_SQL`'s `FOR UPDATE`: a second publisher parks on the
    // advisory lock above and never reaches that row lock. Named because an
    // earlier draft of this comment led with it and it is unreachable.
    yield* Effect.tryPromise({
      try: () => tx.query(IDENTITY_MUTATION_LOCK_RESET_SQL),
      catch: (cause) =>
        new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
    });

    const drafts = yield* Effect.tryPromise({
      try: () => tx.query(DRAFT_FACTS_SQL, [orgId]),
      catch: (cause) =>
        new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
    });

    const promotable: PromotableDraft[] = [];
    const refused: PromotionRefusal[] = [];
    for (const raw of drafts.rows) {
      const row = toDraftFactRow(raw);
      if (!row) {
        return yield* Effect.fail(
          new PublishPhaseError({
            table: BRAIN_FACTS_TABLE,
            phase: "promote",
            cause: new Error(
              "promoteBrainFacts: draft row has no usable `id` — the draft-facts query shape changed",
            ),
          }),
        );
      }
      const refusal = classifyFactForPromotion(row);
      if (refusal) {
        refused.push(refusal);
        continue;
      }
      // Promotable, but its grant may still carry junk alongside a valid token
      // (`['user:u1', 'everyone']`): enforceable, so NOT a refusal — the valid
      // token does real work — yet the author plainly believed the second token
      // did something. `acl.ts` calls this the read-time seam it cannot reach
      // from a push-down predicate; promotion is the one place holding every
      // draft's grant, so it is where the observable half of that gap narrows.
      // NOT closed: #4797 stays open for `brain_episodes` that are evidence for
      // nothing promotable (gated by the same predicate, but never promoted;
      // `groupEvidenceGrants` below is the equivalent seam for the ones that
      // ARE) and for facts that arrive already `published` through the region
      // import.
      //
      // Narrowed once, here, because this value is also what gets written BACK
      // if the evidence widens it — see `toStoredGrant`.
      const grant = toStoredGrant(row.visible_to);
      logGrantAnomalies(grant, {
        table: BRAIN_FACTS_TABLE,
        rowId: row.id,
        workspaceId: orgId,
      });
      promotable.push({ id: row.id, grant });
    }

    // Skip the round trips when there is nothing to promote — a workspace with
    // no brain drafts is the overwhelmingly common case and publish runs this
    // adapter on every call.
    let promoted = 0;
    // #5033 — provable collisions the tier guard withheld. Declared beside the
    // three report accumulators rather than inside the supersession block,
    // because it must reach the report even when that block reports nothing:
    // "held back 2, superseded 0" is exactly the state an empty `superseded`
    // would otherwise render as "nothing collided".
    //
    // `number | null`, and the `null` is load-bearing: the diagnostic can fail
    // or drift, and a durable record that said 0 in that case would re-create
    // the ambiguity the field exists to remove. 0 is the answer when the count
    // ran and found nothing.
    let heldBack: number | null = 0;
    const widened: GrantWidening[] = [];
    const superseded: FactSupersession[] = [];
    if (promotable.length > 0) {
      // #4912: which already-published facts will this promotion supersede?
      // Read BEFORE the promote UPDATEs, and only for the classified-promotable
      // drafts — see SUPERSESSION_TARGETS_SQL. A refused draft never reaches
      // this list, so it can never supersede.
      //
      // EVERY promotable draft is offered, where this used to pre-filter to the
      // rows whose own `predicate_cardinality` said `single` (#5027). There is
      // nothing left to pre-filter ON: cardinality is a property of the
      // canonical predicate now, so the answer lives in
      // `brain_predicate_cardinality` and the collision predicate reads it
      // there. The filter did not move — it stopped being expressible here.
      const offeredIds = promotable.map((draft) => draft.id);
      const supersessionPairs: { readonly newId: string; readonly oldId: string }[] = [];
      if (offeredIds.length > 0) {
        const targets = yield* Effect.tryPromise({
          try: () => tx.query(SUPERSESSION_TARGETS_SQL, [orgId, offeredIds]),
          catch: (cause) =>
            new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
        });
        let unusableTargetRows = 0;
        for (const raw of targets.rows) {
          if (
            !isJsonObject(raw) ||
            typeof raw.draft_id !== "string" ||
            raw.draft_id === "" ||
            typeof raw.superseded_id !== "string" ||
            raw.superseded_id === ""
          ) {
            // Query drift, not tenant data — both columns are PKs cast to text.
            // Skipped rather than fatal, per this adapter's refuse-the-row
            // posture, but NEVER silent: a dropped pair is a rival that keeps
            // answering as-of-now reads after the disclosure said it would
            // stop.
            unusableTargetRows++;
            continue;
          }
          supersessionPairs.push({ newId: raw.draft_id, oldId: raw.superseded_id });
        }
        if (unusableTargetRows > 0) {
          log.warn(
            { workspaceId: orgId, unusableTargetRows, targetRows: targets.rows.length },
            "brain publish: supersession target rows came back without usable ids — those published rivals were NOT superseded and will keep answering as-of-now reads; diff SUPERSESSION_TARGETS_SQL",
          );
        }

        // #5033 — the OTHER half of the same question. The statement above lists
        // what will be stamped; this one counts what provably collided and will
        // NOT be, because one side is tier-1 or its source kind is unresolvable.
        // Without it that outcome is invisible: the pair is filtered inside the
        // collision predicate, so it reaches neither `supersessionPairs` nor the
        // shortfall warning below, and the publish reports an empty `superseded`
        // that reads identically to "nothing collided".
        //
        // A COUNT, not ids: both claims are still live and addressable through
        // the fact's `in-tension-with` cluster, and this line exists to say
        // THAT THERE IS SOMETHING TO LOOK AT rather than to re-disclose the
        // claims.
        //
        // ## Behind a SAVEPOINT, because telemetry must not be able to destroy
        // ## the operation it describes
        //
        // This statement produces one log line and one report field. Everything
        // else in this transaction is the publish itself, and
        // `admin-publish.ts` runs EVERY adapter inside one transaction — so an
        // unguarded failure here would roll back the connections, prompts,
        // knowledge documents, semantic entities and facts of a complete,
        // correct publish because a diagnostic could not be computed. That
        // inverts this file's own posture ("Refuse the row, never the
        // workspace") and makes the diagnostic stricter than the thing it
        // diagnoses: the unusable-target-rows path twenty lines up treats
        // genuinely load-bearing drift as skip-and-warn.
        //
        // A bare `catchAll` is NOT sufficient and was the first thing tried:
        // Postgres puts the whole transaction in the aborted state (`25P02`)
        // after ANY statement error, so every later statement — the promote
        // UPDATEs, the stamp — fails too. Recovering needs a savepoint. The
        // reachable causes are ordinary rather than exotic: a `statement_timeout`
        // (`57014`), a deadlock against `reconcile.ts` or `correction.ts` on
        // `brain_facts` (`40P01`), or statement drift (`42703`, a column this
        // statement names having been renamed or dropped).
        //
        // The SAVEPOINT is not released on the success path. One savepoint in a
        // short admin transaction costs nothing, and `RELEASE` is a fourth
        // statement whose own failure would need the same treatment.
        const heldBackCount = yield* advisoryCount(tx, {
          savepoint: "brain_tier_held_back",
          sql: TIER_HELD_BACK_COUNT_SQL,
          params: [orgId, offeredIds],
          read: (row) =>
            readHeldBackCount(row, orgId, {
              name: "TIER_HELD_BACK_COUNT_SQL",
              withheldBecause: "on tier grounds",
            }),
          onFailure: (cause) =>
            log.warn(
              { workspaceId: orgId, err: cause instanceof Error ? cause.message : String(cause) },
              "brain publish: the tier-held-back count could not be computed — any pairs withheld on tier grounds this publish have NO trace, though the publish itself is unaffected and commits; diff TIER_HELD_BACK_COUNT_SQL",
            ),
        });
        heldBack = heldBackCount;

        // #5027 — the OTHER reason a provable collision does not stamp, and
        // since this slice the overwhelmingly common one. Its own savepoint, so
        // a failure in either diagnostic cannot take the other down with it (a
        // shared one would be rolled back by the first failure and the second
        // statement would run in an aborted transaction).
        //
        // Not folded into `heldBack`: the two numbers mean different things to
        // an operator — one is a permanent tier refusal to arbitrate by hand,
        // the other is a curation prompt — and a sum would be a number with no
        // action attached. Kept OUT of the report and the audit row on purpose,
        // which is the line this fix was scoped at: `supersessionHeldBack` is a
        // durable per-publish record of an irreversible refusal, and a count
        // that will be large-and-shrinking for every workspace during the
        // vocabulary's first months does not belong in one. #5025's preview is
        // where it becomes a surface.
        const uncuratedCount = yield* advisoryCount(tx, {
          savepoint: "brain_cardinality_held_back",
          sql: CARDINALITY_HELD_BACK_COUNT_SQL,
          params: [orgId, offeredIds],
          read: (row) =>
            readHeldBackCount(row, orgId, {
              name: "CARDINALITY_HELD_BACK_COUNT_SQL",
              withheldBecause: "for want of a vocabulary entry",
            }),
          onFailure: (cause) =>
            log.warn(
              { workspaceId: orgId, err: cause instanceof Error ? cause.message : String(cause) },
              "brain publish: the uncurated-cardinality count could not be computed — pairs held back for want of a vocabulary entry this publish have NO trace, though the publish itself is unaffected and commits; diff CARDINALITY_HELD_BACK_COUNT_SQL",
            ),
        });
        if (uncuratedCount !== null && uncuratedCount > 0) {
          log.info(
            {
              workspaceId: orgId,
              uncurated: uncuratedCount,
              superseding: supersessionPairs.length,
            },
            "brain publish: provable collisions were NOT superseded because their canonical predicate is not curated `single` (#5027) — absent from the vocabulary means `multi`, so nothing was stamped and both claims stay current; curating the predicate makes these supersedable at the NEXT publish, retroactively and with no per-row record of the regime each fact was written under",
          );
        }

        if (heldBackCount !== null && heldBackCount > 0) {
          log.info(
            { workspaceId: orgId, heldBack: heldBackCount, superseding: supersessionPairs.length },
            "brain publish: provable collisions were NOT superseded because one side is warehouse-derived (tier-1) or carries a source kind this region cannot classify (#5033) — no valid_to was stamped and both claims stay current and published; a human arbitrates from the fact's in-tension-with cluster, NOT the draft review queue",
          );
        }
      }

      // #4823: publish is the review gate, and the review gate is the one place
      // ADR-0036 permits a grant to widen. Read every episode already recorded
      // as evidence, so a claim restated in a wider audience stops being served
      // only to the narrower one it was first seen in.
      const evidence = yield* Effect.tryPromise({
        try: () =>
          tx.query(EVIDENCE_GRANTS_SQL, [orgId, promotable.map((draft) => draft.id)]),
        catch: (cause) =>
          new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
      });
      const { byFact, unusableRows, unusableGrantFor } = groupEvidenceGrants(evidence.rows, {
        workspaceId: orgId,
      });
      if (unusableRows > 0) {
        // Deliberately does NOT claim which facts were affected: rows with no
        // usable `fact_id` are unattributable by definition, which is the whole
        // problem with them.
        log.warn(
          { workspaceId: orgId, unusableRows, evidenceRows: evidence.rows.length },
          "brain publish: evidence rows carry no usable fact_id, so the widening input was incomplete and the facts they belonged to cannot be named — diff EVIDENCE_GRANTS_SQL",
        );
      }
      if (unusableGrantFor.size > 0) {
        // "May be narrower", not "is": a fact with one bad evidence row and
        // three good ones still widens, just less than it should have. An
        // operator told the grant is unchanged would go looking for the wrong
        // symptom.
        const factIds = [...unusableGrantFor];
        log.warn(
          {
            workspaceId: orgId,
            factIds: factIds.slice(0, LOGGED_ID_SAMPLE_CAP),
            factIdCount: factIds.length,
            sampleTruncated: factIds.length > LOGGED_ID_SAMPLE_CAP,
          },
          "brain publish: an evidence episode's visible_to did not load as an array — brain_episodes.visible_to changed shape. These facts widened from their remaining usable evidence only, so their published grant may be narrower than intended, and it is NOT re-offered",
        );
      }

      const plainIds: string[] = [];
      const widenedEntries: { readonly id: string; readonly grant: StoredGrant }[] = [];
      for (const draft of promotable) {
        const widening = widenGrantFromEvidence(draft.grant, byFact.get(draft.id) ?? []);
        if (!widening) {
          plainIds.push(draft.id);
          continue;
        }
        widenedEntries.push({ id: draft.id, grant: widening.grant });
        widened.push({ rowId: draft.id, added: widening.added });
      }

      // `rowCount` is authoritative for a non-RETURNING UPDATE (`rows` is
      // empty); the `rows.length` fallback keeps test doubles that populate
      // only one of the two from reporting a false zero. Mirrors
      // `promoteSimpleTable` in the registry.
      const countOf = (result: Awaited<ReturnType<ModeTxClient["query"]>>): number =>
        result.rowCount ?? result.rows?.length ?? 0;

      let plainPromoted = 0;
      if (plainIds.length > 0) {
        const result = yield* Effect.tryPromise({
          try: () => tx.query(PROMOTE_FACTS_SQL, [orgId, plainIds]),
          catch: (cause) =>
            new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
        });
        plainPromoted = countOf(result);
      }
      let widenedPromoted = 0;
      if (widenedEntries.length > 0) {
        const result = yield* Effect.tryPromise({
          try: () => tx.query(WIDEN_AND_PROMOTE_FACTS_SQL, [orgId, JSON.stringify(widenedEntries)]),
          catch: (cause) =>
            new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
        });
        widenedPromoted = countOf(result);
      }
      promoted = plainPromoted + widenedPromoted;

      if (promoted !== promotable.length) {
        // `FOR UPDATE` pins every classified row for the rest of this
        // transaction, so the two UPDATEs must together touch exactly the ids
        // we passed. A divergence means the lock did not hold, a row changed
        // status underneath us, or the driver under-reported `rowCount` — and
        // the consequence is rows that are neither promoted-and-counted nor
        // refused-and-reported, i.e. the silent under-report this whole
        // adapter exists to prevent. Never silent.
        //
        // Reported per STATEMENT: a shortfall on the widening UPDATE is a
        // different incident from one on the plain promote — it means facts
        // whose ACL should have changed are sitting as unpromoted drafts — and
        // a single pair of totals cannot tell an operator which happened.
        log.warn(
          {
            workspaceId: orgId,
            expected: promotable.length,
            actual: promoted,
            plainExpected: plainIds.length,
            plainActual: plainPromoted,
            widenedExpected: widenedEntries.length,
            widenedActual: widenedPromoted,
          },
          "brain publish: promoted count does not match the classified-promotable set — some drafts may be unaccounted for",
        );
      }

      // #4912 — supersession, atomically with the promotion above: stamp the
      // superseded facts' `valid_to`, then record the arbitration as
      // `supersedes` edges. Order matters only in that both follow the promote
      // UPDATEs, so the edges' `from` end is a fact this transaction has
      // already made published.
      if (supersessionPairs.length > 0) {
        const oldIds = [...new Set(supersessionPairs.map((pair) => pair.oldId))];
        const stampResult = yield* Effect.tryPromise({
          // `offeredIds` a SECOND time, and not a convenience: it is the same
          // list `SUPERSESSION_TARGETS_SQL` was given, so the stamp re-asks the
          // exact question that produced `oldIds` instead of trusting the answer
          // across the window an alias removal can land in (#5024).
          try: () => tx.query(SUPERSEDE_STAMP_SQL, [orgId, oldIds, offeredIds]),
          catch: (cause) =>
            new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
        });
        const stamped = new Set<string>();
        let unreadableStampRows = 0;
        for (const raw of stampResult.rows) {
          if (isJsonObject(raw) && typeof raw.id === "string" && raw.id !== "") {
            stamped.add(raw.id);
          } else {
            unreadableStampRows++;
          }
        }
        if (unreadableStampRows > 0) {
          // A FAILURE, not a skip, and the asymmetry with every other drift
          // path in this adapter is deliberate: an unreadable RETURNING row
          // means the stamp APPLIED to a fact this code can no longer name
          // — proceeding would retire a belief with no `supersedes` edge and
          // no audit record, the exact silent supersession #4912 forbids.
          // Failing here rolls the whole transaction (and the stamp) back.
          return yield* Effect.fail(
            new PublishPhaseError({
              table: BRAIN_FACTS_TABLE,
              phase: "promote",
              cause: new Error(
                `promoteBrainFacts: ${unreadableStampRows} SUPERSEDE_STAMP_SQL RETURNING row(s) had no usable id — the statement shape changed; rolling back rather than committing a supersession with no record`,
              ),
            }),
          );
        }
        if (stamped.size !== oldIds.length) {
          // Reachable, not only drift: the published side is not FOR-UPDATE
          // locked, so a concurrent retraction between the collision check and
          // the stamp legitimately shrinks the set. Warned because the
          // pre-publish disclosure may have listed a supersession that then
          // did not happen — the operator-visible trace of that gap is here.
          log.warn(
            {
              workspaceId: orgId,
              expected: oldIds.length,
              stamped: stamped.size,
              missing: oldIds.filter((id) => !stamped.has(id)).slice(0, LOGGED_ID_SAMPLE_CAP),
            },
            // THREE causes since #5024, and naming only the first two sends an
            // operator hunting for a retraction that never happened. The third
            // is the one this slice added on purpose: the stamp re-checks the
            // collision, so an alias REMOVAL that de-merged the pair leaves it
            // unstamped. That is the guard working, not a fault.
            "brain publish: some supersession targets were not stamped — retracted, already superseded, or DE-MERGED by an alias removal since the collision check (the stamp re-checks the collision, #5024); the will-supersede disclosure may have over-listed, and no belief was retired without a live collision",
          );
        }
        const stampedPairs = supersessionPairs.filter((pair) => stamped.has(pair.oldId));
        if (stampedPairs.length > 0) {
          // Edges only for pairs the stamp CONFIRMED: a `supersedes` edge whose
          // target is still current would be an arbitration record of an
          // arbitration that never happened.
          const edgeResult = yield* Effect.tryPromise({
            try: () =>
              tx.query(INSERT_SUPERSEDES_EDGES_SQL, [orgId, JSON.stringify(stampedPairs)]),
            catch: (cause) =>
              new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
          });
          const edgesInserted = edgeResult.rowCount ?? edgeResult.rows?.length ?? 0;
          if (edgesInserted < stampedPairs.length) {
            // Usually legitimate — `WHERE NOT EXISTS` skips an edge a region
            // import already carried — so this is not a failure. It is logged
            // because an exact-count check is genuinely ambiguous here, and
            // without this line an insert drift that under-writes edges would
            // leave stamps with no graph record and no operator trace. The
            // durable audit record is unaffected: `superseded` below is built
            // from the stamped pairs, not from this count.
            log.info(
              {
                workspaceId: orgId,
                pairs: stampedPairs.length,
                edgesInserted,
              },
              "brain publish: fewer supersedes edges inserted than pairs stamped — pre-existing edges (a region import), or the edge statement drifted",
            );
          }
          const byNewFact = new Map<string, string[]>();
          for (const pair of stampedPairs) {
            const list = byNewFact.get(pair.newId);
            if (list) list.push(pair.oldId);
            else byNewFact.set(pair.newId, [pair.oldId]);
          }
          for (const [rowId, oldList] of byNewFact) {
            const [first, ...rest] = oldList;
            if (first !== undefined) superseded.push({ rowId, superseded: [first, ...rest] });
          }
        }
      }
    }

    if (widened.length > 0) {
      // An ACL widened, so it is stated at INFO rather than left to a debug
      // level: over-restriction is invisible by construction — nobody can report
      // a fact they cannot read — so this is the signal, on every publish seam,
      // that a publish changed who can see a claim. Sampled purely for LINE
      // SIZE: the first publish after a history backfill can widen a lot at
      // once. Not a privacy bound on the two seams that sweep it — the complete
      // list travels in `PromotionReport.widened`, which the REST route and the
      // MCP seam record in full. `knowledge/ingest-bundle.ts` discards it, so
      // on THAT path this sampled line is all there is.
      log.info(
        {
          workspaceId: orgId,
          widenedCount: widened.length,
          widened: widened.slice(0, LOGGED_ID_SAMPLE_CAP),
          sampleTruncated: widened.length > LOGGED_ID_SAMPLE_CAP,
        },
        "brain publish: widened grants to cover the evidence behind them — a claim restated in a wider audience is no longer served only to the narrower one it was first seen in",
      );
    }

    if (superseded.length > 0) {
      // INFO for the widened log's reason, one axis over: a supersession
      // changes which claim answers as-of-now reads the moment this commits,
      // and the superseded side is invisible by construction afterwards —
      // nobody can report a fact the reads now hide. Sampled for line size
      // only; the complete list rides `PromotionReport.superseded` to the
      // callers' durable records.
      log.info(
        {
          workspaceId: orgId,
          supersededCount: superseded.length,
          superseded: superseded.slice(0, LOGGED_ID_SAMPLE_CAP),
          sampleTruncated: superseded.length > LOGGED_ID_SAMPLE_CAP,
        },
        "brain publish: promoted single-cardinality facts superseded their published rivals — valid_to stamped and supersedes edges written; the old facts stay readable to as-of reads",
      );
    }

    if (refused.length > 0) {
      log.warn(
        {
          workspaceId: orgId,
          refusedCount: refused.length,
          promotedCount: promoted,
          refused: refused.map((r) => ({ rowId: r.rowId, reasons: r.reasons })),
        },
        "brain publish: refused to promote facts that break a structural rule — they remain drafts",
      );
    }

    return {
      table: BRAIN_FACTS_TABLE,
      promoted,
      // Always present (possibly empty) for this adapter: the fact class HAS a
      // refusal concept, and `[]` is the meaningful "nothing was refused this
      // run" answer, distinct from a table that cannot refuse at all.
      refused,
      // Same reasoning, one axis over: this is the table that HAS a grant, so
      // `[]` means "no ACL changed today" rather than "this table has no ACL".
      widened,
      // And a third axis (#4912): the table that HAS supersession, so `[]`
      // means "nothing was superseded this run", distinct from a table where
      // the concept does not exist.
      superseded,
      // …and the fourth (#5033): what supersession was DECLINED, so a caller can
      // tell "nothing collided" from "a collision was proven and its consequence
      // withheld". Always present for this adapter — `0` included, and `null`
      // when the count itself could not be established.
      supersessionHeldBack: heldBack,
    } satisfies PromotionReport;
  });
}
