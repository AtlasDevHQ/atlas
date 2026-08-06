/**
 * The region importer's identity-loss line (#5035, ADR-0037 §8).
 *
 * ## Why this file exists
 *
 * The importer nulls a comparable value for four reasons and the column records
 * one outcome for all four. Without a log, an operator cannot tell:
 *
 *   - **`storeLocal`** — an `entity:` id dropped. §8's rule working, and the
 *     size of it is how much of the corpus abstains until recomputed.
 *   - **`unreadable`** — the SOURCE region wrote a tag or a payload this region
 *     cannot read. **Real evidence lost**, not deferred, and the only other
 *     symptom is its absence. Two independently deployed regions on skewed
 *     releases produce exactly this, and nothing else in the system would ever
 *     mention it.
 *   - **`unkeyable`** — a legacy surface that normalizes away, so no key exists.
 *     Legal and permanent; the ingest path warns about it and calls that "the
 *     only signal such a claim ever produces", and this is the second key
 *     writer.
 *
 * A `200` with healthy `imported` counts is the same response in all three
 * cases. The line is the difference, and a line nothing checks is deletable
 * green — which is the whole reason this repo generates mutation tables.
 *
 * ## Why a separate file
 *
 * `alias-proposal-logging.test.ts`'s pattern and its constraint: mocking the
 * logger means `mock.module`ing EVERY value export of `@atlas/api/lib/logger`
 * and importing the module under test DYNAMICALLY, so the mock is installed
 * before the import binds. That is process-wide, so it cannot share a file with
 * suites that want real logging.
 *
 * No database — `importBundle` takes an injected client, so every case here is a
 * scripted result set. The behaviour lives in `migrate-roundtrip-pg.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { InternalPoolClient } from "@atlas/api/lib/db/internal";

interface Captured {
  readonly payload: unknown;
  readonly message: string;
}

const errors: Captured[] = [];
const warns: Captured[] = [];
const debugs: Captured[] = [];

/**
 * Every value export of `lib/logger`, replaced.
 *
 * ⚠️ A PARTIAL mock is the trap this repo has recorded: `mock.module` replaces
 * the whole module, so any export left out becomes `undefined` and the module
 * under test throws on first use. The factory is SYNCHRONOUS, because an async
 * one deadlocks `bun:test`.
 */
void mock.module("@atlas/api/lib/logger", () => {
  const record = (sink: Captured[]) => (payload: unknown, message?: unknown) =>
    sink.push({ payload, message: typeof message === "string" ? message : String(payload) });
  const capture = {
    error: record(errors),
    warn: record(warns),
    info: () => {},
    debug: record(debugs),
    level: "info",
  };
  return {
    createLogger: () => capture,
    getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
    setLogLevel: () => true,
    getRequestContext: () => undefined,
    withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
    redactPaths: [] as string[],
    scrubErrSerializer: (value: unknown) => value,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
  };
});

type ImportBundle = typeof import("@atlas/api/api/routes/admin-migrate")["importBundle"];
let importBundle: ImportBundle;

beforeAll(async () => {
  ({ importBundle } = await import("@atlas/api/api/routes/admin-migrate"));
});

afterEach(() => {
  errors.length = 0;
  warns.length = 0;
  debugs.length = 0;
});

/**
 * A client that answers every statement with no rows — so nothing is "already
 * present" and every fact takes the INSERT path.
 *
 * The one exception is `vocabulary.ts`'s advisory-lock PROBE, which refuses to
 * proceed against an executor that answers it with nothing ("not answering as a
 * Postgres client"). That refusal is correct and load-bearing — it is what stops
 * a pool being passed where a transaction is required — so it is ANSWERED here
 * rather than routed around.
 *
 * ⚠️ Stating the cost of answering it: this suite therefore CANNOT catch "the
 * importer took the lock outside a transaction". `migrate-roundtrip-pg.test.ts`
 * covers that against a real connection; what this file pins is the ORDER of the
 * statements, which is invisible there.
 */
function captureClient(): { client: InternalPoolClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("pg_locks")) return { rows: [{ n: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  } as unknown as InternalPoolClient;
  return { client, calls };
}

/** A v3 bundle with one episode whose facts are supplied by the caller. */
function bundleWith(facts: Record<string, unknown>[], version = 3): Parameters<ImportBundle>[1] {
  return {
    manifest: {
      version,
      exportedAt: "2026-08-06T00:00:00Z",
      source: { label: "logging-test" },
      counts: {
        conversations: 0, messages: 0, semanticEntities: 0, learnedPatterns: 0, settings: 0,
      },
    },
    conversations: [],
    semanticEntities: [],
    learnedPatterns: [],
    settings: [],
    brainEpisodes: [
      {
        id: "ep-1",
        source: "slack",
        sourceId: "C1/1.0",
        sourceActor: "U-a",
        body: "…",
        locator: null,
        occurredAt: null,
        ingestedAt: "2026-08-06T00:00:00Z",
        extractedAt: null,
        visibleTo: ["org"],
        createdAt: "2026-08-06T00:00:00Z",
        facts,
      },
    ],
  } as unknown as Parameters<ImportBundle>[1];
}

/** One v3 fact, identity supplied by the caller. */
function fact(id: string, identity: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    subject: "acme",
    predicate: "priced at",
    object: "49",
    validFrom: null,
    validTo: null,
    ingestedAt: "2026-08-06T00:00:00Z",
    invalidatedAt: null,
    extractedAt: null,
    provenance: { actor: "U-a" },
    status: "draft",
    visibleTo: ["org"],
    preWideningVisibleTo: null,
    subjectKey: "acme",
    predicateKey: "priced at",
    objectKey: "49",
    subjectCmp: null,
    objectCmp: null,
    createdAt: "2026-08-06T00:00:00Z",
    updatedAt: "2026-08-06T00:00:00Z",
    ...identity,
  };
}

const identityWarn = (): Captured | undefined =>
  warns.find((w) => w.message.includes("Region import WILL land identity losses"));

describe("the identity-loss line (#5035)", () => {
  it("separates the RULE from the DRIFT, and counts each", async () => {
    const { client } = captureClient();
    await importBundle(
      client,
      bundleWith([
        // The rule working: a store-local id at each position.
        fact("f-1", { subjectCmp: "entity:01JSRC", objectCmp: "entity:01JSRC2" }),
        // Drift: a tag this region does not know, and a payload it cannot read.
        fact("f-2", { objectCmp: "duration:P1Y" }),
        fact("f-3", { objectCmp: "date:2026-02-31" }),
        // Nothing lost — must contribute to neither counter, or the line stops
        // sizing the loss and starts sizing the import.
        fact("f-4", {}),
      ]),
      "org-log",
    );

    const warn = identityWarn();
    expect(warn, "the importer no longer reports identity losses at all").toBeDefined();
    expect(warn!.payload).toMatchObject({
      orgId: "org-log",
      bundleVersion: 3,
      // Two POSITIONS on f-1 — the names carry their unit because the first two
      // count positions (up to two per fact) and the last two count facts.
      storeLocalPositions: 2,
      unreadablePositions: 2,
      unkeyableFacts: 0,
      nullKeyFacts: 0,
    });
    // `unreadable` is the count an operator must act on, so the message has to
    // say what it means rather than leaving the reader to infer it from a
    // number. Asserted because a diagnostic that does not explain itself is
    // indistinguishable from one nobody reads.
    expect(warn!.message).toContain("DRIFT");
  });

  it("reports a v3 fact that ARRIVED unkeyed — the exporter's own drift shape", async () => {
    // The destination-side half of `textOrNull`'s failure. Region A's projection
    // drops `f.subject_key`; every fact exports `null`; this region accepts it
    // (null is legitimate at all five positions) and lands the whole corpus
    // unkeyed. Without this counter the only signal lives in the OTHER region's
    // log stream, and nobody watching the cutover reads it.
    const { client } = captureClient();
    await importBundle(
      client,
      bundleWith([fact("f-1", { subjectKey: null }), fact("f-2", {})]),
      "org-log",
    );
    const warn = identityWarn();
    expect(warn, "a v3 fact arriving with no key is silent").toBeDefined();
    expect(warn!.payload).toMatchObject({ nullKeyFacts: 1, unkeyableFacts: 0 });
  });

  it("says nothing when nothing was lost", async () => {
    // The negative, and it is what keeps the line worth reading: a corpus with
    // no entity ids and no drift must produce NO warn. A line that fires on
    // every import is a line an operator learns to skim, and then the one that
    // mattered is skimmed too.
    const { client } = captureClient();
    await importBundle(
      client,
      bundleWith([fact("f-1", { objectCmp: "money:USD:49" }), fact("f-2", {})]),
      "org-log",
    );
    expect(identityWarn()).toBeUndefined();
  });

  it("counts a legacy surface that normalizes away as `unkeyable`", async () => {
    // The second key writer's parity with the ingest path, which warns about
    // exactly this and calls it "the only signal such a claim ever produces".
    // `___` and `-` normalize to the empty string, and `identityKey` returns
    // null rather than storing a key every other unkeyed row would join.
    const { client } = captureClient();
    const legacy = bundleWith(
      [
        {
          ...fact("f-1", {}),
          subject: "___",
          subjectKey: undefined,
          predicateKey: undefined,
          objectKey: undefined,
          subjectCmp: undefined,
          objectCmp: undefined,
        },
      ],
      2,
    );
    await importBundle(client, legacy, "org-log");

    const warn = identityWarn();
    expect(warn, "a legacy fact whose surface normalizes away is now silent").toBeDefined();
    expect(warn!.payload).toMatchObject({
      storeLocalPositions: 0,
      unreadablePositions: 0,
      unkeyableFacts: 1,
    });
  });

  it("merges the vocabulary BEFORE it reads one to key legacy facts", async () => {
    // The section reorder, pinned as an ORDER rather than as an outcome. The
    // `-pg` test proves the effect (a fact keys through an edge that arrived in
    // the same bundle); this proves the mechanism, and it is the only place the
    // ordering itself is asserted — a reorder is invisible to every assertion
    // about values whenever the destination's vocabulary happens to agree.
    const { client, calls } = captureClient();
    const legacy = bundleWith([{ ...fact("f-1", {}), subjectKey: undefined, predicateKey: undefined, objectKey: undefined, subjectCmp: undefined, objectCmp: undefined }], 2);
    (legacy as unknown as Record<string, unknown>).brainVocabularyEdges = [
      {
        slotPosition: "predicate",
        fromNorm: "priced at",
        toNorm: "unit price",
        approvedBy: null,
        approvedAt: "2026-08-06T00:00:00Z",
      },
    ];
    await importBundle(client, legacy, "org-log");

    const edgeInsert = calls.findIndex((s) => s.includes("INSERT INTO brain_vocabulary_edge"));
    const vocabularyRead = calls.findIndex((s) => s.includes("FROM brain_vocabulary_edge e"));
    const factInsert = calls.findIndex((s) => s.includes("INSERT INTO brain_facts ("));
    expect(edgeInsert, "the vocabulary edges are no longer imported").toBeGreaterThan(-1);
    expect(vocabularyRead, "the legacy arm no longer loads a vocabulary").toBeGreaterThan(-1);
    expect(factInsert, "no fact was inserted").toBeGreaterThan(-1);
    // Merge, then read, then key. Any other order keys against a vocabulary
    // that does not include the decisions arriving in this very bundle.
    expect(edgeInsert).toBeLessThan(vocabularyRead);
    expect(vocabularyRead).toBeLessThan(factInsert);
  });

  it("takes the workspace vocabulary lock before the legacy READ", async () => {
    // The lock is acquired in section 9 only when the bundle carries edges — and
    // a legacy bundle usually carries NONE, since v1/v2 predate the vocabulary.
    // That is precisely the arm that reads it here. Unlocked, this transaction
    // reads the closure at t0; a concurrent `decideAliasProposal` approves,
    // rebuilds and re-keys every row for the workspace, committing before we do
    // — and our rows commit with pre-approval keys, splitting the corpus
    // permanently.
    const { client, calls } = captureClient();
    const legacy = bundleWith([{ ...fact("f-1", {}), subjectKey: undefined, predicateKey: undefined, objectKey: undefined, subjectCmp: undefined, objectCmp: undefined }], 2);
    await importBundle(client, legacy, "org-log");

    const lock = calls.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const vocabularyRead = calls.findIndex((s) => s.includes("FROM brain_vocabulary_edge e"));
    expect(lock, "no advisory lock is taken on the legacy keying path").toBeGreaterThan(-1);
    expect(vocabularyRead).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(vocabularyRead);
  });

  it("neither locks nor reads a vocabulary for a v3 bundle", async () => {
    // The common path pays nothing. Also the negative for the two assertions
    // above: they would pass against an importer that locked and loaded
    // unconditionally, which would serialize every region import in the
    // workspace against every alias approval for no reason.
    const { client, calls } = captureClient();
    await importBundle(client, bundleWith([fact("f-1", {})]), "org-log");
    expect(calls.some((s) => s.includes("FROM brain_vocabulary_edge e"))).toBe(false);
    expect(calls.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(false);
  });
});
