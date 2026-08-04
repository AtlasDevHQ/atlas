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
 * Draft facts awaiting review, with exactly the columns the refusal rules and
 * the supersession classifier read (#4912 — `predicate_cardinality` is the
 * supersession input; everything else feeds `classifyFactForPromotion`).
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
         visible_to,
         predicate_cardinality
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
 * The supersession collision (#4912, ADR-0036 §Temporal), spelled ONCE.
 *
 * Joins a draft alias `d` to every already-published fact it would supersede:
 * the same SLOT — `(subject_key, predicate_key)` — a DIFFERENT object slot, and
 * BOTH sides `single`-cardinality. The published side must be live (not
 * tombstoned) and current (`valid_to IS NULL`) — a fact some earlier promotion
 * already superseded is settled history, and stamping it twice would rewrite
 * when the belief ended.
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
 * A NULL key on EITHER side excludes the pair, since `=` and `<>` are both
 * unknown against NULL. That is fail-closed and the direction this join must
 * fail in — no collision means no `valid_to` stamp, which is the recoverable
 * outcome — but it is not free, and the cost is symmetric: such a row can
 * neither BE superseded nor supersede anything, so an unkeyed draft publishes
 * beside a live rival and an unkeyed published fact survives one. Three
 * populations reach it, and only two of them are transient:
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
 * Both sides `single`, not just the draft, because the two rows can disagree
 * about the predicate (corroboration never upgrades cardinality — see
 * `reconcile.ts`) and wrongly superseding destroys a belief where wrongly
 * coexisting is recoverable at the review gate. A `multi` fact is NEVER
 * superseded by publish, whatever the incoming draft claims.
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
      ON ${p}.workspace_id = ${d}.workspace_id
     AND ${p}.subject_key = ${d}.subject_key
     AND ${p}.predicate_key = ${d}.predicate_key
     AND ${p}.object_key <> ${d}.object_key
     AND ${p}.predicate_cardinality = 'single'
     AND ${d}.predicate_cardinality = 'single'
     AND ${p}.status = 'published'
     AND ${p}.invalidated_at IS NULL
     AND ${p}.valid_to IS NULL`;
}

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
 * `$2` is the `single`-cardinality subset of the classified-promotable ids
 * (the join re-checks cardinality regardless), so a refused draft never
 * supersedes anything: the collision only fires for rows the transaction will
 * actually promote.
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
 * `valid_to` write (#4912), executed by exactly two allowlisted callers: this
 * adapter (a human promotion, inside the publish transaction) and
 * `correct_fact`'s supersede verb (#4915, `lib/brain/correction.ts` — a human
 * correction, inside the correction transaction, importing THIS constant so
 * the two arbitration paths cannot drift). Nothing autonomous ever writes it,
 * and `check-brain-fact-promotion.sh` refuses UPDATE-shape writes to the
 * column outside its allowlist (this file, `correction.ts`, plus
 * `admin-migrate.ts` — the region import restores an already-closed window
 * verbatim, a restore rather than a new arbitration).
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
export const SUPERSEDE_STAMP_SQL = `
  UPDATE brain_facts
     SET valid_to = now(), updated_at = now()
   WHERE workspace_id = $1
     AND id = ANY($2::uuid[])
     AND status = 'published'
     AND invalidated_at IS NULL
     AND valid_to IS NULL
   RETURNING id::text AS id
`;

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
 * the exact claims `/admin/brain-facts` had just refused to show them, one
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
  /**
   * The draft's predicate cardinality (#4912) — `single` is the only kind
   * that can supersede on promotion; `multi` coexists.
   */
  readonly cardinality: "single" | "multi";
}

/**
 * Cardinality off the draft row, defaulting CONSERVATIVELY.
 *
 * `chk_brain_facts_predicate_cardinality` makes an out-of-vocabulary value
 * unreachable from the database, so a fallback here is query drift — logged,
 * because the `multi` arm is the one that never supersedes: a `single` draft
 * misread as `multi` leaves a stale rival answering as-of-now reads, which an
 * operator can only find from this line. Wrongly superseding destroys a
 * belief; wrongly coexisting leaves a visible tension — so drift degrades to
 * the recoverable side.
 */
function draftCardinality(
  raw: unknown,
  meta: { readonly rowId: string; readonly workspaceId: string },
): "single" | "multi" {
  const value = isJsonObject(raw) ? raw.predicate_cardinality : undefined;
  if (value === "single" || value === "multi") return value;
  log.warn(
    { ...meta, cardinality: value },
    "brain publish: draft carries a predicate cardinality outside the vocabulary — treating it as `multi`, so it will coexist rather than supersede",
  );
  return "multi";
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
      promotable.push({
        id: row.id,
        grant,
        cardinality: draftCardinality(raw, { rowId: row.id, workspaceId: orgId }),
      });
    }

    // Skip the round trips when there is nothing to promote — a workspace with
    // no brain drafts is the overwhelmingly common case and publish runs this
    // adapter on every call.
    let promoted = 0;
    const widened: GrantWidening[] = [];
    const superseded: FactSupersession[] = [];
    if (promotable.length > 0) {
      // #4912: which already-published facts will this promotion supersede?
      // Read BEFORE the promote UPDATEs, and only for the classified-promotable
      // `single` drafts — see SUPERSESSION_TARGETS_SQL on both. A refused draft
      // never reaches this list, so it can never supersede.
      const singleIds = promotable
        .filter((draft) => draft.cardinality === "single")
        .map((draft) => draft.id);
      const supersessionPairs: { readonly newId: string; readonly oldId: string }[] = [];
      if (singleIds.length > 0) {
        const targets = yield* Effect.tryPromise({
          try: () => tx.query(SUPERSESSION_TARGETS_SQL, [orgId, singleIds]),
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
          try: () => tx.query(SUPERSEDE_STAMP_SQL, [orgId, oldIds]),
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
            "brain publish: some supersession targets were not stamped — retracted or already superseded since the collision check; the will-supersede disclosure may have over-listed",
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
    } satisfies PromotionReport;
  });
}
