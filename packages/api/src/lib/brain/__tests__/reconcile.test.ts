/**
 * The reconcile stage's decision matrix (#4771, ADR-0036 §T6).
 *
 * These tests drive `reconcileFacts` against an in-memory executor that
 * dispatches on the module's EXPORTED SQL constants — no string parsing, no
 * `mock.module()`, no database. What they pin is the part a real-Postgres test
 * cannot make legible: which failure BLOCKS, which failure FLAGS, and exactly
 * what a reviewer ends up holding. The storage-level claims (the CHECKs, the
 * real transaction rollback, two overlapping reconciles racing for one claim,
 * cross-tenant scoping) live in the `-pg` siblings — `extract-reconcile-pg` for
 * the stage, and `identity-consumers-pg` for claim identity (see below).
 *
 * The block-vs-flag asymmetry is the reason this file exists at all. Both
 * directions are failure modes with names:
 *   - a SAFETY failure that flags is a leak (a fact nobody can see, or one
 *     nobody can attribute, reaching the review queue as if it were fine);
 *   - a QUALITY failure that blocks is a silent fact-dropper.
 * So every failure class gets a test on the arm it is supposed to take.
 *
 * ## ⚠️ What a green run here does NOT mean (#5021, ADR-0037 §9)
 *
 * It does not mean claim identity works. This file cannot see identity and no
 * longer pretends to: the store below dispatches on each SQL constant's string
 * IDENTITY and reads its binds POSITIONALLY, so it cannot tell which COLUMNS a
 * statement names, and it stopped deciding which stored fact shares a slot with
 * an incoming candidate. What survives here is the half that is genuinely
 * unit-visible — **which values the stage BINDS to the key positions**, and what
 * it does with a lookup result once it has one.
 *
 * *Does this pair of claims collide?* is answered in
 * `identity-consumers-pg.test.ts`, where eight claim pairs are read by all three
 * consumers — corroboration, the rival scan, and the publish gate's collision
 * join — against a real schema. The lexical backstop at the bottom of this file
 * is the cheap tripwire for a repoint, not the proof.
 *
 * That narrowing is the intended outcome and not a regression. Before it, every
 * BEHAVIOURAL test here stayed green against a `reconcile.ts` whose lookups had
 * been repointed at the surface columns — only the backstop, which greps the
 * statement text, caught it. That is the exact defect the identity slice exists
 * to fix.
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
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";
import { isWarehouseDerived } from "@atlas/api/lib/brain/correction";

// ---------------------------------------------------------------------------
// A store that RECORDS the six statements the stage issues — and answers no
// identity question it cannot prove (#5021, the map's T7 §4)
// ---------------------------------------------------------------------------
//
// This fake used to decide, in TypeScript, which stored fact was in the same
// slot as an incoming candidate. That made the file a green light for a property
// it could not see: it dispatches on each SQL constant's string IDENTITY and
// reads the binds POSITIONALLY, so it cannot tell which COLUMNS a statement
// names. Repointing `CORROBORATION_LOOKUP_SQL` back at the surface columns left
// every BEHAVIOURAL test here passing — verified by mutation, and the defect
// #5021 exists to retire. (The lexical backstop at the bottom of the file greps
// the statement text and does catch that one; it is a tripwire, not a proof.)
//
// So the two lookups no longer answer. What the store keeps is what it can
// honestly prove: the statement was issued, in this order, with these binds.
// A test that needs a lookup to HIT declares that — `corroborateWith`,
// `scriptRivals` — as a premise about the world, and then asserts what the
// STAGE does about it. Which claims actually share a slot is a question about
// SQL against a real schema, and it lives in `identity-consumers-pg.test.ts`,
// where eight claim pairs are read by all three consumers.
//
// The two edge inserts still model their `NOT EXISTS` guards. That is a
// deliberate line, not an oversight: those guards compare opaque uuids for
// exact equality, with no normalization and no identity layer anywhere in them,
// so a JS reimplementation cannot masquerade as identity coverage the way the
// slot lookups did. The PROVENANCE edge's guard is pinned against a real schema
// in `extract-reconcile-pg.test.ts` ("re-running over an already-extracted
// window is a no-op"); the tension edge's dedupe arm is not pinned anywhere.

interface StoredFact {
  id: string;
  workspaceId: string;
  subject: string;
  predicate: string;
  object: string;
  /**
   * What the stage bound to the key columns (#5020) — a RECORDING, read back by
   * the tests below, never matched on. Kept separate from the surfaces because
   * a fake that re-derived a key from the stored surface could not tell a stage
   * that keys its rows from one that does not.
   */
  slot: SlotBinds;
  provenance: Record<string, unknown>;
  visibleTo: string[];
  cardinality: string;
  validFrom: string | null;
  extractedAt: string | null;
}

interface SlotBinds {
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly object: string | null;
}

/**
 * Three consecutive key binds, read positionally — `null` stays `null` rather
 * than becoming `"null"` through `String()`, which is the whole distinction
 * these tests are about.
 */
function keyParams(params: readonly unknown[], from: number): SlotBinds {
  const at = (i: number): string | null => {
    const v = params[from + i];
    return v === null || v === undefined ? null : String(v);
  };
  return { subject: at(0), predicate: at(1), object: at(2) };
}

/**
 * The six statements the stage issues, as a CLOSED domain.
 *
 * The accessors below take a name from this record rather than a raw SQL string.
 * That is not ceremony: the tension block asserts that a statement was NOT
 * issued (`bindsFor("tensionScan")` against a captured baseline), and with a
 * `string` parameter, passing `INSERT_TENSION_EDGE_SQL` where
 * `TENSION_CANDIDATES_SQL` was meant —
 * one word apart, both imported here — type-checks and passes vacuously. That is
 * the same "green against a property it cannot see" failure this whole file was
 * rewritten to retire, and it would have been reintroduced at the accessor.
 *
 * `keyOffset` lives here too, because the position at which a statement's three
 * key binds start is a property OF the statement, not of each call site. Restated
 * at each call site it is one more chance, per site, to read the adjacent
 * binds instead — and the store itself reads it for the INSERT recording below.
 */
const STATEMENTS = {
  lock: { sql: RECONCILE_LOCK_SQL },
  corroboration: { sql: CORROBORATION_LOOKUP_SQL, keyOffset: 1 },
  insertFact: { sql: INSERT_FACT_SQL, keyOffset: 10 },
  provenanceEdge: { sql: INSERT_PROVENANCE_EDGE_SQL },
  tensionScan: { sql: TENSION_CANDIDATES_SQL, keyOffset: 1 },
  tensionEdge: { sql: INSERT_TENSION_EDGE_SQL },
} as const;

type StatementName = keyof typeof STATEMENTS;

/** The three statements that carry slot keys — the only ones `keyBindsFor` accepts. */
type KeyedStatementName = {
  [K in StatementName]: (typeof STATEMENTS)[K] extends { keyOffset: number } ? K : never;
}[StatementName];

interface StoredEdge {
  workspaceId: string;
  edgeType: string;
  fromFactId: string;
  toFactId: string | null;
  toEpisodeId: string | null;
}

interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

class FakeBrainStore {
  /** Every statement the stage issued, in order, with its binds. THE recording. */
  readonly calls: RecordedCall[] = [];
  readonly facts: StoredFact[] = [];
  readonly edges: StoredEdge[] = [];
  /** Full `pg_advisory_xact_lock` params — the namespace matters as much as the key. */
  readonly locks: unknown[][] = [];
  transactions = 0;
  /**
   * The id `CORROBORATION_LOOKUP_SQL` returns, or `null` for no hit.
   *
   * A PREMISE the test states, not a conclusion the fake reaches: "suppose the
   * lookup finds this row". Whether it would is `identity-consumers-pg`'s
   * question.
   *
   * ⚠️ STICKY for the store's lifetime — every later reconcile against the same
   * store corroborates too. Set it through {@link corroborateWith}, which is
   * also what stops a phantom id naming a fact that was never written.
   */
  private corroborationHit: string | null = null;
  /** Likewise for `TENSION_CANDIDATES_SQL`; set through {@link scriptRivals}. */
  private rivalIds: readonly string[] = [];
  private seq = 0;

  /**
   * "Suppose the corroboration lookup comes back with this row."
   *
   * Takes the RECORDED fact rather than a bare id, so a premise can only name a
   * row the stage actually wrote — a phantom id would have the stage attach a
   * provenance edge to a fact that does not exist, and the fake would happily
   * record it.
   */
  corroborateWith(fact: StoredFact | undefined): void {
    if (fact === undefined) throw new Error("corroborateWith: no such fact was recorded");
    this.corroborationHit = fact.id;
  }

  /** "Suppose the rival scan comes back with these rows." */
  scriptRivals(first: StoredFact | undefined, ...rest: (StoredFact | undefined)[]): void {
    this.rivalIds = [first, ...rest].map((fact) => {
      if (fact === undefined) throw new Error("scriptRivals: no such fact was recorded");
      return fact.id;
    });
  }

  /** The binds of every call to one statement, in order. */
  bindsFor(name: StatementName): readonly (readonly unknown[])[] {
    const { sql } = STATEMENTS[name];
    return this.calls.filter((c) => c.sql === sql).map((c) => c.params);
  }

  /** The slot keys the stage bound to one statement's key positions. */
  keyBindsFor(name: KeyedStatementName): readonly SlotBinds[] {
    const statement = STATEMENTS[name];
    return this.bindsFor(name).map((params) => keyParams(params, statement.keyOffset));
  }

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
    this.calls.push({ sql, params });
    switch (sql) {
      case STATEMENTS.lock.sql: {
        this.locks.push(params);
        return { rows: [] };
      }
      case STATEMENTS.corroboration.sql: {
        return { rows: this.corroborationHit === null ? [] : [{ id: this.corroborationHit }] };
      }
      case STATEMENTS.insertFact.sql: {
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
          slot: keyParams(params, STATEMENTS.insertFact.keyOffset),
        });
        return { rows: [{ id }] };
      }
      case STATEMENTS.provenanceEdge.sql: {
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
      case STATEMENTS.tensionScan.sql: {
        // `id <> $5` is the ONE arm still applied here, and it is not identity:
        // it is the statement refusing to return the row the stage just wrote,
        // compared by uuid. Modelling it keeps a scripted rival list from
        // producing a self-edge the real query cannot produce.
        const selfId = String(params[4]);
        return { rows: this.rivalIds.filter((id) => id !== selfId).map((id) => ({ id })) };
      }
      case STATEMENTS.tensionEdge.sql: {
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
      // Defaulted in the HELPER, not in the production type — the field is
      // required there on purpose (`identity.ts`, "`alias` is REQUIRED").
      vocabulary: identityVocabulary,
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
    // The row has to EXIST for its missing flag to mean anything — a stage that
    // wrote nothing also has no provisional fact.
    expect(store.facts).toHaveLength(1);
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
  // Every test here states the lookup's answer as a PREMISE — "suppose the
  // corroboration lookup comes back with this row" — and asserts what the stage
  // then does. Whether a given pair of claims SHOULD produce that hit is a
  // question about SQL columns against a real schema, and it is asked over one
  // eight-pair corpus in `identity-consumers-pg.test.ts`.

  test("a lookup hit strengthens the existing belief instead of duplicating it", async () => {
    const store = new FakeBrainStore();
    await run(store);
    store.corroborateWith(store.facts[0]);

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

  test("a lookup MISS mints a fresh draft rather than silently dropping the claim", async () => {
    // The other arm, and the one that makes the test above mean something: with
    // no hit the stage must still write. A `corroborated` that fell through to
    // nothing would lose the claim entirely.
    const store = new FakeBrainStore();
    await run(store);

    const second = await run(store, { episode: episode({ id: "ep-2" }) });

    expect(second.created).toBe(1);
    expect(second.corroborated).toBe(0);
    expect(store.facts).toHaveLength(2);
  });

  test("re-running the SAME episode adds no second evidence edge", async () => {
    // This is what makes `extract.ts`'s work-then-stamp ordering safe: a crash
    // between the reconcile commit and the queue stamp costs a repeated model
    // call and nothing else. The guard is `INSERT … NOT EXISTS` on
    // `(workspace, fact, episode)` — uuid equality, no identity layer in it.
    const store = new FakeBrainStore();
    await run(store);
    store.corroborateWith(store.facts[0]);

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
    store.corroborateWith(store.facts[0]);

    await run(store, { episode: episode({ id: "ep-2", visibleTo: ["org"] }) });

    expect(store.facts).toHaveLength(1);
    expect(store.facts[0]?.visibleTo).toEqual(["audience:chat-channel:slack:C1"]);
  });

  test("the lookup's first bind is the episode's workspace", async () => {
    // `workspace_id = $1`. Dropping it from the statement turns a dedupe into a
    // cross-tenant read — tenant B's re-observation attaching a provenance edge
    // to tenant A's fact — and this file can only prove the PARAMETER is passed.
    // That the SQL text still names the column is
    // `extract-reconcile-pg.test.ts`'s ("keeps corroboration inside the tenant").
    const store = new FakeBrainStore();
    await run(store, { episode: episode({ workspaceId: "ws-other" }) });

    expect(store.bindsFor("corroboration").map((p) => p[0])).toEqual(["ws-other"]);
  });
});

// ---------------------------------------------------------------------------
// Advisory contradiction
// ---------------------------------------------------------------------------

describe("advisory contradiction edges", () => {
  const single = { subject: "Ada", predicate: "reports to", predicateCardinality: "single" } as const;

  test("a rival the scan returns earns an in-tension-with edge", async () => {
    // Premise: the scan comes back with a rival. WHICH rows it would come back
    // with is `identity-consumers-pg`'s `rival-through-phrasing` case.
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ ...single, object: "Grace" })] });
    store.scriptRivals(store.facts[0]);

    const second = await run(store, {
      episode: episode({ id: "ep-2" }),
      candidates: [candidate({ ...single, object: "Alan" })],
    });

    expect(second.outcomes[0]).toMatchObject({ kind: "created", tensionEdges: 1 });
    // Both beliefs survive — nothing is superseded, invalidated, or ranked.
    // M2 owns arbitration; this edge only makes the conflict visible.
    expect(store.facts).toHaveLength(2);
    expect(store.edges.filter((e) => e.edgeType === "in-tension-with")).toHaveLength(1);
  });

  test("a non-single predicate never even ISSUES the rival scan", async () => {
    // Stronger than "no edge appeared", and it is the arm a scripted store can
    // still prove outright: the stage does not reach the statement at all, so no
    // rival list could produce an edge however the scan behaved. Scripted with a
    // REAL rival standing by, so the refusal is the cardinality gate rather than
    // an empty world.
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ ...single, object: "Grace" })] });
    store.scriptRivals(store.facts[0]);
    const scansAfterSetup = store.bindsFor("tensionScan").length;

    await run(store, {
      episode: episode({ id: "ep-2" }),
      candidates: [
        candidate({ subject: "Ada", predicate: "reports to", object: "Alan", predicateCardinality: "multi" }),
      ],
    });

    expect(store.bindsFor("tensionScan")).toHaveLength(scansAfterSetup);
    expect(store.edges.filter((e) => e.edgeType === "in-tension-with")).toHaveLength(0);
  });

  test("an empty rival scan writes no edge", async () => {
    // The prohibition's positive control is the first test in this block: with
    // the scan issued and coming back empty, the stage must write nothing.
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ ...single, object: "Grace" })] });

    expect(store.bindsFor("tensionScan")).toHaveLength(1);
    expect(store.edges.filter((e) => e.edgeType === "in-tension-with")).toHaveLength(0);
  });

  test("the scan binds the row just written as its own self-exclusion", async () => {
    // `id <> $5`. Without it every `single` fact earns a self-edge the moment it
    // lands, and the review queue fills with claims contradicting themselves.
    // The BIND is what this file can prove; that the statement still spells the
    // arm is the lexical backstop at the bottom.
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ ...single, object: "Grace" })] });

    const binds = store.bindsFor("tensionScan");
    expect(binds, "the rival scan was never issued").toHaveLength(1);
    expect(binds[0]![4]).toBe(store.facts[0]!.id);
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
          vocabulary: identityVocabulary,
          episode: episode(),
          candidates: [candidate()],
          producer: "extraction:v1",
          extractedAt: new Date(),
        },
        { withTransaction: failing },
      ),
    ).rejects.toThrow("edge insert failed");
  });

  test("the stage keys its binds off the surfaces — every slot, every statement (#5020)", async () => {
    // The bind half of claim identity, which IS unit-visible: swapping
    // `item.keys.*` back to the surface fields turns this red. `Deploy_Window` /
    // `Ships  On` differ from their norms in case AND separator, which is the
    // whole of `lexicalNorm`.
    //
    // The COLUMN half — that the two lookups still NAME the key columns — this
    // file structurally cannot see (see the header). It is proven in
    // `identity-consumers-pg.test.ts` against a real schema, with the lexical
    // tripwire at the bottom of this file as the cheap local backstop.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [
        // `single`, so the rival scan is REACHED — at `multi` the stage skips it
        // and this test would silently assert two of the three statements.
        candidate({
          subject: "Deploy_Window",
          predicate: "Ships  On",
          object: "Thursdays",
          predicateCardinality: "single",
        }),
      ],
    });

    const keyed = { subject: "deploy window", predicate: "ships on", object: "thursdays" };
    // All three statements that carry keys agree, and each is asserted: an
    // INSERT keyed correctly beside a lookup keyed off the raw surface would
    // write rows nothing can ever find.
    expect(store.keyBindsFor("insertFact")[0]).toEqual(keyed);
    expect(store.keyBindsFor("corroboration")[0]).toEqual(keyed);
    expect(store.keyBindsFor("tensionScan")[0]).toEqual(keyed);
    // The RETAINED surface is untouched — identity moved, the record of what
    // the producer actually said did not.
    expect(store.facts[0]).toMatchObject({ subject: "Deploy_Window", predicate: "Ships  On" });
  });

  test("keys are derived AFTER entity resolution, off the surface actually stored", async () => {
    // A key must describe the row that was written. Deriving it from the raw
    // candidate would key a fact under a name that appears nowhere in it — and
    // every resolved fact would then be unreachable by its own identity.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ subject: "deploy-01" })],
      resolveEntity: (surface, { role }) =>
        role === "subject" ? { canonical: "The Deploy Box" } : { canonical: surface },
    });

    expect(store.facts[0]?.subject).toBe("The Deploy Box");
    expect(store.keyBindsFor("insertFact")[0]).toMatchObject({ subject: "the deploy box" });
  });

  test("the workspace's vocabulary reaches every slot", async () => {
    // The vocabulary seam, through the stage. Without this the whole threading
    // is unfalsifiable: the default IS the empty vocabulary, so dropping
    // `request.vocabulary` — or dropping the second argument at the three
    // `slotKey` calls — changes nothing observable and leaves the suite green.
    //
    // #5000's pair, closed by an ENTRY rather than by a normalization rule,
    // which is the whole reason the seam exists (ADR-0037 §6 / #5016). That the
    // pair does NOT collide without one is the corpus's `copula-pair` entry.
    const store = new FakeBrainStore();
    const vocabulary = {
      ...identityVocabulary,
      predicate: (norm: string): string => (norm === "is priced at" ? "priced at" : norm),
    };

    await run(store, {
      vocabulary,
      candidates: [candidate({ predicate: "Is_Priced At" })],
    });

    // The aliased slot is what both the INSERT and the lookup carry…
    expect(store.keyBindsFor("insertFact")[0]).toMatchObject({ predicate: "priced at" });
    expect(store.keyBindsFor("corroboration")[0]).toMatchObject({ predicate: "priced at" });
    // …the PREDICATE slot, not only the entity-resolved sides…
    expect(store.facts[0]?.slot).toMatchObject({ predicate: "priced at" });
    // …and the surface the producer emitted is still what the row records.
    expect(store.facts[0]?.predicate).toBe("Is_Priced At");
  });

  test("a predicate-position vocabulary does not reach the subject or object slots", async () => {
    // ADR-0037 §6's position-scoping, at the CALL SITE rather than in the store
    // (`vocabulary-pg.test.ts` holds the schema half). The bug this prohibits is
    // the shape #5020 shipped: one bare `AliasLookup` threaded through all three
    // `slotKey` calls, under which a PREDICATE approval re-keys SUBJECTS
    // workspace-wide — silently, and in the direction nothing undoes.
    //
    // The rule is a bare common noun, which is T4 §2's actual population:
    // warehouse predicates are `price`, `owner`, `status`, `tier`, `region`,
    // exactly the norms most likely to also be subject or object surfaces. Here
    // the same word `owner` sits at all three positions of one claim, so a
    // vocabulary applied to the wrong slot is visible in the wrong slot's key.
    const store = new FakeBrainStore();
    const vocabulary = {
      ...identityVocabulary,
      predicate: (norm: string): string => (norm === "owner" ? "account owner" : norm),
    };

    await run(store, {
      vocabulary,
      candidates: [candidate({ subject: "Owner", predicate: "owner", object: "OWNER" })],
    });

    const keys = store.keyBindsFor("insertFact")[0];
    expect(keys).toMatchObject({ predicate: "account owner" });
    // The prohibition. Both of these are `"account owner"` under a
    // position-agnostic vocabulary, and BOTH surfaces are spelled off normal
    // form so a broken fold cannot be what makes either pass — an earlier
    // version of this fixture had the object side already normalized, which is
    // the repo's own "both sides off normal form" hazard.
    expect(keys).toMatchObject({ subject: "owner", object: "owner" });
  });

  test("all three slots read their OWN position's lookup", async () => {
    // The test above proves predicate ≠ the other two, but leaves subject and
    // object indistinguishable (both the empty function) — so swapping
    // `vocabulary.object` for `vocabulary.subject` at the call site survives it.
    // Three distinct non-identity lookups over the same norm is what separates
    // all three, and it is the call-site twin of `vocabulary-pg.test.ts`'s
    // "three independent forests" control.
    const store = new FakeBrainStore();
    const only =
      (target: string): ((norm: string) => string) =>
      (norm) =>
        norm === "owner" ? target : norm;

    await run(store, {
      vocabulary: {
        subject: only("owner (person)"),
        predicate: only("account owner"),
        object: only("owner (value)"),
      },
      candidates: [candidate({ subject: "Owner", predicate: "owner", object: "OWNER" })],
    });

    expect(store.keyBindsFor("insertFact")[0]).toEqual({
      subject: "owner (person)",
      predicate: "account owner",
      object: "owner (value)",
    });
  });

  test("a throwing vocabulary aborts the episode — it never degrades to the un-aliased norm", async () => {
    // `identity.ts` documents this as a deliberate asymmetry with `tryResolve`,
    // which catches a throwing ENTITY resolver and flags the candidate
    // provisional. There is no safe degraded answer for a failed vocabulary
    // lookup: falling back to the un-aliased norm keys the row into the slot
    // the vocabulary exists to move it out of, and nothing surfaces it
    // afterwards. Pinned because the behaviour is true only by ABSENCE of a
    // catch, and wrapping it in `tryResolve`'s shape is the obvious refactor.
    const store = new FakeBrainStore();
    const boom = (): string => {
      throw new Error("vocabulary unavailable");
    };

    await expect(
      run(store, { vocabulary: { ...identityVocabulary, predicate: boom } }),
    ).rejects.toThrow("vocabulary unavailable");
    // Nothing written, and no transaction opened — the keys are computed in the
    // preparation loop, above the transaction.
    expect(store.facts).toHaveLength(0);
    expect(store.transactions).toBe(0);
  });

  test("the STORED surface is trimmed, so padding never reaches the corpus", async () => {
    // `reconcile.ts` trims the candidate surfaces before it resolves or keys
    // them, and the trimmed form is what lands in the row. Pinned here because
    // the identity corpus deliberately CANNOT cover it: a space-padded pair is
    // normalized by this trim no matter what `lexicalNorm` does, which is why
    // `separator-edges` uses `_`/`-` instead. Deleting `.trim()` outright is
    // caught by the MALFORMED_CLAIM test above; storing the untrimmed surface
    // beside a trimmed key is caught only here.
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ subject: "  deploy window  ", object: " Thursdays " })] });

    expect(store.facts).toHaveLength(1);
    expect(store.facts[0]).toMatchObject({ subject: "deploy window", object: "Thursdays" });
  });

  test("a surface that norms away is bound as NULL, never as an empty string", async () => {
    // `-` survives the MALFORMED_CLAIM guard (`trim()` strips whitespace, not
    // `_` or `-`), so it is a storable claim whose key is permanently NULL.
    // A bound `""` would file every placeholder in the corpus under ONE slot:
    // two unrelated claims corroborate as one and, at `single` cardinality,
    // publishing either stamps `valid_to` on the other. `null` joins nothing,
    // which is the honest answer for a surface that asserts nothing.
    //
    // The bind is what this file can see. That two such rows then fail to
    // corroborate each other is `extract-reconcile-pg.test.ts`'s.
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ object: "-" })] });

    expect(store.keyBindsFor("insertFact")[0]?.object).toBeNull();
    expect(store.keyBindsFor("corroboration")[0]?.object).toBeNull();
    // …and the degenerate surface is still stored VERBATIM, so the reviewer can
    // see what the producer emitted and repair it. Asserted on `object` — the
    // column that actually carries one; the subject is the shared default and
    // would prove nothing.
    expect(store.facts[0]?.object).toBe("-");
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

  test("both lookups match on the SLOT KEYS and on no surface column (#5020)", () => {
    // The lexical backstop for the pivot, and after #5021 it is the ONLY thing
    // in this file that looks at a column name. The store above dispatches on
    // each statement's string IDENTITY and reads its binds positionally, so
    // repointing either statement at the surface columns leaves every other test
    // in this file green — and the real proof lives in
    // `identity-consumers-pg.test.ts` (three consumers over one corpus) and
    // `extract-reconcile-pg.test.ts`, both of which SKIP without
    // `TEST_DATABASE_URL`. Without these assertions the revert is green on a
    // default local run.
    expect(CORROBORATION_LOOKUP_SQL).toContain("subject_key = $2");
    expect(CORROBORATION_LOOKUP_SQL).toContain("predicate_key = $3");
    expect(CORROBORATION_LOOKUP_SQL).toContain("object_key = $4");
    expect(TENSION_CANDIDATES_SQL).toContain("subject_key = $2");
    expect(TENSION_CANDIDATES_SQL).toContain("predicate_key = $3");
    // `<>`, never `=`: a rival asserts a DIFFERENT value in the same slot.
    expect(TENSION_CANDIDATES_SQL).toContain("object_key <> $4");
    // …and the self-exclusion, whose BIND is asserted above but whose presence
    // in the statement nothing else here can see. Without it every `single` fact
    // is its own rival the moment it lands.
    expect(TENSION_CANDIDATES_SQL).toContain("id <> $5");
    // …and no surviving surface comparison in either. An AND-ed surface arm
    // beside a key arm reads as pivoted and is not.
    for (const [name, sql] of [
      ["CORROBORATION_LOOKUP_SQL", CORROBORATION_LOOKUP_SQL],
      ["TENSION_CANDIDATES_SQL", TENSION_CANDIDATES_SQL],
    ] as const) {
      for (const column of ["subject", "predicate", "object"]) {
        expect(
          new RegExp(`\\b${column}\\b(?!_key)\\s*(=|<>)`).test(sql),
          `${name} still compares the ${column} SURFACE — identity is the materialized key (ADR-0037 §1)`,
        ).toBe(false);
      }
    }
    // The write half: the INSERT must name all three, or every row it lands is
    // unkeyed and inert in the two statements above.
    expect(INSERT_FACT_SQL).toContain("subject_key, predicate_key, object_key");
  });
});
