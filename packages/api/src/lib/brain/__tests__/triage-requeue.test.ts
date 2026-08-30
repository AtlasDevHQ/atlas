/**
 * The triage backlog reader and the re-queue verb (#5534), without a database.
 *
 * What lives here and nowhere else:
 *
 *   1. **The two statements agree on their population.** The backlog count and
 *      the re-queue share one predicate — marked, and not extracted — so the
 *      number an admin reads is the number the verb can move. Two statements
 *      that drifted would offer a re-queue of rows the UPDATE then declines to
 *      touch, and the admin would read the gap as a bug in the verb.
 *   2. **The re-queue statement is COMPOSED, never re-typed.** `extract.ts`
 *      owns it and `extract-triage.test.ts` pins its shape; the counting CTE
 *      here must contain that exact string, or those pins stop covering the
 *      only caller.
 *   3. **A retired rule id survives the read.** The column holds what a past
 *      deploy wrote, so the bucket list must report an unknown reason rather
 *      than drop it — that backlog is reachable only through the all-rules arm,
 *      and only if something says it is there.
 *
 * The `-pg` sibling has the live-schema half: that the partial index is used and
 * that a cleared episode actually returns to the drain. Neither is answerable
 * with a double.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// `extract.ts` sits in this module's import graph (it owns the re-queue
// statement), and `reconcile.ts` under it reads the internal DB at module load.
// `extract-triage.test.ts` records the same two lines for the same reason.
process.env.DATABASE_URL ??= "postgres://triage-requeue-test/none";

const realInternal = await import("@atlas/api/lib/db/internal");
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => true,
}));

const {
  TRIAGE_BACKLOG_SQL,
  REQUEUE_TRIAGED_COUNTED_SQL,
  isKnownTriageRule,
  loadTriageBacklog,
  requeueTriagedEpisodes,
} = await import("@atlas/api/lib/brain/triage-requeue");
const { REQUEUE_TRIAGED_SQL } = await import("@atlas/api/lib/brain/extract");
const { TRIAGE_RULE_IDS } = await import("@atlas/api/lib/brain/triage");

const WORKSPACE = "ws-triage-requeue";

/** Every statement the module issued, with its parameters. */
let issued: { sql: string; params: unknown[] }[] = [];

/**
 * The narrow reader the module takes. `rows` is what the next query answers —
 * one handle rather than a per-test fake, so a test that forgets to seed it
 * sees an empty result rather than a stale one from its neighbour.
 */
function reader(rows: readonly unknown[]) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      issued.push({ sql, params: params ?? [] });
      return { rows };
    },
  };
}

beforeEach(() => {
  issued = [];
});

describe("the two statements describe one population", () => {
  test("both narrow to marked-and-not-extracted rows in one workspace", () => {
    for (const sql of [TRIAGE_BACKLOG_SQL, REQUEUE_TRIAGED_SQL]) {
      expect(sql).toContain("workspace_id = $1");
      expect(sql).toContain("triaged_out_at IS NOT NULL");
      expect(sql).toContain("extracted_at IS NULL");
    }
  });

  test("the backlog groups by the stored reason, matching 0210's partial index", () => {
    expect(TRIAGE_BACKLOG_SQL).toContain("GROUP BY triage_reason");
    expect(TRIAGE_BACKLOG_SQL).toContain("count(*)::int");
    // `::int`, not a bare `count(*)`: int8 reaches node-pg as a STRING, and a
    // string would flow into the audit row's `requeued` and the wire's
    // `episodes` as a number-shaped lie.
    expect(TRIAGE_BACKLOG_SQL).not.toMatch(/count\(\*\)\s+AS/);
  });

  test("the counting wrapper contains the exported statement verbatim", () => {
    // The point of the assertion: `extract-triage.test.ts`'s shape pins on
    // `REQUEUE_TRIAGED_SQL` only cover this surface while the surface uses that
    // string rather than a hand-typed copy carrying its own RETURNING.
    expect(REQUEUE_TRIAGED_COUNTED_SQL).toContain(REQUEUE_TRIAGED_SQL);
    expect(REQUEUE_TRIAGED_COUNTED_SQL).toContain("RETURNING 1");
    expect(REQUEUE_TRIAGED_COUNTED_SQL).toContain("count(*)::int AS requeued");
  });
});

describe("loadTriageBacklog", () => {
  test("sums the buckets and marks each rule known or retired", async () => {
    const backlog = await loadTriageBacklog(
      reader([
        { rule: "known_ack", episodes: 4102 },
        { rule: "pure_reaction", episodes: 311 },
        // A reason no rule in this deploy writes — the retired-rule case.
        { rule: "channel_join_notice", episodes: 12 },
      ]),
      WORKSPACE,
    );

    expect(backlog.total).toBe(4425);
    expect(backlog.byRule).toEqual([
      { rule: "known_ack", episodes: 4102, known: true },
      { rule: "pure_reaction", episodes: 311, known: true },
      { rule: "channel_join_notice", episodes: 12, known: false },
    ]);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.params).toEqual([WORKSPACE]);
  });

  test("an empty backlog is zero and an empty list, not an absent one", async () => {
    // The console renders `byRule` directly; `undefined` there is a crash and
    // `[{ episodes: 0 }]` per rule would be a different claim ("we looked and
    // each rule holds nothing") from the one an empty group-by supports.
    expect(await loadTriageBacklog(reader([]), WORKSPACE)).toEqual({ total: 0, byRule: [] });
  });

  test("every shipped rule id reads as known", async () => {
    const backlog = await loadTriageBacklog(
      reader(TRIAGE_RULE_IDS.map((rule) => ({ rule, episodes: 1 }))),
      WORKSPACE,
    );
    expect(backlog.byRule.every((bucket) => bucket.known)).toBe(true);
    expect(backlog.total).toBe(TRIAGE_RULE_IDS.length);
  });

  test("a reason-less row is dropped from the buckets rather than named 'null'", async () => {
    // 0210's CHECK makes this unrepresentable; if the CHECK is ever gone, a
    // bucket labelled "null" in an admin's list is a worse answer than a
    // missing one. The count it carries is dropped with it — deliberately: a
    // total that included rows no bucket explains would not add up on screen.
    const backlog = await loadTriageBacklog(
      reader([
        { rule: null, episodes: 9 },
        { rule: "known_ack", episodes: 2 },
      ]),
      WORKSPACE,
    );
    expect(backlog.byRule).toEqual([{ rule: "known_ack", episodes: 2, known: true }]);
    expect(backlog.total).toBe(2);
  });
});

describe("requeueTriagedEpisodes", () => {
  test("passes the workspace and the rule through as the statement's parameters", async () => {
    const result = await requeueTriagedEpisodes(reader([{ requeued: 7 }]), WORKSPACE, "known_ack");
    expect(result).toEqual({ requeued: 7 });
    expect(issued[0]?.sql).toBe(REQUEUE_TRIAGED_COUNTED_SQL);
    expect(issued[0]?.params).toEqual([WORKSPACE, "known_ack"]);
  });

  test("a null rule reaches the statement as NULL — the every-rule arm", async () => {
    // `$2::text IS NULL OR triage_reason = $2::text` is what makes this the
    // arm that also clears marks written under a retired rule, so the null has
    // to survive the call rather than being folded to a string.
    await requeueTriagedEpisodes(reader([{ requeued: 0 }]), WORKSPACE, null);
    expect(issued[0]?.params).toEqual([WORKSPACE, null]);
  });

  test("zero rows is a successful outcome, not an error", async () => {
    expect(await requeueTriagedEpisodes(reader([{ requeued: 0 }]), WORKSPACE, "pure_reaction")).toEqual({
      requeued: 0,
    });
  });

  test("a missing count row THROWS rather than reporting zero", async () => {
    // `requeued` becomes the audit row's only account of what moved. Reporting
    // 0 for "the driver answered something we do not understand" would put
    // "nothing matched" and "we cannot tell" in the same number, on the one
    // field that has to be trusted afterwards.
    await expect(requeueTriagedEpisodes(reader([]), WORKSPACE, null)).rejects.toThrow(
      /returned no count row/,
    );
  });
});

describe("isKnownTriageRule", () => {
  test("accepts every shipped rule id and nothing else", () => {
    for (const id of TRIAGE_RULE_IDS) expect(isKnownTriageRule(id)).toBe(true);
    expect(isKnownTriageRule("known_acks")).toBe(false);
    expect(isKnownTriageRule("")).toBe(false);
    // Not a member lookup on a bare object: a prototype key must not read as a
    // rule, or `POST /requeue { rule: "toString" }` would pass the guard and
    // match zero rows while reporting success.
    expect(isKnownTriageRule("toString")).toBe(false);
  });
});
