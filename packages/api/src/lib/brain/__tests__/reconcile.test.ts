/**
 * The reconcile stage's decision matrix (#4771, ADR-0036 §T6).
 *
 * These tests drive `reconcileFacts` against an in-memory executor that
 * dispatches on the module's EXPORTED SQL constants — no string parsing, no
 * `mock.module()`, no database. What they pin is the part a real-Postgres test
 * cannot make legible: which failure BLOCKS, which failure FLAGS, and exactly
 * what a reviewer ends up holding. The storage-level claims (the CHECKs, the
 * real transaction rollback, two overlapping reconciles racing for one claim,
 * cross-tenant scoping) live in the `-pg` sibling.
 *
 * The block-vs-flag asymmetry is the reason this file exists at all. Both
 * directions are failure modes with names:
 *   - a SAFETY failure that flags is a leak (a fact nobody can see, or one
 *     nobody can attribute, reaching the review queue as if it were fine);
 *   - a QUALITY failure that blocks is a silent fact-dropper.
 * So every failure class gets a test on the arm it is supposed to take.
 */

import { describe, expect, test } from "bun:test";
import {
  CORROBORATION_LOOKUP_SQL,
  INSERT_FACT_SQL,
  INSERT_PROVENANCE_EDGE_SQL,
  INSERT_TENSION_EDGE_SQL,
  RECONCILE_BLOCK_REASONS,
  RECONCILE_LOCK_SQL,
  TENSION_CANDIDATES_SQL,
  reconcileFacts,
  type EntityResolver,
  type FactCandidate,
  type ReconcileEpisodeRef,
  type ReconcileExecutor,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
import { WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";
import { isWarehouseDerived } from "@atlas/api/lib/brain/correction";

// ---------------------------------------------------------------------------
// A store that answers exactly the six statements the stage issues
// ---------------------------------------------------------------------------

interface StoredFact {
  id: string;
  workspaceId: string;
  subject: string;
  predicate: string;
  object: string;
  provenance: Record<string, unknown>;
  visibleTo: string[];
  cardinality: string;
  validFrom: string | null;
  extractedAt: string | null;
}

interface StoredEdge {
  workspaceId: string;
  edgeType: string;
  fromFactId: string;
  toFactId: string | null;
  toEpisodeId: string | null;
}

class FakeBrainStore {
  readonly facts: StoredFact[] = [];
  readonly edges: StoredEdge[] = [];
  /** Full `pg_advisory_xact_lock` params — the namespace matters as much as the key. */
  readonly locks: unknown[][] = [];
  transactions = 0;
  private seq = 0;

  /** A runner shaped like the real one, so "did anything open a tx?" is testable. */
  readonly runner: ReconcileTransactionRunner = async <T>(
    fn: (tx: ReconcileExecutor) => Promise<T>,
  ): Promise<T> => {
    this.transactions++;
    return fn({ query: (sql, params) => this.query(sql, params ?? []) });
  };

  private async query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: readonly unknown[] }> {
    switch (sql) {
      case RECONCILE_LOCK_SQL: {
        this.locks.push(params);
        return { rows: [] };
      }
      case CORROBORATION_LOOKUP_SQL: {
        const [workspaceId, subject, predicate, object] = params.map(String);
        const hit = this.facts.find(
          (f) =>
            f.workspaceId === workspaceId &&
            f.subject === subject &&
            f.predicate === predicate &&
            f.object === object,
        );
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      case INSERT_FACT_SQL: {
        const id = `fact-${++this.seq}`;
        this.facts.push({
          id,
          workspaceId: String(params[0]),
          subject: String(params[1]),
          predicate: String(params[2]),
          object: String(params[3]),
          validFrom: params[4] === null ? null : String(params[4]),
          extractedAt: params[5] === null ? null : String(params[5]),
          provenance: JSON.parse(String(params[7])) as Record<string, unknown>,
          visibleTo: JSON.parse(String(params[8])) as string[],
          cardinality: String(params[9]),
        });
        return { rows: [{ id }] };
      }
      case INSERT_PROVENANCE_EDGE_SQL: {
        const [workspaceId, fromFactId, toEpisodeId] = params.map(String);
        const exists = this.edges.some(
          (e) =>
            e.edgeType === "provenance" &&
            e.workspaceId === workspaceId &&
            e.fromFactId === fromFactId &&
            e.toEpisodeId === toEpisodeId,
        );
        if (exists) return { rows: [] };
        this.edges.push({
          workspaceId,
          edgeType: "provenance",
          fromFactId,
          toFactId: null,
          toEpisodeId,
        });
        return { rows: [{ id: `edge-${++this.seq}` }] };
      }
      case TENSION_CANDIDATES_SQL: {
        const [workspaceId, subject, predicate, object, selfId] = params.map(String);
        const rivals = this.facts.filter(
          (f) =>
            f.workspaceId === workspaceId &&
            f.subject === subject &&
            f.predicate === predicate &&
            f.object !== object &&
            f.id !== selfId,
        );
        return { rows: rivals.map((f) => ({ id: f.id })) };
      }
      case INSERT_TENSION_EDGE_SQL: {
        const [workspaceId, fromFactId, toFactId] = params.map(String);
        const exists = this.edges.some(
          (e) =>
            e.edgeType === "in-tension-with" &&
            e.fromFactId === fromFactId &&
            e.toFactId === toFactId,
        );
        if (exists) return { rows: [] };
        this.edges.push({
          workspaceId,
          edgeType: "in-tension-with",
          fromFactId,
          toFactId,
          toEpisodeId: null,
        });
        return { rows: [{ id: `edge-${++this.seq}` }] };
      }
      default:
        throw new Error(`FakeBrainStore received an unexpected statement: ${sql}`);
    }
  }
}

const WORKSPACE = "ws-brain";

function episode(overrides: Partial<ReconcileEpisodeRef> = {}): ReconcileEpisodeRef {
  return {
    id: "ep-1",
    workspaceId: WORKSPACE,
    source: "slack",
    sourceId: "C01:1719000000.000100",
    sourceActor: "U123",
    occurredAt: new Date("2026-06-21T09:00:00.000Z"),
    visibleTo: ["org"],
    ...overrides,
  };
}

function candidate(overrides: Partial<FactCandidate> = {}): FactCandidate {
  return {
    subject: "deploy window",
    predicate: "is",
    object: "Thursdays",
    ...overrides,
  };
}

function run(
  store: FakeBrainStore,
  request: Partial<Parameters<typeof reconcileFacts>[0]> = {},
) {
  return reconcileFacts(
    {
      episode: episode(),
      candidates: [candidate()],
      producer: "extraction:v1",
      extractedAt: new Date("2026-06-21T10:00:00.000Z"),
      ...request,
    },
    { withTransaction: store.runner, now: () => new Date("2026-06-21T10:00:01.000Z") },
  );
}

// ---------------------------------------------------------------------------
// BLOCK — safety failures
// ---------------------------------------------------------------------------

describe("block: no usable grant", () => {
  // The load-bearing case. `['everyone']` satisfies
  // `chk_brain_facts_grant_nonempty` (cardinality 1) and grants NOBODY, because
  // enforcement is array overlap against reader tokens. Written as a draft it
  // would be legal, invisible, refused at every publish forever by #4769's
  // GRANT_UNUSABLE classifier, and unrepairable until #4772 ships a repair UI.
  test("blocks a grant the 0180 CHECK admits but no reader can ever match", async () => {
    const store = new FakeBrainStore();
    const report = await run(store, { episode: episode({ visibleTo: ["everyone"] }) });

    expect(report.blocked.NO_GRANT).toBe(1);
    expect(report.created).toBe(0);
    expect(report.outcomes[0]).toEqual({
      kind: "blocked",
      reason: RECONCILE_BLOCK_REASONS.noGrant,
    });
    expect(store.facts).toHaveLength(0);
    // Not merely "wrote nothing" — it must not even open a transaction, since
    // no candidate on this episode can produce a safe row.
    expect(store.transactions).toBe(0);
  });

  test("blocks an empty grant", async () => {
    const store = new FakeBrainStore();
    const report = await run(store, { episode: episode({ visibleTo: [] }) });
    expect(report.blocked.NO_GRANT).toBe(1);
    expect(store.facts).toHaveLength(0);
  });

  test("blocks a grant of only null / empty elements", async () => {
    // `chk_brain_episodes_grant_nonempty` refuses this AT REST, so it cannot
    // arrive from the database. It can arrive from an entry point that has not
    // stored anything yet — a write-back proposal, a human correction being
    // pre-flighted — which is exactly the caller class this stage is built to
    // be agnostic about. `parseGrant` counts the elements as malformed rather
    // than throwing; either way nobody can read the result.
    const store = new FakeBrainStore();
    const report = await run(store, { episode: episode({ visibleTo: [null, ""] }) });
    expect(report.blocked.NO_GRANT).toBe(1);
  });

  test("proceeds when one usable principal sits beside a malformed one", async () => {
    // The rule is "at least one principal a reader could match", not "every
    // token is well-formed" — the inert token is carried through verbatim and
    // simply matches nothing.
    const store = new FakeBrainStore();
    const report = await run(store, {
      episode: episode({ visibleTo: ["everyone", "user:u-1"] }),
    });
    expect(report.created).toBe(1);
    expect(store.facts[0]?.visibleTo).toEqual(["everyone", "user:u-1"]);
  });
});

describe("block: unattributable claim", () => {
  test("blocks when neither the caller nor the episode names a source principal", async () => {
    const store = new FakeBrainStore();
    const report = await run(store, { episode: episode({ sourceActor: null }) });

    expect(report.blocked.SOURCE_PRINCIPAL_UNRESOLVED).toBe(1);
    expect(store.transactions).toBe(0);
  });

  test("blocks on a whitespace-only source actor", async () => {
    const store = new FakeBrainStore();
    const report = await run(store, { episode: episode({ sourceActor: "   " }) });
    expect(report.blocked.SOURCE_PRINCIPAL_UNRESOLVED).toBe(1);
  });

  test("an explicit sourcePrincipal covers an actorless episode", async () => {
    // The entry-point-agnostic half: a warehouse snapshot has no `source_actor`
    // (0180) and its caller supplies the system principal instead. Without this
    // arm, every non-chat entry point would be permanently blocked.
    const store = new FakeBrainStore();
    const report = await run(store, {
      episode: episode({ sourceActor: null, source: WAREHOUSE_SOURCE }),
      sourcePrincipal: "system:warehouse",
    });

    expect(report.created).toBe(1);
    expect(store.facts[0]?.provenance.actor).toBe("system:warehouse");
    // The PRODUCER half of tier-1 refusal (#4938). This module copies
    // `episode.source` verbatim into `provenance.source`, and `correction.ts`
    // reads that payload back to decide a warehouse-derived fact has no
    // correction path at all. Asserting the predicate HERE — against the value
    // this module actually wrote, not a literal the correction suite
    // hand-seeds — is what makes the two sides one fact rather than a
    // coincidence between two strings. Without it, a warehouse connector
    // naming its class after the vendor would fail the ADR invariant open with
    // every test still green.
    expect(store.facts[0]?.provenance.source).toBe(WAREHOUSE_SOURCE);
    expect(isWarehouseDerived(store.facts[0]?.provenance)).toBe(true);
  });

  test("the episode's actor is namespaced by source", async () => {
    // `U123` is only meaningful next to the source that minted it — two
    // vendors can both hand out `U123`.
    const store = new FakeBrainStore();
    await run(store);
    expect(store.facts[0]?.provenance.actor).toBe("slack:U123");
  });
});

describe("block: no provenance", () => {
  test("blocks an episode with no id", async () => {
    const store = new FakeBrainStore();
    const report = await run(store, { episode: episode({ id: "  " }) });
    expect(report.blocked.NO_PROVENANCE).toBe(1);
    expect(store.transactions).toBe(0);
  });
});

describe("block: malformed claim", () => {
  test("blocks a candidate with a blank column and still writes its siblings", async () => {
    // Per-candidate, not per-episode: one bad triple from a producer must not
    // cost the good ones, which is the same per-record isolation the ingest
    // core applies to episodes.
    const store = new FakeBrainStore();
    const report = await run(store, {
      candidates: [
        candidate({ object: "   " }),
        candidate({ subject: "release train", object: "weekly" }),
      ],
    });

    expect(report.blocked.MALFORMED_CLAIM).toBe(1);
    expect(report.created).toBe(1);
    expect(store.facts).toHaveLength(1);
    expect(store.facts[0]?.subject).toBe("release train");
  });
});

// ---------------------------------------------------------------------------
// FLAG — quality failures
// ---------------------------------------------------------------------------

describe("flag: entity resolution", () => {
  const failingResolver: EntityResolver = (surface, { role }) =>
    role === "object" ? null : { canonical: surface };

  test("an unresolved object is written as a provisional draft, never dropped", async () => {
    const store = new FakeBrainStore();
    const report = await run(store, { resolveEntity: failingResolver });

    expect(report.created).toBe(1);
    expect(report.provisional).toBe(1);
    expect(report.outcomes[0]).toMatchObject({ kind: "created", provisional: true });

    const fact = store.facts[0];
    expect(fact).toBeDefined();
    // The reviewer needs to know WHICH side is unsettled — "provisional" alone
    // would send them re-reading both.
    expect(fact?.provenance.provisional).toBe(true);
    expect(fact?.provenance.unresolved).toEqual(["object"]);
    // And the unresolved surface form is preserved, so there is something to
    // resolve rather than a hole.
    expect(fact?.object).toBe("Thursdays");
  });

  test("a resolver that THROWS flags rather than blocking the episode", async () => {
    // A resolver is injected code — a future one will call a store and can time
    // out. Letting the throw escape would turn a quality failure into a block
    // for every candidate on the episode, inverting the asymmetry.
    const store = new FakeBrainStore();
    const report = await run(store, {
      resolveEntity: () => {
        throw new Error("entity store unreachable");
      },
    });

    expect(report.created).toBe(1);
    expect(report.provisional).toBe(1);
    expect(store.facts[0]?.provenance.unresolved).toEqual(["subject", "object"]);
  });

  test("the default resolver marks nothing provisional", async () => {
    const store = new FakeBrainStore();
    const report = await run(store);
    expect(report.provisional).toBe(0);
    expect(store.facts[0]?.provenance.provisional).toBeUndefined();
  });

  test("a resolver's canonical form is what lands in the fact", async () => {
    const store = new FakeBrainStore();
    await run(store, {
      resolveEntity: (surface, { role }) =>
        role === "subject" ? { canonical: "Deploy Window", entityId: "e-7" } : { canonical: surface },
    });

    expect(store.facts[0]?.subject).toBe("Deploy Window");
    expect(store.facts[0]?.provenance.entityIds).toEqual({ subject: "e-7" });
  });
});

// ---------------------------------------------------------------------------
// Corroboration
// ---------------------------------------------------------------------------

describe("corroboration", () => {
  test("re-observing a claim strengthens it instead of duplicating it", async () => {
    const store = new FakeBrainStore();
    await run(store);
    const second = await run(store, {
      episode: episode({ id: "ep-2", sourceId: "C01:1719000900.000200" }),
    });

    expect(second.created).toBe(0);
    expect(second.corroborated).toBe(1);
    expect(second.outcomes[0]).toMatchObject({ kind: "corroborated", evidenceAdded: true });
    // One belief…
    expect(store.facts).toHaveLength(1);
    // …with two pieces of evidence behind it.
    expect(store.edges.filter((e) => e.edgeType === "provenance")).toHaveLength(2);
  });

  test("re-running the SAME episode adds no second evidence edge", async () => {
    // This is what makes `extract.ts`'s work-then-stamp ordering safe: a crash
    // between the reconcile commit and the queue stamp costs a repeated model
    // call and nothing else.
    const store = new FakeBrainStore();
    await run(store);
    const again = await run(store);

    expect(again.corroborated).toBe(1);
    expect(again.outcomes[0]).toMatchObject({ evidenceAdded: false });
    expect(store.facts).toHaveLength(1);
    expect(store.edges.filter((e) => e.edgeType === "provenance")).toHaveLength(1);
  });

  test("corroboration never rewrites the existing fact's grant", async () => {
    // Grants are immutable per fact version (0180): a wider re-observation is
    // evidence, not a promotion to a wider audience.
    const store = new FakeBrainStore();
    await run(store, { episode: episode({ visibleTo: ["audience:chat-channel:slack:C1"] }) });
    await run(store, { episode: episode({ id: "ep-2", visibleTo: ["org"] }) });

    expect(store.facts).toHaveLength(1);
    expect(store.facts[0]?.visibleTo).toEqual(["audience:chat-channel:slack:C1"]);
  });
});

// ---------------------------------------------------------------------------
// Advisory contradiction
// ---------------------------------------------------------------------------

describe("advisory contradiction edges", () => {
  test("a single-cardinality predicate with a rival object earns an in-tension-with edge", async () => {
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [
        candidate({ subject: "Ada", predicate: "reports to", object: "Grace", predicateCardinality: "single" }),
      ],
    });
    const second = await run(store, {
      episode: episode({ id: "ep-2" }),
      candidates: [
        candidate({ subject: "Ada", predicate: "reports to", object: "Alan", predicateCardinality: "single" }),
      ],
    });

    expect(second.outcomes[0]).toMatchObject({ kind: "created", tensionEdges: 1 });
    // Both beliefs survive — nothing is superseded, invalidated, or ranked.
    // M2 owns arbitration; this edge only makes the conflict visible.
    expect(store.facts).toHaveLength(2);
    expect(store.edges.filter((e) => e.edgeType === "in-tension-with")).toHaveLength(1);
  });

  test("multi-cardinality values coexist with no tension edge", async () => {
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ subject: "Ada", predicate: "knows", object: "Ada-lang" })] });
    await run(store, {
      episode: episode({ id: "ep-2" }),
      candidates: [candidate({ subject: "Ada", predicate: "knows", object: "Fortran" })],
    });

    expect(store.edges.filter((e) => e.edgeType === "in-tension-with")).toHaveLength(0);
  });

  test("cardinality defaults to the conservative arm", async () => {
    const store = new FakeBrainStore();
    await run(store);
    expect(store.facts[0]?.cardinality).toBe("multi");
  });
});

// ---------------------------------------------------------------------------
// The candidate a reviewer receives
// ---------------------------------------------------------------------------

describe("the draft candidate", () => {
  test("carries provenance, grant, evidence edge, and validity in one pass", async () => {
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ validFrom: new Date("2026-06-01T00:00:00.000Z") })],
    });

    const fact = store.facts[0];
    expect(fact?.provenance).toMatchObject({
      source: "slack",
      sourceId: "C01:1719000000.000100",
      episodeId: "ep-1",
      actor: "slack:U123",
      producer: "extraction:v1",
      occurredAt: "2026-06-21T09:00:00.000Z",
      extractedAt: "2026-06-21T10:00:00.000Z",
    });
    expect(fact?.visibleTo).toEqual(["org"]);
    expect(fact?.validFrom).toBe("2026-06-01T00:00:00.000Z");
    expect(store.edges).toEqual([
      {
        workspaceId: WORKSPACE,
        edgeType: "provenance",
        fromFactId: fact?.id ?? "",
        toFactId: null,
        toEpisodeId: "ep-1",
      },
    ]);
  });

  test("a producer's detail enriches provenance but cannot overwrite it", async () => {
    // Producer detail is merged UNDER the structural keys on purpose: a
    // confused (or hostile) producer must not be able to restate where the
    // claim came from.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [
        candidate({ detail: { model: "some-model", confidence: 0.4, actor: "spoofed", episodeId: "elsewhere" } }),
      ],
    });

    expect(store.facts[0]?.provenance).toMatchObject({
      model: "some-model",
      confidence: 0.4,
      actor: "slack:U123",
      episodeId: "ep-1",
    });
  });

  test("an invalid validFrom degrades to null rather than throwing mid-transaction", async () => {
    const store = new FakeBrainStore();
    const report = await run(store, { candidates: [candidate({ validFrom: new Date("nonsense") })] });

    expect(report.created).toBe(1);
    expect(store.facts[0]?.validFrom).toBeNull();
  });

  test("every write for one episode happens inside a single transaction, under the workspace lock", async () => {
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate(), candidate({ object: "Fridays" }), candidate({ object: "Mondays" })],
    });

    expect(store.transactions).toBe(1);
    // The NAMESPACE is asserted, not just the key: `4771` is what keeps a
    // reconcile from serializing behind an unrelated per-workspace guard, and
    // four sibling files now record that the seven two-arg namespaces are
    // pairwise distinct. Swapping it for another guard's number must fail here.
    expect(store.locks).toEqual([[4771, WORKSPACE]]);
    expect(store.facts).toHaveLength(3);
  });

  test("outcomes come back in input order, one per candidate", async () => {
    // #4772's review surface will zip this against what it submitted; a report
    // that silently compacted the blocked entries would misattribute every
    // verdict after the first refusal.
    const store = new FakeBrainStore();
    const report = await run(store, {
      candidates: [candidate({ predicate: "   " }), candidate(), candidate({ object: "Fridays" })],
    });

    expect(report.outcomes.map((o) => o.kind)).toEqual(["blocked", "created", "created"]);
  });

  test("a failed provenance edge takes the fact down with it", async () => {
    // "A fact never exists without its evidence pointer" is the criterion, and
    // it is one `try/catch` away from being false: swallowing the edge failure
    // to 'avoid losing the fact' would write precisely the no-provenance row
    // the rule forbids, and every other test here would stay green.
    const store = new FakeBrainStore();
    const failing: ReconcileTransactionRunner = async (fn) =>
      fn({
        query: async (sql, params) => {
          if (sql === INSERT_PROVENANCE_EDGE_SQL) throw new Error("edge insert failed");
          return store.runner((tx) => tx.query(sql, params ?? []));
        },
      });

    await expect(
      reconcileFacts(
        {
          episode: episode(),
          candidates: [candidate()],
          producer: "extraction:v1",
          extractedAt: new Date(),
        },
        { withTransaction: failing },
      ),
    ).rejects.toThrow("edge insert failed");
  });

  test("identity is byte-exact — canonicalizing is the resolver's job, not this stage's", async () => {
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ subject: "Alice" })] });
    await run(store, {
      episode: episode({ id: "ep-2" }),
      candidates: [candidate({ subject: "alice" })],
    });

    // Two facts, not one. A `lower()` comparison here would quietly take the
    // "are these the same entity?" decision away from the seam that exists to
    // make it — and make it globally, for every workspace, with no reviewer.
    expect(store.facts).toHaveLength(2);
  });

  test("surrounding whitespace is trimmed, so it never forks a claim", async () => {
    const store = new FakeBrainStore();
    await run(store);
    const second = await run(store, {
      episode: episode({ id: "ep-2" }),
      candidates: [candidate({ subject: "  deploy window  ", object: " Thursdays " })],
    });

    expect(second.corroborated).toBe(1);
    expect(store.facts).toHaveLength(1);
  });

  test("corroboration is scoped to the workspace", async () => {
    const store = new FakeBrainStore();
    await run(store);
    const other = await run(store, {
      episode: episode({ id: "ep-2", workspaceId: "ws-other" }),
    });

    // Same claim, different tenant — a corroboration across that line would be
    // a cross-tenant read dressed as a dedupe.
    expect(other.created).toBe(1);
    expect(store.facts).toHaveLength(2);
  });

  test("no candidates is a no-op, not an empty transaction", async () => {
    const store = new FakeBrainStore();
    const report = await run(store, { candidates: [] });

    expect(report).toMatchObject({ created: 0, corroborated: 0, provisional: 0 });
    expect(store.transactions).toBe(0);
  });
});

describe("no autonomous supersession (#4912)", () => {
  const EVERY_RECONCILE_SQL = {
    RECONCILE_LOCK_SQL,
    CORROBORATION_LOOKUP_SQL,
    INSERT_FACT_SQL,
    INSERT_PROVENANCE_EDGE_SQL,
    TENSION_CANDIDATES_SQL,
    INSERT_TENSION_EDGE_SQL,
  };

  test("this stage issues no UPDATE at all — it cannot stamp valid_to by construction", () => {
    // "A human promotion stamps `valid_to`; there is no autonomous
    // supersession" (ADR-0036 §Temporal). The strongest available pin: the
    // unattended ingest stage has no UPDATE statement to smuggle a stamp into,
    // so acquiring one is a deliberate decision that has to argue with this
    // test — and with `check-brain-fact-promotion.sh`, which now refuses
    // UPDATE-shape writes to the column outside its allowlisted
    // publish/import files.
    for (const [name, sql] of Object.entries(EVERY_RECONCILE_SQL)) {
      expect(`${name}: ${sql}`).not.toMatch(/\bUPDATE\b/i);
    }
  });

  test("the fact INSERT names valid_from and never valid_to", () => {
    // A producer may know when a claim BEGAN; only the publish gate (and later
    // `correct_fact`) may close a window.
    expect(INSERT_FACT_SQL).toContain("valid_from");
    expect(INSERT_FACT_SQL).not.toContain("valid_to");
  });

  test("corroboration targets only CURRENT facts — a superseded row never absorbs a re-observation", () => {
    // Without `valid_to IS NULL`, re-asserting a superseded claim would
    // strengthen a row every as-of-now read hides: the world's flip back to
    // the old value would be swallowed invisibly instead of minting a fresh
    // draft the publish gate can arbitrate.
    expect(CORROBORATION_LOOKUP_SQL).toContain("valid_to IS NULL");
  });

  test("tension edges target only CURRENT rivals — settled history is not a contradiction", () => {
    expect(TENSION_CANDIDATES_SQL).toContain("valid_to IS NULL");
  });
});
