/**
 * `correct_fact` — the four correction verbs and the correction-episode
 * materialization behind them (#4915, ADR-0036 §Temporal, conflict &
 * provenance).
 *
 * T4's SECOND human-authoritative entry point, beside the review gate:
 * a correction is a first-class human-authored EPISODE — immutable,
 * actor-attributed, highest-trust — whose effect lands authoritative
 * immediately rather than queueing as a draft. The reviewer gate exists to put
 * a human between machine extraction and trust; a correction already HAS its
 * human, so making it wait for a second one would review the reviewer.
 *
 * ## The four verbs, and what each may touch
 *
 *   - **retract** — the ONLY tombstone path, and the verb a GDPR erasure
 *     ROUTES THROUGH (the ADR's epithet; actual content deletion of the row
 *     and its episodes is a separate operation this verb does not perform).
 *     The row stays stored, and every FACT-SERVING read hides it, `asOf`
 *     included — #4916 keeps `invalidated_at IS NULL` in BOTH temporal
 *     branches, because hiding history is what this verb is for. The one
 *     exception is the tension cluster: `tensions.ts`'s counterpart SELECT
 *     deliberately does not filter `invalidated_at`, so a retracted claim is
 *     still listed — labelled by `invalidatedAt`, with its payload — as a
 *     withdrawn rival of any live claim it contested. That carve-out is why
 *     erasure of CONTENT has to be a separate operation and cannot be read
 *     off this verb. Stamps
 *     `invalidated_at` (never `status` — ADR-0036: withdrawal is a tombstone,
 *     not a demotion) and FLAGS every `derives-from` dependent for re-review.
 *     Flagging is a provenance marker (`reReview`), never a cascade: a
 *     dependent's own `invalidated_at`, `valid_to`, and `status` are untouched,
 *     because a conclusion may survive losing one of its premises and only a
 *     human can say so. The admin review route's `POST /:id/retract` runs THIS
 *     code path — one retract semantics, not two (#4772's negative verb
 *     unified here).
 *   - **supersede** — stamps the target's `valid_to` and records the
 *     `supersedes` edge by executing the SAME statements the publish gate runs
 *     (`SUPERSEDE_STAMP_SQL` / `INSERT_SUPERSEDES_EDGES_SQL`, #4912) —
 *     imported, not restated, so the two human arbitration paths cannot drift.
 *     The replacement claim enters through `reconcileFacts` as the second
 *     IMPLEMENTED producer (`correction`) on the seam ADR-0036 designs for
 *     three (connector · warehouse-derived · correction) — and is then
 *     promoted to `published` in the same transaction (see the allowlist note
 *     below). The stamp runs BEFORE the reconcile, deliberately: the belief
 *     being retired must already have a closed window when the replacement's
 *     tension pass runs, or reconcile would mint an `in-tension-with` edge
 *     against the very fact this verb is resolving — permanent conflict noise
 *     recording a question the human answered in the same transaction.
 *   - **re-authority** — re-anchors the claim's authority on the correcting
 *     human: the correction episode becomes EVIDENCE (a `provenance` edge, the
 *     same idempotent statement reconcile uses), and a `reAuthority` marker
 *     records who vouched and when. Because `LAST_OBSERVED_AT_SELECT` reads
 *     provenance-edge episodes, the human observation also resets the #4914
 *     decay clock — "a person checked" is the freshest observation there is.
 *   - **pin** — the same evidence edge plus a `pinned` marker. Advisory at
 *     rest, exactly like the decay signal it counteracts: surfaces may read
 *     the marker, nothing may auto-act on it.
 *
 * ## Tier-1 has no correction path
 *
 * A warehouse-derived fact (`provenance.source = "warehouse"`) is refused with
 * an actionable error for EVERY verb: tier-1 is authoritative by construction,
 * so you fix the data or the semantic layer, not the brain. The refusal is
 * evaluated on the stored provenance because tier-1 proper is never stored at
 * all — an id that names no brain row is an ordinary not-found.
 *
 * ## Why this file is on `check-brain-fact-promotion.sh`'s ALLOWLIST
 *
 * `PROMOTE_CORRECTION_FACT_SQL` writes `status = 'published'` — the exact
 * shape the guard exists to refuse. This is the "second gate-time writer" the
 * guard's own remediation text forecast for `correct_fact` (#4912): the write
 * is a human trust decision (the correction's author IS the reviewer),
 * actor-attributed, episode-recorded, and still screened through
 * `classifyFactForPromotion` so no-provenance-no-promotion and
 * no-grant-no-promotion hold on this path too. The `valid_to` stamp is not a
 * second spelling at all — it executes the publish adapter's own statement.
 *
 * ## Grant seed — the narrowest defensible set (the T9 pattern)
 *
 * The correction episode's grant is the TARGET FACT's own grant, verbatim:
 * everyone entitled to the claim is entitled to know it was corrected, and
 * nobody else learns a claim existed. The actor is inside that set by
 * construction — the ACL-gated target read is what found the fact. A freshly
 * created supersede replacement then inherits this grant through reconcile's
 * ordinary derive-at-ingest path, so it is served to exactly the audience the
 * superseded belief was; a CORROBORATED pre-existing rival keeps its own
 * grant, which reconcile never rewrites (the correction episode still lands
 * as evidence, so the next publish may widen it — #4823's ordinary path).
 *
 * ## Atomicity
 *
 * Every verb runs in ONE transaction (`withBrainTransaction`), opened after
 * all pure validation: the episode, its edges, the tombstone/stamp/marker, and
 * the flagged dependents commit together or not at all. A refusal discovered
 * mid-transaction throws {@link CorrectionRefusedError}, which rolls the
 * episode back — a correction that half-happened must not leave an authored
 * episode asserting it did.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";
import {
  aclVisibilityClause,
  isUnknownArray,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import {
  INSERT_PROVENANCE_EDGE_SQL,
  reconcileFacts,
  withBrainTransaction,
  type ReconcileExecutor,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
import {
  INSERT_SUPERSEDES_EDGES_SQL,
  SUPERSEDE_STAMP_SQL,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { classifyFactForPromotion, isJsonObject, type DraftFactRow } from "@atlas/api/lib/brain/promotion";
import { BRAIN_CORRECTION_VERBS } from "@useatlas/schemas";
import type { BrainCorrectionVerb, BrainFactCorrectionResponse } from "@useatlas/types";

const log = createLogger("brain-correction");

/** Surface tag carried on this module's `BrainReaderUnresolvedError` throws. */
const CORRECTION_SURFACE = "correction";

/**
 * The verb vocabulary — re-exported from `@useatlas/schemas`, which holds the
 * one runtime tuple (with its exhaustiveness pin against the wire union), the
 * same way every other brain tuple is consumed API-side. A second spelling
 * here would be a membership-drift risk two compile pins would have to hold
 * shut.
 */
export const CORRECTION_VERBS = BRAIN_CORRECTION_VERBS;

export type CorrectionVerb = BrainCorrectionVerb;

/**
 * Why a correction was refused. Every refusal carries actionable prose beside
 * the code; the code is what a tool or route branches on, the prose is what a
 * human acts on.
 */
export const CORRECTION_REFUSAL_REASONS = {
  /** The actor's role does not carry the correction verb. */
  notAuthorized: "NOT_AUTHORIZED",
  /** Tier-1: warehouse-derived facts have no correction path. */
  warehouseTarget: "WAREHOUSE_TARGET",
  /** Supersession retires a published belief; the target is not one. */
  targetNotPublished: "TARGET_NOT_PUBLISHED",
  /** The target's validity window is already closed (or already decided). */
  validityAlreadyClosed: "VALIDITY_ALREADY_CLOSED",
  /** `supersede` needs a replacement claim and none was given. */
  replacementMissing: "REPLACEMENT_MISSING",
  /** The replacement restates the target's own object — nothing to supersede. */
  replacementIdentical: "REPLACEMENT_IDENTICAL",
  /** The replacement could not become a published fact (structural refusal). */
  replacementUnpublishable: "REPLACEMENT_UNPUBLISHABLE",
} as const;

export type CorrectionRefusalReason =
  (typeof CORRECTION_REFUSAL_REASONS)[keyof typeof CORRECTION_REFUSAL_REASONS];

/**
 * A refusal raised INSIDE the transaction, so the throw is what rolls the
 * correction episode back. Caught by {@link correctFact} and returned as an
 * ordinary outcome — a refused correction is a result, not an incident.
 */
export class CorrectionRefusedError extends Error {
  constructor(
    readonly reason: CorrectionRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "CorrectionRefusedError";
  }
}

export interface CorrectionReplacement {
  /** The corrected object; subject and predicate are inherited from the target. */
  readonly object: string;
  /** When the corrected value began to hold. Defaults to the correction time. */
  readonly validFrom?: Date | null;
}

export interface CorrectionRequest {
  readonly ctx: BrainPrincipalContext;
  readonly factId: string;
  readonly verb: CorrectionVerb;
  /** Free-text rationale, recorded verbatim in the correction episode body. */
  readonly reason?: string;
  /** Required for `supersede`, meaningless elsewhere. */
  readonly replacement?: CorrectionReplacement;
  readonly requestId?: string;
}

export interface CorrectionDeps {
  /** Defaults to a transaction on the internal pool. */
  readonly withTransaction?: ReconcileTransactionRunner;
  /** Test clock. */
  readonly now?: () => Date;
  /** Test seam for the episode's unique `source_id` suffix. */
  readonly newCorrectionId?: () => string;
}

/** What became of one correction request. */
export type CorrectionOutcome =
  | { readonly kind: "corrected"; readonly result: BrainFactCorrectionResponse }
  | {
      readonly kind: "refused";
      readonly reason: CorrectionRefusalReason;
      readonly message: string;
    }
  /**
   * No such fact, already retracted, or not visible to this actor — the three
   * are deliberately indistinguishable, for `retractFactCandidate`'s original
   * reason: a distinct answer would confirm the existence of a fact the actor
   * may not see.
   */
  | { readonly kind: "not-found" };

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
//
// Exported for two test seams: `candidates-pg.test.ts` §7 executes these
// strings against the live schema (via `correctFact`, on that file's existing
// bootstrap), and `correction.test.ts` dispatches on their identity so a
// paraphrased second spelling of any statement fails loudly.
//
// NOTE for the next editor: this file is on `check-brain-fact-promotion.sh`'s
// ALLOWLIST — see the module header for the recorded rationale. That is a
// carve-out for the ONE `status` write below and the imported #4912 stamp,
// not license: any new statement here that touches `status`, `visible_to`, or
// `valid_to` needs the same argument the existing ones carry.

/**
 * The ACL-gated target read. `FOR UPDATE` serializes two corrections (or a
 * correction and a publish) racing on one fact, so every later statement in
 * the transaction acts on the row version this SELECT saw.
 *
 * `invalidated_at IS NULL`: a tombstoned fact is already withdrawn — every
 * verb on it answers not-found, indistinguishable from absence (see
 * {@link CorrectionOutcome}).
 *
 * `aclSql` must alias the fact table `f` and is interpolated — same contract
 * as `brainFactPreviewSql` and every other clause-taking builder in the slice.
 */
export function correctionTargetSql(aclSql: string, idParam: number): string {
  return `SELECT f.id::text AS id,
                f.subject,
                f.predicate,
                f.object,
                f.status,
                f.predicate_cardinality,
                f.provenance,
                f.visible_to,
                f.valid_to,
                f.source_episode_id::text AS source_episode_id
           FROM brain_facts f
          WHERE ${aclSql}
            AND f.id = $${idParam}::uuid
            AND f.invalidated_at IS NULL
            FOR UPDATE`;
}

/**
 * The correction episode — the immutable human-authored record of the verb.
 *
 * `source = 'human'` (the connector-class vocabulary already reserves it), a
 * fresh `correction:`-prefixed `source_id` per correction (two corrections of
 * one fact are two episodes; nothing dedupes them away), the acting principal
 * as `source_actor`, and the verb payload as the body.
 *
 * `extracted_at` is stamped AT INSERT — deliberately opposite to the connector
 * ingest path, whose header calls a stamped-at-ingest value a silent drop.
 * Here the correction path IS the episode's processing: the fact-side effect
 * commits in the same transaction, so leaving the row on the extraction queue
 * would hand a human's exact words to the LLM extraction fiber to be
 * re-derived as a second, machine-produced claim.
 */
export const CORRECTION_EPISODE_INSERT_SQL = `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, locator, occurred_at, visible_to, extracted_at)
       VALUES ($1, 'human', $2, $3, $4, NULL, $5::timestamptz,
               ARRAY(SELECT jsonb_array_elements_text($6::jsonb)), $5::timestamptz)
       RETURNING id::text AS id`;

/**
 * The tombstone — the only tombstone DECISION path, now that the review
 * surface's retract routes through this module (#4915 unification of #4772's
 * negative verb). The one other statement writing the column is the region
 * import's INSERT (`admin-migrate.ts`), which restores an existing
 * `invalidated_at` verbatim — a restore, not a new arbitration, the same
 * distinction the promotion guard's allowlist draws. It never names `status`:
 * withdrawal is a tombstone, not a demotion — and the tombstone hides the row
 * from every fact-serving read, `asOf` included (#4916); only the tension
 * surfaces still list it, labelled, as a withdrawn rival. The ACL already ran
 * at {@link correctionTargetSql}, which also holds the row lock; the residual
 * predicates make the statement correct standalone.
 */
export const RETRACT_FACT_SQL = `UPDATE brain_facts
        SET invalidated_at = now(), updated_at = now()
      WHERE workspace_id = $1
        AND id = $2::uuid
        AND invalidated_at IS NULL
    RETURNING id::text AS id, invalidated_at`;

/**
 * The correction's lineage pointer, fact → correction episode. `derives-from`
 * rather than `provenance`, and the distinction is load-bearing: a
 * `provenance` edge says the episode is EVIDENCE FOR the claim — it feeds the
 * corroboration count and the decay anchor — which is exactly wrong for a
 * retraction or a supersession, where the episode refutes or retires the
 * claim. `re-authority` and `pin` use the provenance statement instead,
 * because there the human really is vouching for the claim. Idempotence guard
 * mirrors `INSERT_PROVENANCE_EDGE_SQL`'s.
 */
export const DERIVES_FROM_EDGE_SQL = `INSERT INTO brain_edges
         (workspace_id, edge_type, from_fact_id, to_episode_id)
       SELECT $1, 'derives-from', $2::uuid, $3::uuid
        WHERE NOT EXISTS (
          SELECT 1 FROM brain_edges
           WHERE workspace_id = $1
             AND edge_type = 'derives-from'
             AND from_fact_id = $2::uuid
             AND to_episode_id = $3::uuid)
       RETURNING id`;

/**
 * Live facts that derive from the target — the set a retraction flags.
 *
 * Deliberately NOT gated by the actor's ACL: the flag is a quality marker on
 * rows the retraction just undermined, and skipping the ones the actor cannot
 * see would leave exactly those unflagged forever (nobody else knows the
 * premise fell). Nothing about the dependents is DISCLOSED — the response
 * carries opaque ids only, the same class of handle the withheld-tension arm
 * already ships.
 */
export const DEPENDENT_FACTS_SQL = `SELECT ed.from_fact_id::text AS id
     FROM brain_edges ed
     JOIN brain_facts f
       ON f.workspace_id = ed.workspace_id
      AND f.id = ed.from_fact_id
    WHERE ed.workspace_id = $1
      AND ed.edge_type = 'derives-from'
      AND ed.to_fact_id = $2::uuid
      AND f.invalidated_at IS NULL
    ORDER BY f.ingested_at, f.id`;

/**
 * Merge a correction marker under a fact's provenance payload.
 *
 * `provenance || $3::jsonb` appends top-level keys and can only ever ADD or
 * replace the marker key itself — the structural keys reconcile wrote are
 * untouched because no marker spells them. Three markers ride this statement:
 * `reReview` (retract flags a dependent), `reAuthority`, and `pinned`. It
 * names none of the gated columns, which is what makes flagging a NON-cascade
 * by construction: this is the only statement a dependent is ever touched by.
 */
export const MERGE_PROVENANCE_MARKER_SQL = `UPDATE brain_facts
        SET provenance = provenance || $3::jsonb, updated_at = now()
      WHERE workspace_id = $1
        AND id = ANY($2::uuid[])
        AND invalidated_at IS NULL
    RETURNING id::text AS id`;

/**
 * Promote the correction-authored replacement — the allowlisted `status`
 * write this module exists to carry (see the header). Only ever pointed at
 * the fact `reconcileFacts` just created or corroborated IN THIS TRANSACTION,
 * after {@link classifyFactForPromotion} admitted it; the `status = 'draft'`
 * predicate keeps the statement correct standalone, exactly like
 * `PROMOTE_FACTS_SQL`'s.
 */
export const PROMOTE_CORRECTION_FACT_SQL = `UPDATE brain_facts
        SET status = 'published', updated_at = now()
      WHERE workspace_id = $1
        AND id = $2::uuid
        AND status = 'draft'
        AND invalidated_at IS NULL
    RETURNING id::text AS id`;

/** The replacement row, read back for the promotion classifier. */
export const REPLACEMENT_ROW_SQL = `SELECT f.id::text AS id,
                f.subject,
                f.predicate,
                f.object,
                f.status,
                f.source_episode_id::text AS source_episode_id,
                f.provenance,
                f.visible_to
           FROM brain_facts f
          WHERE f.workspace_id = $1
            AND f.id = $2::uuid
            FOR UPDATE`;

// ---------------------------------------------------------------------------
// The verb dispatcher
// ---------------------------------------------------------------------------

interface TargetRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly status: string;
  readonly cardinality: "single" | "multi";
  readonly provenance: unknown;
  readonly grantTokens: readonly string[];
  readonly validTo: unknown;
}

/**
 * Apply one correction verb.
 *
 * Returns an outcome, never throws for a DOMAIN refusal — a refused or
 * not-found correction is an ordinary result. Throws only for infrastructure
 * failure (the caller's 500 path) and {@link BrainReaderUnresolvedError} when
 * the actor's identity resolves to no usable principals.
 */
export async function correctFact(
  request: CorrectionRequest,
  deps: CorrectionDeps = {},
): Promise<CorrectionOutcome> {
  const { ctx, factId, verb, requestId } = request;
  const now = deps.now ?? (() => new Date());
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const newCorrectionId = deps.newCorrectionId ?? randomUUID;

  // ── Authority ─────────────────────────────────────────────────────────
  // A correction is a trust decision with immediate authoritative effect, so
  // it carries the review gate's own bar: org owner/admin. The
  // `unauthenticated-local` arm passes — that deployment has DECLARED the
  // local operator is the only identity there is, and the admin surface
  // already treats them as such.
  if (ctx.origin === "authenticated" && ctx.role !== "owner" && ctx.role !== "admin") {
    return {
      kind: "refused",
      reason: CORRECTION_REFUSAL_REASONS.notAuthorized,
      message:
        "Corrections are an admin verb: they land authoritative immediately, without the review queue. " +
        "Ask a workspace owner or admin to apply this correction, or flag the fact in review instead.",
    };
  }

  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, CORRECTION_SURFACE);
  }

  // ── Pure request validation, before any connection is checked out ────
  const replacement = normalizeReplacement(request.replacement);
  if (verb === "supersede") {
    if (replacement === null) {
      return {
        kind: "refused",
        reason: CORRECTION_REFUSAL_REASONS.replacementMissing,
        message:
          "Superseding needs the corrected value: pass a non-blank `replacement.object` (the subject and " +
          "predicate are inherited from the fact being superseded). To withdraw the claim without replacing " +
          "it, use `retract`.",
      };
    }
  }

  const actor = ctx.userId ?? "local-operator";
  // Grammar-valid principal for the replacement fact's provenance `actor`.
  // The `unauthenticated-local` arm records the class rather than an id —
  // that deployment declared it has no ids to record.
  const sourcePrincipal = ctx.userId !== null ? `user:${ctx.userId}` : "human:local-operator";

  try {
    const result = await withTransaction(async (tx) => {
      // ── The target, ACL-gated and row-locked ──────────────────────────
      const params: unknown[] = [...acl.params, factId];
      const targetResult = await tx.query(correctionTargetSql(acl.sql, params.length), params);
      const target = readTargetRow(targetResult.rows[0], ctx.workspaceId);
      if (target === null) return null;

      // Tier-1: refused for EVERY verb, before anything is written.
      if (isWarehouseDerived(target.provenance)) {
        throw new CorrectionRefusedError(
          CORRECTION_REFUSAL_REASONS.warehouseTarget,
          "This fact is warehouse-derived (tier-1), and tier-1 has no correction path: the warehouse is " +
            "authoritative by construction. Fix the underlying data, or fix the semantic layer that derives it — " +
            "the brain never overrides the warehouse.",
        );
      }

      // Supersede-only target-state checks, BEFORE the episode is written so
      // the common refusals never open a write at all.
      if (verb === "supersede") {
        if (target.status !== "published") {
          throw new CorrectionRefusedError(
            CORRECTION_REFUSAL_REASONS.targetNotPublished,
            "Supersession retires a published belief, and this fact is not published. " +
              "If it is a draft you no longer trust, `retract` it from the review queue instead — " +
              "there is nothing current to replace yet.",
          );
        }
        if (target.validTo !== null) {
          throw new CorrectionRefusedError(
            CORRECTION_REFUSAL_REASONS.validityAlreadyClosed,
            "This fact's validity window is already closed or already has a decided end date, so there is " +
              "no current belief to supersede. Correct the CURRENT fact for this subject and predicate instead.",
          );
        }
        if (replacement !== null && replacement.object === target.object) {
          throw new CorrectionRefusedError(
            CORRECTION_REFUSAL_REASONS.replacementIdentical,
            `The replacement restates what the fact already says ("${target.object}"), so there is nothing ` +
              "to supersede. To re-assert the claim as human-verified, use `re-authority` or `pin` instead.",
          );
        }
      }

      // ── The correction episode — the immutable human record ───────────
      const at = now();
      const correctionSourceId = `correction:${verb}:${newCorrectionId()}`;
      const body = JSON.stringify({
        kind: "correction",
        verb,
        factId: target.id,
        claim: { subject: target.subject, predicate: target.predicate, object: target.object },
        ...(verb === "supersede" && replacement !== null
          ? { replacement: { object: replacement.object } }
          : {}),
        ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
        actor,
        at: at.toISOString(),
      });
      const episodeInsert = await tx.query(CORRECTION_EPISODE_INSERT_SQL, [
        ctx.workspaceId,
        correctionSourceId,
        actor,
        body,
        at.toISOString(),
        JSON.stringify(target.grantTokens),
      ]);
      const episodeId = firstId(episodeInsert.rows);
      if (episodeId === null) {
        throw new Error(
          `brain correction: episode insert returned no id (workspace ${ctx.workspaceId}, fact ${target.id})`,
        );
      }

      // ── Verb effects ──────────────────────────────────────────────────
      const base: BrainFactCorrectionResponse = {
        verb,
        factId: target.id,
        correctionEpisodeId: episodeId,
        invalidatedAt: null,
        flaggedForReReview: [],
        supersededBy: null,
        validTo: null,
      };
      switch (verb) {
        case "retract":
          return applyRetract(tx, ctx.workspaceId, target, episodeId, at, base);
        case "supersede":
          // `replacement` is non-null past the pure-validation gate above; the
          // assertion-free re-check keeps that reasoning local.
          if (replacement === null) {
            throw new Error("brain correction: supersede reached dispatch without a replacement");
          }
          return applySupersede(tx, ctx.workspaceId, target, episodeId, at, base, {
            replacement,
            sourcePrincipal,
            actor,
            correctionSourceId,
            grantTokens: target.grantTokens,
          });
        case "re-authority":
          return applyVouch(tx, ctx.workspaceId, target, episodeId, at, base, "reAuthority", actor);
        case "pin":
          return applyVouch(tx, ctx.workspaceId, target, episodeId, at, base, "pinned", actor);
        default: {
          const unexpected: never = verb;
          throw new Error(`Unhandled correction verb: ${JSON.stringify(unexpected)}`);
        }
      }
    });

    if (result === null) {
      log.info(
        { workspaceId: ctx.workspaceId, factId, verb, userId: ctx.userId, requestId },
        "brain correction: verb matched no row — absent, already retracted, or not visible to this actor",
      );
      return { kind: "not-found" };
    }

    log.info(
      {
        workspaceId: ctx.workspaceId,
        factId,
        verb,
        userId: ctx.userId,
        correctionEpisodeId: result.correctionEpisodeId,
        supersededBy: result.supersededBy,
        flaggedForReReview: result.flaggedForReReview.length,
        requestId,
      },
      "brain correction: verb applied — human-authoritative, recorded as an immutable correction episode",
    );
    return { kind: "corrected", result };
  } catch (err) {
    if (err instanceof CorrectionRefusedError) {
      // The throw already rolled the transaction (and any episode row) back.
      log.info(
        { workspaceId: ctx.workspaceId, factId, verb, reason: err.reason, requestId },
        "brain correction: verb refused",
      );
      return { kind: "refused", reason: err.reason, message: err.message };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-verb effects
// ---------------------------------------------------------------------------

async function applyRetract(
  tx: ReconcileExecutor,
  workspaceId: string,
  target: TargetRow,
  episodeId: string,
  at: Date,
  base: BrainFactCorrectionResponse,
): Promise<BrainFactCorrectionResponse> {
  const stamped = await tx.query(RETRACT_FACT_SQL, [workspaceId, target.id]);
  const row = stamped.rows[0];
  const invalidatedAt = isJsonObject(row) ? iso(row.invalidated_at) : null;
  if (invalidatedAt === null) {
    // The target was read FOR UPDATE with `invalidated_at IS NULL` in the same
    // transaction, so a non-matching UPDATE is statement drift, not a race —
    // and reporting a retraction that did not stamp would be the silent
    // partial this module must not produce.
    throw new Error(
      `brain correction: retract stamped no row for fact ${target.id} — RETRACT_FACT_SQL drifted from the target read`,
    );
  }

  await tx.query(DERIVES_FROM_EDGE_SQL, [workspaceId, target.id, episodeId]);

  // Flag, never cascade — see the module header.
  const dependents = await tx.query(DEPENDENT_FACTS_SQL, [workspaceId, target.id]);
  const dependentIds = idList(dependents.rows);
  let flagged: readonly string[] = [];
  if (dependentIds.length > 0) {
    const marker = JSON.stringify({
      reReview: {
        reason: "derives-from-retracted",
        retractedFactId: target.id,
        correctionEpisodeId: episodeId,
        flaggedAt: at.toISOString(),
      },
    });
    const flaggedResult = await tx.query(MERGE_PROVENANCE_MARKER_SQL, [
      workspaceId,
      dependentIds,
      marker,
    ]);
    flagged = idList(flaggedResult.rows);
    if (flagged.length < dependentIds.length) {
      // Reachable (a dependent retracted between the SELECT and the marker
      // UPDATE — those need no flag) and also the only trace if the marker
      // statement ever drifts, which would leave dependents permanently
      // unflagged with the retraction reporting success.
      log.warn(
        {
          workspaceId,
          factId: target.id,
          expected: dependentIds.length,
          flagged: flagged.length,
          missing: dependentIds.filter((id) => !flagged.includes(id)),
        },
        "brain correction: some derives-from dependents were not flagged — retracted concurrently, or MERGE_PROVENANCE_MARKER_SQL drifted",
      );
    }
    log.info(
      { workspaceId, factId: target.id, flagged: flagged.length },
      "brain correction: retraction flagged derives-from dependents for re-review — nothing cascaded",
    );
  }

  return { ...base, invalidatedAt, flaggedForReReview: flagged };
}

interface SupersedeInputs {
  readonly replacement: { readonly object: string; readonly validFrom: Date | null };
  readonly sourcePrincipal: string;
  readonly actor: string;
  readonly correctionSourceId: string;
  readonly grantTokens: readonly string[];
}

async function applySupersede(
  tx: ReconcileExecutor,
  workspaceId: string,
  target: TargetRow,
  episodeId: string,
  at: Date,
  base: BrainFactCorrectionResponse,
  inputs: SupersedeInputs,
): Promise<BrainFactCorrectionResponse> {
  // #4912's stamp FIRST, via the publish gate's own statement — before the
  // replacement reconciles. The ordering is load-bearing: reconcile's tension
  // pass flags every LIVE same-subject/predicate rival of a new single-
  // cardinality claim, and the target is exactly such a rival until its
  // window closes. Stamping first means the belief being retired is already
  // settled history when the pass runs (`TENSION_CANDIDATES_SQL` filters
  // `valid_to IS NULL`), so this verb cannot mint a permanent
  // `in-tension-with` edge recording a conflict the same transaction
  // resolves. Any OTHER live rival still earns its advisory edge, which is
  // correct — the human arbitrated this pair, not the whole field. A failure
  // later in the verb rolls the stamp back with everything else.
  const stampResult = await tx.query(SUPERSEDE_STAMP_SQL, [workspaceId, [target.id]]);
  const stampedId = firstId(stampResult.rows);
  if (stampedId === null) {
    // The target is row-locked and was pre-checked published/current in this
    // transaction, so an empty RETURNING is drift — and committing would
    // record a supersession that never stamped.
    throw new Error(
      `brain correction: supersede stamped no row for fact ${target.id} — the target checks and SUPERSEDE_STAMP_SQL disagree`,
    );
  }

  // The replacement claim enters through the SAME seam every producer does —
  // reconcile is what attaches the provenance edge, the grant, and (if a live
  // rival already asserts the value) the corroboration instead of a duplicate.
  const report = await reconcileFacts(
    {
      episode: {
        id: episodeId,
        workspaceId,
        source: "human",
        sourceId: inputs.correctionSourceId,
        sourceActor: inputs.actor,
        occurredAt: at,
        visibleTo: inputs.grantTokens,
      },
      candidates: [
        {
          subject: target.subject,
          predicate: target.predicate,
          object: inputs.replacement.object,
          validFrom: inputs.replacement.validFrom ?? at,
          predicateCardinality: target.cardinality,
        },
      ],
      producer: "correction",
      // An authored claim is not extracted from anything.
      extractedAt: null,
      sourcePrincipal: inputs.sourcePrincipal,
    },
    // Reuse THIS transaction — the default runner would nest a second pool
    // checkout under the held connection, which is the bounded-pool starvation
    // deadlock `withBrainTransaction` documents.
    { withTransaction: (fn) => fn(tx), now: () => at },
  );
  const outcome = report.outcomes[0];
  if (!outcome || outcome.kind === "blocked") {
    // Unreachable by construction — the episode was just written with the
    // target's own usable grant and an explicit principal — so a block here
    // means the seam's contract changed underneath this caller.
    throw new Error(
      `brain correction: reconcile blocked the replacement claim (${outcome ? outcome.reason : "no outcome"}) — ` +
        "the correction episode should satisfy every episode-level gate by construction",
    );
  }

  // Authoritative immediately: a still-draft replacement is promoted inside
  // this same transaction, screened through the SAME classifier the publish
  // gate runs. A refusal is unreachable for a row this transaction built, and
  // is treated as a hard refusal (rolling everything back) if it happens.
  const rowResult = await tx.query(REPLACEMENT_ROW_SQL, [workspaceId, outcome.factId]);
  const row = rowResult.rows[0];
  if (!isJsonObject(row) || typeof row.id !== "string" || typeof row.status !== "string") {
    throw new Error(
      `brain correction: replacement fact ${outcome.factId} could not be read back — REPLACEMENT_ROW_SQL drifted`,
    );
  }
  if (row.status === "draft") {
    const draftRow: DraftFactRow = {
      id: row.id,
      subject: typeof row.subject === "string" ? row.subject : "?",
      predicate: typeof row.predicate === "string" ? row.predicate : "?",
      object: typeof row.object === "string" ? row.object : "?",
      source_episode_id: typeof row.source_episode_id === "string" ? row.source_episode_id : null,
      provenance: row.provenance,
      visible_to: row.visible_to,
    };
    const refusal = classifyFactForPromotion(draftRow);
    if (refusal) {
      throw new CorrectionRefusedError(
        CORRECTION_REFUSAL_REASONS.replacementUnpublishable,
        `The replacement could not be published: ${refusal.detail}`,
      );
    }
    const promoted = await tx.query(PROMOTE_CORRECTION_FACT_SQL, [workspaceId, row.id]);
    if (firstId(promoted.rows) === null) {
      throw new Error(
        `brain correction: replacement fact ${row.id} was classified promotable but the promote matched no row`,
      );
    }
  } else if (row.status !== "published") {
    // `archived`, or an out-of-vocabulary status: there is no path from here
    // to a current published successor, and silently superseding with a
    // non-served fact would retire the target in favour of nothing.
    throw new CorrectionRefusedError(
      CORRECTION_REFUSAL_REASONS.replacementUnpublishable,
      `A fact already asserts "${target.subject} ${target.predicate} ${inputs.replacement.object}" but is ` +
        `'${row.status}', so it cannot serve as the current belief. Resolve that fact first, then supersede.`,
    );
  }

  // The arbitration record (new → old), via the publish gate's own statement.
  // The stamp already ran — first in the verb, see the top of this function.
  await tx.query(INSERT_SUPERSEDES_EDGES_SQL, [
    workspaceId,
    JSON.stringify([{ newId: outcome.factId, oldId: target.id }]),
  ]);
  await tx.query(DERIVES_FROM_EDGE_SQL, [workspaceId, target.id, episodeId]);

  return {
    ...base,
    supersededBy: outcome.factId,
    validTo: at.toISOString(),
  };
}

/**
 * `re-authority` and `pin` — the two vouching verbs. Identical mechanics
 * (evidence edge + marker), different marker key; the SEMANTICS live in the
 * marker and in the tool/route prose, not in divergent machinery.
 */
async function applyVouch(
  tx: ReconcileExecutor,
  workspaceId: string,
  target: TargetRow,
  episodeId: string,
  at: Date,
  base: BrainFactCorrectionResponse,
  markerKey: "reAuthority" | "pinned",
  actor: string,
): Promise<BrainFactCorrectionResponse> {
  await tx.query(INSERT_PROVENANCE_EDGE_SQL, [workspaceId, target.id, episodeId]);
  const marker = JSON.stringify({
    [markerKey]: { actor, at: at.toISOString(), correctionEpisodeId: episodeId },
  });
  const marked = await tx.query(MERGE_PROVENANCE_MARKER_SQL, [workspaceId, [target.id], marker]);
  if (firstId(marked.rows) === null) {
    throw new Error(
      `brain correction: ${markerKey} marker matched no row for fact ${target.id} — the target read and the marker UPDATE disagree`,
    );
  }
  return base;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

/**
 * Tier-1 detection, off the stored payload: `reconcile.ts` writes
 * `provenance.source` structurally from the episode's connector class, so a
 * warehouse-derived fact carries `"warehouse"` there. Tier-1 proper is never
 * stored in `brain_facts` at all — this guards the DERIVED class the ADR
 * likewise exempts from correction.
 */
export function isWarehouseDerived(provenance: unknown): boolean {
  return isJsonObject(provenance) && provenance.source === "warehouse";
}

function normalizeReplacement(
  replacement: CorrectionReplacement | undefined,
): { readonly object: string; readonly validFrom: Date | null } | null {
  if (!replacement) return null;
  const object = replacement.object.trim();
  if (object === "") return null;
  const validFrom = replacement.validFrom ?? null;
  if (validFrom !== null && Number.isNaN(validFrom.getTime())) {
    // Both entry seams validate `validFrom` as ISO-8601 (`.datetime()`), so
    // this backstop is for a future caller constructing the Date directly.
    // Degrading is safe — the nullable slot already means "no stated start",
    // and the verb then records the correction time — but degrading a HUMAN's
    // stated temporal boundary silently is not; the warn is the trace.
    log.warn(
      { object },
      "brain correction: replacement.validFrom is an invalid Date — recording the correction time as the validity start instead",
    );
    return { object, validFrom: null };
  }
  return { object, validFrom };
}

/**
 * Narrow the locked target row, or say precisely why it cannot be narrowed.
 *
 * Returns `null` ONLY when there was no row at all — the genuine
 * absent/retracted/invisible trio the caller reports as not-found. A row that
 * EXISTS but fails narrowing is query drift in `correctionTargetSql`, and it
 * THROWS (→ a 500 with a requestId) rather than masquerading as not-found:
 * every column here is `NOT NULL text` at rest, and the drifted triple would
 * otherwise flow into a `supersede` replacement's own subject and predicate —
 * a published fact asserting `? ?`, the silent partial the module forswears.
 * Same posture, same reason, as the grant-token throw below.
 */
function readTargetRow(row: unknown, workspaceId: string): TargetRow | null {
  if (row === undefined || row === null) return null;
  const drift = (what: string): never => {
    throw new Error(
      `brain correction: the target read returned a row this module cannot narrow (${what}) — correctionTargetSql drifted (workspace ${workspaceId})`,
    );
  };
  if (!isJsonObject(row)) return drift("not an object");
  if (typeof row.id !== "string" || row.id === "") return drift("no usable id");
  if (
    typeof row.subject !== "string" ||
    typeof row.predicate !== "string" ||
    typeof row.object !== "string" ||
    typeof row.status !== "string"
  ) {
    return drift(`non-text SPO/status for fact ${row.id}`);
  }
  const cardinality =
    row.predicate_cardinality === "single" || row.predicate_cardinality === "multi"
      ? row.predicate_cardinality
      : "multi";
  if (cardinality !== row.predicate_cardinality) {
    log.warn(
      { rowId: row.id, workspaceId, cardinality: row.predicate_cardinality },
      "brain correction: target carries a predicate cardinality outside the vocabulary — treating it as `multi`",
    );
  }
  const grantTokens = isUnknownArray(row.visible_to)
    ? row.visible_to.filter((t): t is string => typeof t === "string")
    : [];
  if (grantTokens.length === 0) {
    // Unreachable for a row the ACL-gated read served (the actor matched a
    // token), so this is query drift — and seeding an episode with an empty
    // grant would trip the 0180 CHECK mid-transaction with a worse message.
    throw new Error(
      `brain correction: target fact ${row.id} produced no usable grant tokens — the visible_to projection drifted`,
    );
  }
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    status: row.status,
    cardinality,
    provenance: row.provenance,
    grantTokens,
    validTo: row.valid_to ?? null,
  };
}

function rowId(row: unknown): string | null {
  if (!isJsonObject(row)) return null;
  return typeof row.id === "string" && row.id !== "" ? row.id : null;
}

function firstId(rows: readonly unknown[]): string | null {
  return rows.length === 0 ? null : rowId(rows[0]);
}

function idList(rows: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const id = rowId(row);
    if (id !== null) ids.push(id);
  }
  return ids;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}
