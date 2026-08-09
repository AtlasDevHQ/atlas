/**
 * The Pending queue's DRIFT accounting (#5088).
 *
 * ## Why a stub suite beside a `-pg` one
 *
 * `vocabulary-in-force.test.ts`'s reason, unchanged: real Postgres cannot
 * produce the states under test here. `COUNT(*) OVER ()` is always a number,
 * `jsonb_agg` always returns an array, and a `text` column never arrives as an
 * object — so every *"this count could not be read"* branch is structurally
 * unreachable from the `-pg` suite, and deleting them all leaves it green.
 *
 * Those branches are exactly the ones that decide whether an approver reads
 * *"2 subjects agree"* as a fact or as a number nothing established. On a surface
 * whose entire premise is that its sentences are exact, a fabricated zero is the
 * worst possible failure — and it is the one no integration test can see.
 *
 * These also run without `TEST_DATABASE_URL`, where the `-pg` file skips in
 * silence.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const warnCalls: { payload: Record<string, unknown>; msg: string }[] = [];
void mock.module("@atlas/api/lib/logger", () => {
  const logger = {
    info: () => {},
    debug: () => {},
    error: () => {},
    // BOTH arguments — `vocabulary-in-force.test.ts`'s rule: capturing only the
    // payload makes a drift log assertable by an incidental field at best.
    warn: (payload: unknown, msg?: unknown) => {
      if (typeof payload === "object" && payload !== null) {
        warnCalls.push({
          payload: payload as Record<string, unknown>,
          msg: typeof msg === "string" ? msg : "",
        });
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

const { loadPendingQueue, PENDING_PAGE_MAX } = await import(
  "@atlas/api/lib/brain/vocabulary-pending"
);

const WS = "ws-pending-unit";

const owner: BrainPrincipalContext = {
  origin: "authenticated",
  workspaceId: WS,
  userId: "user-1",
  role: "owner",
  audienceIds: ["eng"],
};

const unresolved: BrainPrincipalContext = {
  origin: "unresolved",
  workspaceId: WS,
  userId: null,
  role: null,
  audienceIds: [],
};

interface StubRows {
  /** Per-position rows for the alias queue query. */
  readonly alias?: Partial<Record<string, readonly unknown[]>>;
  /** Per-position workspace-wide totals. */
  readonly aliasTotals?: Partial<Record<string, readonly unknown[]>>;
  readonly cardinality?: readonly unknown[];
  readonly cardinalityTotal?: readonly unknown[];
}

/**
 * A reader that dispatches on the statement.
 *
 * ⚠️ THROWS on an unmatched statement rather than answering with a plausible
 * shape — `vocabulary-in-force.test.ts`'s rule. A query that stops matching its
 * arm after a SQL edit would otherwise be served the wrong rows and the fixture
 * would quietly test something else.
 */
function stubReader(rows: StubRows) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM brain_vocabulary_proposal\n      WHERE")) {
        const position = String(params?.[1] ?? "");
        return { rows: rows.aliasTotals?.[position] ?? [{ n: 0 }] };
      }
      if (sql.includes("brain_vocabulary_proposal p")) {
        // The position is the second-to-last bind before the evidence clauses;
        // it is easier and more robust to read it off the statement's own params
        // by value, since the three positions are distinct strings.
        const position = (params ?? []).find(
          (p) => p === "subject" || p === "predicate" || p === "object",
        );
        return { rows: rows.alias?.[String(position)] ?? [] };
      }
      if (sql.includes("FROM brain_predicate_cardinality\n      WHERE")) {
        return { rows: rows.cardinalityTotal ?? [{ n: 0 }] };
      }
      if (sql.includes("brain_predicate_cardinality c")) {
        return { rows: rows.cardinality ?? [] };
      }
      throw new Error(`vocabulary-pending stub: unmatched statement — ${sql.slice(0, 90)}`);
    },
  };
}

const aliasRow = (over: Record<string, unknown> = {}) => ({
  id: "p-1",
  from_norm: "is priced at",
  to_norm: "priced at",
  directed: false,
  source_class: "seam",
  confidence: 0.67,
  proposed_by: "brain:alias-proposal",
  proposed_at: "2026-08-09T00:00:00.000Z",
  scoped_total: 1,
  subjects: 2,
  scoped_subjects: 2,
  examples: [],
  ...over,
});

const cardinalityRow = (over: Record<string, unknown> = {}) => ({
  cardinality: "single",
  source_class: "correction_event",
  proposed_by: "brain:correction-event-cardinality",
  proposed_at: "2026-08-08T00:00:00.000Z",
  predicate_surface: "reports to",
  claims: 4,
  subjects: 3,
  scoped_subjects: 3,
  events: 5,
  examples: [],
  scoped_total: 1,
  ...over,
});

beforeEach(() => {
  warnCalls.length = 0;
});

describe("evidence that will not narrow is REPORTED, never rendered as zero", () => {
  it("⚠️ an unreadable agreeing-subject count clears countsConsistent", async () => {
    // *"No subject in your corpus exhibits this agreement"* is a reason to
    // reject; *"the evidence query drifted"* is a reason to fix the server. A
    // renderer cannot tell them apart from a zero, so the flag is the only thing
    // that can.
    const queue = await loadPendingQueue(
      stubReader({ alias: { predicate: [aliasRow({ subjects: "not-a-number" })] } }),
      owner,
    );
    const entry = queue.entries[0]!;
    if (entry.kind !== "alias") throw new Error("expected an alias entry");
    // ⚠️ Its OWN ARM, not zeros beside a flag. The flat shape let the client
    // render "0 distinct subjects … this now reads below the bar that raised it,
    // because the count is re-derived from the corpus as it stands" — a
    // confident causal story about a number nobody read. The numbers are now
    // structurally unreadable on this branch.
    expect(entry.evidence).toEqual({ kind: "unreadable" });
    expect(warnCalls.some((c) => c.msg.includes("reported as unreadable"))).toBe(true);
  });

  it("POSITIVE CONTROL — a readable count is reported as a fact", async () => {
    // Without this, `countsConsistent: false` unconditionally would satisfy the
    // assertion above and the real signal would be gone.
    // ⚠️ The workspace-wide total is supplied to MATCH the scoped one. The
    // stub's default is `{n: 0}`, and one visible row against a total of zero is
    // a genuine inversion — `withheldCount` reports it and `logFailClosedHole`
    // logs it, correctly. Leaving the default here would have made the
    // "and nothing was logged" assertion fail for a reason that has nothing to
    // do with the evidence path it is guarding.
    const queue = await loadPendingQueue(
      stubReader({ alias: { predicate: [aliasRow()] }, aliasTotals: { predicate: [{ n: 1 }] } }),
      owner,
    );
    const entry = queue.entries[0]!;
    if (entry.kind !== "alias" || entry.evidence.kind !== "structural") {
      throw new Error("expected structural alias evidence");
    }
    expect(entry.evidence.subjects).toBe(2);
    expect(entry.evidence.countsConsistent).toBe(true);
    // The fail-closed line has to stay rare to be worth reading.
    expect(warnCalls).toHaveLength(0);
  });

  it("an examples aggregate that will not parse is NOT the same as an empty one", async () => {
    // `[]` means "nothing agreed" and is a real answer; a non-array means the
    // sample never arrived. Mapping both to `[]` with `countsConsistent: true`
    // would tell an approver their corpus is silent when the query is.
    const queue = await loadPendingQueue(
      stubReader({ alias: { predicate: [aliasRow({ examples: "oops" })] } }),
      owner,
    );
    const entry = queue.entries[0]!;
    if (entry.kind !== "alias") throw new Error("expected an alias entry");
    expect(entry.evidence).toEqual({ kind: "unreadable" });
  });

  it("⚠️ fewer EVENTS than SUBJECTS is a third statement disagreeing", async () => {
    // Every distinct subject contributes at least one correction, so `events <
    // subjects` is arithmetically impossible. Clamping it into a plausible pair
    // would hand the approver two numbers that cannot both be true, presented as
    // facts.
    const queue = await loadPendingQueue(
      stubReader({ cardinality: [cardinalityRow({ subjects: 3, events: 1 })] }),
      owner,
    );
    const entry = queue.entries[0]!;
    if (entry.kind !== "cardinality") throw new Error("expected a cardinality entry");
    if (entry.evidence.kind !== "behavioral") throw new Error("expected behavioral evidence");
    expect(entry.evidence.countsConsistent).toBe(false);
  });
});

describe("the disclosure accounting", () => {
  it("⚠️ uses the WINDOW value for `scoped`, never the page length", async () => {
    // The defect this guards, named by `BlastRadiusSide`: a page cap presented
    // to the approver as a hard ACL fact — "truncation dressed as an ACL
    // boundary". The window value survives the cap; the page length does not.
    const rows = Array.from({ length: PENDING_PAGE_MAX + 20 }, (_, i) =>
      aliasRow({ id: `p-${i}`, scoped_total: 500 }),
    );
    const queue = await loadPendingQueue(
      stubReader({
        alias: { predicate: rows },
        aliasTotals: { predicate: [{ n: 500 }] },
      }),
      owner,
    );
    const counts = queue.aliasCounts.find((c) => c.position === "predicate")!;
    expect(counts.scoped).toBe(500);
    expect(counts.withheld).toBe(0);
    expect(queue.truncated).toBe(true);
  });

  it("a workspace-wide total that will not narrow is reported UNKNOWN, not zero", async () => {
    const queue = await loadPendingQueue(
      stubReader({
        alias: { predicate: [aliasRow()] },
        aliasTotals: { predicate: [{ n: "nope" }] },
      }),
      owner,
    );
    const counts = queue.aliasCounts.find((c) => c.position === "predicate")!;
    // A total silently read as zero produces `withheld: 0, consistent: true` —
    // "nothing is hidden from you" — computed from a number nobody read.
    expect(counts.consistent).toBe(false);
    expect(warnCalls.some((c) => c.msg.includes("pending total did not narrow"))).toBe(true);
  });

  it("an unresolved reader sees nothing, and the SIZE is still disclosed", async () => {
    // ADR-0037 §6: the vocabulary is workspace-global, so its size is not a
    // secret even when its contents are. A denied read that also zeroed the
    // total would say "your workspace has no pending work" on the strength of
    // seeing nothing.
    const queue = await loadPendingQueue(
      stubReader({ aliasTotals: { predicate: [{ n: 7 }] } }),
      unresolved,
    );
    expect(queue.entries).toHaveLength(0);
    const counts = queue.aliasCounts.find((c) => c.position === "predicate")!;
    expect(counts.decision).toBe("deny-all");
    expect(counts.total).toBe(7);
    expect(counts.withheld).toBe(7);
    // A denied reader genuinely sees zero — that is an answer, not a drift.
    expect(counts.consistent).toBe(true);
  });
});

describe("rows that will not narrow are DROPPED and counted, never smuggled through", () => {
  it("⚠️ drops a row whose `proposed_at` is empty rather than defaulting it", async () => {
    // The queue is ORDERED by this column and the empty string sorts to the end
    // of a text ordering, so a defaulted row would silently take the oldest slot
    // in the merged list — on top of rendering an un-parseable date.
    const queue = await loadPendingQueue(
      stubReader({
        alias: { predicate: [aliasRow({ proposed_at: "" }), aliasRow({ id: "p-2" })] },
      }),
      owner,
    );
    expect(queue.entries).toHaveLength(1);
    // ⚠️ `incomplete`, not `truncated` — see the block at the end of this file.
    expect(queue.incomplete).toBe(true);
    expect(warnCalls.some((c) => c.msg.includes("would not narrow and were dropped"))).toBe(true);
  });

  it("drops a cardinality row whose value is outside the two-member vocabulary", async () => {
    // Counted and logged rather than allowed through to fail the wire schema,
    // which would take the whole pane down as a 500 over one bad row.
    const queue = await loadPendingQueue(
      stubReader({ cardinality: [cardinalityRow({ cardinality: "sometimes" })] }),
      owner,
    );
    expect(queue.entries).toHaveLength(0);
    expect(queue.incomplete).toBe(true);
  });

  it("an unreadable rank renders as 0 and LOGS, rather than reaching the wire as NaN", async () => {
    // NaN serializes to `null` through JSON, which the wire schema then rejects
    // and the whole pane 500s over one bad row. The decision path re-reads the
    // column itself and is where a NaN must fail every comparison.
    const queue = await loadPendingQueue(
      stubReader({ alias: { predicate: [aliasRow({ confidence: "high" })] } }),
      owner,
    );
    const entry = queue.entries[0]!;
    if (entry.kind !== "alias") throw new Error("expected an alias entry");
    expect(entry.rank).toBe(0);
    expect(warnCalls.some((c) => c.msg.includes("confidence did not read back"))).toBe(true);
  });
});

describe("the shape the queue promises its client", () => {
  it("⚠️ a cardinality row with no live surface is reported UNDECIDABLE", async () => {
    // The decide route addresses rows by SURFACE precisely so no key reaches the
    // wire, so an entry whose every claim has been retracted has no address. A
    // client rendering Approve on it would send a request that 400s about a
    // surface the approver never chose.
    const queue = await loadPendingQueue(
      stubReader({ cardinality: [cardinalityRow({ predicate_surface: null })] }),
      owner,
    );
    const entry = queue.entries[0]!;
    if (entry.kind !== "cardinality") throw new Error("expected a cardinality entry");
    // ⚠️ `null` IS the undecidability, carried by one field rather than two.
    // The client narrows on it; a `decidable` boolean beside it admitted
    // `{ predicateSurface: null, decidable: true }`, which is the button that
    // 400s — the state the flag was added to prevent.
    expect(entry.predicateSurface).toBeNull();
  });

  it("⚠️ never asserts a direction the producer did not claim", async () => {
    const undirected = await loadPendingQueue(
      stubReader({ alias: { predicate: [aliasRow({ directed: false })] } }),
      owner,
    );
    const a = undirected.entries[0]!;
    if (a.kind !== "alias") throw new Error("expected an alias entry");
    expect(a.direction).toBeNull();
    // The PAIR still travels — a renderer needs both norms to offer both
    // orderings — but it is not a direction and the type says so.
    expect(a.pair).toEqual(["is priced at", "priced at"]);

    const directed = await loadPendingQueue(
      stubReader({ alias: { predicate: [aliasRow({ directed: true })] } }),
      owner,
    );
    const b = directed.entries[0]!;
    if (b.kind !== "alias") throw new Error("expected an alias entry");
    expect(b.direction).toEqual({ fromNorm: "is priced at", toNorm: "priced at" });
  });

  it("reports ENTITY-position evidence as unaskable rather than as zero", async () => {
    const queue = await loadPendingQueue(
      stubReader({ alias: { subject: [aliasRow({ from_norm: "a", to_norm: "b" })] } }),
      owner,
    );
    const entry = queue.entries[0]!;
    if (entry.kind !== "alias") throw new Error("expected an alias entry");
    expect(entry.evidence).toEqual({ kind: "not-applicable", reason: "entity-position" });
  });

  it("interleaves the two kinds by age and caps the merged list", async () => {
    const queue = await loadPendingQueue(
      stubReader({
        alias: { predicate: [aliasRow({ proposed_at: "2026-08-01T00:00:00.000Z" })] },
        cardinality: [cardinalityRow({ proposed_at: "2026-08-09T00:00:00.000Z" })],
      }),
      owner,
    );
    // Newest first, across kinds. Two lists rendered one after the other would
    // satisfy every other assertion in this file.
    expect(queue.entries.map((e) => e.kind)).toEqual(["cardinality", "alias"]);

    const capped = await loadPendingQueue(
      stubReader({
        alias: { predicate: [aliasRow()] },
        cardinality: [cardinalityRow()],
      }),
      owner,
      { limit: 1 },
    );
    expect(capped.entries).toHaveLength(1);
    // ⚠️ A silent cap on a review queue reads as "that is all there is to
    // decide", which on this surface is the one sentence that must never be said
    // by accident.
    expect(capped.truncated).toBe(true);
  });
});

describe("⚠️ a kind that was NOT ASKED ABOUT has no counts, never a zeroed record", () => {
  it("returns `cardinalityCounts: null` when the caller filtered it out", async () => {
    // `?? true` defaulted "never read" to "known", so a queue filtered to
    // `kind=alias` shipped `{ total: 0, scoped: 0, withheld: 0, consistent:
    // true }` — rendered as "curated predicates · 0 of 0" with a clean scope
    // badge, for a question nobody asked. The alias half already got this right
    // by being simply ABSENT.
    const queue = await loadPendingQueue(stubReader({}), owner, { kind: "alias" });
    expect(queue.cardinalityCounts).toBeNull();
  });

  it("POSITIVE CONTROL — an unfiltered read DOES carry them", async () => {
    const queue = await loadPendingQueue(stubReader({ cardinalityTotal: [{ n: 4 }] }), owner);
    expect(queue.cardinalityCounts).not.toBeNull();
    expect(queue.cardinalityCounts?.total).toBe(4);
  });
});

describe("⚠️ a CAPPED page and a DROPPED row are different facts", () => {
  it("reports a dropped row as `incomplete`, not as `truncated`", async () => {
    // One boolean carried both, and the client stated one remedy for both:
    // "Filter to reach them". No filter reaches a row that would not narrow, so
    // that sends an approver hunting for a proposal no query returns.
    const queue = await loadPendingQueue(
      stubReader({ alias: { predicate: [aliasRow({ proposed_at: "" })] } }),
      owner,
    );
    expect(queue.incomplete).toBe(true);
    expect(queue.truncated).toBe(false);
  });

  it("reports a capped page as `truncated`, not as `incomplete`", async () => {
    const queue = await loadPendingQueue(
      stubReader({ alias: { predicate: [aliasRow(), aliasRow({ id: "p-2" })] } }),
      owner,
      { limit: 1 },
    );
    expect(queue.truncated).toBe(true);
    expect(queue.incomplete).toBe(false);
  });
});
