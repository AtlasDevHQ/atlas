/**
 * The `in-tension-with` conflict-cluster read (#4913, ADR-0036 §Temporal,
 * conflict & provenance) — the clustering `reconcile.ts` defers to when it
 * writes the edges.
 *
 * ONE implementation behind BOTH read surfaces. The review queue
 * (`candidates.ts`) and the fused search (`search.ts`) previously each carried
 * their own copy of this walk, and the two copies agreeing about what a
 * "conflict" is was a matter of diligence. Now the walk lives here and each
 * surface only PROJECTS the cluster into its own wire shape — per-rival
 * withheld handles for the human reviewer, an aggregated withheld count for the
 * LLM context window.
 *
 * ## What a cluster is, and is not
 *
 * A fact's cluster is its 1-hop `in-tension-with` neighborhood, in BOTH
 * directions. `reconcile.ts` writes each edge from the newer claim to the
 * incumbent, so an incumbent that has since been contradicted only ever
 * appears on the `to` side — a `from`-only walk would hide from the reader
 * exactly the older claim whose trust is now in question.
 *
 * It is NOT an arbitration. Nothing here ranks, scores, or orders by anything
 * that implies a winner: counterparts and withheld handles are sorted by
 * `factId` alone — deterministic, and deliberately not by time, status,
 * source authority, or corroboration. Those travel ON the counterpart as
 * surfacing hints for the reader; refusing to pick between them is the point
 * (ADR-0036 — supersession is the human gate's verb, composed via #4912).
 *
 * ## The likeliest leak, and how this module holds the line
 *
 * Two statements, never a join:
 *
 *   1. The EDGES — ungated, because `brain_edges` carries no grant of its own.
 *   2. The counterpart FACTS — through a FRESH `aclVisibilityClause` against
 *      `brain_facts`, applied independently of whatever entitled the reader to
 *      the fact that owns the cluster.
 *
 * A join gated by the OWNER's predicate would hand a reader a rival claim
 * (and, since #4913, its provenance) because they were entitled to the claim
 * it conflicts with. A counterpart the reader may not see is REPORTED rather
 * than dropped — "there is a rival you cannot see" is precisely what should
 * stop a reviewer approving or an agent asserting, and an omitted row reads as
 * "nothing contradicts this".
 *
 * The counterpart SELECT deliberately reads NO episode content: provenance is
 * the fact row's own `jsonb` payload, and the attribution triple inside it is
 * re-decided per counterpart row by each surface's projection
 * (`attributionDecision`, fed the `pre_widening_visible_to` this SELECT
 * carries) — a counterpart is a fact in its own right, so inheriting the
 * owner's decision would be a guess about a different row's grant.
 */

import type { createLogger } from "@atlas/api/lib/logger";
import {
  aclVisibilityClause,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import { corroborationCountSql } from "@atlas/api/lib/brain/actor-identity";
import type { BrainFactTensionDirection } from "@useatlas/types";

/** The database handle this module needs — see `BrainCandidateReader`. */
export interface BrainTensionReader {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/** The structural half of `createLogger`'s return this module calls. */
type BrainTensionLogger = Pick<ReturnType<typeof createLogger>, "warn">;

/**
 * A counterpart row off `pg`.
 *
 * `subject` / `predicate` / `object` are trusted `string` (0180 `text NOT
 * NULL`), as are the two `::text`-cast uuid columns — the same exception both
 * surfaces already make for the owner rows. Everything else is `unknown` and
 * narrowed by the surface's projection, because the surfaces already own the
 * drift fallbacks for status, corroboration, and timestamps (logged or
 * deliberately silent per each helper's own doc).
 */
export interface TensionCounterpartRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly status: unknown;
  readonly visible_to: unknown;
  /** ACL input for the per-counterpart attribution decision (#4836). */
  readonly pre_widening_visible_to: unknown;
  readonly provenance: unknown;
  readonly source_episode_id: string | null;
  readonly valid_from: unknown;
  /** Supersession stamp — `invalidated_at`'s twin on the other axis (#4912, carried onto the counterpart in #4935). */
  readonly valid_to: unknown;
  /** Retraction tombstone — see `loadTensionClusters` for why both axes are carried. */
  readonly invalidated_at: unknown;
  readonly ingested_at: unknown;
  readonly corroboration_count: unknown;
}

/** One ACL-visible member of a cluster, with which end of the edge it sat on. */
export interface TensionCounterpart {
  readonly row: TensionCounterpartRow;
  readonly direction: BrainFactTensionDirection;
}

/** One member the reader may not see — an opaque handle, never the payload. */
export interface TensionWithheld {
  readonly factId: string;
  readonly direction: BrainFactTensionDirection;
}

/**
 * One fact's 1-hop conflict cluster. Both lists are sorted by `factId` —
 * deterministic and neutral; any other key would be a ranking.
 */
export interface TensionCluster {
  readonly counterparts: readonly TensionCounterpart[];
  readonly withheld: readonly TensionWithheld[];
}

export interface TensionClusterOptions {
  readonly ctx: BrainPrincipalContext;
  /**
   * Most edges resolved per page. Surface-specific on purpose: the review
   * queue budgets for a 200-row admin table (500), the fused search for an LLM
   * context window (200). When it bites, `truncated` reaches the caller's wire
   * AND the log — a truncated conflict list reads as "nothing contradicts
   * this", which is the one thing either surface must never imply.
   */
  readonly cap: number;
  /**
   * Which read surface is asking — carried on the `BrainReaderUnresolvedError`
   * and stamped into the log lines, so the two surfaces stay tellable apart in
   * an incident even though the walk is shared.
   */
  readonly surface: "review" | "search";
  readonly log: BrainTensionLogger;
  readonly requestId?: string;
}

/** Log prefix per surface — matches each surface's other lines. */
const SURFACE_LABEL: Record<TensionClusterOptions["surface"], string> = {
  review: "brain review",
  search: "brain search",
};

/**
 * Columns the counterpart projection reads. A subset of the review queue's
 * `CANDIDATE_COLUMNS` — deliberately re-listed rather than shared, because the
 * queue's list serves its page query and would silently grow this SELECT
 * whenever the queue needs a new column.
 */
const COUNTERPART_COLUMNS = `f.id::text AS id,
         f.subject,
         f.predicate,
         f.object,
         f.status,
         f.visible_to,
         f.pre_widening_visible_to,
         f.provenance,
         f.source_episode_id::text AS source_episode_id,
         f.valid_from,
         f.valid_to,
         f.invalidated_at,
         f.ingested_at`;

/**
 * Corroboration = DISTINCT SOURCES behind the claim, never a row count and —
 * since #5487 — never an edge count either.
 *
 * Re-observing a claim strengthens it by adding a `provenance` edge; it never
 * duplicates the fact, so counting rows would report 1 forever. Counting the
 * EDGES was the previous derivation and reported an inflated number: two
 * messages from one person are two edges and one source. {@link
 * corroborationCountSql} carries the definition of "distinct source", the
 * three-way choice behind it, and why a machine principal is exempt; it is
 * shared with `INSERT_PROVENANCE_EDGE_SQL`'s guard so the count and the edges
 * cannot disagree.
 */
const COUNTERPART_CORROBORATION = corroborationCountSql("f");

interface TensionEdgeRow {
  readonly from_id: string | null;
  readonly to_id: string | null;
}

interface TensionPair {
  readonly owner: string;
  readonly other: string;
  readonly direction: BrainFactTensionDirection;
}

/**
 * Load the conflict clusters for a page of facts the caller ALREADY holds
 * (i.e. already fetched through its own ACL-gated statement).
 *
 * @throws {BrainReaderUnresolvedError} on a deny-all counterpart clause —
 *   unreachable in practice because every caller has already thrown on the
 *   same decision against the same table, but throwing (rather than skipping
 *   the query) matters: skipping would leave every counterpart unresolved and
 *   therefore reported as withheld — fabricated ACL withholding, which neither
 *   a reviewer nor an agent can tell from the real thing.
 */
export async function loadTensionClusters(
  db: BrainTensionReader,
  factIds: readonly string[],
  options: TensionClusterOptions,
): Promise<{ clusters: Map<string, TensionCluster>; truncated: boolean }> {
  const { ctx, cap, surface, log, requestId } = options;
  const clusters = new Map<string, TensionCluster>();
  if (factIds.length === 0) return { clusters, truncated: false };
  if (!ctx.workspaceId) {
    // Unreachable — a workspace-less context denies at the caller. Loud rather
    // than a bare return, because this guard's failure mode is a page that
    // silently reports no conflicts at all.
    log.warn(
      { requestId, origin: ctx.origin, surface },
      `${SURFACE_LABEL[surface]}: contradiction lookup reached with no workspace — reporting no conflicts, which is wrong; this is an Atlas bug`,
    );
    return { clusters, truncated: false };
  }

  // `DISTINCT` because 0180 puts no unique index on the edge tuple —
  // `reconcile.ts` dedupes with `WHERE NOT EXISTS`, which two concurrent
  // passes can race, and a duplicate edge would surface as two identical
  // conflicts. The ORDER BY makes the cap's bite deterministic; the loss it
  // concentrates at the tail is why `truncated` exists.
  const edgeResult = await db.query(
    `SELECT DISTINCT from_fact_id::text AS from_id, to_fact_id::text AS to_id
       FROM brain_edges
      WHERE workspace_id = $1
        AND edge_type = 'in-tension-with'
        AND (from_fact_id = ANY($2::uuid[]) OR to_fact_id = ANY($2::uuid[]))
      ORDER BY from_id, to_id
      LIMIT $3`,
    [ctx.workspaceId, [...factIds], cap + 1],
  );
  const edges = edgeResult.rows as readonly TensionEdgeRow[];
  if (edges.length === 0) return { clusters, truncated: false };

  // `let`, because a dropped edge below also makes this page's conflict list
  // incomplete and readers gate on exactly that. See the null-endpoint arm.
  // ⚠️ `usable` is sliced from the CAP verdict alone, on the next line — that
  // later assignment must stay below it, or a dropped edge would re-slice the
  // page and re-fire the cap warning for a truncation that never happened.
  let truncated = edges.length > cap;
  const usable = truncated ? edges.slice(0, cap) : edges;
  if (truncated) {
    log.warn(
      { workspaceId: ctx.workspaceId, requestId, cap, facts: factIds.length, surface },
      `${SURFACE_LABEL[surface]}: in-tension-with fan-out exceeded the per-page cap — some contradiction hints are omitted from this page`,
    );
  }

  const onPage = new Set(factIds);
  const pairs: TensionPair[] = [];
  for (const edge of usable) {
    const { from_id: from, to_id: to } = edge;
    if (!from || !to) {
      // Unreachable — the endpoint columns are nullable by the four-endpoint
      // design, but `chk_brain_edges_endpoint_kinds` forces both FACT
      // endpoints non-null for every `in-tension-with` row this query can
      // return. A hit would make a conflict silently read as "nothing
      // contradicts this", so it is logged rather than skipped bare — with the
      // surviving endpoint, so an operator can find the row.
      //
      // It also marks the page TRUNCATED, which is the same thing the fan-out
      // cap means: this page's conflict list is incomplete. Not cosmetic since
      // #4995 — the review queue's "Conflict resolved" badge is gated on that
      // flag, so without this a row whose only OPEN rival was the dropped one
      // would render an affirmative "this was arbitrated" over a rival nobody
      // ever saw. The log alone cannot reach the reader; the flag can.
      truncated = true;
      log.warn(
        { workspaceId: ctx.workspaceId, requestId, surface, edge: { from, to } },
        `${SURFACE_LABEL[surface]}: tension edge row is missing an endpoint — the edge query shape changed; a conflict hint was dropped`,
      );
      continue;
    }
    // An edge with BOTH ends on the page yields two entries — each fact names
    // the other. Symmetric on purpose: neither end is the authority. A raced
    // reciprocal PAIR (A→B and B→A — `reconcile.ts` dedupes one direction
    // only) likewise yields one pair per edge, and that is deliberate for
    // visible rivals: each entry carries its `edgeDirection`, so listing the
    // rival once per direction is graph-faithful, not double-counting. Only
    // the search surface's direction-less withheld COUNT collapses to
    // distinct rivals (`search.ts`), because there the number is the whole
    // signal.
    if (onPage.has(from)) pairs.push({ owner: from, other: to, direction: "to" });
    if (onPage.has(to)) pairs.push({ owner: to, other: from, direction: "from" });
  }
  if (pairs.length === 0) return { clusters, truncated };

  const counterpartIds = [...new Set(pairs.map((p) => p.other))];
  // The FRESH fact predicate — see the module header on why this is a second
  // statement and never a join onto the owner's row.
  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  if (acl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, surface);
  }

  const params: unknown[] = [...acl.params, counterpartIds];
  // NEITHER temporal axis is filtered, and BOTH are selected — the argument is
  // one argument applied twice.
  //
  // Not filtered: a rival that was retracted (`invalidated_at`) or superseded
  // (`valid_to`) is still why this claim was contested, and hiding it would
  // make a conflict vanish the moment somebody resolved one side.
  //
  // Selected and carried, RAW rather than as a boolean: neither verb writes
  // `status`, so a retired rival still reports whatever status it held, and a
  // future-dated `valid_to` is a live fact — only the reader can decide
  // whether a window has actually closed. Why either stamp is load-bearing,
  // and what a reader owes it, is on `BrainFactTensionVisible.validTo`
  // (#4935).
  const result = await db.query(
    `SELECT ${COUNTERPART_COLUMNS},
            ${COUNTERPART_CORROBORATION} AS corroboration_count
       FROM brain_facts f
      WHERE ${acl.sql}
        AND f.id = ANY($${params.length}::uuid[])`,
    params,
  );
  const visible = new Map<string, TensionCounterpartRow>();
  for (const raw of result.rows as readonly TensionCounterpartRow[]) {
    if (typeof raw.id === "string" && raw.id !== "") {
      visible.set(raw.id, raw);
    } else {
      // This row came back THROUGH the ACL predicate, so dropping it here
      // reclassifies an entitled rival as withheld — fabricated ACL
      // withholding, the exact failure the deny-all throw above refuses.
      // Unreachable from the database (`f.id::text` of a NOT NULL uuid), so a
      // hit is query drift, and it must not be silent. `idType` and the batch
      // size are what tell an operator whether one row drifted or the whole
      // statement did.
      log.warn(
        {
          workspaceId: ctx.workspaceId,
          requestId,
          surface,
          idType: typeof (raw as { id?: unknown }).id,
          batch: counterpartIds.length,
        },
        `${SURFACE_LABEL[surface]}: counterpart row has no usable id — the counterpart query shape changed; the rival will be misreported as withheld`,
      );
    }
  }

  const building = new Map<string, { counterparts: TensionCounterpart[]; withheld: TensionWithheld[] }>();
  for (const pair of pairs) {
    let cluster = building.get(pair.owner);
    if (!cluster) {
      cluster = { counterparts: [], withheld: [] };
      building.set(pair.owner, cluster);
    }
    const row = visible.get(pair.other);
    if (row) cluster.counterparts.push({ row, direction: pair.direction });
    else cluster.withheld.push({ factId: pair.other, direction: pair.direction });
  }

  for (const [owner, cluster] of building) {
    // Deterministic, and deliberately NOT by time, status, source authority,
    // or corroboration — any of those would be a ranking, and refusing to
    // arbitrate is the point.
    cluster.counterparts.sort((a, b) => a.row.id.localeCompare(b.row.id));
    cluster.withheld.sort((a, b) => a.factId.localeCompare(b.factId));
    clusters.set(owner, cluster);
  }

  return { clusters, truncated };
}
