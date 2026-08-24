/**
 * The RETIREMENT listing — published, warehouse-derived facts, with their ids
 * (#5403).
 *
 * ## Why this exists as its own surface
 *
 * `POST /api/v1/admin/brain-facts/{id}/retract` admits warehouse-derived facts
 * (`correction.ts`: the tier-1 refusal fires for every verb EXCEPT `retract`,
 * #5331). It needs a fact id. As of #5341 no surface this deployment exposes
 * could produce one for a PUBLISHED observation: `searchBrain` excludes them
 * from both content-mode arms, `/admin/brain-coverage` emits predicates without
 * ids, `executeSQL` is whitelist-scoped and `brain_facts` is not an entity, and
 * the candidate listing excludes them at every `?status=` including `all`.
 *
 * So the arc that shipped the verb closed, in the same milestone, every path to
 * the identifiers the verb consumes. Both halves were right on their own; the
 * gap was only visible from the operator's side, and #5331 AC5 — "verified by
 * reading them back" — was specified while the rows were still enumerable and
 * became unsatisfiable underneath it.
 *
 * ## What this is NOT
 *
 * ⚠️ **This is not a weakening of the review-queue exclusion, and must never
 * become one.** `candidates.ts` places `notAnObservationSql("f")` ABOVE its
 * status arm precisely so `?status=published` and `?status=all` cannot list
 * these rows, and the comment there states the intent outright. That placement
 * is correct and is untouched by #5403: an observation is not a candidate for
 * REVIEW, because a reviewer has no trust call to make on it — their only
 * options were approve or leave it forever (they may not reject it, #5330, nor
 * correct it afterwards).
 *
 * The insight #5403 turns on is that **retirement is not review**. Two
 * different needs had been collapsed onto one listing, and separating them is
 * what lets both be right: the review queue keeps excluding observations, and
 * the operator retiring an ADR-0042 straggler gets a surface built for that
 * question. A `?source=` filter on the candidate listing was considered and
 * rejected — it would re-introduce the exact shape that comment argues against,
 * and re-open `?status=published` on the review surface to do it.
 *
 * `retirable-vs-review.test.ts` pins BOTH directions with one fixture, so the
 * two surfaces cannot quietly drift back together.
 *
 * ## A closed population, deliberately served by a permanent surface
 *
 * Nothing new can enter this population: the publish gate has refused
 * warehouse-derived promotions since #5342, so the set only shrinks. A
 * throwaway DB query was the cheaper option and was considered. It was rejected
 * because retraction is audited and ACL-gated while a `psql` session is
 * neither, because #5331 AC5's read-back would then also have to be a DB query
 * on all three regions, and because no test can pin "the review queue still
 * excludes these" against a query that lives in a runbook.
 *
 * ## Reader scoping, and the per-region caveat
 *
 * Reads compose the reviewer's own fail-closed ACL predicate, like every other
 * read on this router — the audit override is NOT wired up here either. So
 * `total` is "what YOU can see", not "what exists".
 *
 * ⚠️ A workspace-admin session authenticates against exactly ONE region
 * (ADR-0024, "the process is the region"). The stranded rows #5331 names live
 * on `eu-prod` and `apac-prod`, so clearing them needs a session PER REGION —
 * one admin login does not cover all three, and a `200` from `api` says nothing
 * about `api-eu`. That is correct behaviour, not a gap, and it is stated in the
 * route description too because the runbook reader will meet it before this
 * file.
 */

import {
  aclVisibilityClause,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import { isJsonObject, observationSql } from "@atlas/api/lib/brain/observation";
import type { BrainCandidateReader } from "@atlas/api/lib/brain/candidates";
import type {
  BrainFactRetirableListResponse,
  BrainFactRetirableObservation,
} from "@useatlas/types";

/** Surface tag carried on this module's `BrainReaderUnresolvedError` throws. */
const RETIREMENT_SURFACE = "retirement";

/** Hard ceiling on one page, mirroring `CANDIDATE_PAGE_MAX`'s role on the review surface. */
export const RETIRABLE_PAGE_MAX = 200;

export interface LoadRetirableOptions {
  readonly ctx: BrainPrincipalContext;
  readonly limit: number;
  readonly offset: number;
  readonly requestId: string;
}

/** The raw row shape this module's SELECT produces. */
interface RetirableRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly provenance: unknown;
  readonly valid_from: Date | string | null;
  readonly valid_to: Date | string | null;
  readonly ingested_at: Date | string | null;
  readonly total_count?: number | string | null;
}

/** Postgres hands back `Date` for timestamptz; the wire contract is ISO strings. */
function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * The stored `provenance.source`, echoed for the operator.
 *
 * Read defensively rather than asserted: a region import restores a bundle's
 * `provenance` verbatim (`api/routes/admin-migrate.ts`), so a row at rest can
 * carry `{}`, `{"source": null}`, or a non-object entirely. Returning `null`
 * for all three is honest — the row matched the SQL predicate on its source, so
 * this field is a DISPLAY echo, never the thing that decided membership.
 */
function readSource(provenance: unknown): string | null {
  if (!isJsonObject(provenance)) return null;
  const source = provenance["source"];
  return typeof source === "string" ? source : null;
}

function toObservation(row: RetirableRow): BrainFactRetirableObservation {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    source: readSource(row.provenance),
    validFrom: isoOrNull(row.valid_from),
    validTo: isoOrNull(row.valid_to),
    ingestedAt: isoOrNull(row.ingested_at),
  };
}

/** `COUNT(*) OVER ()` arrives as a string on some drivers; coerce without trusting it. */
function count(value: number | string | null | undefined): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

/** The WHERE clauses + bound params, shared by the page and the past-the-end re-count. */
function retirableWhere(aclSql: string, aclParams: readonly unknown[]): {
  where: string[];
  params: unknown[];
} {
  return {
    params: [...aclParams],
    where: [
      aclSql,
      // Already-retired rows have left. This surface's whole purpose is to let
      // an operator confirm a clearing, so a row that still listed after being
      // retracted would report the opposite of the truth (#5331 AC5).
      "f.invalidated_at IS NULL",
      // ADR-0042's population, in the POSITIVE. `observationSql` is the exact
      // predicate `notAnObservationSql` negates for the review queue, so the
      // two surfaces are complementary BY CONSTRUCTION rather than by two
      // hand-written predicates that agree today.
      //
      // ⚠️ Note this is `observationSql` bare, NOT `IS TRUE`-folded: a
      // `source`-less row (NULL) is excluded here and INCLUDED by the review
      // queue, which is the correct split. Such a row predates the provenance
      // shape and is not a known observation, so it is not retirement material
      // — and `readStoredSource`'s third answer ("a kind this deployment cannot
      // classify") is deliberately not swept in either. Retiring a row on a
      // guess is exactly the fail-open `correction.ts` refuses to take.
      observationSql("f"),
      // The stranded population is the PUBLISHED one. A warehouse-derived DRAFT
      // is refused at the publish gate (#5342) and needs no operator action —
      // listing it here would invite retracting rows that were never blessed
      // and are already inert.
      "f.status = 'published'",
      // ⚠️ `brainFactCurrentClause` is DELIBERATELY ABSENT, and this is the one
      // predicate where this surface parts company with every sibling reader
      // (`candidates.ts`, `search.ts`, the correction window). Saying so
      // explicitly because that function's docstring warns that a caller who
      // forgets it "serves superseded claims as current belief" — and the
      // warning does not bite here, because this surface serves nothing as
      // belief. It is a DISCOVERY listing whose entire purpose is to make a row
      // nameable so it can be retracted.
      //
      // Filtering on it would reintroduce an invisibility on the one surface
      // built to remove one. A published observation carrying a stamped
      // `valid_to` is reachable by no other path — search excludes it twice
      // over (source AND currency), review excludes it on source — so omitting
      // it here would strand it exactly as #5403 found the others stranded,
      // and `retract` is admitted on it (the verb is not gated on the
      // supersession window; only `re-authority` and `pin` are).
      //
      // Nor is it the same case as the DRAFT above. A draft was never blessed;
      // a superseded observation WAS, and `retract` says precisely that it
      // should not have been. The row is still readable to an as-of query,
      // which supersession does not change and only the tombstone does.
      //
      // The operator is not left guessing which they are looking at: `validTo`
      // is in the projection, so an inert row is visibly inert. Reporting the
      // state beats filtering on it when the filter's cost is a row nobody can
      // find. `retirable-vs-review.test.ts` pins this.
    ],
  };
}

/**
 * One page of published warehouse-derived facts the reader may see.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable principals.
 */
export async function loadRetirableObservations(
  db: BrainCandidateReader,
  options: LoadRetirableOptions,
): Promise<BrainFactRetirableListResponse> {
  const { ctx, requestId } = options;
  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), RETIRABLE_PAGE_MAX);
  const offset = Math.max(0, Math.trunc(options.offset));

  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, RETIREMENT_SURFACE);
  }

  const { where, params } = retirableWhere(acl.sql, acl.params);
  params.push(limit, offset);
  const limitParam = params.length - 1;

  // `COUNT(*) OVER ()` gives the grand total in the same pass as the page, so
  // the count and the rows cannot disagree under concurrent retraction.
  //
  // ORDER BY is stable and boring on purpose: oldest ingest first, `id` as the
  // tiebreak. An operator working a finite list top-to-bottom across several
  // requests needs the order not to move under them, and this surface has no
  // ranking to express — unlike the review queue, whose stale-first hint exists
  // to keep an aged claim from being buried under fresh ingest. Nothing new can
  // arrive here (#5342), so there is no fresh ingest to bury anything.
  const sql = `SELECT f.id::text AS id,
         f.subject,
         f.predicate,
         f.object,
         f.provenance,
         f.valid_from,
         f.valid_to,
         f.ingested_at,
         COUNT(*) OVER ()::int AS total_count
    FROM brain_facts f
   WHERE ${where.join("\n     AND ")}
   ORDER BY f.ingested_at ASC NULLS LAST, f.id ASC
   LIMIT $${limitParam} OFFSET $${limitParam + 1}`;

  const result = await db.query(sql, params);
  const rows = result.rows as RetirableRow[];

  if (rows.length === 0) {
    // An empty window produces no `COUNT(*) OVER ()` row, so on a page past the
    // end the total is UNKNOWN rather than zero — and reporting zero is the one
    // answer this surface must never give wrongly, since "zero" is how an
    // operator concludes the retirement is COMPLETE. Pay for the second
    // statement only when the page could be past the end.
    const total = offset > 0 ? await countRetirable(db, acl.sql, acl.params) : 0;
    return { observations: [], total };
  }

  return {
    observations: rows.map(toObservation),
    total: count(rows[0]?.total_count),
  };
}

/** The grand total alone — only reached for a page past the end. See the call site. */
async function countRetirable(
  db: BrainCandidateReader,
  aclSql: string,
  aclParams: readonly unknown[],
): Promise<number> {
  const { where, params } = retirableWhere(aclSql, aclParams);
  const result = await db.query(
    `SELECT COUNT(*)::int AS total_count FROM brain_facts f WHERE ${where.join("\n     AND ")}`,
    params,
  );
  return count((result.rows[0] as { total_count?: number | string | null })?.total_count);
}
