/**
 * What a claim REPLACED — the `supersedes` lineage read (#5461, PRD finish
 * condition 5, ADR-0036 §Temporal).
 *
 * > **5. The past is legible.** Someone asks a question whose answer changed
 * > three months ago. They get today's answer, can see the previous answer, and
 * > can see who changed it and when.
 *
 * ## Why this module exists at all
 *
 * `supersedes` has been written since #4912 — by the publish gate
 * (`content-mode/adapters/brain-facts.ts`) and, since #5458, by a human through
 * the correction dialog. Until this module NOTHING READ IT BACK to a reader.
 * Every other reference in the tree is write-side or gate-side: the cardinality
 * repeat gate (`lib/brain/cardinality.ts`), vocabulary supersession
 * (`lib/brain/vocabulary-pending.ts`), and insert-time dedupe (the publish
 * adapter). The edge that exists precisely to preserve a previous answer had no
 * read path, admin or otherwise — which is why condition 5 held "at the record
 * level" and not for any person.
 *
 * It is therefore born NON-ADMIN. There is exactly one non-admin path into
 * brain data — the `searchBrain` result on the chat stream — and that is the
 * one this feeds, so the previous answer reaches a person from a normal answer
 * rather than from `/admin/brain`.
 *
 * ## ⚠️ The retracted predecessor, which is the whole disclosure boundary
 *
 * BOTH statements below exclude `invalidated_at IS NOT NULL`, and the walk
 * STOPS at a tombstone rather than counting through it. `retract` is the verb
 * whose PURPOSE is to make the past unreadable, and it is the GDPR-erasure path
 * (#4916) — which is why `invalidated_at IS NULL` survives in both branches of
 * `search.ts`'s temporal read, `asOf` included.
 *
 * Excluding it from {@link FactLineage.priorCount} is not belt-and-braces. A
 * count that still said "1" after an erasure would re-disclose the erased
 * claim's existence on the very surface built to show history — and a reader
 * seeing `priorCount: 1` with a withheld prior would reasonably conclude the
 * previous answer merely sat outside their grant. The second statement repeats
 * the predicate anyway, because a retraction can land BETWEEN the two reads and
 * the cost of the extra term is nothing next to what it guards.
 *
 * ## Two statements, never a join — the `tensions.ts` posture
 *
 * The walk is unauthenticated existence; the CONTENT read is a fresh
 * `aclVisibilityClause` against the predecessor's OWN frozen `visible_to`,
 * never the live claim's decision carried over. Each version carries the grant
 * it was published with, so "what we believed then" is gated by the grant it
 * was published under with no code here doing anything — the bi-temporal ACL
 * falls out of grant immutability (`search.ts`'s `asOf` header).
 *
 * A deny-all reader THROWS rather than returning an empty map, for
 * `tensions.ts`'s reason: skipping the statement would report every predecessor
 * as withheld, and fabricated ACL withholding is indistinguishable from the
 * real thing.
 *
 * ## The count is disclosed, the content is not
 *
 * {@link FactLineage.priorCount} counts non-retracted ancestors whether or not
 * this reader may read them, and {@link FactLineage.prior} degrades to
 * `{ visible: false }`. That split is `BrainSearchTensionWithheld`'s, taken
 * deliberately rather than re-argued: an omitted entry reads as "this never
 * changed", which on this surface is the worse untruth.
 */

import {
  aclVisibilityClause,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import type { createLogger } from "@atlas/api/lib/logger";
import type {
  BrainFactChangeAgent,
  BrainFactHistoryView,
  BrainFactPriorVersion,
  BrainFactProvenanceView,
} from "@useatlas/types";

/** The `db.query` shape this module needs — the `tensions.ts` seam verbatim. */
export interface BrainLineageReader {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/** The structural half of `createLogger`'s return this module calls. */
type BrainLineageLogger = Pick<ReturnType<typeof createLogger>, "warn">;

/**
 * How far back the walk goes.
 *
 * Also the CYCLE GUARD: `supersedes` has no acyclicity constraint (0180 puts no
 * unique index on the edge tuple and nothing forbids A→B→A, which a region
 * import could carry), so the depth bound — not a visited-set — is what
 * terminates the recursion. Ten is far past anything the record holds (the
 * deepest lineage in production is one hop) and a page that hits it reports
 * {@link FactLineage.truncated} rather than a short count.
 */
const LINEAGE_DEPTH_CAP = 10;

/**
 * The lineage walk. Non-retracted ancestors only — see the module header.
 *
 * `created_at` rides only the DEPTH-1 rows in practice, but is selected at
 * every level so the ordering below is expressible without a second statement.
 * The `ORDER BY` makes the cap's bite deterministic; `LIMIT` takes one more
 * than the cap so the caller can tell "full" from "overflowing".
 */
const LINEAGE_SQL = `WITH RECURSIVE lineage AS (
      SELECT e.from_fact_id AS root,
             e.to_fact_id   AS prior_id,
             e.created_at   AS recorded_at,
             1              AS depth
        FROM brain_edges e
        JOIN brain_facts p
          ON p.workspace_id = e.workspace_id
         AND p.id = e.to_fact_id
         AND p.invalidated_at IS NULL
       WHERE e.workspace_id = $1
         AND e.edge_type = 'supersedes'
         AND e.from_fact_id = ANY($2::uuid[])
       UNION ALL
      SELECT l.root,
             e.to_fact_id,
             e.created_at,
             l.depth + 1
        FROM lineage l
        JOIN brain_edges e
          ON e.workspace_id = $1
         AND e.edge_type = 'supersedes'
         AND e.from_fact_id = l.prior_id
        JOIN brain_facts p
          ON p.workspace_id = e.workspace_id
         AND p.id = e.to_fact_id
         AND p.invalidated_at IS NULL
       WHERE l.depth < $3
    )
    SELECT DISTINCT root::text AS root,
                    prior_id::text AS prior_id,
                    recorded_at,
                    depth
      FROM lineage
     ORDER BY root, depth, prior_id
     LIMIT $4`;

interface LineageEdgeRow {
  readonly root: string | null;
  readonly prior_id: string | null;
  readonly recorded_at: unknown;
  readonly depth: unknown;
}

/**
 * The predecessor's own columns.
 *
 * ⚠️ `subject` and `predicate` are deliberately NOT selected. A supersession
 * inherits the target's slot verbatim (`inheritedSlot`, `correction.ts`), so a
 * predecessor's subject and predicate cannot differ from the live claim's —
 * selecting them would let a surface render them side by side and imply they
 * could. `BrainFactPriorVersionVisible` omits them for the same reason.
 */
const PRIOR_COLUMNS = `f.id::text AS id, f.object, f.valid_from, f.valid_to`;

interface PriorRow {
  readonly id: string;
  readonly object: string;
  readonly valid_from: unknown;
  readonly valid_to: unknown;
}

export interface FactLineage {
  /** The immediate predecessor — most recently RECORDED where a claim retired several at once. */
  readonly prior: BrainFactPriorVersion;
  /** Distinct non-retracted ancestors reachable through `supersedes`. ≥ 1. */
  readonly priorCount: number;
  /** When that supersession was recorded — the edge's own stamp. */
  readonly recordedAt: string | null;
}

export interface FactLineageOptions {
  readonly ctx: BrainPrincipalContext;
  /**
   * Most lineage rows resolved per page. Surface-specific for
   * `TensionClusterOptions.cap`'s reason; when it bites, `truncated` reaches
   * the wire AND the log, because an undercount reads as a shorter history than
   * the record holds.
   */
  readonly cap: number;
  readonly log: BrainLineageLogger;
  readonly requestId?: string;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * Load what each fact on a page replaced.
 *
 * @throws {BrainReaderUnresolvedError} on a deny-all predecessor clause — see
 *   the module header on fabricated ACL withholding.
 */
export async function loadFactLineage(
  db: BrainLineageReader,
  factIds: readonly string[],
  options: FactLineageOptions,
): Promise<{ lineage: Map<string, FactLineage>; truncated: boolean }> {
  const { ctx, cap, log, requestId } = options;
  const lineage = new Map<string, FactLineage>();
  if (factIds.length === 0) return { lineage, truncated: false };
  if (!ctx.workspaceId) {
    // Unreachable — a workspace-less context denies at the caller. Loud rather
    // than a bare return, because this guard's failure mode is a page on which
    // nothing ever appears to have changed.
    log.warn(
      { requestId, origin: ctx.origin },
      "brain search: lineage lookup reached with no workspace — reporting that nothing changed, which is wrong; this is an Atlas bug",
    );
    return { lineage, truncated: false };
  }

  const walk = await db.query(LINEAGE_SQL, [
    ctx.workspaceId,
    [...factIds],
    LINEAGE_DEPTH_CAP,
    cap + 1,
  ]);
  const rows = walk.rows as readonly LineageEdgeRow[];
  if (rows.length === 0) return { lineage, truncated: false };

  // ⚠️ Sliced from the CAP verdict alone, before any row is dropped below — a
  // dropped row also makes the page's history incomplete, and re-slicing there
  // would re-fire this warning for a truncation that never happened.
  let truncated = rows.length > cap;
  const usable = truncated ? rows.slice(0, cap) : rows;
  if (truncated) {
    log.warn(
      { workspaceId: ctx.workspaceId, requestId, cap, facts: factIds.length },
      "brain search: supersedes lineage exceeded the per-page cap — some earlier versions are omitted from this page",
    );
  }

  const onPage = new Set(factIds);
  /** Deduped ancestors per root — a diamond reaches the same claim at two depths. */
  const ancestors = new Map<string, Set<string>>();
  /** The best depth-1 candidate per root, by recorded time then id. */
  const immediate = new Map<string, { priorId: string; recordedAt: string | null }>();
  for (const row of usable) {
    const { root, prior_id: priorId } = row;
    if (!root || !priorId) {
      // Unreachable — `chk_brain_edges_endpoint_kinds` forces both FACT
      // endpoints non-null for every `supersedes` row this query can return. A
      // hit would make a changed answer silently read as unchanged, so it marks
      // the page truncated (the flag reaches the reader; the log cannot).
      truncated = true;
      log.warn(
        { workspaceId: ctx.workspaceId, requestId, edge: { root, priorId } },
        "brain search: supersedes lineage row is missing an endpoint — the lineage query shape changed; an earlier version was dropped",
      );
      continue;
    }
    if (!onPage.has(root)) continue;
    let seen = ancestors.get(root);
    if (!seen) {
      seen = new Set<string>();
      ancestors.set(root, seen);
    }
    seen.add(priorId);
    if (row.depth !== 1) continue;
    const recordedAt = iso(row.recorded_at);
    const current = immediate.get(root);
    // Ordered on the EDGE's stamp and the id, both of which are the same for
    // every reader. Ordering on the predecessor's own `valid_to` would read off
    // the ACL'd statement below and hand two readers of the same claim a
    // different "previous answer".
    if (
      !current ||
      (recordedAt ?? "") > (current.recordedAt ?? "") ||
      ((recordedAt ?? "") === (current.recordedAt ?? "") && priorId < current.priorId)
    ) {
      immediate.set(root, { priorId, recordedAt });
    }
  }
  if (immediate.size === 0) return { lineage, truncated };

  // A depth-1 row at the bound cannot exist (the seed is depth 1 and the bound
  // is 10), so this flags only a walk that actually ran out of room.
  if (usable.some((r) => r.depth === LINEAGE_DEPTH_CAP)) {
    truncated = true;
    log.warn(
      { workspaceId: ctx.workspaceId, requestId, depthCap: LINEAGE_DEPTH_CAP },
      "brain search: supersedes lineage hit its depth bound — the earlier-version count is a floor, not a total",
    );
  }

  const priorIds = [...new Set([...immediate.values()].map((c) => c.priorId))];
  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, "search");
  }
  const params: unknown[] = [...acl.params, priorIds];
  // `invalidated_at IS NULL` again — the walk already excluded tombstones, and
  // a retraction landing between the two reads must not slip a previous answer
  // out. See the module header.
  const result = await db.query(
    `SELECT ${PRIOR_COLUMNS}
       FROM brain_facts f
      WHERE ${acl.sql}
        AND f.id = ANY($${params.length}::uuid[])
        AND f.invalidated_at IS NULL`,
    params,
  );
  const visible = new Map<string, PriorRow>();
  for (const raw of result.rows as readonly PriorRow[]) {
    if (typeof raw.id === "string" && raw.id !== "") {
      visible.set(raw.id, raw);
    } else {
      // This row came back THROUGH the ACL predicate, so dropping it silently
      // would reclassify an entitled predecessor as withheld — fabricated ACL
      // withholding, the failure the deny-all throw above refuses.
      log.warn(
        {
          workspaceId: ctx.workspaceId,
          requestId,
          idType: typeof (raw as { id?: unknown }).id,
          batch: priorIds.length,
        },
        "brain search: predecessor row has no usable id — the predecessor query shape changed; a previous answer will be misreported as withheld",
      );
    }
  }

  for (const [root, candidate] of immediate) {
    const row = visible.get(candidate.priorId);
    const prior: BrainFactPriorVersion = row
      ? {
          visible: true,
          factId: row.id,
          object: row.object,
          validFrom: iso(row.valid_from),
          validTo: iso(row.valid_to),
        }
      : { visible: false };
    lineage.set(root, {
      prior,
      priorCount: ancestors.get(root)?.size ?? 1,
      recordedAt: candidate.recordedAt,
    });
  }

  return { lineage, truncated };
}

/** The empty view — a claim that replaced nothing. Shared so it cannot drift. */
export const NO_HISTORY: BrainFactHistoryView = {
  prior: null,
  priorCount: 0,
  changedBy: null,
  truncated: false,
};

/**
 * Project one fact's lineage onto its wire view.
 *
 * ## ⚠️ The producer, never the actor
 *
 * `changedBy` is discriminated on the REPLACEMENT's `provenance.producer`
 * because two producers write `supersedes`: the correction verbs, where a human
 * deliberately retired a claim they knew about, and the publish gate, where the
 * edge is a side effect of promoting a newer claim into the same slot. On the
 * gate path the replacement's `actor` is whichever principal the NEWER claim
 * was extracted from — a person who never touched the old claim. Naming them
 * would be an accusation the record does not support, so the promotion arm
 * names nobody and says the gate did it.
 *
 * `producer` is `"correction"` for every correction verb (`correction.ts` sets
 * it on the replacement it mints), and anything else — `extraction:v1`,
 * `write-back`, `human` — reached this slot through the gate.
 *
 * ## Attribution is inherited, not re-decided
 *
 * The correcting human rides the replacement's OWN attribution decision
 * (#4836), already made once in `toFactResult`. A reader outside the original
 * grant sees THAT the claim changed and not by whom — that degradation is
 * modelled, and this must never become a second place that decides it.
 */
export function toHistoryView(
  lineage: FactLineage | undefined,
  provenance: BrainFactProvenanceView,
  truncated: boolean,
): BrainFactHistoryView {
  if (!lineage) return truncated ? { ...NO_HISTORY, truncated: true } : NO_HISTORY;
  const at = lineage.recordedAt;
  const changedBy: BrainFactChangeAgent =
    provenance.producer === "correction"
      ? {
          kind: "correction",
          actor: provenance.attribution.visible ? provenance.attribution.actor : null,
          actorIdentity: provenance.attribution.visible
            ? provenance.attribution.actorIdentity
            : null,
          at,
        }
      : { kind: "promotion", at };
  return {
    prior: lineage.prior,
    priorCount: lineage.priorCount,
    changedBy,
    truncated,
  };
}
