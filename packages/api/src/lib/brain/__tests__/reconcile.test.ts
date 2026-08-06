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
 * `identity-consumers-pg.test.ts`, where one corpus of claim pairs is read by all
 * three consumers — corroboration, the rival scan, and the publish gate's
 * collision join — against a real schema. The lexical backstop at the bottom of this file
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
import { COMPARABLE_TAGS } from "@atlas/api/lib/brain/object-cmp";
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
// where one corpus of claim pairs is read by all three consumers.
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
  validFrom: string | null;
  extractedAt: string | null;
}

interface SlotBinds {
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly object: string | null;
  /**
   * The comparable value (#5030) — the fourth member of `agreementBinds`.
   *
   * Read here rather than left to the `-pg` lane because that lane SKIPS
   * without `TEST_DATABASE_URL`, which is the default local run. Without this
   * field, `agreementBinds` returning `[…keys, null]`, or `reconcile.ts`
   * dropping `declared: candidate.objectType`, is invisible to `bun run test`
   * and dies only where nobody looks.
   */
  readonly comparable: string | null;
}

/**
 * The four consecutive agreement binds, read positionally — `null` stays `null`
 * rather than becoming `"null"` through `String()`, which is the whole
 * distinction these tests are about.
 */
function keyParams(params: readonly unknown[], from: number): SlotBinds {
  const at = (i: number): string | null => {
    const v = params[from + i];
    return v === null || v === undefined ? null : String(v);
  };
  return { subject: at(0), predicate: at(1), object: at(2), comparable: at(3) };
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
 * `keyOffset` lives here too, because the position at which a statement's four
 * agreement binds start is a property OF the statement, not of each call site. Restated
 * at each call site it is one more chance, per site, to read the adjacent
 * binds instead — and the store itself reads it for the INSERT recording below.
 */
const STATEMENTS = {
  lock: { sql: RECONCILE_LOCK_SQL },
  corroboration: { sql: CORROBORATION_LOOKUP_SQL, keyOffset: 1 },
  insertFact: { sql: INSERT_FACT_SQL, keyOffset: 9 },
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
        // `id <> $6` is the ONE arm still applied here, and it is not identity:
        // it is the statement refusing to return the row the stage just wrote,
        // compared by uuid. Modelling it keeps a scripted rival list from
        // producing a self-edge the real query cannot produce.
        //
        // ⚠️ Index 5, and it was 4 until #5030 widened `agreementBinds` — a stale
        // index here does not fail, it silently STOPS modelling the arm: the
        // filter compares rival ids against `"money:USD:499"`, matches nothing,
        // and the fake starts returning a self-rival the real statement cannot.
        // The renumbering assertion further down caught its own index and left
        // this one; that is the shape `agreementBinds`'s docstring warns about,
        // reproduced inside the harness that is supposed to catch it.
        const selfId = String(params[5]);
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
  // ⚠️ EVERY prohibition below must be run against a store that ANSWERS.
  // `passthroughEntityResolver` returns an empty map, so "the resolver did not
  // rewrite the surface" and "no key contains an id" pass vacuously against it —
  // there is no surface to rewrite and no id to leak. That is the fixture trap
  // #5011 §3 names, and the double below is the remedy: it answers every surface
  // it is asked about, with an id that shares no characters with the surface's
  // norm, so a leak is visible rather than merely absent.
  //
  // ⚠️ SEPARATOR-FREE, and that is not cosmetic. `lexicalNorm` folds `-` and `_`
  // to a space, so a marker of `ent-` is UNRECOGNISABLE in a key: the obvious
  // leak mutation — `slotKey(objectEntityId ?? object, …)` — produces
  // `"ent 12345"`, and a `toContain("ent-")` probe passes while the id sits in
  // the key. A marker that a key can launder proves nothing about keys.
  const ENTITY_ID_MARKER = "entid";

  /**
   * The double's id for a surface: stable, and sharing no SUBSTRING with any
   * fixture surface's norm — separator-free, so `lexicalNorm` cannot launder the
   * marker out of a value it leaked into. (Not character-disjoint; `Deploy_Window`
   * and `entid69448` share four letters. Substring-disjointness of the MARKER is
   * the property the probe rests on.)
   */
  function adversarialId(surface: string): string {
    let hash = 0;
    for (const char of surface) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 100_000;
    return `${ENTITY_ID_MARKER}${String(hash).padStart(5, "0")}`;
  }

  /** An adversarial entity store: answers everything, records every batch. */
  class AnsweringStore {
    /** One entry per CALL — the assertion that the seam is episode-level. */
    readonly batches: ReadonlySet<string>[] = [];
    /**
     * How many transactions the fake had opened when each batch was issued.
     * `[0]` is the whole assertion that the call sits BEFORE the transaction —
     * the property `EntityResolver`'s docstring calls load-bearing against the
     * bounded-pool starvation deadlock.
     *
     * ⚠️ The store is REQUIRED, not optional. Optional, `[0]` means either "no
     * transaction was open" or "nobody wired a store in", and the second reading
     * makes the assertion pass against a stage that resolves inside the
     * transaction — the defect it exists to catch. (Two other tests catch that
     * mutation for their own reasons, so this is the property's NAME rather than
     * its only guard.)
     */
    readonly transactionsAtCall: number[] = [];

    constructor(private readonly store: FakeBrainStore) {}

    readonly resolve: EntityResolver = (surfaces) => {
      this.batches.push(new Set(surfaces));
      this.transactionsAtCall.push(this.store.transactions);
      return new Map([...surfaces].map((s) => [s, { entityId: adversarialId(s) }]));
    };
  }

  test("a store that ANSWERS does not alter the stored surfaces", async () => {
    // The prohibition. Retention is what makes an alias reversible: re-deriving
    // identity from the surface the producer wrote is the only way back from a
    // bad vocabulary entry, and a canonical form written into the SPO columns
    // would be irreversible at the entity position (ADR-0037 §5).
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ subject: "Deploy_Window", object: "Acme Corp" })],
      resolveEntity: new AnsweringStore(store).resolve,
    });

    expect(store.facts[0]?.subject).toBe("Deploy_Window");
    expect(store.facts[0]?.object).toBe("Acme Corp");
  });

  test("…and no key it produced contains the entity id", async () => {
    // The second prohibition, on the same fixture. Ids at a slot would silently
    // orphan the corpus: a workspace's live facts keyed `acme corp` stop
    // colliding with anything new the moment the store starts answering an id —
    // #5000 re-caused by the fix for #5000.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ subject: "Deploy_Window", object: "Acme Corp" })],
      resolveEntity: new AnsweringStore(store).resolve,
    });

    // ⚠️ The MARKER sweep runs FIRST, and it is what makes the exact assertion
    // below more than a duplicate. An earlier draft had them the other way
    // round, which made the sweep unreachable on failure — the exact
    // `toMatchObject` threw before it, so the loop only ever executed in the
    // world where every key already equalled its expected literal and no leak
    // was possible. A probe that can only run when it must pass is not a probe.
    //
    // It is also WIDER than the exact assertion: every key bind of every
    // key-carrying statement, plus the retained surfaces. The exact assertion
    // covers three binds of one statement.
    for (const name of ["insertFact", "corroboration", "tensionScan"] as const) {
      const binds = store.keyBindsFor(name)[0];
      for (const position of ["subject", "predicate", "object"] as const) {
        expect(binds?.[position] ?? "", `${name}.${position} leaked an entity id`).not.toContain(
          ENTITY_ID_MARKER,
        );
      }
    }
    expect(store.facts[0]?.subject).not.toContain(ENTITY_ID_MARKER);
    expect(store.facts[0]?.object).not.toContain(ENTITY_ID_MARKER);

    // Exactly `alias(lexicalNorm(surface))` at all three positions — the same
    // keys the passthrough default would have produced.
    expect(store.keyBindsFor("insertFact")[0]).toMatchObject({
      subject: "deploy window",
      predicate: "is",
      object: "acme corp",
    });
  });

  test("POSITIVE CONTROL: the store's answer did reach the row — at `object_cmp`", async () => {
    // Without this, both prohibitions above are satisfied by a stage that
    // ignores the resolver entirely, which is exactly what they are supposed to
    // catch. One side of the assertion is a value the SYSTEM produced: the id
    // the double minted, read back off the bind the stage actually made.
    const store = new FakeBrainStore();
    const answering = new AnsweringStore(store);
    await run(store, {
      // `single` so the rival scan is issued too — it carries the same four
      // agreement binds and is the statement a partial repoint would miss.
      candidates: [
        candidate({ subject: "Deploy_Window", object: "Acme Corp", predicateCardinality: "single" }),
      ],
      resolveEntity: answering.resolve,
    });

    // BEFORE the transaction opened. See `transactionsAtCall`.
    expect(answering.transactionsAtCall).toEqual([0]);

    // Not a literal: the id comes from the double's own rule, so the two sides
    // are one fact rather than a coincidence between two strings.
    //
    // All THREE key-carrying statements, on `reconcile.test.ts`'s standing
    // pattern for the comparable bind: an INSERT and a lookup disagreeing about
    // what a claim's value IS is the failure this module keeps naming, and the
    // entity arm was the one comparable-value producer not swept that way.
    for (const name of ["insertFact", "corroboration", "tensionScan"] as const) {
      expect(store.keyBindsFor(name)[0]?.comparable, `${name} bound no entity id`).toBe(
        `entity:${adversarialId("Acme Corp")}`,
      );
    }
  });

  test("ONE call per episode, over the deduplicated subject AND object surfaces", async () => {
    // Dedup is a CORRECTNESS property, not a saving: two lookups for one surface
    // can straddle a store write and key differently within a single episode.
    // And the batch covers BOTH positions — the subject-side id has no
    // destination column until #5032, which is why a test is the only thing
    // holding the subject in the set.
    // ⚠️ The fixture has to make the two positions DISTINGUISHABLE. A corpus
    // where every subject also appears at some object position is satisfied by
    // an object-only batch — the set comes out identical and the test proves
    // nothing. So `Beta Inc` is subject-only and `Grace` object-only, and each
    // one alone falsifies one direction of the mutation.
    const store = new FakeBrainStore();
    const answering = new AnsweringStore(store);
    await run(store, {
      candidates: [
        // Padded on purpose: the store is asked about the surface that will be
        // STORED, never the producer's raw text. Untrimmed, the lookup misses a
        // real entry and the row lands `object_cmp` NULL with no marker — a
        // permanent, silent abstain that looks exactly like an honest one.
        candidate({ subject: "  Acme Corp ", predicate: "employs", object: "Ada" }),
        // …and once at an OBJECT position, which is the half that reaches a
        // column. Padded only at the subject, an untrimmed LOOKUP survives:
        // `subjectEntityId` is read by nothing until #5032, so the miss is
        // invisible.
        candidate({ subject: "Beta Inc", predicate: "employs", object: " Grace  " }),
        // `Acme Corp` and `Ada` again, positions swapped: role-invariance is why
        // that is one lookup per surface and not two.
        candidate({ subject: "Ada", predicate: "works for", object: "Acme Corp" }),
        // Refused by the blank-trim pass, so its subject is never looked up.
        candidate({ subject: "Never Stored", object: "   " }),
      ],
      resolveEntity: answering.resolve,
    });

    expect(answering.batches).toHaveLength(1);
    // Four surfaces drawn from six populated positions, and SORTED — the batch
    // must carry no positional information, or a resolver can infer `role` from
    // iteration order for any surface that appears at exactly one position,
    // which is the argument this seam deleted `role` to make unnecessary.
    // (`toEqual` on a Set is membership-based and would not see the order.)
    expect([...answering.batches[0]!]).toEqual(["Acme Corp", "Ada", "Beta Inc", "Grace"]);
    // And the trimmed surface is what the LOOKUP used, not just what the batch
    // carried: ` Grace  ` reached the store as `Grace` and its id came back to
    // the row.
    expect(store.keyBindsFor("insertFact")[1]?.comparable).toBe(`entity:${adversarialId("Grace")}`);
  });

  test("an honest abstain does NOT flag the candidate provisional", async () => {
    // A store that answers "no entry" is not a failure. The claim still keys
    // totally, still corroborates, still earns tension edges; it declines only
    // to prove DIFFERENCE, which `object_cmp` NULL already says. Flagging it
    // would set the marker on every entity-valued object forever under the
    // shipped default, defeating #4772's filter on the key's presence.
    const store = new FakeBrainStore();
    const report = await run(store, { resolveEntity: () => new Map() });

    expect(report.created).toBe(1);
    expect(report.provisional).toBe(0);
    expect(store.facts[0]?.provenance.provisional).toBeUndefined();
    expect(store.facts[0]?.provenance.unresolved).toBeUndefined();
    // The surface is retained, so there is something to resolve later rather
    // than a hole.
    expect(store.facts[0]?.object).toBe("Thursdays");
  });

  test("an abstain on ONE surface leaves the other's id intact", async () => {
    // Absence is per-KEY, not per-batch: a store with an entry for the object
    // and none for the subject answers both honestly in one map.
    const store = new FakeBrainStore();
    const report = await run(store, {
      resolveEntity: () => new Map([["Thursdays", { entityId: "ent-day-4" }]]),
    });

    expect(report.provisional).toBe(0);
    expect(store.keyBindsFor("insertFact")[0]?.comparable).toBe("entity:ent-day-4");
  });

  test("a store that THROWS flags rather than blocking the episode", async () => {
    // A resolver is injected code — a real one calls a store and can time out.
    // Letting the throw escape would turn a quality failure into a block for
    // every candidate on the episode, inverting the asymmetry.
    //
    // This is the outcome the flag now exists for, and ONLY this one: an outage
    // changes on replay and there is no key-based way to find its rows, because
    // `object_cmp IS NULL` matches every honest abstain too.
    const store = new FakeBrainStore();
    const report = await run(store, {
      resolveEntity: () => {
        throw new Error("entity store unreachable");
      },
    });

    expect(report.created).toBe(1);
    expect(report.provisional).toBe(1);
    expect(store.facts[0]?.provenance.provisional).toBe(true);
    // Always both sides. One batch covered both positions, so a failure has no
    // per-role granularity to report — #4772's review surface reads the array
    // and gets the honest answer rather than a guess about which side failed.
    expect(store.facts[0]?.provenance.unresolved).toEqual(["subject", "object"]);
  });

  test("a REJECTED promise fails the batch too, and the claim keeps its surfaces and keys", async () => {
    // The async arm of the throwing test above — `await run(...)` would reject
    // outright if the rejection escaped. The flag is a MARKER, never a
    // degradation: an outage costs the object's comparability and nothing else.
    // A stage that also dropped the keys would make an outage silently
    // un-corroboratable, which no replay repairs.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ subject: "Deploy_Window" })],
      resolveEntity: () => Promise.reject(new Error("connection reset")),
    });

    // The marker is what proves this ran the FAILED arm rather than simply
    // never calling a resolver — every other assertion here is also true of a
    // stage with no resolver at all.
    expect(store.facts[0]?.provenance.provisional).toBe(true);
    expect(store.facts[0]?.subject).toBe("Deploy_Window");
    expect(store.keyBindsFor("insertFact")[0]).toMatchObject({
      subject: "deploy window",
      comparable: null,
    });
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

  test("no batch is issued when every candidate was refused", async () => {
    // A real store would spend a connection checkout answering about nothing.
    // Safe to skip precisely because there is no prepared candidate left for a
    // failure to flag — which is why the assertion has to be on the CALL, not
    // on an outcome: nothing downstream can see the difference.
    const store = new FakeBrainStore();
    const answering = new AnsweringStore(store);
    const report = await run(store, {
      candidates: [candidate({ object: "   " }), candidate({ subject: "" })],
      resolveEntity: answering.resolve,
    });

    expect(answering.batches).toHaveLength(0);
    expect(report.blocked.MALFORMED_CLAIM).toBe(2);
  });

  test("a store answering with a blank id fails the batch — it is a contract violation, not an abstain", async () => {
    // The one path where an infrastructure fault could have presented as an
    // honest abstain. A blank id will CHANGE on replay (the store is broken and
    // someone will fix it), which is the entire criterion the marker encodes —
    // and, untrapped, a blank id tags a comparable value with nothing and makes
    // two unrelated objects read as provably the SAME.
    const store = new FakeBrainStore();
    const report = await run(store, {
      resolveEntity: () => new Map([["Thursdays", { entityId: "   " }]]),
    });

    expect(report.provisional).toBe(1);
    expect(store.facts[0]?.provenance.unresolved).toEqual(["subject", "object"]);
    expect(store.keyBindsFor("insertFact")[0]?.comparable).toBeNull();
  });

  test("a store answering with a non-string id fails the batch rather than throwing mid-loop", async () => {
    // From an untyped JS store. Without the guard the number reaches `.trim()`
    // in the preparation loop — OUTSIDE the resolver catch — and aborts the
    // whole episode: the quality-failure-becomes-a-block inversion, reached by a
    // second route from the non-Map case below.
    const store = new FakeBrainStore();
    const report = await run(store, {
      resolveEntity: (() => new Map([["Thursdays", { entityId: 7 }]])) as unknown as EntityResolver,
    });

    expect(report.created).toBe(1);
    expect(report.provisional).toBe(1);
    expect(store.keyBindsFor("insertFact")[0]?.comparable).toBeNull();
  });

  test("a conforming non-`Map` ReadonlyMap is an ANSWER, not an outage", async () => {
    // The seam's declared type is STRUCTURAL, so a caching wrapper or a
    // cross-realm map is legal. A nominal `instanceof` check would report every
    // episode as a store outage forever — flagging the whole corpus provisional
    // and destroying the marker's one meaning, in the alarming direction.
    const backing = new Map([["Thursdays", { entityId: "entid-00042" }]]);
    const wrapper: ReadonlyMap<string, { entityId: string }> = {
      get: (k) => backing.get(k),
      has: (k) => backing.has(k),
      size: backing.size,
      keys: () => backing.keys(),
      values: () => backing.values(),
      entries: () => backing.entries(),
      forEach: (fn) => backing.forEach(fn),
      [Symbol.iterator]: () => backing[Symbol.iterator](),
    };

    const store = new FakeBrainStore();
    const report = await run(store, { resolveEntity: () => wrapper });

    expect(report.provisional).toBe(0);
    expect(store.keyBindsFor("insertFact")[0]?.comparable).toBe("entity:entid-00042");
  });

  test("a failed batch withholds the comparable value FROM THE ROW", async () => {
    // ⚠️ The irreversible direction. `499` is an entity in a healthy store, so
    // its comparison is `entity:…` — a different TAG from a sibling's
    // `number:…`, hence `unknown`, hence tension only. Write the surface parse
    // during an outage and it becomes `number:499`: same tag, unequal, PROVABLY
    // different, and the publish gate — which compares two STORED rows — stamps
    // `valid_to` on a belief a healthy store would only have flagged for a
    // human. An outage must never reach further than an answer would have.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ object: "499", predicateCardinality: "single" })],
      resolveEntity: () => {
        throw new Error("entity store unreachable");
      },
    });

    expect(store.keyBindsFor("insertFact")[0]?.comparable).toBeNull();
  });

  test("…and KEEPS it at the two lookups, because a NULL there disables the difference veto", async () => {
    // The other half, and the defect the first draft of this rule shipped.
    // `objectSameSql` = `(key match OR value match) AND NOT provably-different`.
    // The veto arm is NULL when the bind is NULL, `IS NOT TRUE` swallows it, and
    // corroboration collapses to bare key equality — at which point `-499` and
    // `499` (which key IDENTICALLY, since `lexicalNorm` strips a leading `-`)
    // MERGE during an outage. No new row, no tension edge, and because
    // corroboration writes no provenance, not even a marker to find it by.
    // Withholding belongs on the row, not on the lookups.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ object: "-499", predicateCardinality: "single" })],
      resolveEntity: () => {
        throw new Error("entity store unreachable");
      },
    });

    for (const name of ["corroboration", "tensionScan"] as const) {
      expect(store.keyBindsFor(name)[0]?.comparable, `${name} lost its veto arm`).toBe(
        "number:-499",
      );
    }
    // …while the row itself still refuses to carry it.
    expect(store.keyBindsFor("insertFact")[0]?.comparable).toBeNull();
  });

  test("POSITIVE CONTROL: that same surface IS written comparable when the batch did not fail", async () => {
    // Without this, the tests above are satisfied by a stage that never computes
    // a comparable value at all — and `499` is exactly the surface that parses
    // on its own terms, so the withholding has to be shown to be the FAILURE's
    // doing rather than the parser's. An abstain is not a failure, which is why
    // an answering-with-nothing store is the right control here.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ object: "499", predicateCardinality: "single" })],
      resolveEntity: () => new Map(),
    });

    expect(store.keyBindsFor("insertFact")[0]?.comparable).toBe("number:499");
  });

  test("a failed batch flags EVERY candidate on the episode, not just the first", async () => {
    // The unit of failure is the batch, and every docstring in the seam says so
    // in the plural. Nothing pinned it: every other outage test here carries one
    // candidate, so flagging only `prepared[0]` was green.
    const store = new FakeBrainStore();
    const report = await run(store, {
      candidates: [
        candidate({ object: "499" }),
        candidate({ subject: "release train", object: "Fridays" }),
      ],
      resolveEntity: () => {
        throw new Error("entity store unreachable");
      },
    });

    expect(report.provisional).toBe(2);
    for (const index of [0, 1]) {
      expect(store.facts[index]?.provenance.provisional, `fact ${index}`).toBe(true);
      expect(store.keyBindsFor("insertFact")[index]?.comparable, `fact ${index}`).toBeNull();
    }
  });

  test("the answer is read by ITERATION — a hostile `get` is never called", async () => {
    // The snapshot's first claim. A Proxy-wrapped Map passes `instanceof` and
    // then throws `Map operation called on non-Map object` at the first `.get`,
    // in the preparation loop, OUTSIDE the catch — the whole reason the nominal
    // check was replaced. Reading by iteration means that `get` is never
    // reached, and this is the only test that can tell the two apart: the
    // conforming-wrapper test below supplies a WORKING `get`, so it dies to a
    // nominal check but not to a `.get`-based read.
    //
    // It also settles the snapshot's OTHER claim — that the stage does not hold
    // a live reference to the resolver's map, which would let one surface
    // resolve two ways within a single episode. A reference the stage never
    // calls cannot be live: if `resolveEntitiesForEpisode` returned the
    // resolver's own map instead of the owned copy, `storeId` would reach this
    // `get` and the episode would abort. (Asserting that directly — mutate the
    // map after returning it — is not expressible: `await` drains microtasks
    // before the copy loop runs, so the "later" mutation always lands first.)
    const backing = new Map([["Thursdays", { entityId: "entid00042" }]]);
    const hostile: ReadonlyMap<string, { entityId: string }> = {
      get: () => {
        throw new Error("Map operation called on non-Map object");
      },
      has: (k) => backing.has(k),
      size: backing.size,
      keys: () => backing.keys(),
      values: () => backing.values(),
      entries: () => backing.entries(),
      forEach: (fn) => backing.forEach(fn),
      [Symbol.iterator]: () => backing[Symbol.iterator](),
    };

    const store = new FakeBrainStore();
    const report = await run(store, { resolveEntity: () => hostile });

    expect(report.provisional).toBe(0);
    expect(store.keyBindsFor("insertFact")[0]?.comparable).toBe("entity:entid00042");
  });

  test("a key that is not a requested surface fails the batch — a store must not normalize keys", async () => {
    // The key half of the contract. A store that lowercases or re-trims on the
    // way out returns a FULL, well-formed map that misses on every lookup: a
    // total, permanent, unmarked abstain across every episode, with no log line
    // anywhere. That is the all-or-nothing collapse the seam prohibits, reached
    // through the one arm a value check cannot see.
    const store = new FakeBrainStore();
    const report = await run(store, {
      // `thursdays`, not `Thursdays` — the shape a normalizing store produces.
      resolveEntity: () => new Map([["thursdays", { entityId: "entid00042" }]]),
    });

    expect(report.provisional).toBe(1);
    expect(store.keyBindsFor("insertFact")[0]?.comparable).toBeNull();
  });

  test("a resolver returning a non-Map is a failed batch, not an escaped TypeError", async () => {
    // The seam is typed, so this is untrusted-input handling: a JS caller (or a
    // resolver that forgot an `await`) returning something else would otherwise
    // throw on the first `.get`, OUTSIDE the catch, and block the whole episode
    // — the same inversion by a different route.
    const store = new FakeBrainStore();
    const report = await run(store, {
      // The cast IS the test: nothing in the type system can stop a JS caller,
      // and the seam is the one place untyped input arrives.
      resolveEntity: (() => null) as unknown as EntityResolver,
    });

    expect(report.created).toBe(1);
    expect(report.provisional).toBe(1);
    expect(store.facts[0]?.provenance.unresolved).toEqual(["subject", "object"]);
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
    // `id <> $6`. Without it every `single` fact earns a self-edge the moment it
    // lands, and the review queue fills with claims contradicting themselves.
    // The BIND is what this file can prove; that the statement still spells the
    // arm is the lexical backstop at the bottom.
    //
    // Index 5, not 4, since #5030: the agreement tuple spread ahead of it grew a
    // fourth member (the comparable value). That renumbering is the hazard
    // `agreementBinds`'s docstring names — a stale index here binds a KEY where
    // the statement declares `::uuid`, so this assertion is also the one that
    // fails if the next `_cmp` column widens the spread without renumbering.
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ ...single, object: "Grace" })] });

    const binds = store.bindsFor("tensionScan");
    expect(binds, "the rival scan was never issued").toHaveLength(1);
    expect(binds[0]![5]).toBe(store.facts[0]!.id);
  });

  test("…and the fake HONOURS that exclusion, so no self-edge is ever observed", async () => {
    // The bind assertion above proves the stage passes the right id; it says
    // nothing about whether the fake's `id <> $6` model reads it at the right
    // index. Nothing did, and the model had silently stopped working: after
    // #5030 widened `agreementBinds` it compared rival ids against the
    // COMPARABLE VALUE, matched nothing, and would have handed the stage a
    // self-rival the real statement cannot return.
    //
    // A fake that lies in the permissive direction is worse than no fake — the
    // next author to debug a self-edge would be debugging the harness. So the
    // one arm it still models gets its own falsifier: script the just-written
    // fact as its own rival and assert no edge is wired.
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ ...single, object: "Grace" })] });
    const written = store.facts[0]!;

    const selfRival = new FakeBrainStore();
    selfRival.scriptRivals(written);
    await run(selfRival, { candidates: [candidate({ ...single, object: "Grace" })] });

    expect(
      selfRival.edges.filter((e) => e.edgeType === "in-tension-with"),
      "the stage wired an in-tension-with edge from a fact to ITSELF — the fake's `id <> $6` exclusion is reading the wrong bind index",
    ).toHaveLength(0);
  });

  test("the stage binds NO cardinality at all — the column left the insert (#5027)", async () => {
    // The falsification of ADR-0037 §3's "the extractor stops feeding the
    // column". It used to be `$10` here, carrying the model's per-claim guess
    // into the both-sides clause at the publish gate — so supersession fired at
    // roughly P(model says `single`)², from two independent model calls.
    //
    // A COUNT rather than a value check, and that is the only thing that
    // catches it: re-adding the column and its bind leaves valid SQL, an
    // unchanged row, and every other assertion in this file still green. The
    // column now falls to its schema default until #5028 drops it.
    const store = new FakeBrainStore();
    await run(store, { candidates: [candidate({ predicateCardinality: "single" })] });

    expect(INSERT_FACT_SQL).not.toContain("predicate_cardinality");
    expect(store.bindsFor("insertFact")[0]).toHaveLength(13);
  });

  test("the producer's cardinality hint still gates the ADVISORY tension scan", async () => {
    // The other half, and it is what keeps the previous test from being
    // satisfiable by deleting the field: the hint survives, with exactly the
    // authority a model guess is worth. An `in-tension-with` edge is recoverable
    // in both directions; a `valid_to` stamp is recoverable in neither.
    //
    // Asserted as a CONTRAST in one test rather than as a bare "the scan ran",
    // which `an empty rival scan writes no edge` already proves and which would
    // read as coverage without adding any: what this pins is that the hint is
    // still the thing that decides, i.e. that #5027 removed the field's
    // destructive consumer and not the field.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ predicateCardinality: "single", object: "Grace" })],
    });
    expect(store.bindsFor("tensionScan")).toHaveLength(1);

    const landed = store.facts.length;
    await run(store, {
      episode: episode({ id: "ep-hint-multi" }),
      candidates: [candidate({ predicateCardinality: "multi", object: "Alan" })],
    });
    // The `multi` claim LANDED — asserted first, because "no new scan" is
    // equally satisfied by a second pass that wrote nothing at all, and a
    // prohibition whose premise never happened proves nothing.
    expect(store.facts).toHaveLength(landed + 1);
    expect(
      store.bindsFor("tensionScan"),
      "the cardinality hint stopped gating the tension scan — either it lost its last consumer (and `ExtractionSchema.cardinality` is now dead weight the model is still asked for) or it gained one that ignores it",
    ).toHaveLength(1);
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

    const keyed = {
      subject: "deploy window",
      predicate: "ships on",
      object: "thursdays",
      // `Thursdays` names no comparable value, which is the COMMON case and the
      // whole abstain band — so the fourth bind is `null` here, and the test
      // below is the one that proves it can be non-null.
      comparable: null,
    };
    // All four agreement binds, on all three statements that carry them, and
    // each is asserted: an INSERT keyed correctly beside a lookup keyed off the
    // raw surface would write rows nothing can ever find.
    expect(store.keyBindsFor("insertFact")[0]).toEqual(keyed);
    expect(store.keyBindsFor("corroboration")[0]).toEqual(keyed);
    expect(store.keyBindsFor("tensionScan")[0]).toEqual(keyed);
    // The RETAINED surface is untouched — identity moved, the record of what
    // the producer actually said did not.
    expect(store.facts[0]).toMatchObject({ subject: "Deploy_Window", predicate: "Ships  On" });
  });

  test("…and the comparable value is bound too, on all three (#5030)", async () => {
    // THE positive control for the `comparable: null` above, which is satisfied
    // by an `agreementBinds` that always yields `null` — i.e. by the stage never
    // computing a comparable value at all. It also proves `objectType` is
    // threaded from `FactCandidate` all the way to the bind: without the
    // declaration `499` parses to `number:499`, so the assertion is specific to
    // the declaration having been passed through.
    //
    // In the FAST lane deliberately. The `-pg` suites skip without
    // `TEST_DATABASE_URL`, so leaving this to them means a dropped declaration
    // is green on a default local run.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [
        candidate({
          object: "499",
          objectType: { kind: "money", currency: "USD" },
          predicateCardinality: "single",
        }),
      ],
    });

    for (const name of ["insertFact", "corroboration", "tensionScan"] as const) {
      expect(store.keyBindsFor(name)[0]?.comparable, `${name} bound no comparable value`).toBe(
        "money:USD:499",
      );
    }
  });

  test("keys are derived off the RETAINED surface, which the resolver cannot move", async () => {
    // A key must describe the row that was written — and since #5031 that is
    // structural rather than a discipline, because the surface a fact stores is
    // the one the producer wrote, always. The entity store moves a claim's slot
    // through the VOCABULARY (a re-keyable, reviewed alias edge) or not at all;
    // the resolver reaches `object_cmp` and nothing else.
    //
    // The store answers, and the `comparable` assertion below is where that
    // answer shows up — without it this test is satisfied by a stage that never
    // called a resolver at all. The prohibition itself is owned in full by the
    // `flag: entity resolution` block.
    const store = new FakeBrainStore();
    await run(store, {
      candidates: [candidate({ subject: "deploy-01" })],
      // Separator-free, like the block above: a hyphenated id is one
      // `lexicalNorm` away from unrecognisable in a key.
      resolveEntity: (surfaces) =>
        new Map([...surfaces].map((s) => [s, { entityId: "entid00042" }])),
    });

    // The surface verbatim; the key its lexical norm, separators folded and no
    // trace of the id; the id itself parked at the comparable position.
    expect(store.facts[0]?.subject).toBe("deploy-01");
    expect(store.keyBindsFor("insertFact")[0]).toMatchObject({
      subject: "deploy 01",
      comparable: "entity:entid00042",
    });
  });

  test("the workspace's vocabulary reaches every slot", async () => {
    // The vocabulary seam, through the stage. `ReconcileRequest.vocabulary` is
    // REQUIRED since #5022, so it can no longer be dropped silently — but the
    // three `slotKey` calls can still be handed the wrong lookup, or the same
    // one three times, and that is what this and the tests below catch.
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
      // `Owner` names no comparable value. Asserted rather than omitted: the
      // vocabulary is a KEY-layer rewrite and must not reach the cmp position,
      // and an `objectSameSql` fed an aliased value there would compare the
      // vocabulary's output against a parser's.
      comparable: null,
    });
  });

  test("a throwing vocabulary aborts the episode — it never degrades to the un-aliased norm", async () => {
    // `identity.ts` documents this as a deliberate asymmetry with
    // `resolveEntitiesForEpisode`, which catches a throwing ENTITY resolver and
    // flags that EPISODE's candidates provisional. There is no safe degraded
    // answer for a failed vocabulary lookup: falling back to the un-aliased norm
    // keys the row into the slot the vocabulary exists to move it out of, and
    // nothing surfaces it afterwards. Pinned because the behaviour is true only
    // by ABSENCE of a catch, and wrapping it in the resolver seam's shape is the
    // obvious refactor.
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
    // The object arm is a whole three-valued test since #5030, and the two
    // statements take opposite halves of ONE definition — corroboration fires on
    // *provably same*, the rival scan on everything that is not. Pinned
    // lexically because the fake dispatches on statement identity and reads
    // binds positionally, so dropping any arm leaves every behavioural test in
    // this file green.
    //
    // ⚠️ `IS NOT TRUE`, never `NOT (…)`, in BOTH statements. Both wrap an
    // expression that is NULL for the whole abstain band, and a WHERE clause
    // treats NULL as false — so the readable spelling deletes corroboration for
    // every unparseable object (in the veto) and deletes the abstain band from
    // tension entirely (in the rival scan). Two different disasters, one typo.
    expect(CORROBORATION_LOOKUP_SQL).toContain("(object_key = $4 OR object_cmp = $5)");
    expect(CORROBORATION_LOOKUP_SQL).toContain("IS NOT TRUE");
    expect(TENSION_CANDIDATES_SQL).toContain("(object_cmp = $5) IS NOT TRUE");
    expect(CORROBORATION_LOOKUP_SQL).not.toContain("NOT (");
    expect(TENSION_CANDIDATES_SQL).not.toContain("NOT (");
    // The VETO, and the arm that carries a key-equal-but-provably-different pair
    // into tension. `lexicalNorm` strips a leading `-`, so `-499` and `499` key
    // identically while their comparable values disagree; without these two the
    // pair corroborates into the opposite-signed belief and earns no edge.
    expect(CORROBORATION_LOOKUP_SQL).toContain("object_cmp <> $5");
    expect(TENSION_CANDIDATES_SQL).toContain("object_cmp <> $5");
    // …and the known-tag membership arm, which keeps the SQL from calling two
    // values with an unrecognized head *different*. The expectation is BUILT
    // from `COMPARABLE_TAGS` rather than hand-spelled: that array's docstring
    // says the SQL list is generated from it precisely so there is one list and
    // not three, and a hand-written copy here would be the third.
    const tagList = COMPARABLE_TAGS.map((tag) => `'${tag}'`).join(", ");
    for (const sql of [CORROBORATION_LOOKUP_SQL, TENSION_CANDIDATES_SQL]) {
      expect(sql).toContain(tagList);
      // …and the separator arms beside it. `split_part` returns the WHOLE
      // string when there is no separator, so a bare tag name passes the
      // membership test — `'money'` read as provably different from
      // `'money:USD:499'` until these landed. Pinned HERE because their only
      // behavioural falsifier is in `object-cmp-pg.test.ts`, which SKIPS
      // without `TEST_DATABASE_URL`: deleting them is otherwise green on a
      // default local run, which is this block's whole reason to exist.
      expect(sql).toContain("strpos(object_cmp, ':') > 0");
      expect(sql).toContain("strpos($5, ':') > 0");
    }
    // …and the self-exclusion, whose BIND is asserted above but whose presence
    // in the statement nothing else here can see. Without it every `single` fact
    // is its own rival the moment it lands. `$6` since #5030 widened the
    // agreement spread ahead of it.
    expect(TENSION_CANDIDATES_SQL).toContain("id <> $6");
    // …and the cap, the last placeholder after the spread. `agreementBinds`'s
    // docstring names this assertion as part of what enforces the renumbering,
    // so it has to exist: widening the tuple again without renumbering pushes
    // the cap past the end of the bind list and pg raises at runtime, not here.
    expect(TENSION_CANDIDATES_SQL).toContain("LIMIT $7");
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
    // unkeyed and inert in the two statements above — plus `object_cmp`, which
    // has NO other writer at all. Migration 0191 deliberately does not backfill,
    // so a value omitted here is a row that abstains forever.
    expect(INSERT_FACT_SQL).toContain("subject_key, predicate_key, object_key, object_cmp");
  });
});
