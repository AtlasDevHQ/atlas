/**
 * The *In force* pane's DISCLOSURE ACCOUNTING (#5087).
 *
 * ## Why a stub suite, when there is a `-pg` one
 *
 * Because real Postgres cannot produce the states under test here. `COUNT(*)
 * OVER ()` is always a number, `GROUP BY` always narrows, and a `text` column
 * never arrives as an object — so every "this count could not be read" branch is
 * structurally unreachable from the `-pg` suite, and reverting them left the
 * whole suite green. Those branches are exactly the ones that decide whether the
 * pane says *"12 entries you cannot see"* or *"none"*, which is the distinction
 * the surface exists to make.
 *
 * The one state that IS reachable in Postgres and was still untested is the
 * ordinary one: a position with no edges. `GROUP BY slot_position` returns no
 * row for it, and reading that as "the count did not narrow" put a destructive
 * *counts disagreed* badge on every empty workspace's day-one page.
 *
 * These also run locally. Without `TEST_DATABASE_URL` the `-pg` file is skipped
 * in silence, so before this file the local signal for the whole accounting was
 * zero.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const warnCalls: Record<string, unknown>[] = [];
void mock.module("@atlas/api/lib/logger", () => {
  const logger = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (payload: unknown) => {
      if (typeof payload === "object" && payload !== null) {
        warnCalls.push(payload as Record<string, unknown>);
      }
    },
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    getRequestContext: () => ({ requestId: "test-req" }),
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    setLogLevel: () => {},
    ACTOR_KINDS: ["user", "system"] as const,
  };
});

const { loadInForceVocabulary } = await import("@atlas/api/lib/brain/vocabulary-in-force");

const WS = "ws-in-force";

const owner: BrainPrincipalContext = {
  origin: "authenticated",
  workspaceId: WS,
  userId: "user-1",
  role: "owner",
  audienceIds: ["eng"],
};

const denied: BrainPrincipalContext = {
  origin: "unresolved",
  workspaceId: WS,
  userId: null,
  role: null,
  audienceIds: [],
};

interface StubRows {
  /** Rows for the per-position edge query, keyed by position. */
  readonly edges?: Partial<Record<string, readonly unknown[]>>;
  /** Rows for the workspace-wide `GROUP BY slot_position` totals. */
  readonly totals?: readonly unknown[];
  /** The single-row curated-predicate total. */
  readonly cardinalityTotal?: readonly unknown[];
  /** Rows for the curated-predicate list. */
  readonly cardinalities?: readonly unknown[];
}

/**
 * A reader that dispatches on the statement, so each of the four queries
 * `loadInForceVocabulary` issues can be answered independently.
 *
 * Dispatching on distinctive fragments rather than call order: the edge queries
 * run inside a `Promise.all`, so order is not something a fixture may rely on.
 */
function stubReader(rows: StubRows) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM brain_vocabulary_edge e")) {
        const position = String(params?.[params.length - 2] ?? "");
        return { rows: rows.edges?.[position] ?? [] };
      }
      if (sql.includes("FROM brain_vocabulary_edge")) return { rows: rows.totals ?? [] };
      if (sql.includes("FROM brain_predicate_cardinality\n")) {
        return { rows: rows.cardinalityTotal ?? [{ n: 0 }] };
      }
      if (sql.includes("brain_predicate_cardinality c")) {
        return { rows: rows.cardinalities ?? [] };
      }
      if (sql.includes("brain_predicate_cardinality")) {
        return { rows: rows.cardinalityTotal ?? [{ n: 0 }] };
      }
      // The coverage query — not this file's subject.
      return { rows: [{}] };
    },
  };
}

const edgeRow = (from: string, to: string, scopedTotal: unknown = 1) => ({
  from_norm: from,
  to_norm: to,
  approved_by: "user-1",
  approved_at: "2026-08-08T00:00:00.000Z",
  proposal_id: "p-1",
  scoped_total: scopedTotal,
});

const countsFor = (
  view: Awaited<ReturnType<typeof loadInForceVocabulary>>,
  position: string,
) => view.counts.find((c) => c.position === position)!;

beforeEach(() => {
  warnCalls.length = 0;
});

describe("a position with no edges is an ANSWER, not a failure to read one", () => {
  it("⚠️ reports every empty position as CONSISTENT", async () => {
    // `loadEdgeTotals` is `GROUP BY slot_position`, so a position with zero
    // edges produces no row. Reading that as "the count did not narrow" put a
    // destructive `counts disagreed` badge and a "reload to get a consistent
    // pair" paragraph on the day-one empty state — advice no reload could ever
    // act on — and fired `logFailClosedHole`'s most alarming warning three times
    // per page load, drowning the one line ADR-0037 §6 requires be findable.
    const view = await loadInForceVocabulary(stubReader({}), owner);
    for (const position of ["subject", "predicate", "object"]) {
      const counts = countsFor(view, position);
      expect(counts.total).toBe(0);
      expect(counts.withheld).toBe(0);
      expect(counts.consistent, `${position} reported inconsistent on an empty workspace`).toBe(
        true,
      );
    }
    // …and nothing was logged. The fail-closed line has to stay rare to be worth
    // reading.
    expect(warnCalls).toHaveLength(0);
  });

  it("reports a partially-populated workspace's empty positions as consistent too", async () => {
    const view = await loadInForceVocabulary(
      stubReader({
        totals: [{ slot_position: "predicate", n: 1 }],
        edges: { predicate: [edgeRow("is priced at", "priced at")] },
      }),
      owner,
    );
    expect(countsFor(view, "predicate").consistent).toBe(true);
    expect(countsFor(view, "subject").consistent).toBe(true);
    expect(countsFor(view, "subject").total).toBe(0);
  });

  it("POSITIVE CONTROL — a totals row that will not narrow IS reported inconsistent", async () => {
    // Without this, `consistent: true` unconditionally would satisfy both
    // assertions above and the real drift signal would be gone.
    const view = await loadInForceVocabulary(
      stubReader({ totals: [{ slot_position: "predicate", n: "not-a-number" }] }),
      owner,
    );
    // Workspace-wide rather than per-position: a row that would not narrow
    // cannot be attributed to a position, so it must taint all three.
    for (const position of ["subject", "predicate", "object"]) {
      expect(countsFor(view, position).consistent).toBe(false);
    }
    expect(warnCalls.some((c) => c.unreadable === 1)).toBe(true);
  });
});

describe("the scoped total comes from the window function, never the page length", () => {
  it("⚠️ uses the window value even when the page is capped", async () => {
    // The defect this guards: `scoped` falling back to `edges.length` (capped at
    // 200) against a real workspace-wide `total` renders a PAGE CAP as an ACL
    // withholding — "truncation dressed as an ACL boundary", which this module
    // forbids by name.
    const rows = Array.from({ length: 250 }, (_, i) => edgeRow(`from-${i}`, "to", 500));
    const view = await loadInForceVocabulary(
      stubReader({ totals: [{ slot_position: "predicate", n: 500 }], edges: { predicate: rows } }),
      owner,
    );
    const counts = countsFor(view, "predicate");
    expect(view.edges).toHaveLength(200);
    expect(counts.scoped).toBe(500);
    // 500 total, 500 visible → nothing withheld, despite only 200 being listed.
    expect(counts.withheld).toBe(0);
    expect(counts.consistent).toBe(true);
    expect(view.truncated).toBe(true);
  });

  it("⚠️ reports INCONSISTENT when the window value never arrives", async () => {
    // Structurally unreachable from Postgres, which is why it needs a stub: real
    // `COUNT(*) OVER ()` is always a number. Reverting to `scopedTotal ??
    // edges.length; scopedTotalKnown: true` left the entire suite green.
    const view = await loadInForceVocabulary(
      stubReader({
        totals: [{ slot_position: "predicate", n: 500 }],
        edges: { predicate: [edgeRow("a", "b", "not-a-number")] },
      }),
      owner,
    );
    expect(countsFor(view, "predicate").consistent).toBe(false);
    expect(
      warnCalls.some((c) => String(c.msg ?? "").length >= 0 && c.position === "predicate"),
    ).toBe(true);
  });

  it("drops an edge row with an unusable timestamp rather than shipping an empty one", async () => {
    // `approvedAt: ""` parses as a `string` on the wire and renders as an
    // un-parseable date. The row is unreadable, and unreadable rows are counted
    // and logged in this module, never smuggled through with a plausible field.
    const view = await loadInForceVocabulary(
      stubReader({
        totals: [{ slot_position: "predicate", n: 1 }],
        edges: { predicate: [{ ...edgeRow("a", "b"), approved_at: null }] },
      }),
      owner,
    );
    expect(view.edges).toEqual([]);
    expect(view.truncated).toBe(true);
  });
});

describe("curated predicates get the same accounting as the edges", () => {
  const cardinalityRow = (surface: string, scopedTotal: unknown = 1) => ({
    cardinality: "single",
    source_class: "human",
    proposed_by: "user-1",
    reviewed_by: "user-1",
    reviewed_at: "2026-08-08T00:00:00.000Z",
    predicate_surface: surface,
    claims: 2,
    scoped_total: scopedTotal,
  });

  it("⚠️ a page cap does not become a withheld count at an UNSCOPED position", async () => {
    // The same defect as the edge one, reintroduced in the code that fixed it —
    // `withheldCount(total, rows.length)` where `rows` is page-capped. The
    // predicate position is unscoped, so `withheld` must be zero by
    // construction; anything else is the pane claiming an ACL boundary it does
    // not have.
    const rows = Array.from({ length: 250 }, (_, i) => cardinalityRow(`p-${i}`, 250));
    const view = await loadInForceVocabulary(
      stubReader({ cardinalityTotal: [{ n: 250 }], cardinalities: rows }),
      owner,
    );
    expect(view.cardinalities).toHaveLength(200);
    expect(view.cardinalityCounts.withheld).toBe(0);
    expect(view.cardinalityCounts.consistent).toBe(true);
    expect(view.truncated).toBe(true);
  });

  it("counts a drifted cardinality value as unreadable instead of failing the pane", async () => {
    // `cardinality.ts` reads an unrecognised value as `multi` with a warn; this
    // loader's contract is to count and log it. Either way it must not reach the
    // wire schema, where one bad row would 500 the entire pane.
    const view = await loadInForceVocabulary(
      stubReader({
        cardinalityTotal: [{ n: 1 }],
        cardinalities: [{ ...cardinalityRow("p"), cardinality: "sometimes" }],
      }),
      owner,
    );
    expect(view.cardinalities).toEqual([]);
    expect(view.truncated).toBe(true);
    expect(warnCalls.some((c) => c.unreadable === 1)).toBe(true);
  });

  it("POSITIVE CONTROL — a readable entry comes through with its surface", async () => {
    const view = await loadInForceVocabulary(
      stubReader({ cardinalityTotal: [{ n: 1 }], cardinalities: [cardinalityRow("reports to")] }),
      owner,
    );
    expect(view.cardinalities).toHaveLength(1);
    expect(view.cardinalities[0]!.predicateSurface).toBe("reports to");
    expect(view.cardinalityCounts.consistent).toBe(true);
  });

  it("reports the total as UNKNOWN rather than zero when it will not narrow", async () => {
    const view = await loadInForceVocabulary(
      stubReader({ cardinalityTotal: [{ n: null }] }),
      owner,
    );
    expect(view.cardinalityCounts.consistent).toBe(false);
  });
});

describe("a denied reader is told nothing, and the counts say so", () => {
  it("⚠️ still reports the workspace-wide totals, so 'denied' is distinguishable from 'empty'", async () => {
    // The counts are content-free — no norm, no surface, no pair — and ADR-0037
    // §6 makes the vocabulary's SIZE disclosable even when its contents are not.
    // Without them the empty state asserts "nothing is in force in this
    // workspace" on the strength of a read that was refused.
    const view = await loadInForceVocabulary(
      stubReader({
        totals: [{ slot_position: "subject", n: 7 }],
        cardinalityTotal: [{ n: 3 }],
      }),
      denied,
    );
    expect(view.edges).toEqual([]);
    expect(view.cardinalities).toEqual([]);

    const subject = countsFor(view, "subject");
    expect(subject.decision).toBe("deny-all");
    expect(subject.total).toBe(7);
    expect(subject.withheld).toBe(7);

    expect(view.cardinalityCounts.decision).toBe("deny-all");
    expect(view.cardinalityCounts.total).toBe(3);
    expect(view.cardinalityCounts.withheld).toBe(3);

    // …and the fail-closed hole is logged, because those entries are also
    // un-removable by this reader.
    expect(warnCalls.some((c) => c.withheld === 7)).toBe(true);
  });
});
