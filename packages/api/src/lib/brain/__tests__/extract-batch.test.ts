/**
 * The Batch API path's DB-free surface (#5352).
 *
 * `extract-reconcile-pg.test.ts` drives whole cycles against a live schema and
 * is the better test for anything that touches rows. What lives here is the part
 * that has no database in it and would otherwise be tested nowhere:
 *
 *   1. **`parseBatchResultLine`** — the wire reader. Every arm of it decides
 *      whether an episode is charged a strike, and the arms are only
 *      distinguishable at this layer.
 *   2. **Result matching by `custom_id`** — the one defect in this ticket that a
 *      naive implementation passes every fixture on. The vendor documents that
 *      results arrive in any order; the ordering that makes positional matching
 *      LOOK right is the common case, so this is pinned with a shuffle.
 *   3. **The two-phase cycle's control flow** — collect before drain before
 *      submit, the in-flight exclusion, the fallback to the synchronous path,
 *      and the strike/no-strike split between a failed BATCH and a failed
 *      REQUEST. All of it runs against injected `BatchClient` / `BatchLedger`
 *      seams, which exist for exactly this.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import type { FactCandidate, ReconcileReport } from "@atlas/api/lib/brain/reconcile";

// `runPeriodicDbCycle` guards on `hasInternalDB()`, which reads `DATABASE_URL`
// rather than the pool — set so the skeleton runs its populated path. Every DB
// call the cycle would make is behind an injected seam except `stampExtracted`,
// which is mocked below.
process.env.DATABASE_URL ??= "postgres://batch-test/none";

const stamped: string[] = [];
const internalQueryMock = mock(async (sql: string, _params?: unknown[]) => {
  if (sql.includes("UPDATE brain_episodes")) {
    stamped.push(String(_params?.[0] ?? ""));
    return [] as unknown[];
  }
  return [] as unknown[];
});

// PARTIAL, spreading the real module. A wholesale replacement drops
// `getInternalDB`, which `reconcile.ts` imports at module load — the failure is
// a `SyntaxError: Export named 'getInternalDB' not found`, which reads as a
// broken import rather than as an over-broad mock.
const realInternal = await import("@atlas/api/lib/db/internal");
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: internalQueryMock,
  hasInternalDB: () => true,
}));

const {
  parseBatchResultLine,
  assertAnthropicOrigin,
  COLLECT_BATCHES_PER_TICK,
  BATCH_EPISODES_SQL,
} = await import("@atlas/api/lib/brain/extract-batch");

const { runBrainExtractionCycle, DRAIN_EPISODES_SQL, _resetBrainExtractionFailures } = await import(
  "@atlas/api/lib/brain/extract"
);

// Static, not destructured off the dynamic import: types are erased, so a
// `type` binding inside an object pattern is a syntax error rather than a
// no-op. The value import above stays dynamic because the `mock.module` call
// must run first.
import type {
  BatchClient,
  BatchLedger,
  EpisodeRow,
  ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract";

const WORKSPACE = "ws-batch";

const MODEL: ResolvedExtractionModel = {
  model: "fake-model" as unknown as ResolvedExtractionModel["model"],
  modelId: "claude-haiku-4-5",
  batchApiKey: "sk-ant-test",
};

/** The same shape with no batch endpoint — the documented fallback. */
const MODEL_NO_BATCH: ResolvedExtractionModel = { ...MODEL, batchApiKey: null };

function episode(id: string, body = "the deploy window is Thursdays"): EpisodeRow {
  return {
    id,
    workspace_id: WORKSPACE,
    source: "slack",
    source_id: `slack-${id}`,
    source_actor: "U123",
    body,
    locator: null,
    occurred_at: new Date("2026-08-01T00:00:00.000Z"),
    visible_to: ["org"],
  };
}

function succeededLine(customId: string, subject: string): string {
  return JSON.stringify({
    custom_id: customId,
    result: {
      type: "succeeded",
      message: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              facts: [
                { subject, predicate: "deploys on", object: "Thursdays", cardinality: "multi" },
              ],
            }),
          },
        ],
      },
    },
  });
}

/** A reconcile stub that records what it was handed and commits nothing. */
function recordingReconcile(seen: { episodeId: string; candidates: readonly FactCandidate[] }[]) {
  return async (request: {
    episode: { id: string };
    candidates: readonly FactCandidate[];
  }): Promise<ReconcileReport> => {
    seen.push({ episodeId: request.episode.id, candidates: request.candidates });
    return {
      created: request.candidates.length,
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

beforeEach(() => {
  _resetBrainExtractionFailures();
  stamped.length = 0;
  internalQueryMock.mockClear();
});

// ---------------------------------------------------------------------------
// 1. The drain's in-flight exclusion
// ---------------------------------------------------------------------------

describe("DRAIN_EPISODES_SQL — the in-flight exclusion", () => {
  test("⭐ excludes on the batch's STATUS, not on the pointer being null", () => {
    // THE stranding bug this predicate exists to make unrepresentable. A collect
    // pass settles the batch BEFORE its episodes are reconciled and stamped — it
    // must, because the stamp happens per-episode later in the same tick. Under
    // `extraction_batch_id IS NULL` a crash in that window (or a results set
    // that simply omitted an episode) leaves the row excluded from the drain
    // FOREVER, with nothing left to unwind it.
    //
    // MUTATION THIS CATCHES: replacing the NOT EXISTS with
    // `AND e.extraction_batch_id IS NULL`. Every happy-path test still passes.
    expect(DRAIN_EPISODES_SQL).toContain("NOT EXISTS");
    expect(DRAIN_EPISODES_SQL).toContain("b.status = 'in_flight'");
    // The pointer-null arm is still there as the fast path for every episode
    // that never went near a batch — but it is an OR, not the whole predicate.
    expect(DRAIN_EPISODES_SQL).toContain("e.extraction_batch_id IS NULL\n");
  });

  test("the batch-episode load selects the same columns the drain does", () => {
    // Both feed one `EpisodeRow`. A divergence surfaces as a column reading
    // `undefined` deep inside reconcile rather than as a query error, so it is
    // pinned where it is cheap.
    for (const column of [
      "source_actor",
      "occurred_at",
      "visible_to",
      "locator",
      "body",
    ]) {
      expect(BATCH_EPISODES_SQL).toContain(column);
      expect(DRAIN_EPISODES_SQL).toContain(column);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The wire reader
// ---------------------------------------------------------------------------

describe("parseBatchResultLine", () => {
  test("reads a succeeded line's first text block", () => {
    const parsed = parseBatchResultLine(succeededLine("ep-1", "the api"));
    expect(parsed?.kind).toBe("succeeded");
    expect(parsed?.kind === "succeeded" && parsed.text).toContain("deploys on");
  });

  test("⭐ a line with no custom_id is dropped, never matched by position", () => {
    // The alternative — falling back to position — writes one episode's facts
    // under another episode's provenance AND another episode's grant. Dropping
    // is the only safe answer: there is no episode to attribute it to.
    expect(parseBatchResultLine(JSON.stringify({ result: { type: "succeeded" } }))).toBeNull();
    expect(parseBatchResultLine("{not json")).toBeNull();
  });

  test("`errored` is the request's own refusal and becomes a strike-charging failure", () => {
    // The vendor refused THIS request on its own terms — a body that trips a
    // content filter, a malformed request. That is the episode's evidence, so
    // it charges a strike and eventually backs off.
    const parsed = parseBatchResultLine(
      JSON.stringify({
        custom_id: "ep-1",
        result: { type: "errored", error: { type: "invalid_request" } },
      }),
    );
    expect(parsed?.kind).toBe("failed");
    expect(parsed?.kind === "failed" && parsed.error).toContain("errored");
  });

  test("⭐ `expired` and `canceled` are UNFULFILLED, and that is a different verdict", () => {
    // These arrive in exactly the shape of a per-request failure and are not
    // one: a 24h expiry is a vendor capacity incident and a cancel is an
    // operator at the vendor console. Collapsing them into `failed` — which the
    // first cut of this reader did — lets three vendor expiries quarantine a
    // whole backlog, through the one path that never reaches `abandonBatch`.
    //
    // MUTATION THIS CATCHES: removing the `UNFULFILLED_RESULT_TYPES` branch.
    for (const type of ["expired", "canceled"]) {
      const parsed = parseBatchResultLine(JSON.stringify({ custom_id: "ep-1", result: { type } }));
      expect(parsed?.kind).toBe("unfulfilled");
      expect(parsed?.kind === "unfulfilled" && parsed.reason).toContain(type);
    }
  });

  test("⭐ an `errored` line can still be the WORLD's — the inner error type decides", () => {
    // The outer envelope is not enough, and assuming it was is the defect this
    // pins. `errored` is what the vendor sends for BOTH "this request was bad"
    // and "we could not serve it" — an overload, a rate limit, a 5xx, a rotated
    // key all arrive as per-request `errored` lines inside an `ended` batch.
    // Classifying on the envelope alone charged a strike to every episode in a
    // batch the vendor simply could not serve, which is #5352's AC broken one
    // layer below where the first fix put the guard.
    //
    // MUTATION THIS CATCHES: emptying `UNFULFILLED_ERROR_TYPES`, or reverting
    // to a bare `result.type === "errored" -> failed`.
    for (const errorType of [
      "overloaded_error",
      "api_error",
      "rate_limit_error",
      "timeout_error",
      "authentication_error",
      "permission_error",
      "billing_error",
    ]) {
      const parsed = parseBatchResultLine(
        JSON.stringify({ custom_id: "ep-1", result: { type: "errored", error: { type: errorType } } }),
      );
      expect(parsed?.kind).toBe("unfulfilled");
    }
  });

  test("the two errors that ARE this message's own still charge a strike", () => {
    // The control for the test above. Without it, "world evidence" could be
    // satisfied by a classifier that forgives every `errored` line — which
    // would let a permanently-poisoned body cost a batched request per tick,
    // for ever, with nothing bounding it.
    for (const errorType of ["invalid_request_error", "request_too_large"]) {
      const parsed = parseBatchResultLine(
        JSON.stringify({ custom_id: "ep-1", result: { type: "errored", error: { type: errorType } } }),
      );
      expect(parsed?.kind).toBe("failed");
    }
  });

  test("an unrecognised ERROR type charges a strike — the bounded direction", () => {
    // The allowlist fails toward the side quarantine can absorb: a
    // wrongly-charged strike heals itself at one call per widening window, a
    // wrongly-forgiven one re-submits at full price for ever.
    const parsed = parseBatchResultLine(
      JSON.stringify({ custom_id: "ep-1", result: { type: "errored", error: { type: "brand_new_error" } } }),
    );
    expect(parsed?.kind).toBe("failed");
  });

  test("an unrecognised result type is treated as the request's own failure", () => {
    // The safe default for a vocabulary that grows: a strike is bounded by the
    // quarantine backoff, while a silent re-queue on an unknown terminal state
    // would re-submit the episode forever at full price.
    const parsed = parseBatchResultLine(
      JSON.stringify({ custom_id: "ep-1", result: { type: "something_new" } }),
    );
    expect(parsed?.kind).toBe("failed");
  });

  test("a succeeded line with no text block is a failure, not a silent empty extraction", () => {
    // Treating it as "the model found no claims" would stamp the episode and
    // drop its evidence permanently, on a response we could not read.
    const parsed = parseBatchResultLine(
      JSON.stringify({ custom_id: "ep-1", result: { type: "succeeded", message: { content: [] } } }),
    );
    expect(parsed?.kind).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// 3. The two-phase cycle
// ---------------------------------------------------------------------------

interface Harness {
  readonly client: BatchClient;
  readonly ledger: BatchLedger;
  readonly submitted: { modelId: string; customIds: string[] }[];
  readonly abandoned: { batchId: string; reason: string }[];
  readonly settled: string[];
}

function harness(opts: {
  readonly inFlight?: readonly Record<string, unknown>[];
  readonly episodesByBatch?: Record<string, readonly EpisodeRow[]>;
  readonly resultsByBatch?: Record<string, readonly string[]>;
  readonly status?: "in_progress" | "ended";
  readonly retrieveThrows?: boolean;
  readonly submitThrows?: boolean;
}): Harness {
  const submitted: { modelId: string; customIds: string[] }[] = [];
  const abandoned: { batchId: string; reason: string }[] = [];
  const settled: string[] = [];

  const client: BatchClient = {
    submit: async ({ modelId, items }) => {
      if (opts.submitThrows) throw new Error("vendor rejected the batch");
      submitted.push({ modelId, customIds: items.map((i) => i.customId) });
      return {
        providerBatchId: `msgbatch_${submitted.length}`,
        expiresAt: new Date("2026-08-03T00:00:00.000Z"),
      };
    },
    retrieve: async ({ providerBatchId }) => {
      if (opts.retrieveThrows) throw new Error("vendor is unreachable");
      return {
        processingStatus: opts.status ?? "ended",
        resultsUrl: `https://api.anthropic.com/results/${providerBatchId}`,
        expiresAt: null,
      };
    },
    results: async ({ resultsUrl }) => {
      const batchId = Object.keys(opts.resultsByBatch ?? {}).find((id) =>
        resultsUrl.includes(String((opts.inFlight ?? []).find((b) => b.id === id)?.provider_batch_id)),
      );
      const lines = batchId === undefined ? [] : (opts.resultsByBatch?.[batchId] ?? []);
      return lines
        .map((line) => parseBatchResultLine(line))
        .filter((r): r is NonNullable<typeof r> => r !== null);
    },
  };

  const ledger: BatchLedger = {
    loadInFlight: async () => (opts.inFlight ?? []) as never,
    loadEpisodes: async (batchId) => opts.episodesByBatch?.[batchId] ?? [],
    record: async () => "batch-new",
    settleCollected: async (batchId) => {
      settled.push(batchId);
    },
    abandon: async ({ batchId, reason }) => {
      abandoned.push({ batchId, reason });
      return (opts.episodesByBatch?.[batchId] ?? []).length;
    },
  };

  return { client, ledger, submitted, abandoned, settled };
}

function inFlightRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "batch-1",
    workspace_id: WORKSPACE,
    provider: "anthropic",
    provider_batch_id: "msgbatch_live",
    model_id: "claude-haiku-4-5",
    request_count: 2,
    expires_at: new Date("2026-08-03T00:00:00.000Z"),
    ...overrides,
  };
}

const NOW = () => new Date("2026-08-02T00:00:00.000Z");

describe("the batch submit phase", () => {
  test("⭐ drained episodes go out as a batch instead of being extracted now", async () => {
    const h = harness({});
    const extract = mock(async () => [] as FactCandidate[]);
    const seen: { episodeId: string; candidates: readonly FactCandidate[] }[] = [];

    internalQueryMock.mockImplementation(async (sql: string) =>
      sql.includes("FROM brain_episodes e") ? [episode("ep-1"), episode("ep-2")] : [],
    );

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract,
        reconcile: recordingReconcile(seen) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]?.customIds).toEqual(["ep-1", "ep-2"]);
    // The tier travels with the submission — a batch records what it was
    // submitted AS, so a later tier change cannot re-attribute these claims.
    expect(h.submitted[0]?.modelId).toBe("claude-haiku-4-5");
    // ⭐ And nothing was extracted synchronously. Without this the test passes
    // on an implementation that submits AND immediately extracts — double spend,
    // invisible in every other assertion.
    expect(extract).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    expect(result.batch.submitted).toBe(2);
    expect(result.extracted).toBe(0);
  });

  test("⭐ a provider with no batch endpoint falls back to the immediate path", async () => {
    // The fallback is the AC that makes "batch is a capability of the resolved
    // provider" true rather than aspirational — `ollama` and `openai-compatible`
    // deployments must keep working with the setting switched on.
    const h = harness({});
    const extract = mock(async () => [] as FactCandidate[]);
    const seen: { episodeId: string; candidates: readonly FactCandidate[] }[] = [];

    internalQueryMock.mockImplementation(async (sql: string) =>
      sql.includes("FROM brain_episodes e") ? [episode("ep-1")] : [],
    );

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract,
        reconcile: recordingReconcile(seen) as never,
        resolveModel: async () => MODEL_NO_BATCH,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(h.submitted).toHaveLength(0);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(result.extracted).toBe(1);
    expect(result.batch.submitted).toBe(0);
  });

  test("a failed submission drops that workspace to the immediate path for the tick", async () => {
    // Per-WORKSPACE, and nothing is lost: the episodes were never pointed at a
    // batch, so they are simply extracted now.
    const h = harness({ submitThrows: true });
    const extract = mock(async () => [] as FactCandidate[]);

    internalQueryMock.mockImplementation(async (sql: string) =>
      sql.includes("FROM brain_episodes e") ? [episode("ep-1")] : [],
    );

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract,
        reconcile: recordingReconcile([]) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(extract).toHaveBeenCalledTimes(1);
    expect(result.extracted).toBe(1);
    expect(result.batch.submitted).toBe(0);
  });

  test("the setting off means no submission at all", async () => {
    const h = harness({});
    const extract = mock(async () => [] as FactCandidate[]);
    internalQueryMock.mockImplementation(async (sql: string) =>
      sql.includes("FROM brain_episodes e") ? [episode("ep-1")] : [],
    );

    await Effect.runPromise(
      runBrainExtractionCycle({
        extract,
        reconcile: recordingReconcile([]) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => false,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(h.submitted).toHaveLength(0);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});

describe("the batch collect phase", () => {
  test("⭐ results are matched by custom_id even when they arrive shuffled", async () => {
    // THE test this ticket's AC names. The vendor documents that results arrive
    // in any order; a positional reader passes every fixture written in
    // submission order and silently writes one episode's claims under another's
    // provenance and grant in production.
    //
    // The lines below are DELIBERATELY reversed relative to the episode order.
    const episodes = [episode("ep-a"), episode("ep-b")];
    const h = harness({
      inFlight: [inFlightRow()],
      episodesByBatch: { "batch-1": episodes },
      resultsByBatch: {
        "batch-1": [succeededLine("ep-b", "the b service"), succeededLine("ep-a", "the a service")],
      },
    });
    const seen: { episodeId: string; candidates: readonly FactCandidate[] }[] = [];

    internalQueryMock.mockImplementation(async () => []);

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: async () => {
          throw new Error("the collect path must not call a model");
        },
        reconcile: recordingReconcile(seen) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(result.extracted).toBe(2);
    expect(seen).toHaveLength(2);
    // Each episode got ITS OWN claim. Positional matching would swap these two
    // and every count above would still be right.
    const byEpisode = new Map(seen.map((s) => [s.episodeId, s.candidates[0]?.subject]));
    expect(byEpisode.get("ep-a")).toBe("the a service");
    expect(byEpisode.get("ep-b")).toBe("the b service");
    expect(h.settled).toEqual(["batch-1"]);
    expect(result.batch.collected).toBe(1);
  });

  test("a collected episode does not cost a second model call", async () => {
    // The whole economic point: the batch already paid for this answer.
    const h = harness({
      inFlight: [inFlightRow({ request_count: 1 })],
      episodesByBatch: { "batch-1": [episode("ep-a")] },
      resultsByBatch: { "batch-1": [succeededLine("ep-a", "the a service")] },
    });
    const extract = mock(async () => [] as FactCandidate[]);
    internalQueryMock.mockImplementation(async () => []);

    await Effect.runPromise(
      runBrainExtractionCycle({
        extract,
        reconcile: recordingReconcile([]) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(extract).not.toHaveBeenCalled();
  });

  test("⭐ a failed BATCH re-queues its episodes and charges no strikes", async () => {
    // #5352's AC verbatim: "A failed batch does not quarantine every episode it
    // contained." An expired batch is evidence about the world, not about any
    // of the episodes in it — charging them would quarantine a batch of
    // perfectly good episodes after three bad batches.
    const episodes = [episode("ep-a"), episode("ep-b")];
    const h = harness({
      inFlight: [inFlightRow({ expires_at: new Date("2026-08-01T00:00:00.000Z") })],
      episodesByBatch: { "batch-1": episodes },
      retrieveThrows: true,
    });
    internalQueryMock.mockImplementation(async () => []);

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: async () => [],
        reconcile: recordingReconcile([]) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(h.abandoned).toHaveLength(1);
    expect(result.batch.abandoned).toBe(1);
    expect(result.batch.requeued).toBe(2);
    // ⭐ NOT counted as failures — a failure is what charges a strike, and a
    // strike is what quarantines. This is the assertion the AC is about.
    expect(result.failed).toBe(0);
  });

  test("a still-running batch inside its expiry is left alone", async () => {
    const h = harness({
      inFlight: [inFlightRow()],
      episodesByBatch: { "batch-1": [episode("ep-a")] },
      status: "in_progress",
    });
    internalQueryMock.mockImplementation(async () => []);

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: async () => [],
        reconcile: recordingReconcile([]) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(h.abandoned).toHaveLength(0);
    expect(h.settled).toHaveLength(0);
    expect(result.batch.polled).toBe(1);
    expect(result.batch.collected).toBe(0);
  });

  test("⭐ a per-REQUEST error IS charged, unlike a batch failure", async () => {
    // The other half of the split, and the reason the two are not collapsed:
    // the vendor already tells us which failures belong to one request. An
    // episode whose own request errored is evidence about that episode, so it
    // charges a strike and eventually backs off — otherwise a permanently
    // poisoned body costs one batched request every tick forever.
    const h = harness({
      inFlight: [inFlightRow({ request_count: 1 })],
      episodesByBatch: { "batch-1": [episode("ep-a")] },
      resultsByBatch: {
        "batch-1": [
          JSON.stringify({
            custom_id: "ep-a",
            result: { type: "errored", error: { type: "invalid_request" } },
          }),
        ],
      },
    });
    internalQueryMock.mockImplementation(async () => []);

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: async () => [],
        reconcile: recordingReconcile([]) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(result.failed).toBe(1);
    expect(result.extracted).toBe(0);
    // The batch itself still collected — it did its job, one request in it did
    // not. Abandoning here would re-queue and re-pay for the whole batch.
    expect(h.settled).toEqual(["batch-1"]);
    expect(h.abandoned).toHaveLength(0);
  });

  test("⭐ an episode collected this tick is not ALSO drained this tick", async () => {
    // The defect this pins is invisible in every other test here, because they
    // all stub the drain empty. In production the drain runs AFTER the collect
    // phase settled the batch, and a collected episode is still unstamped (the
    // stamp happens in `applyRow`, later) — so `DRAIN_EPISODES_SQL` re-admits
    // it by design, as the oldest row on the queue.
    //
    // Both arms are expensive and neither shows up in a counter without this:
    // with batch ON the submit phase re-sends answers already in hand (a whole
    // extra batch's spend per collect tick, cancelling the 50% saving), and
    // with batch OFF the id lands in both halves of `scan`'s return and
    // `applyRow` reconciles the same episode twice.
    //
    // MUTATION THIS CATCHES: dropping the collected ids from the drain's
    // exclusion argument in `scan`.
    const collectedEpisode = episode("ep-a");
    const h = harness({
      inFlight: [inFlightRow({ request_count: 1 })],
      episodesByBatch: { "batch-1": [collectedEpisode] },
      resultsByBatch: { "batch-1": [succeededLine("ep-a", "the a service")] },
    });
    const seen: { episodeId: string; candidates: readonly FactCandidate[] }[] = [];

    // The drain HONOURS its `$2` exclusion, as real Postgres does. That is the
    // level the fix lives at since it moved into the predicate: a stub that
    // ignored `$2` would report this episode as drained no matter what `scan`
    // passed, and would go on passing if the exclusion were dropped entirely.
    // `extract-batch-pg.test.ts` covers the same ground against real SQL.
    const excludedSeen: string[][] = [];
    internalQueryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (!sql.includes("FROM brain_episodes e")) return [];
      const excluded = (params?.[1] as string[] | undefined) ?? [];
      excludedSeen.push(excluded);
      return excluded.includes(collectedEpisode.id) ? [] : [collectedEpisode];
    });

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: async () => {
          throw new Error("the collect path must not call a model");
        },
        reconcile: recordingReconcile(seen) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    // The mechanism, asserted directly: the collected id reached the drain's
    // exclusion list rather than being filtered out of its result. Excluding it
    // in the PREDICATE is what keeps `LIMIT` spendable on rows we can use — a
    // post-hoc filter would drain 25 and keep none on a full collect tick.
    expect(excludedSeen).toHaveLength(1);
    expect(excludedSeen[0]).toContain(collectedEpisode.id);

    expect(seen).toHaveLength(1);
    expect(result.inspected).toBe(1);
    expect(result.extracted).toBe(1);
    // And it was not re-submitted either — the other arm of the same exclusion.
    expect(h.submitted).toHaveLength(0);
    expect(result.batch.submitted).toBe(0);
  });

  test("⭐ a vendor-EXPIRED request re-queues without a strike, unlike an errored one", async () => {
    // `expired` and `canceled` arrive as per-request lines inside an `ended`
    // batch, so they never pass through `abandonBatch` — and treating them as
    // per-request failures (which is what they look like) means a vendor
    // capacity incident charges a strike to every episode in the batch. Three
    // of those quarantine the whole backlog with exponential backoff, which is
    // exactly the outcome #5352's AC forbids, reached by the one path that
    // bypasses the guard written for it.
    //
    // MUTATION THIS CATCHES: folding `expired`/`canceled` back into `failed`.
    const episodes = [episode("ep-a"), episode("ep-b")];
    const h = harness({
      inFlight: [inFlightRow({ request_count: 2 })],
      episodesByBatch: { "batch-1": episodes },
      resultsByBatch: {
        "batch-1": [
          JSON.stringify({ custom_id: "ep-a", result: { type: "expired" } }),
          JSON.stringify({
            custom_id: "ep-b",
            result: { type: "errored", error: { type: "invalid_request" } },
          }),
        ],
      },
    });
    internalQueryMock.mockImplementation(async () => []);

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: async () => [],
        reconcile: recordingReconcile([]) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => true,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    // ep-b's own request errored — that is its evidence, and it is charged.
    // ep-a expired at the vendor — that is the vendor's, and it is not.
    expect(result.failed).toBe(1);
    expect(result.batch.requeued).toBe(1);
    expect(result.inspected).toBe(1);
  });

  test("the collect phase runs even when new submissions are switched off", async () => {
    // Turning the setting off must not discard work already paid for — that is
    // the expensive direction of a mistake that is otherwise free to make.
    const h = harness({
      inFlight: [inFlightRow({ request_count: 1 })],
      episodesByBatch: { "batch-1": [episode("ep-a")] },
      resultsByBatch: { "batch-1": [succeededLine("ep-a", "the a service")] },
    });
    internalQueryMock.mockImplementation(async () => []);

    const result = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: async () => [],
        reconcile: recordingReconcile([]) as never,
        resolveModel: async () => MODEL,
        loadVocabulary: async () => ({}) as never,
        resolveEntity: (() => async () => new Map())() as never,
        proposeAliases: async () => undefined,
        batchEnabled: () => false,
        batchClient: h.client,
        batchLedger: h.ledger,
        now: NOW,
      }),
    );

    expect(result.batch.collected).toBe(1);
    expect(result.extracted).toBe(1);
    expect(h.submitted).toHaveLength(0);
  });
});

describe("assertAnthropicOrigin", () => {
  test("⭐ refuses a results url that is not Anthropic's", () => {
    // The one url in this module that comes from the vendor's RESPONSE BODY
    // rather than from us, and it is fetched carrying the workspace's own API
    // key. `fetch` strips only `Authorization`/`Cookie` across origins, so an
    // unexpected `results_url` — or a redirect to one — leaks the key.
    //
    // MUTATION THIS CATCHES: deleting the call in `readExtractionBatchResults`.
    for (const url of [
      "https://evil.example.com/results",
      "http://api.anthropic.com/results", // scheme is part of the origin
      "https://api.anthropic.com.evil.example.com/results",
      "not a url",
    ]) {
      expect(() => assertAnthropicOrigin(url)).toThrow();
    }
  });

  test("permits the vendor's own results url", () => {
    // The control: without it, `toThrow()` above is satisfied by a function
    // that refuses everything, including every real batch.
    expect(() =>
      assertAnthropicOrigin("https://api.anthropic.com/v1/messages/batches/msgbatch_1/results"),
    ).not.toThrow();
  });

  test("the refusal does not echo the url it refused", () => {
    // Attacker-influenced text heading for a log line. The origin is named
    // because that is the actionable part; the path and query are not.
    try {
      assertAnthropicOrigin("https://evil.example.com/results?token=leak-me");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(String(err)).not.toContain("leak-me");
    }
  });
});

describe("bounds", () => {
  test("the collect phase is bounded per tick", () => {
    // Each ended batch becomes up to BATCH_SIZE reconcile transactions in the
    // same tick, through a `concurrency: 1` loop. Unbounded, twenty batches
    // landing after an outage would starve the drain behind them.
    expect(COLLECT_BATCHES_PER_TICK).toBeGreaterThan(0);
    expect(COLLECT_BATCHES_PER_TICK).toBeLessThanOrEqual(8);
  });
});
