/**
 * The stage-0 triage backlog, and the verb that clears it (#5534).
 *
 * `REQUEUE_TRIAGED_SQL` shipped with #5531 (stage 0 of #5336) exported,
 * documented and shape-tested, with no wired caller — the deliberate scope cut
 * this module closes. Until now, clearing a triage mark took hand-written SQL
 * against the tenant database, which makes 0180's *"NULL forever is a visible
 * backlog, not a silent drop"* posture true only for someone holding a psql
 * prompt. A backlog nobody can drain from a product surface is a drop with
 * extra steps.
 *
 * Two operations, and they are deliberately a pair:
 *
 *   {@link loadTriageBacklog}      — how many episodes each rule is holding
 *   {@link requeueTriagedEpisodes} — put them back on the drain
 *
 * The count is what motivates the verb ("`known_ack` is holding 4,102
 * episodes") and the verb is what makes the count actionable. Shipping either
 * alone reproduces the gap #5531 left, one level up.
 *
 * ## Episode-grained, so NOT in `oversight.ts`
 *
 * The issue nominated `lib/brain/oversight.ts` — "where the triage counts
 * surface; a re-queue action belongs near the numbers that motivate it" — and
 * that is the right instinct about ADJACENCY and the wrong module. That file
 * states one rule and enforces it mechanically: *no unscoped query there
 * selects claim content "or anything off `brain_episodes`"*, and it names
 * `willWidenRowsSql` as the single statement that touches the episode table at
 * all, reader-scoped, with its exception argued in place.
 *
 * A triage backlog is entirely episode-grained. Bolting it onto
 * `loadFactOversight` would mean adding an unscoped `brain_episodes` read to
 * the one module whose header forbids exactly that — eroding an invariant that
 * is doing real work, to save an import. So the counts live here, beside the
 * verb that consumes them, and the two surfaces compose at the ROUTER
 * (`api/routes/admin-brain-triage.ts`) rather than in the store. `oversight.ts`
 * carries a pointer to this module so the next reader finds it.
 *
 * ## What the counts do and do not say
 *
 * Numbers and rule ids only — no body, no locator, no actor, no source id.
 * A triage rule id is a member of a closed vocabulary an admin can already
 * read in `TRIAGE_RULES`; it discloses nothing about the episode beyond
 * "some deterministic rule matched its shape", which is the same disclosure
 * the rule list itself makes. That keeps this surface on the right side of the
 * counts-without-content line even though it reads a table `oversight.ts`
 * holds at arm's length.
 *
 * ## Why `byRule` is a LIST keyed by a raw string, not `Record<TriageRuleId, …>`
 *
 * A `Record` over the closed vocabulary is the right shape for a per-tick tally
 * the process itself produces (`BrainTriageTally.matched` is exactly
 * that, and a new rule failing to compile there is the point). It is the wrong
 * shape for a read of what is AT REST.
 *
 * The column holds whatever a past deploy wrote. Retire a rule from
 * {@link TRIAGE_RULE_IDS} and its marks stay on the rows — a `Record` typed by
 * today's vocabulary would either drop those rows from the count or force a
 * cast that lies about them. The list reports the column, so a retired rule
 * shows up as a bucket an admin can see and act on.
 *
 * ⚠️ That is also why {@link requeueTriagedEpisodes} takes `rule: string | null`
 * and validates membership at the ROUTE rather than here: `null` (every rule)
 * always reaches an orphaned reason id, so no backlog can be stranded by
 * retiring the rule that created it. The route's narrower check is a typo
 * guard, not a safety property — see its header.
 */

import { createLogger } from "@atlas/api/lib/logger";
// The re-queue statement itself, not a copy of it. #5336 requires the triage
// rules enumerable in ONE place; the same argument applies to the SQL that
// undoes them, and `extract-triage.test.ts` already pins the exported string's
// shape. Composing it below (rather than re-typing it with a `RETURNING`)
// keeps that pin load-bearing for this surface too.
import { REQUEUE_TRIAGED_SQL } from "./extract";
import { TRIAGE_RULE_IDS, type TriageRuleId } from "./triage";

const log = createLogger("brain-triage-requeue");

/**
 * The narrow database seam, `GateExportReader`'s shape one module over:
 * enough to run a parameterised statement, and nothing that would let this
 * module reach for a transaction or a pool it has no business holding.
 */
export interface TriageBacklogReader {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: readonly unknown[]; rowCount?: number | null }>;
}

/** One rule's share of the backlog. `rule` is the stored `triage_reason`. */
export interface TriageBacklogBucket {
  /**
   * The stored reason id. Usually a {@link TriageRuleId}; deliberately typed
   * wider, because a rule retired from the vocabulary leaves its marks behind
   * and this surface exists to make those visible rather than to pretend the
   * column agrees with today's code.
   */
  readonly rule: string;
  /** Episodes this rule is currently holding off the drain. */
  readonly episodes: number;
  /**
   * Whether `rule` is still a member of {@link TRIAGE_RULE_IDS}. `false` means
   * a past deploy wrote this mark under a rule that no longer exists — the
   * bucket is real, it is re-queueable via the all-rules arm, and no
   * per-rule request can name it.
   */
  readonly known: boolean;
}

/** What {@link loadTriageBacklog} answers. */
export interface TriageBacklog {
  /** Episodes held off the drain by ANY triage rule. */
  readonly total: number;
  /** Per-rule breakdown, largest bucket first. Empty when nothing is held. */
  readonly byRule: readonly TriageBacklogBucket[];
  /**
   * True when a bucket was dropped because its stored reason could not be
   * named, so {@link total} is an UNDER-count.
   *
   * ⚠️ Under-counting is the flattering direction here, and the flattering
   * direction is the one that has to travel. On the Coverage Surface this
   * number is the count of episodes Atlas deliberately did not look at
   * (#5338 AC 8) — a silently smaller one reads as a smaller blind spot, which
   * is precisely the "green while nothing is happening" statement ADR-0041
   * exists to end. `coverage.ts` folds this into `countsConsistent`.
   *
   * Unreachable through the writers — migration 0210's CHECK pairs the mark
   * with its reason — so it is a signal about a broken CHECK, not an ordinary
   * state. Reported rather than thrown on, because a backlog an admin can
   * partly see is still worth seeing.
   */
  readonly degraded: boolean;
}

/**
 * Count what stage 0 is holding, per rule.
 *
 * The predicate is the re-queue's own, verbatim in intent: marked, and not
 * extracted. `extracted_at IS NULL` is not decoration — migration 0210's CHECK
 * pairs the two triage columns but does not forbid a row that was triaged and
 * later extracted by some other path, and counting one of those as "backlog"
 * would offer an admin a re-queue that {@link REQUEUE_TRIAGED_SQL} then
 * declines to perform. The two statements agree by sharing the predicate, and
 * `triage-requeue.test.ts` pins that they do.
 *
 * Backed by 0210's partial index — `(workspace_id, triage_reason) WHERE
 * triaged_out_at IS NOT NULL AND extracted_at IS NULL` — which this grouping
 * matches exactly, so the count is an index scan over the held rows rather
 * than a seq scan of the episode table. (An index-ONLY scan additionally needs
 * a current visibility map, which nothing here guarantees — the weaker claim is
 * the one the schema supports, and `triage-requeue-pg.test.ts` asserts that
 * shape rather than this sentence.)
 */
export const TRIAGE_BACKLOG_SQL = `SELECT triage_reason AS rule,
              count(*)::int AS episodes
         FROM brain_episodes
        WHERE workspace_id = $1
          AND triaged_out_at IS NOT NULL
          AND extracted_at IS NULL
        GROUP BY triage_reason
        ORDER BY count(*) DESC, triage_reason`;

/**
 * Count the episodes stage 0 is holding for one workspace.
 *
 * Workspace-scoped and NOT reader-scoped, for `loadGateDecisions`' reason one
 * module over: there is no claim here to gate. An episode's grant governs who
 * may read what it SAYS, and this answers only how many rows a named rule
 * matched. Composing an ACL predicate would report a smaller number to a
 * reader with fewer grants — a backlog that looks drained because of who is
 * looking, on the one surface whose job is to say a backlog exists.
 */
export async function loadTriageBacklog(
  db: TriageBacklogReader,
  workspaceId: string,
): Promise<TriageBacklog> {
  const result = await db.query(TRIAGE_BACKLOG_SQL, [workspaceId]);

  const known: ReadonlySet<string> = new Set<string>(TRIAGE_RULE_IDS);
  const byRule: TriageBacklogBucket[] = [];
  let total = 0;
  let degraded = false;

  for (const raw of result.rows as readonly Record<string, unknown>[]) {
    // `GROUP BY triage_reason` over a `triage_reason IS NOT NULL` population
    // cannot produce a NULL key — 0210's CHECK pairs the columns, so a row
    // with `triaged_out_at` set has a reason. Guarded anyway rather than
    // asserted: a NULL here would mean the CHECK is gone, and rendering it as
    // the string "null" in an admin's bucket list is a worse answer than
    // dropping a row we cannot name. Logged AND flagged (`degraded`) so it is
    // not silent: the drop shrinks `total`, and a shrunken count of what triage
    // is holding is the reassuring direction.
    const rule = raw.rule;
    if (typeof rule !== "string" || rule === "") {
      degraded = true;
      log.warn(
        { workspaceId, episodes: raw.episodes },
        "brain triage backlog: a triaged-out episode carries no reason — migration 0210's CHECK should make this unrepresentable",
      );
      continue;
    }
    // `count(*)::int` reaches node-pg as a number; `Number()` is the belt for
    // a driver configured with a different int8 parser, and `?? 0` never fires
    // on a `GROUP BY` row.
    const episodes = Number(raw.episodes ?? 0);
    total += episodes;
    byRule.push({ rule, episodes, known: known.has(rule) });
  }

  return { total, byRule, degraded };
}

/**
 * Re-queue triaged-out episodes, optionally narrowed to one rule.
 *
 * `rule: null` clears every mark in the workspace — the "the gate itself was
 * too aggressive" case. A rule id narrows to that rule's verdicts — the "the
 * ack list was wrong" case, which is the one the issue names and the reason
 * {@link REQUEUE_TRIAGED_SQL} carries a `$2` at all.
 *
 * Returns the number of rows actually cleared, which the caller AUDITS. That
 * number is not recoverable afterwards by any query: clearing the mark sets
 * `triaged_out_at` and `triage_reason` back to NULL, so the table retains no
 * trace that these particular episodes were ever triaged. The audit row is
 * therefore the only record this act happened — see the route, which awaits it
 * for exactly that reason.
 *
 * ## Why the count comes from a wrapping CTE
 *
 * `REQUEUE_TRIAGED_SQL` has no `RETURNING`, so the row count would have to come
 * from the driver's `rowCount`, which {@link TriageBacklogReader} (and node-pg
 * itself) types as `number | null`. A null there would leave the audit row
 * unable to state how many rows moved, on an act whose only record is that row.
 * Wrapping the exported statement in a data-modifying CTE makes the count a
 * SELECTED value with a guaranteed single row, and — the part that matters —
 * keeps the statement itself the one in `extract.ts` rather than a second copy
 * carrying a `RETURNING` clause that could drift from it.
 */
export const REQUEUE_TRIAGED_COUNTED_SQL = `WITH requeued AS (
${REQUEUE_TRIAGED_SQL}
        RETURNING 1
      )
      SELECT count(*)::int AS requeued FROM requeued`;

export async function requeueTriagedEpisodes(
  db: TriageBacklogReader,
  workspaceId: string,
  rule: string | null,
): Promise<{ readonly requeued: number }> {
  const result = await db.query(REQUEUE_TRIAGED_COUNTED_SQL, [workspaceId, rule]);
  const row = (result.rows as readonly Record<string, unknown>[])[0];
  // A `count(*)` over a CTE always returns exactly one row. A missing one means
  // the driver handed back something this module does not understand, and
  // reporting 0 would put "nothing matched" and "we cannot tell" in the same
  // answer — on the number that becomes the audit trail's only record.
  if (row === undefined) {
    throw new Error(
      `Brain triage re-queue for workspace ${workspaceId} returned no count row. The UPDATE may have committed; check brain_episodes.triaged_out_at before retrying.`,
    );
  }
  const requeued = Number(row.requeued ?? 0);
  log.info(
    { workspaceId, rule: rule ?? "*", requeued },
    "brain triage re-queue applied",
  );
  return { requeued };
}

/**
 * Is `rule` a triage rule this deploy knows about?
 *
 * The ROUTE's typo guard, exported so the route and its tests share one
 * definition of the vocabulary. ⚠️ Not a safety property: an unknown id can
 * only ever match zero rows, and the all-rules arm reaches every mark
 * regardless — see this module's header on why a retired rule must stay
 * re-queueable.
 */
export function isKnownTriageRule(rule: string): rule is TriageRuleId {
  return (TRIAGE_RULE_IDS as readonly string[]).includes(rule);
}
