/**
 * The stage-0 triage gate at the cycle seam (#5336), without a database.
 *
 * What lives here and nowhere else:
 *
 *   1. **The off-by-default equivalence.** Extraction is live in prod, so with
 *      the gate off the cycle must behave exactly as it did before the gate
 *      existed: every episode reaches the model, no triage query runs, every
 *      triage counter is zero. That is the shipping posture, pinned.
 *   2. **The verdict's consequences.** A routed-out episode is MARKED
 *      (`triaged_out_at` + rule id), never STAMPED (`extracted_at`), never
 *      submitted to a batch, and never handed to the extractor — the four
 *      mistakes a naive gate makes, each asserted separately.
 *   3. **The fail-open arm.** A mark that cannot be written lets the episode
 *      through to the model: a dropped-and-unmarked episode would be the
 *      silent loss this whole design exists to prevent.
 *
 * The `-pg` sibling suites cover the drain SQL against real Postgres; the SQL
 * shape assertions here are the local-suite echo of the same contracts, on
 * `extract-drain.test.ts`'s precedent.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import type { FactCandidate, ReconcileReport } from "@atlas/api/lib/brain/reconcile";

// `runPeriodicDbCycle` guards on `hasInternalDB()`, which reads `DATABASE_URL`
// rather than the pool — set so the skeleton runs its populated path.
process.env.DATABASE_URL ??= "postgres://triage-test/none";

/** Every UPDATE the cycle issued, split by which verb it was. */
const stamped: string[] = [];
const marked: { episodeId: string; rule: string }[] = [];
let markThrows = false;

/**
 * The one internal-DB stand-in, shared by the module-level mock, the
 * `beforeEach` reset and `drainServes` — one shape, three call sites, so the
 * verb-splitting cannot drift between them. `rows` is what the drain serves.
 */
function queryHandler(rows: EpisodeRow[] = []) {
  return async (sql: string, params?: unknown[]): Promise<unknown[]> => {
    if (sql.includes("triaged_out_at = now()")) {
      if (markThrows) throw new Error("internal db unavailable");
      marked.push({ episodeId: String(params?.[0] ?? ""), rule: String(params?.[2] ?? "") });
      return [];
    }
    if (sql.includes("SET extracted_at = now()")) {
      stamped.push(String(params?.[0] ?? ""));
      return [];
    }
    if (sql.includes("FROM brain_episodes e")) return rows;
    return [];
  };
}

const internalQueryMock = mock(queryHandler());

// PARTIAL, spreading the real module — a wholesale replacement drops
// `getInternalDB`, which `reconcile.ts` imports at module load
// (extract-batch.test.ts records the failure shape).
const realInternal = await import("@atlas/api/lib/db/internal");
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: internalQueryMock,
  hasInternalDB: () => true,
}));

const {
  runBrainExtractionCycle,
  isBrainExtractionTriageEnabled,
  DRAIN_EPISODES_SQL,
  MARK_TRIAGED_SQL,
  REQUEUE_TRIAGED_SQL,
  _resetBrainExtractionFailures,
} = await import("@atlas/api/lib/brain/extract");

import type { BatchClient, BatchLedger, EpisodeRow, ResolvedExtractionModel } from "@atlas/api/lib/brain/extract";
import type { BrainExtractionDeps } from "@atlas/api/lib/brain/extract";

const WORKSPACE = "ws-triage";

const MODEL: ResolvedExtractionModel = {
  model: "fake-model" as unknown as ResolvedExtractionModel["model"],
  modelId: "claude-haiku-4-5",
  batchApiKey: null,
};

function episode(id: string, body: string | null): EpisodeRow {
  return {
    id,
    workspace_id: WORKSPACE,
    source: "slack",
    source_id: `slack-${id}`,
    source_actor: "U123",
    body,
    locator: body === null ? `kb://doc/${id}` : null,
    occurred_at: new Date("2026-08-01T00:00:00.000Z"),
    visible_to: ["org"],
  };
}

function recordingReconcile(seen: { episodeId: string }[]) {
  return async (request: { episode: { id: string } }): Promise<ReconcileReport> => {
    seen.push({ episodeId: request.episode.id });
    return {
      created: 0,
      corroborated: 0,
      provisional: 0,
      comparable: 0,
      blocked: {
        NO_PROVENANCE: 0,
        NO_GRANT: 0,
        SOURCE_PRINCIPAL_UNRESOLVED: 0,
        MALFORMED_CLAIM: 0,
      },
    } as unknown as ReconcileReport;
  };
}

/** One cycle with everything injected except what a test overrides. */
async function runCycle(overrides: Partial<BrainExtractionDeps> & { extract?: BrainExtractionDeps["extract"] }) {
  const seen: { episodeId: string }[] = [];
  const result = await Effect.runPromise(
    runBrainExtractionCycle({
      extract: async () => [] as FactCandidate[],
      reconcile: recordingReconcile(seen) as never,
      resolveModel: async () => MODEL,
      loadVocabulary: async () => ({}) as never,
      resolveEntity: (() => async () => new Map())() as never,
      proposeAliases: async () => undefined,
      batchEnabled: () => false,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      ...overrides,
    }),
  );
  return { result, seen };
}

beforeEach(() => {
  _resetBrainExtractionFailures();
  stamped.length = 0;
  marked.length = 0;
  markThrows = false;
  internalQueryMock.mockClear();
  internalQueryMock.mockImplementation(queryHandler());
});

/** Serve these rows from the drain and nothing from anywhere else. */
function drainServes(rows: EpisodeRow[]): void {
  internalQueryMock.mockImplementation(queryHandler(rows));
}

// ---------------------------------------------------------------------------
// 1. The gate, and the off-by-default equivalence
// ---------------------------------------------------------------------------

describe("isBrainExtractionTriageEnabled", () => {
  const prior = process.env.ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED;
  test("is OFF unless the exact string `true` is set", () => {
    try {
      delete process.env.ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED;
      expect(isBrainExtractionTriageEnabled()).toBe(false);
      process.env.ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED = "yes";
      expect(isBrainExtractionTriageEnabled()).toBe(false);
      process.env.ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED = "true";
      expect(isBrainExtractionTriageEnabled()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED;
      else process.env.ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED = prior;
    }
  });
});

describe("⭐ gate OFF — the cycle behaves exactly as before the gate existed", () => {
  test("junk episodes reach the model, nothing is marked, every triage counter is zero", async () => {
    // The prod-safety pin the design guidance demands: extraction is ON in
    // three prod regions, so shipping this gate must change nothing until an
    // operator opts in. "+1" is the canonical shape the gate WOULD catch —
    // asserting it still extracts is what makes this an equivalence test
    // rather than a no-op one.
    drainServes([episode("ep-junk", "+1"), episode("ep-real", "the deploy window is Thursdays")]);
    const extract = mock(async () => [] as FactCandidate[]);

    const { result } = await runCycle({ extract, triageEnabled: () => false });

    expect(extract).toHaveBeenCalledTimes(2);
    expect(marked).toEqual([]);
    // No triage UPDATE was even attempted — equivalence includes the query
    // traffic, not just the outcome.
    const sqls = internalQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("triaged_out_at = now()"))).toBe(false);
    expect(result.extracted).toBe(2);
    expect(result.skipped.triaged).toBe(0);
    expect(result.triage.evaluated).toBe(0);
    expect(Object.values(result.triage.matched).every((n) => n === 0)).toBe(true);
    // Both junk and real were stamped — the pre-gate behaviour for a completed
    // pass, unchanged.
    expect(stamped.sort()).toEqual(["ep-junk", "ep-real"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Gate ON — the verdict and its consequences
// ---------------------------------------------------------------------------

describe("gate ON — a routed-out episode is marked, counted, and never stamped", () => {
  test("⭐ the junk episode is marked with its rule and never reaches the model; the real one extracts", async () => {
    // "on it" and not "+1": both are routed out, but "+1" falls to the length
    // rule first, and this test pins that the STORED reason is the rule that
    // actually fired.
    drainServes([episode("ep-junk", "on it"), episode("ep-real", "the deploy window is Thursdays")]);
    const extract = mock(async () => [] as FactCandidate[]);

    const { result, seen } = await runCycle({ extract, triageEnabled: () => true });

    // The verdict recorded, with the rule that fired — the explainability half.
    expect(marked).toEqual([{ episodeId: "ep-junk", rule: "known_ack" }]);
    // ⭐ Never stamped: `extracted_at` asserts an extraction ran, and none did.
    // Stamping here is the "extracted-with-no-facts" silent drop #5336 forbids.
    expect(stamped).toEqual(["ep-real"]);
    // Never handed to the model or the reconcile stage.
    expect(extract).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.episodeId)).toEqual(["ep-real"]);
    // Counted: the skip reason beside the existing EXTRACTION_SKIP_REASONS,
    // and the per-rule breakdown for the oversight surface.
    expect(result.extracted).toBe(1);
    expect(result.skipped.triaged).toBe(1);
    expect(result.triage.evaluated).toBe(2);
    expect(result.triage.matched.known_ack).toBe(1);
    expect(result.triage.matched.below_min_length).toBe(0);
  });

  test("a body-less episode still takes the no_body path, not a triage verdict", async () => {
    // Two owners for one body class would make the counters disagree. A
    // locator-only episode is by-reference evidence: stamped by the no_body
    // skip exactly as before, with no triage mark.
    drainServes([episode("ep-ref", null)]);
    const extract = mock(async () => [] as FactCandidate[]);

    const { result } = await runCycle({ extract, triageEnabled: () => true });

    expect(marked).toEqual([]);
    expect(result.skipped.no_body).toBe(1);
    expect(result.skipped.triaged).toBe(0);
    expect(result.triage.evaluated).toBe(0);
    expect(stamped).toEqual(["ep-ref"]);
  });

  test("⭐ a routed-out episode is never submitted to a batch — the verdict precedes the spend", async () => {
    // Triage runs before the submit phase or it is worthless on the batch
    // path: a submitted episode is a PAID-FOR episode, and stage 0's whole
    // currency is the calls it does not spend.
    drainServes([episode("ep-junk", "on it"), episode("ep-real", "Dana owns billing now")]);
    const submitted: string[][] = [];
    const client: BatchClient = {
      submit: async ({ items }) => {
        submitted.push(items.map((i) => i.customId));
        return { providerBatchId: "msgbatch_1", expiresAt: new Date("2026-08-03T00:00:00.000Z") };
      },
      retrieve: async () => ({ processingStatus: "ended", resultsUrl: "https://api.anthropic.com/x", expiresAt: null }),
      results: async () => [],
    };
    const ledger: BatchLedger = {
      loadInFlight: async () => [] as never,
      loadEpisodes: async () => [],
      record: async () => "batch-new",
      settleCollected: async () => undefined,
      abandon: async () => 0,
    };

    const { result } = await runCycle({
      triageEnabled: () => true,
      batchEnabled: () => true,
      batchClient: client,
      batchLedger: ledger,
      resolveModel: async () => ({ ...MODEL, batchApiKey: "sk-ant-test" }),
    });

    expect(submitted).toEqual([["ep-real"]]);
    expect(marked.map((m) => m.episodeId)).toEqual(["ep-junk"]);
    expect(result.skipped.triaged).toBe(1);
    expect(result.batch.submitted).toBe(1);
  });

  test("⭐ a mark that cannot be written lets the episode through to the model", async () => {
    // Fail OPEN: dropping an episode whose mark did not land would be an
    // unrecorded, uncounted loss — the exact silent-drop class the marking
    // scheme exists to prevent. The cost of the open direction is one model
    // call, which is stage 0's own currency.
    drainServes([episode("ep-junk", "+1")]);
    markThrows = true;
    const extract = mock(async () => [] as FactCandidate[]);

    const { result } = await runCycle({ extract, triageEnabled: () => true });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(result.extracted).toBe(1);
    expect(result.skipped.triaged).toBe(0);
    // Evaluated is still counted — the gate looked; only the verdict failed.
    expect(result.triage.evaluated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The SQL contracts, pinned where the local suite can see them
// ---------------------------------------------------------------------------

describe("the SQL verbs", () => {
  test("the drain excludes triaged-out episodes — as a recorded mark, not an inline rule", () => {
    expect(DRAIN_EPISODES_SQL).toContain("e.triaged_out_at IS NULL");
    // And the exclusion sits before the LIMIT, so a triaged episode does not
    // consume a slot it will only be skipped in (the head-of-line argument the
    // backing-off exclusion already makes).
    expect(DRAIN_EPISODES_SQL.indexOf("triaged_out_at IS NULL")).toBeLessThan(
      DRAIN_EPISODES_SQL.indexOf("LIMIT"),
    );
  });

  test("⭐ the mark never touches extracted_at, and refuses already-settled rows", () => {
    // The one-way doors, both directions: a triage verdict must not stamp an
    // extraction, and must not overwrite an extraction (or an earlier verdict)
    // that got there first.
    expect(MARK_TRIAGED_SQL).not.toContain("extracted_at = now()");
    expect(MARK_TRIAGED_SQL).toContain("extracted_at IS NULL");
    expect(MARK_TRIAGED_SQL).toContain("triaged_out_at IS NULL");
    expect(MARK_TRIAGED_SQL).toContain("triage_reason = $3");
  });

  test("the re-queue verb clears BOTH halves of the mark and only for un-extracted rows", () => {
    // Clearing one half would trip chk_brain_episodes_triage_pair; clearing an
    // extracted row's mark would re-queue evidence that was already processed.
    expect(REQUEUE_TRIAGED_SQL).toContain("triaged_out_at = NULL");
    expect(REQUEUE_TRIAGED_SQL).toContain("triage_reason = NULL");
    expect(REQUEUE_TRIAGED_SQL).toContain("extracted_at IS NULL");
    // The per-rule narrowing: NULL re-queues everything, a rule id only its
    // own verdicts.
    expect(REQUEUE_TRIAGED_SQL).toContain("$2::text IS NULL OR triage_reason = $2::text");
  });

  test("the re-queue verb stays CLAUSE-FINAL, so it can be composed into a CTE", () => {
    // #5534 wraps this exact string: `WITH requeued AS (<this> RETURNING 1)
    // SELECT count(*)`. A trailing `RETURNING` here makes the composed
    // statement `RETURNING … RETURNING 1` — a runtime syntax error on an act
    // that is not undoable — and a `;` or a trailing `--` comment breaks it the
    // same way. Every `toContain` pin in this file and in
    // `triage-requeue.test.ts` stays green through all three, because they ask
    // what the string CONTAINS and never what it ends with.
    //
    // The positive proof is `triage-requeue-pg.test.ts`, which executes the
    // composition. This is the cheap guard that fails in the local suite, next
    // to the constant, naming the reason.
    expect(REQUEUE_TRIAGED_SQL).not.toMatch(/RETURNING/i);
    expect(REQUEUE_TRIAGED_SQL).not.toContain(";");
    expect(REQUEUE_TRIAGED_SQL).not.toMatch(/--/);
    expect(REQUEUE_TRIAGED_SQL.trimEnd()).toMatch(/\)$/);
  });
});
