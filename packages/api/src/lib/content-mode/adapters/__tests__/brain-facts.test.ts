/**
 * Unit tests for the `brain_facts` content-mode adapter (#4769).
 *
 * Drives the adapter through a literal transaction double rather than
 * `mock.module()` — `ModeTxClient` is a one-method interface precisely so a
 * test can satisfy it structurally, with no module registry to mutate.
 *
 * The live-database behaviour (the CHECKs, the real UPDATE, the registry
 * readFilter over real rows) is `lib/brain/__tests__/promotion-pg.test.ts`.
 * What is pinned HERE is the adapter's own contract: which ids it promotes,
 * what it reports, and that it never issues the UPDATE for a refused row.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  BRAIN_FACTS_TABLE,
  CARDINALITY_HELD_BACK_COUNT_SQL,
  SUPERSEDE_STAMP_EXPLICIT_SQL,
  SUPERSEDE_STAMP_SQL,
  SUPERSESSION_TARGETS_SQL,
  TIER_HELD_BACK_COUNT_SQL,
  brainFactStatusClause,
  brainFactsCountSql,
  promoteBrainFacts,
  supersedingDraftPredicate,
  supersessionCollisionPredicate,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { subjectNotDifferentSql } from "@atlas/api/lib/brain/subject-cmp";
import {
  IDENTITY_MUTATION_LOCK_NAMESPACE,
  IDENTITY_MUTATION_LOCK_RESET_SQL,
  IDENTITY_MUTATION_LOCK_SQL,
  IDENTITY_MUTATION_LOCK_TIMEOUT_SQL,
} from "@atlas/api/lib/brain/identity";
import { NON_WAREHOUSE_SOURCES, isWarehouseDerivedSource } from "@atlas/api/lib/brain/sources";
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import { PublishPhaseError, type ModeTxClient } from "@atlas/api/lib/content-mode/port";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** One `pg_advisory_xact_lock` call, with how many statements preceded it. */
interface LockCall {
  readonly params: readonly unknown[];
  readonly precededCalls: number;
}

/**
 * One `SET LOCAL lock_timeout`, with its position on BOTH axes.
 *
 * `precededCalls` is not redundant with `precededLocks`, and the gap between
 * them is where a real defect hid: with only the lock count, a reset displaced
 * to AFTER the drafts read still satisfies "it came after the lock" — which is
 * the presence of the reset, not the property. The property is that no
 * table-touching statement runs while the bound is in force.
 */
interface BoundCall {
  readonly precededLocks: number;
  readonly precededCalls: number;
}

/**
 * A transaction double that answers the draft SELECT, the evidence-grants
 * SELECT (#4823), and the supersession trio (#4912), and records every call.
 *
 * Routed on the SQL rather than on call ORDER: the adapter now issues up to
 * seven statements and an index-keyed double would silently feed draft rows to
 * the evidence query the moment the plan changed again.
 */
/**
 * A supersession pair's log/fixture identity — the same `newId->oldId` spelling
 * `promoteBrainFacts`' own `pairLogKey` uses, so a fixture's expectation and the
 * adapter's warning name a pair the same way.
 */
const stampPairKey = (pair: { readonly newId: string; readonly oldId: string }) =>
  `${pair.newId}->${pair.oldId}`;

function txWithDrafts(
  drafts: readonly unknown[],
  opts: {
    readonly failOnUpdate?: boolean;
    readonly evidence?: readonly unknown[];
    /** `SUPERSESSION_TARGETS_SQL` rows: `{ draft_id, superseded_id }`. */
    readonly supersessions?: readonly unknown[];
    /** Overrides which old ids the stamp UPDATE confirms; defaults to all asked. */
    readonly stampConfirms?: readonly string[];
    /**
     * Overrides which PAIRS still collide at stamp time, as `newId->oldId` keys
     * (#5324). Defaults to every pair offered.
     *
     * A separate knob from {@link stampConfirms} because they model different
     * events with different visibility: a narrowed TARGET set is a retraction,
     * which the shortfall warning sees, while a narrowed PAIR set on a target
     * that stays stamped is a de-merge that the target-level count cannot
     * detect — which is the whole of #5324.
     */
    readonly livePairs?: readonly string[];
    /**
     * Stamped target ids to return with a NULL `new_id` — the LEFT JOIN arm
     * real Postgres cannot reach, injected so the adapter's fail-closed
     * response to it is drivable.
     */
    readonly stampUnattributed?: readonly string[];
    /** Make the identity-mutation lock raise `55P03`, as the bound's expiry does. */
    readonly lockTimesOut?: boolean;
    /**
     * `TIER_HELD_BACK_COUNT_SQL`'s single column (#5033). Defaults to 0 — the
     * overwhelmingly common answer, and the one that keeps every pre-#5033 test
     * in this file asserting exactly what it asserted before. Pass a string or
     * `null` to model the driver drift `readHeldBackCount` degrades on.
     */
    readonly heldBack?: number | string | null;
    /** Make the held-back COUNT itself fail, as a timeout or deadlock would. */
    readonly heldBackFails?: boolean;
    /** `CARDINALITY_HELD_BACK_COUNT_SQL`'s single column (#5027). */
    readonly uncurated?: number;
    readonly uncuratedFails?: boolean;
  } = {},
): {
  tx: ModeTxClient;
  calls: Call[];
  locks: LockCall[];
  bounds: BoundCall[];
  resets: BoundCall[];
  savepoints: string[];
} {
  const calls: Call[] = [];
  const locks: LockCall[] = [];
  const bounds: BoundCall[] = [];
  const resets: BoundCall[] = [];
  const savepoints: string[] = [];
  const tx: ModeTxClient = {
    query: async (sql, params = []) => {
      // The identity-mutation advisory lock (#5024) is recorded SEPARATELY, and
      // that is a deliberate shape rather than a convenience. It is not a
      // statement about a table: it has no `workspace_id = $1` and no
      // `invalidated_at IS NULL`, so folding it into `calls` would force every
      // "…on every statement" loop in this file to grow an exemption — and an
      // exemption in a loop is where the next statement that should have been
      // checked quietly stops being.
      //
      // `precededCalls` is the index it was taken at, which is what makes the
      // ORDER assertable rather than merely its presence. Answered with an empty
      // result because `pg_advisory_xact_lock` returns void and nothing reads it.
      if (sql === IDENTITY_MUTATION_LOCK_TIMEOUT_SQL) {
        bounds.push({ precededLocks: locks.length, precededCalls: calls.length });
        return { rows: [] };
      }
      if (sql === IDENTITY_MUTATION_LOCK_RESET_SQL) {
        resets.push({ precededLocks: locks.length, precededCalls: calls.length });
        return { rows: [] };
      }
      if (sql === IDENTITY_MUTATION_LOCK_SQL) {
        locks.push({ params, precededCalls: calls.length });
        // Injected contention: `pg_advisory_xact_lock` never errors on its own,
        // so the only way to reach the `55P03` branch is to make the DRIVER
        // raise what Postgres would raise when the bound expires.
        if (opts.lockTimesOut) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
        return { rows: [] };
      }
      // Transaction-control for #5033's advisory count. Matched on the
      // STATEMENT PREFIX and placed ahead of `calls`, on the advisory lock's
      // reasoning: these say nothing about a table, so folding them into
      // `calls` would force every "…on every statement" loop below to grow an
      // exemption.
      //
      // ⚠️ Ahead of the `held_back` arm too, and that ordering is load-bearing
      // rather than tidy: the savepoint is NAMED `brain_tier_held_back`, so
      // `sql.includes("held_back")` matches `SAVEPOINT brain_tier_held_back`
      // as well. Until this arm existed the double answered the savepoint with
      // a COUNT row and every supersession test passed while modelling neither
      // statement — a double agreeing with itself.
      if (/^\s*SAVEPOINT /i.test(sql) || /^\s*ROLLBACK TO SAVEPOINT /i.test(sql)) {
        savepoints.push(sql.trim());
        return { rows: [] };
      }
      calls.push({ sql, params });
      // ⚠️ Matched on statement IDENTITY, not on `/^UPDATE/` plus a substring,
      // and #5324 is why: the stamp is a `WITH … stamped AS (UPDATE …)` now, so
      // the regex below no longer sees it at all. The `held_back` discriminator
      // makes the general form of this argument twenty lines down — a substring
      // over a statement built from a shared builder is a claim about the whole
      // builder tree and goes stale silently.
      if (sql === SUPERSEDE_STAMP_SQL) {
        if (opts.failOnUpdate) throw new Error("update exploded");
        // The stamp RETURNs one row per (stamped target, still-colliding draft),
        // left-joined — so a target with no surviving pair would arrive with a
        // NULL `new_id`. Emulated faithfully rather than conveniently: a target
        // is stamped IFF one of its offered pairs is still live, which is the
        // property the statement's `EXISTS` has and a per-target double does not.
        const pairs = JSON.parse(String(params[2])) as readonly {
          readonly newId: string;
          readonly oldId: string;
        }[];
        const asked = params[1] as readonly string[];
        // Two knobs, because two different things can break between the targets
        // SELECT and the stamp. `stampConfirms` narrows by TARGET (a concurrent
        // retraction); `livePairs` narrows by PAIR (a de-merge that breaks one
        // of two pairs sharing one rival — #5324's case, invisible to the first).
        const confirmedTargets = opts.stampConfirms ?? asked;
        const liveKeys = opts.livePairs ?? pairs.map(stampPairKey);
        const live = pairs.filter(
          (pair) =>
            confirmedTargets.includes(pair.oldId) && liveKeys.includes(stampPairKey(pair)),
        );
        const rows: { id: string; new_id: string | null }[] = live.map((pair) => ({
          id: pair.oldId,
          new_id: pair.newId,
        }));
        // The LEFT JOIN's NULL arm, which real Postgres cannot produce here — a
        // live pair is WHY a row is stamped. Injectable so the adapter's
        // roll-back-rather-than-commit arm has something to be driven by.
        for (const id of opts.stampUnattributed ?? []) rows.push({ id, new_id: null });
        return { rows, rowCount: rows.length };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        if (opts.failOnUpdate) throw new Error("update exploded");
        // Emulate `pg`: a non-RETURNING UPDATE reports through `rowCount`. The
        // plain statement binds an id array; the widening one binds a jsonb
        // string of `{id, grant}` entries.
        const target = params[1];
        const rowCount = Array.isArray(target)
          ? target.length
          : (JSON.parse(String(target)) as readonly unknown[]).length;
        return { rows: [], rowCount };
      }
      if (/^\s*INSERT/i.test(sql)) {
        // The supersedes-edge batch insert RETURNs one id per inserted edge.
        const pairs = JSON.parse(String(params[1])) as readonly unknown[];
        return { rows: pairs.map((_, i) => ({ id: `edge-${i}` })) };
      }
      // TWO held-back diagnostics, and they must be told apart HERE rather than
      // by arrival order: both are `COUNT(*) … AS held_back` over the same
      // collision core, so a single `includes("held_back")` arm would answer
      // whichever ran first and hand the other the same number — the tier tests
      // below would then pass while reading the cardinality count, and neither
      // statement would be modelled by anything.
      //
      // Discriminated on statement IDENTITY, never on a substring. It used to
      // key on `IS NOT TRUE`, described here as "#5033's three-valued negation,
      // spelled nowhere else" — and #5032 spelled it somewhere else, inside
      // `collisionCorePredicate`, which BOTH statements are built from. The
      // discriminator then answered `tier` for both, and the tier test read a
      // rolled-back cardinality savepoint. A substring discriminator over two
      // statements that share a builder is a claim about the whole builder tree
      // and goes stale silently; `===` cannot.
      if (sql.includes("held_back")) {
        const tier = sql === TIER_HELD_BACK_COUNT_SQL;
        if (!tier && sql !== CARDINALITY_HELD_BACK_COUNT_SQL) {
          throw new Error(
            "a third `held_back` statement reached the tx double, or one of the two drifted from its exported constant — the discriminator cannot name it",
          );
        }
        if (tier && opts.heldBackFails) throw new Error("held-back count exploded");
        if (!tier && opts.uncuratedFails) throw new Error("uncurated count exploded");
        return { rows: [{ held_back: (tier ? opts.heldBack : opts.uncurated) ?? 0 }] };
      }
      if (sql.includes("superseded_id")) return { rows: [...(opts.supersessions ?? [])] };
      if (sql.includes("brain_edges")) return { rows: [...(opts.evidence ?? [])] };
      if (sql.includes("FOR UPDATE")) return { rows: [...drafts] };
      // Not a catch-all: a future eighth statement must FAIL here rather than
      // silently receive draft rows, which is how a shape mismatch would hide.
      throw new Error(`unrecognised statement in the tx double: ${sql}`);
    },
  };
  return { tx, calls, locks, bounds, resets, savepoints };
}

/** The UPDATE statements the adapter issued, in order. */
const updates = (calls: readonly Call[]): Call[] =>
  calls.filter((c) => /^\s*UPDATE/i.test(c.sql));

/** One `EVIDENCE_GRANTS_SQL` row: an episode grant attached to a draft fact. */
function evidenceFor(factId: string, visibleTo: readonly (string | null)[]) {
  return { fact_id: factId, visible_to: [...visibleTo] };
}

const EPISODE = "22222222-2222-4222-8222-222222222222";

/** A private channel's grant — one `org` is strictly wider than. */
const PRIVATE = "audience:chat-channel:slack:C0BKTMEDUN9";

function draft(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    subject: "acme",
    predicate: "uses",
    object: "postgres",
    source_episode_id: EPISODE,
    provenance: { actor: "slack:U1" },
    visible_to: ["org"],
    ...over,
  };
}

/**
 * A draft whose CANONICAL PREDICATE is declared `single` — the only kind that
 * can supersede (#4912, re-keyed by #5027).
 *
 * Identical to {@link draft} at the row level, and that is the whole point of
 * the slice: a draft carries no cardinality opinion any more, so nothing about
 * THIS fixture decides whether it supersedes. What decides is an approved
 * `brain_predicate_cardinality` entry, which lives in the database and which
 * these unit doubles do not have — so the doubles script the targets SELECT's
 * ANSWER (`supersessions`), and `cardinality-pg.test.ts` is where the entry's
 * presence or absence is falsified against real Postgres.
 *
 * Kept as a named alias rather than inlined so the tests below still SAY which
 * drafts they mean to be supersedable.
 */
function singleDraft(id: string, over: Record<string, unknown> = {}) {
  return draft(id, over);
}

const run = <A>(e: Effect.Effect<A, PublishPhaseError, never>) => Effect.runPromise(e);

describe("promoteBrainFacts", () => {
  it("promotes every promotable draft and reports the count", async () => {
    const { tx, calls } = txWithDrafts([draft("fact-a"), draft("fact-b")]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report).toEqual({
      table: "brain_facts",
      promoted: 2,
      refused: [],
      widened: [],
      superseded: [],
      // `0`, not absent (#5033) — this table HAS the concept, and the
      // distinction is the whole point of the field. These drafts are `multi`,
      // so the supersession block is never entered and the accumulator keeps
      // its declared value; the `-pg` suite is where a non-zero one is proven.
      supersessionHeldBack: 0,
    });
    // draft SELECT → targets SELECT → tier held-back COUNT → uncurated-cardinality
    // COUNT → evidence SELECT → one UPDATE (nothing widened). The two counts run
    // BEFORE the promote UPDATEs, beside the targets SELECT, so all three ask
    // the same question of the same rows.
    //
    // The two supersession reads used to be SKIPPED for a batch of `multi`
    // drafts, because the adapter could tell from the rows themselves that
    // none could supersede. It cannot any more and should not be able to
    // (#5027): a draft carries no cardinality opinion, so "does anything in
    // this batch collide" is a question only the database can answer. That is
    // one extra SELECT and one extra COUNT per publish — an admin action, not a
    // hot path — in exchange for deleting a stochastic gate on an irreversible
    // write.
    expect(calls).toHaveLength(6);
    expect(calls[0].params).toEqual(["ws-1"]);
    expect(calls[1].params).toEqual(["ws-1", ["fact-a", "fact-b"]]);
    expect(updates(calls)).toHaveLength(1);
    expect(updates(calls)[0].params).toEqual(["ws-1", ["fact-a", "fact-b"]]);
  });

  it("promotes the good drafts and refuses only the bad one", async () => {
    // The behaviour the whole design turns on: one malformed fact must not
    // hold back its siblings, and must not fail the workspace's publish.
    const { tx, calls } = txWithDrafts([
      draft("good"),
      draft("ungranted", { visible_to: ["everyone"] }),
    ]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(1);
    expect(report.refused?.map((r) => r.rowId)).toEqual(["ungranted"]);
    // The refused id is absent from the UPDATE's id list — the refusal is
    // enforced by what we ask Postgres to touch, not by a later filter.
    expect(updates(calls)[0].params[1]).toEqual(["good"]);
    // …and it is absent from the evidence lookup too, so a refused row's
    // episodes cannot widen anything.
    expect(calls[1].params[1]).toEqual(["good"]);
  });

  it("skips the UPDATE entirely when every draft is refused", async () => {
    const { tx, calls } = txWithDrafts([draft("bad", { visible_to: ["everyone"] })]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(0);
    expect(report.refused).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/SELECT/i);
  });

  it("skips the UPDATE when there are no drafts at all (the common case)", async () => {
    const { tx, calls } = txWithDrafts([]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report).toEqual({
      table: "brain_facts",
      promoted: 0,
      refused: [],
      widened: [],
      superseded: [],
      supersessionHeldBack: 0,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports `refused: []` / `widened: []` / `superseded: []` / `heldBack: 0` rather than omitting them", async () => {
    // `undefined` means "this table has no such concept"; `[]` (or `0`) means
    // "it does, and nothing happened this run". `admin-publish.ts`
    // distinguishes them.
    const { tx } = txWithDrafts([draft("ok")]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));
    expect(report.refused).toEqual([]);
    expect(report.widened).toEqual([]);
    expect(report.superseded).toEqual([]);
    // #5033's axis. `0` rather than absent is what lets a caller say "this
    // publish held nothing back" as distinct from "this table cannot hold
    // anything back" — and a publish that DID hold a pair back is otherwise
    // indistinguishable from one that found no collision at all.
    expect(report.supersessionHeldBack).toBe(0);
  });

  it("takes the draft-selection lock — read-then-write needs FOR UPDATE", async () => {
    // Without it, a concurrent publish could promote a row between our
    // classification and our UPDATE, dropping it from BOTH runs' counts.
    const { tx, calls } = txWithDrafts([draft("a")]);
    await run(promoteBrainFacts(tx, "ws-1"));
    expect(calls[0].sql).toMatch(/FOR UPDATE/i);
  });

  it("takes the identity-mutation lock BEFORE reading the drafts (#5024)", async () => {
    // `FOR UPDATE` above locks DRAFTS. The published rivals this phase stamps
    // `valid_to` on are not covered by it, so what serializes this phase against
    // an alias decision is the advisory lock — and it has to be held before the
    // collision set is read, not merely before it is written. A lock taken after
    // the read it protects is not a lock.
    const { tx, calls, locks } = txWithDrafts([draft("a")]);
    await run(promoteBrainFacts(tx, "ws-1"));

    expect(locks).toHaveLength(1);
    // ZERO statements preceded it — the strongest form of "before the drafts are
    // read", and it does not weaken if a statement is added ahead of the SELECT.
    expect(locks[0].precededCalls).toBe(0);
    expect(locks[0].params).toEqual([IDENTITY_MUTATION_LOCK_NAMESPACE, "ws-1"]);
    // Non-vacuous: the phase really did go on to read something.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("bounds the lock wait BEFORE taking it — an unbounded wait hangs publish with no requestId", async () => {
    // `pg_advisory_xact_lock` does not error on contention, it waits forever, so
    // the `catch` around it never runs for the failure that matters. Without the
    // bound a publish landing during an alias re-key hangs until the proxy kills
    // it: no log line, no `requestId`, no response — and `admin-publish.ts`'s
    // 500 path is never reached to report any of it.
    //
    // ORDER is the whole property. A `SET LOCAL lock_timeout` issued after the
    // acquisition it is meant to bound bounds nothing.
    const { tx, locks, bounds } = txWithDrafts([draft("a")]);
    await run(promoteBrainFacts(tx, "ws-1"));

    expect(bounds, "publish takes the identity lock with no lock_timeout bound").toHaveLength(1);
    expect(bounds[0].precededLocks).toBe(0);
    expect(locks).toHaveLength(1);
  });

  it("RESETS the bound immediately — `SET LOCAL` reverts at COMMIT, not at the next statement", async () => {
    // The half the first cut of this fix missed, and it is a behaviour change in
    // the wrong direction: left set, the 10s bound governs `DRAFT_FACTS_SQL`'s
    // `FOR UPDATE` (which exists to WAIT for a concurrent publish), the promote
    // UPDATEs, and `admin-publish.ts`'s phase-4 archive loop, which runs after
    // `runPublishPhases` returns. A publish that used to block for eleven
    // seconds and commit would instead roll back every row it had promoted.
    const { tx, resets, locks } = txWithDrafts([draft("a")]);
    await run(promoteBrainFacts(tx, "ws-1"));

    expect(resets, "the lock_timeout bound is never reset — it leaks to the whole transaction").toHaveLength(1);
    // AFTER the acquisition…
    expect(resets[0].precededLocks).toBe(1);
    // …and BEFORE any statement that touches a table. This second axis is the
    // one that matters, and its absence was a real hole: with `precededLocks`
    // alone, a reset displaced to after `DRAFT_FACTS_SQL` — leaking the bound
    // over the drafts read, both promote UPDATEs and the supersede stamp, which
    // is the exact harm the reset exists to prevent — passed this whole file.
    // Measured, not reasoned: the displacement was applied and all 54 tests
    // here stayed green.
    expect(
      resets[0].precededCalls,
      "the bound is reset only after a table statement has already run under it",
    ).toBe(0);
    expect(locks).toHaveLength(1);
  });

  it("names the contending operation when the bound expires, instead of relaying a bare 55P03", async () => {
    // The classification branch had no coverage at all: `isLockTimeout` reading
    // `code` off an `unknown`, and the retry-guidance message, both shipped
    // untested. A wrapped cause (so `code` sits one level down) or a typo'd
    // SQLSTATE would silently revert to the raw-error outcome the branch exists
    // to prevent.
    const { tx } = txWithDrafts([draft("a")], { lockTimesOut: true });

    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));

    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    expect(exit.left).toBeInstanceOf(PublishPhaseError);
    // Names WHAT is contending and that nothing was changed — the "actionable,
    // context-specific message + retry guidance" CLAUDE.md asks for, rather than
    // "canceling statement due to lock timeout".
    const message = String(exit.left.cause);
    expect(message).toContain("alias approval or removal is re-keying");
    expect(message).toContain("Nothing was changed");
    expect(message).toContain("Retry");
  });

  it("does NOT swallow a non-timeout lock failure into the retry message", async () => {
    // The positive control's mirror: `isLockTimeout` must be a classification,
    // not a catch-all. A connection failure at the same statement is not
    // retryable and must not be dressed up as one.
    const { tx } = txWithDrafts([draft("a")], {});
    const failing: ModeTxClient = {
      query: async (sql, params) => {
        if (sql === IDENTITY_MUTATION_LOCK_SQL) throw new Error("connection terminated unexpectedly");
        return tx.query(sql, params);
      },
    };

    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(failing, "ws-1")));

    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    // The RAW cause travels, unwrapped — so an operator sees the real fault
    // rather than a retry suggestion that will never succeed.
    const message = String(exit.left.cause);
    expect(message).toContain("connection terminated");
    expect(message).not.toContain("Retry in a few seconds");
  });

  it("takes the identity-mutation lock even when there is nothing to promote", async () => {
    // The positive control's mirror, and it is not pedantry: the natural
    // "optimization" is to lock only once there is work, which reintroduces
    // exactly the window the lock closes — the decision about whether there is
    // work is itself made from a read of the collision set.
    const { tx, locks } = txWithDrafts([]);
    await run(promoteBrainFacts(tx, "ws-1"));
    expect(locks).toHaveLength(1);
    expect(locks[0].precededCalls).toBe(0);
  });

  it("uses a namespace that is neither reconcile's nor the vocabulary's", () => {
    // 4771 would serialize publish against the extraction fiber, which this
    // module refuses at length ("Refuse the row, never the workspace"). 5022 is
    // held by the region importer for its whole edge-insert loop. Both are
    // spelled as literals rather than imported, so a rename cannot make this
    // test agree with a regression by construction.
    expect(IDENTITY_MUTATION_LOCK_NAMESPACE).not.toBe(4771);
    expect(IDENTITY_MUTATION_LOCK_NAMESPACE).not.toBe(5022);
  });

  it("scopes every statement to the workspace", async () => {
    // Including the evidence lookup, which is the one query whose output can
    // WIDEN a grant — an unscoped join there would let another tenant's episode
    // decide who can read this tenant's fact.
    const { tx, calls } = txWithDrafts([draft("a")], {
      evidence: [evidenceFor("a", ["org"])],
    });
    await run(promoteBrainFacts(tx, "ws-1"));
    for (const call of calls) {
      expect(call.sql).toContain("workspace_id = $1");
      expect(call.params[0]).toBe("ws-1");
    }
  });

  it("only ever promotes rows that are still drafts — on BOTH promote statements", async () => {
    // The widening statement carries extra weight here: `status = 'draft'` is
    // what stops a republish from rewriting an already-published fact's grant,
    // which ADR-0036 §T5 makes immutable per version.
    const { tx, calls } = txWithDrafts(
      [draft("plain"), draft("wide", { visible_to: [PRIVATE] })],
      { evidence: [evidenceFor("wide", ["org"])] },
    );
    await run(promoteBrainFacts(tx, "ws-1"));
    const updateCalls = updates(calls);
    expect(updateCalls).toHaveLength(2);
    for (const call of updateCalls) expect(call.sql).toContain("status = 'draft'");
  });

  it("excludes RETRACTED drafts from the select and both promote statements", async () => {
    // A fact with `invalidated_at` set is a retracted claim; promoting it would
    // stamp "reviewed and trusted" on something already withdrawn. Excluded in
    // the SELECT *and* the UPDATEs so they cannot disagree, and — critically —
    // in `brainFactsCountSql` too, so an excluded row does not become a
    // permanent unpromotable backlog nobody is told about.
    //
    // The evidence lookup is exempt by construction, not by omission: it is
    // keyed by the ids the SELECT already filtered, and `brain_edges` /
    // `brain_episodes` have no `invalidated_at` to filter on.
    const { tx, calls } = txWithDrafts(
      [draft("plain"), draft("wide", { visible_to: [PRIVATE] })],
      { evidence: [evidenceFor("wide", ["org"])] },
    );
    await run(promoteBrainFacts(tx, "ws-1"));
    for (const call of calls) {
      if (call.sql.includes("brain_edges")) continue;
      expect(call.sql).toContain("invalidated_at IS NULL");
    }
  });

  it("keeps the draft count in lockstep with what promotion considers", () => {
    expect(brainFactsCountSql("$1")).toContain("invalidated_at IS NULL");
    expect(brainFactsCountSql("$1")).toContain("status = 'draft'");
  });

  it("promotes a grant that is partly malformed but still enforceable", async () => {
    // `['user:u1','everyone']` is PROMOTABLE — the valid token does real work —
    // so it is not a refusal. The `logGrantAnomalies` OBSERVATION that comes
    // with it is asserted in `brain-facts-logging.test.ts`, which is the file
    // that mocks the logger; this one deliberately runs unmocked.
    const { tx } = txWithDrafts([draft("mixed", { visible_to: ["user:u1", "everyone"] })]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));
    expect(report.promoted).toBe(1);
    expect(report.refused).toEqual([]);
  });

  it("falls back to rows.length when the driver omits rowCount", async () => {
    // Test doubles that populate only `rows` must not report a false zero.
    const tx: ModeTxClient = {
      query: async (sql) => {
        if (/^\s*UPDATE/i.test(sql)) return { rows: [{ id: "a" }, { id: "b" }] };
        if (sql.includes("brain_edges")) return { rows: [] };
        return { rows: [draft("a"), draft("b")] };
      },
    };
    const report = await run(promoteBrainFacts(tx, "ws-1"));
    expect(report.promoted).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Publish-time grant widening (#4823)
// ══════════════════════════════════════════════════════════════════════

describe("promoteBrainFacts — grant widening from evidence", () => {
  it("publishes with the UNION when an evidence episode is granted more widely", async () => {
    const { tx, calls } = txWithDrafts([draft("c3", { visible_to: [PRIVATE] })], {
      evidence: [evidenceFor("c3", [PRIVATE]), evidenceFor("c3", ["org"])],
    });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(1);
    // Reported, not only logged: `admin-publish.ts` writes this into the
    // durable audit row, because a widened grant permanently changed who can
    // read a claim and no later publish revisits it.
    expect(report.widened).toEqual([{ rowId: "c3", added: ["org"] }]);
    const [update] = updates(calls);
    expect(update.sql).toContain("visible_to");
    // Append-only: the original token keeps its place, `org` follows it. The
    // pair is deliberate — collapsing to `['org']` would discard the record
    // that the claim was also made privately.
    expect(JSON.parse(String(update.params[1]))).toEqual([
      { id: "c3", grant: [PRIVATE, "org"] },
    ]);
  });

  it("never DROPS a token — a narrower episode cannot displace `org`", async () => {
    // The direction `reconcile.ts` was already safe in. It must stay a no-op:
    // a private restatement of a public claim cannot un-publish it.
    const { tx, calls } = txWithDrafts([draft("wide", { visible_to: ["org"] })], {
      evidence: [evidenceFor("wide", ["org"]), evidenceFor("wide", [PRIVATE])],
    });
    await run(promoteBrainFacts(tx, "ws-1"));

    // It DID widen — `org` plus the audience — because widening is a union and
    // the audience token is one more principal, not a replacement. What must
    // never happen is `org` disappearing.
    const [update] = updates(calls);
    const payload = JSON.parse(String(update.params[1])) as { grant: string[] }[];
    expect(payload[0].grant[0]).toBe("org");
    expect(payload[0].grant).toContain(PRIVATE);
  });

  it("splits the promote so only the widened rows are rewritten", async () => {
    const { tx, calls } = txWithDrafts(
      [draft("plain"), draft("wide", { visible_to: [PRIVATE] })],
      { evidence: [evidenceFor("wide", ["org"])] },
    );
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(2);
    const [plain, wide] = updates(calls);
    expect(plain.params[1]).toEqual(["plain"]);
    expect(plain.sql).not.toContain("visible_to");
    expect(JSON.parse(String(wide.params[1]))).toEqual([
      { id: "wide", grant: [PRIVATE, "org"] },
    ]);
  });

  it("records the pre-widening grant on the same UPDATE that overwrites it", async () => {
    // The WRITE half of #4836, asserted where it always runs. `promotion-pg`
    // proves the Postgres semantics (SET expressions evaluate against the OLD
    // row) but SKIPS silently without `TEST_DATABASE_URL` — so without this,
    // deleting the SET expression leaves the whole local suite green while the
    // fix becomes a no-op: the column stays NULL forever, which the read path
    // reads as "never widened" and discloses.
    //
    // COALESCE rather than a bare assignment: a region import writes `status`
    // verbatim (ADR-0024) and can land an already-widened fact back in
    // `draft`, and overwriting would then record the WIDER grant as the
    // original — disclosing to readers the first widening admitted.
    const { tx, calls } = txWithDrafts([draft("f", { visible_to: [PRIVATE] })], {
      evidence: [evidenceFor("f", ["org"])],
    });
    await run(promoteBrainFacts(tx, "ws-1"));

    const [widening] = updates(calls);
    expect(widening.sql).toContain(
      "pre_widening_visible_to = COALESCE(f.pre_widening_visible_to, f.visible_to)",
    );
  });

  it("leaves the pre-widening column alone on the plain promote", async () => {
    // The negative, and it is load-bearing rather than tidy: NULL is what the
    // read path treats as "disclose". A plain promote that started stamping
    // this column would withhold attribution across the entire corpus and
    // still pass the assertion above.
    const { tx, calls } = txWithDrafts([draft("plain")], { evidence: [] });
    await run(promoteBrainFacts(tx, "ws-1"));

    const [plain] = updates(calls);
    expect(plain.sql).not.toContain("pre_widening_visible_to");
  });

  it("does not copy MALFORMED evidence tokens into the fact's grant", async () => {
    // `everyone` grants nobody anything (`acl.ts`). Propagating it would spread
    // a grant anomaly into a second row for no reader's benefit.
    const { tx, calls } = txWithDrafts([draft("f", { visible_to: [PRIVATE] })], {
      evidence: [evidenceFor("f", ["everyone", "org", null])],
    });
    await run(promoteBrainFacts(tx, "ws-1"));

    expect(JSON.parse(String(updates(calls)[0].params[1]))).toEqual([
      { id: "f", grant: [PRIVATE, "org"] },
    ]);
  });

  it("adds a repeated evidence token only once", async () => {
    const { tx, calls } = txWithDrafts([draft("f", { visible_to: [PRIVATE] })], {
      evidence: [evidenceFor("f", ["org"]), evidenceFor("f", ["org", "role:admin"])],
    });
    await run(promoteBrainFacts(tx, "ws-1"));

    expect(JSON.parse(String(updates(calls)[0].params[1]))).toEqual([
      { id: "f", grant: [PRIVATE, "org", "role:admin"] },
    ]);
  });

  it("attributes evidence per fact — one draft's episodes never widen another's", async () => {
    const { tx, calls } = txWithDrafts(
      [draft("mine", { visible_to: [PRIVATE] }), draft("theirs", { visible_to: [PRIVATE] })],
      { evidence: [evidenceFor("mine", ["org"])] },
    );
    await run(promoteBrainFacts(tx, "ws-1"));

    const [plain, wide] = updates(calls);
    expect(plain.params[1]).toEqual(["theirs"]);
    expect(JSON.parse(String(wide.params[1]))).toEqual([
      { id: "mine", grant: [PRIVATE, "org"] },
    ]);
  });

  it("still promotes — with the narrower grant — when an evidence row is unusable", async () => {
    // Query drift on the evidence side is fail-CLOSED and must not fail the
    // phase: the fact publishes with its own grant, counted and accounted for.
    // (`brain-facts-logging.test.ts` asserts the warning that goes with it.)
    const { tx, calls } = txWithDrafts([draft("f", { visible_to: [PRIVATE] })], {
      evidence: [{ fact_id: "f", visible_to: "org" }, null],
    });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(1);
    expect(report.refused).toEqual([]);
    expect(updates(calls)[0].params[1]).toEqual(["f"]);
  });

  it("wraps a failing evidence lookup as a PublishPhaseError", async () => {
    const tx: ModeTxClient = {
      query: async (sql) => {
        if (sql.includes("brain_edges")) throw new Error("evidence exploded");
        return { rows: [draft("a")] };
      },
    };
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(exit.left).toBeInstanceOf(PublishPhaseError);
      expect(exit.left.phase).toBe("promote");
    }
  });
});

describe("promoteBrainFacts — failure surfaces as PublishPhaseError", () => {
  it("wraps a failing UPDATE so the caller can attribute the rollback", async () => {
    const { tx } = txWithDrafts([draft("a")], { failOnUpdate: true });
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(exit.left).toBeInstanceOf(PublishPhaseError);
      expect(exit.left.table).toBe("brain_facts");
      expect(exit.left.phase).toBe("promote");
    }
  });

  it("fails the phase — never silently skips — when a draft row has no usable id", async () => {
    // Query drift. Skipping the row would leave a draft unpromoted with no
    // refusal recorded, which is indistinguishable from success.
    const { tx } = txWithDrafts([{ source_episode_id: EPISODE, provenance: { a: 1 }, visible_to: ["org"] }]);
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(String(exit.left.cause)).toContain("no usable `id`");
    }
  });

  it("wraps a failing draft SELECT too", async () => {
    const tx: ModeTxClient = {
      query: async () => {
        throw new Error("select exploded");
      },
    };
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") expect(exit.left.phase).toBe("promote");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Human-gated supersession at the publish gate (#4912)
// ══════════════════════════════════════════════════════════════════════

describe("promoteBrainFacts — supersession (#4912)", () => {
  it("stamps the rival, writes the edge, and reports the pair — atomically with promotion", async () => {
    const { tx, calls } = txWithDrafts([singleDraft("new-1")], {
      supersessions: [{ draft_id: "new-1", superseded_id: "old-1" }],
    });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(1);
    expect(report.superseded).toEqual([{ rowId: "new-1", superseded: ["old-1"] }]);

    // Statement plan: draft SELECT → targets SELECT → evidence SELECT →
    // promote UPDATE → stamp UPDATE → edge INSERT.
    const targets = calls.find((c) => c.sql.includes("superseded_id"));
    expect(targets?.params).toEqual(["ws-1", ["new-1"]]);
    const stamp = calls.find((c) => c.sql.includes("valid_to = now()"));
    // THREE binds since #5024: the workspace, the ids to stamp, and — `$3` — the
    // set the re-check re-asks the question against, so the stamp does not trust
    // the targets SELECT's answer across the window a de-merger can land in.
    //
    // ⚠️ `$3` is the PAIR LIST since #5324, where it used to be the flat
    // promotable-draft id list. The per-target form could not attribute a stamp
    // to the draft that caused it; this one can, and the assertion below is what
    // says the two statements are bound from ONE value — the stamp that decides
    // an arbitration and the edge INSERT that records it get the same jsonb.
    expect(stamp?.params).toEqual([
      "ws-1",
      ["old-1"],
      JSON.stringify([{ newId: "new-1", oldId: "old-1" }]),
    ]);
    const edge = calls.find((c) => /^\s*INSERT/i.test(c.sql));
    expect(edge?.sql).toContain("'supersedes'");
    expect(JSON.parse(String(edge?.params[1]))).toEqual([{ newId: "new-1", oldId: "old-1" }]);
    // …and the pair the stamp was ASKED about is the pair the targets SELECT
    // produced. A stamp that re-checked against a different set would be a
    // second spelling of "what collides".
    const offeredDraftIds = targets?.params?.[1] as readonly string[] | undefined;
    expect(JSON.parse(String(stamp?.params?.[2]))).toEqual(
      (offeredDraftIds ?? []).map((newId) => ({ newId, oldId: "old-1" })),
    );
  });

  it("reads the collision targets BEFORE the promote UPDATEs — same-batch rivals must not see each other as published", async () => {
    const { tx, calls } = txWithDrafts([singleDraft("new-1")], {
      supersessions: [{ draft_id: "new-1", superseded_id: "old-1" }],
    });
    await run(promoteBrainFacts(tx, "ws-1"));

    const targetsIndex = calls.findIndex((c) => c.sql.includes("superseded_id"));
    const firstUpdateIndex = calls.findIndex((c) => /^\s*UPDATE/i.test(c.sql));
    expect(targetsIndex).toBeGreaterThanOrEqual(0);
    expect(targetsIndex).toBeLessThan(firstUpdateIndex);
  });

  it("offers EVERY promotable draft to the collision, and stamps nothing when none collides", async () => {
    // The shape #5027 replaced: the adapter used to pre-filter this list in
    // TypeScript to the drafts whose own `predicate_cardinality` said `single`,
    // and skip the round trip entirely when that subset was empty.
    //
    // There is nothing left to pre-filter ON — a draft carries no cardinality
    // opinion — so the question is now asked for every promotable row and
    // answered by the join's one lookup on the shared `predicate_key`. Nothing
    // widened: with no approved entry the join matches nothing, which is what
    // this double's empty `supersessions` stands for.
    const { tx, calls } = txWithDrafts([draft("m1"), draft("m2")], { supersessions: [] });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    const targets = calls.find((c) => c.sql.includes("superseded_id"));
    expect(targets?.params[1]).toEqual(["m1", "m2"]);
    // Asked, and answered "nothing" — so no belief is retired.
    expect(report.superseded).toEqual([]);
    expect(calls.some((c) => c.sql.includes("SET valid_to"))).toBe(false);
  });

  it("a REFUSED single draft supersedes nothing", async () => {
    // The targets list is the classified-promotable subset, so a draft the
    // gate refuses cannot retire a published belief on its way to not being
    // published.
    const { tx, calls } = txWithDrafts([singleDraft("bad", { visible_to: ["everyone"] })]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.refused).toHaveLength(1);
    expect(report.superseded).toEqual([]);
    expect(calls.some((c) => c.sql.includes("superseded_id"))).toBe(false);
  });

  it("no collision ⇒ no stamp, no edge, empty report", async () => {
    const { tx, calls } = txWithDrafts([singleDraft("new-1")], { supersessions: [] });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(1);
    expect(report.superseded).toEqual([]);
    expect(calls.some((c) => c.sql.includes("valid_to = now()"))).toBe(false);
    expect(calls.some((c) => /^\s*INSERT/i.test(c.sql))).toBe(false);
  });

  it("groups several rivals under the one promoted fact, and stamps each old id once", async () => {
    const { tx, calls } = txWithDrafts([singleDraft("new-1"), singleDraft("new-2")], {
      supersessions: [
        { draft_id: "new-1", superseded_id: "old-a" },
        { draft_id: "new-1", superseded_id: "old-b" },
        // The same incumbent contested by BOTH new facts: stamped once, but
        // recorded as two edges — each arbitration is its own record.
        { draft_id: "new-2", superseded_id: "old-a" },
      ],
    });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.superseded).toEqual([
      { rowId: "new-1", superseded: ["old-a", "old-b"] },
      { rowId: "new-2", superseded: ["old-a"] },
    ]);
    const stamp = calls.find((c) => c.sql.includes("valid_to = now()"));
    expect(stamp?.params[1]).toEqual(["old-a", "old-b"]);
    const edge = calls.find((c) => /^\s*INSERT/i.test(c.sql));
    expect(JSON.parse(String(edge?.params[1]))).toHaveLength(3);
  });

  it("drops — from edges AND the report — a pair whose stamp did not confirm", async () => {
    // Models a rival retracted between the collision check and the stamp: the
    // published side is not FOR-UPDATE locked, so the stamp re-checks its own
    // predicates and RETURNs only what it touched. An edge or a report entry
    // for an unstamped pair would be an arbitration record of an arbitration
    // that never happened.
    const { tx, calls } = txWithDrafts([singleDraft("new-1")], {
      supersessions: [
        { draft_id: "new-1", superseded_id: "old-kept" },
        { draft_id: "new-1", superseded_id: "old-retracted" },
      ],
      stampConfirms: ["old-kept"],
    });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.superseded).toEqual([{ rowId: "new-1", superseded: ["old-kept"] }]);
    const edge = calls.find((c) => /^\s*INSERT/i.test(c.sql));
    expect(JSON.parse(String(edge?.params[1]))).toEqual([
      { newId: "new-1", oldId: "old-kept" },
    ]);
  });

  /**
   * #5324 — the attribution half of the stamp guard.
   *
   * Two same-slot `single` drafts in one batch and ONE rival: a case
   * `SUPERSESSION_TARGETS_SQL`'s header discusses as real. A de-merge breaks
   * `new-2`'s pair while `new-1`'s still holds, so the rival IS retired — on
   * `new-1`'s arbitration, correctly — and the question is what the arbitration
   * RECORD says.
   *
   * ⚠️ **This is invisible to `stampConfirms`, and that is the point.** The
   * target set is unchanged: `old-1` is asked for and `old-1` is stamped, so the
   * shortfall warning stays silent and every pre-#5324 assertion in this file
   * still passes. What the per-target stamp could not do was tell the caller
   * WHICH pair did it, so `promoteBrainFacts` filtered on the target id and
   * recorded an edge for both — `new-2 supersedes old-1`, an arbitration that no
   * longer held.
   */
  it("records the supersedes edge only for the pair that still collided, not every pair sharing its target (#5324)", async () => {
    const { tx, calls } = txWithDrafts([singleDraft("new-1"), singleDraft("new-2")], {
      supersessions: [
        { draft_id: "new-1", superseded_id: "old-1" },
        { draft_id: "new-2", superseded_id: "old-1" },
      ],
      // `new-2`'s pair de-merged between the targets SELECT and the stamp — an
      // alias removal, or `entity-comparable-retire.ts` NULLing `object_cmp` on
      // a concurrent producer run (#5321). The TARGET set is untouched.
      livePairs: ["new-1->old-1"],
    });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    // The rival was retired — the stamp is not what changed.
    expect(report.promoted).toBe(2);
    // …and the record names only the arbitration that actually held.
    expect(report.superseded).toEqual([{ rowId: "new-1", superseded: ["old-1"] }]);
    const edge = calls.find((c) => /^\s*INSERT/i.test(c.sql));
    expect(
      JSON.parse(String(edge?.params[1])),
      "an edge was written for a pair that no longer collided — that is an arbitration record of an arbitration that never happened, and a reader auditing why `old-1` was retired is shown the wrong reason (#5324)",
    ).toEqual([{ newId: "new-1", oldId: "old-1" }]);
  });

  it("a stamped target this transaction cannot attribute rolls the whole publish back (#5324)", async () => {
    // The LEFT JOIN's NULL arm. It cannot happen under one snapshot — a live
    // pair is WHY a row is stamped — so what is under test is the RESPONSE: an
    // inner join would have dropped the row silently and left a belief retired
    // with no `supersedes` edge, which is the silent supersession #4912 forbids.
    const { tx } = txWithDrafts([singleDraft("new-1")], {
      supersessions: [{ draft_id: "new-1", superseded_id: "old-1" }],
      stampUnattributed: ["old-orphan"],
    });

    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(exit.left).toBeInstanceOf(PublishPhaseError);
      expect(exit.left.phase).toBe("promote");
      // The MESSAGE, because the two counters it reports are the whole
      // diagnostic: an unreadable `id` is the projection having changed, an
      // unattributed row is the CTE and the UPDATE disagreeing, and an operator
      // reading "the statement shape changed" needs to know which.
      expect(String(exit.left.cause)).toContain("no colliding draft to attribute them to");
    }
  });

  it("the draft projection carries no cardinality at all — there is nothing left to misread (#5027)", async () => {
    // This replaces a test that fed a draft row with the column DELETED and
    // asserted the adapter degraded to `multi`. That fallback existed because a
    // per-row cardinality could be misread; the column is not selected any more,
    // so the misreading it guarded against is unrepresentable rather than
    // handled — which is the shape of the whole slice.
    const { tx, calls } = txWithDrafts([draft("d1")], { supersessions: [] });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(1);
    // No statement the publish issues names the COLUMN — not the draft
    // projection, not the collision, not the stamp.
    //
    // ⚠️ Matched with a negative lookbehind, not `includes`. The new TABLE is
    // `brain_predicate_cardinality`, which contains `predicate_cardinality` as a
    // substring — so a plain `includes` check reports the column present on
    // every statement that reads the vocabulary, i.e. it is true of the fixed
    // code and would have been true of the broken code too. A substring assertion
    // that cannot distinguish the two states is not an assertion.
    const namesTheColumn = /(?<!brain_)predicate_cardinality/;
    expect(calls.filter((c) => namesTheColumn.test(c.sql)).map((c) => c.sql)).toEqual([]);
    // Positive control: the pattern DOES fire on the clause that was deleted, so
    // the emptiness above is evidence rather than a regex that matches nothing.
    expect(namesTheColumn.test("p.predicate_cardinality = 'single'")).toBe(true);
  });

  it("fails the phase when the stamp UPDATE throws — atomicity, not skip-and-warn", async () => {
    // The stamp is half of "atomically with promotion": if it cannot run, the
    // whole transaction must roll back rather than publish the new fact while
    // leaving the rival current. `failOnUpdate` cannot reach it (the promote
    // UPDATE fires first), so this double targets the stamp alone.
    const tx: ModeTxClient = {
      query: async (sql, params = []) => {
        if (/^\s*UPDATE/i.test(sql)) {
          if (sql.includes("valid_to = now()")) throw new Error("stamp exploded");
          const target = params[1];
          const rowCount = Array.isArray(target) ? target.length : 0;
          return { rows: [], rowCount };
        }
        if (sql.includes("superseded_id")) {
          return { rows: [{ draft_id: "new-1", superseded_id: "old-1" }] };
        }
        if (sql.includes("brain_edges")) return { rows: [] };
        return { rows: [singleDraft("new-1")] };
      },
    };
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(exit.left).toBeInstanceOf(PublishPhaseError);
      expect(exit.left.phase).toBe("promote");
    }
  });

  it("fails the phase when the edge INSERT throws — a stamp without its record must roll back", async () => {
    const tx: ModeTxClient = {
      query: async (sql, params = []) => {
        if (/^\s*INSERT/i.test(sql)) throw new Error("edge insert exploded");
        if (/^\s*UPDATE/i.test(sql)) {
          if (sql.includes("valid_to = now()")) {
            const ids = params[1] as readonly string[];
            return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
          }
          const target = params[1];
          const rowCount = Array.isArray(target) ? target.length : 0;
          return { rows: [], rowCount };
        }
        if (sql.includes("superseded_id")) {
          return { rows: [{ draft_id: "new-1", superseded_id: "old-1" }] };
        }
        if (sql.includes("brain_edges")) return { rows: [] };
        return { rows: [singleDraft("new-1")] };
      },
    };
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") expect(exit.left.phase).toBe("promote");
  });

  it("fails the phase — never a silent skip — when a stamp RETURNING row has no usable id", async () => {
    // The one drift path in the supersession arm that must NOT degrade: the
    // stamp COMMITTED for a fact this code can no longer name, so proceeding
    // would retire a belief with no edge and no audit record. Failing rolls
    // the stamp back with the rest of the transaction.
    const { tx } = txWithDrafts([singleDraft("new-1")], {
      supersessions: [{ draft_id: "new-1", superseded_id: "old-1" }],
    });
    const original = tx.query.bind(tx);
    tx.query = async (sql, params) => {
      if (sql.includes("valid_to = now()")) return { rows: [{ nope: true }], rowCount: 1 };
      return original(sql, params);
    };
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(String(exit.left.cause)).toContain("no usable id");
    }
  });

  it("pins the collision join's invariants in the SQL itself", () => {
    // The join is shared with the two disclosure surfaces, so these strings are
    // the contract: the canonical predicate declared single, the rival
    // published, live, and current, and only a PROVABLY DIFFERENT object
    // collides.
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.status = 'published'");
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.invalidated_at IS NULL");
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.valid_to IS NULL");
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.object_cmp <> d.object_cmp");
    // The subject arm on the STAMPING statement, and its POLARITY. `<>` alone
    // would pass whether the arm enables or suppresses — and enabling is the
    // failure ADR-0037 §5 names: `valid_to` stamped between two claims the store
    // has just proven are about different entities. `IS NOT TRUE` is the wrapper
    // that makes it a suppression, and never `NOT (…)`, which is NULL for the
    // whole abstain band and a `WHERE` reads NULL as false.
    // The WHOLE arm, from the builder. It works today as two substrings only
    // because `SUPERSESSION_TARGETS_SQL` happens to contain `)) IS NOT TRUE`
    // exactly once — and this same diff removed that pattern from three tx
    // doubles for going stale the moment a shared builder grew the spelling.
    // Reintroducing it here would have been the same defect one file over.
    expect(SUPERSESSION_TARGETS_SQL).toContain(
      subjectNotDifferentSql("p.subject_cmp", "d.subject_cmp"),
    );
    expect(SUPERSESSION_TARGETS_SQL).not.toContain("p.subject_cmp = d.subject_cmp");
  });

  it("the both-sides cardinality clause is GONE, replaced by one lookup (#5027)", () => {
    // The load-bearing assertion of ADR-0037 §3, and it has to be spelled as a
    // PROHIBITION rather than as a presence check.
    //
    // The clause it removes was `p.predicate_cardinality = 'single' AND
    // d.predicate_cardinality = 'single'` — two rows in one slot each carrying
    // an opinion, each opinion an independent LLM guess against a prompt biased
    // toward `multi`, so supersession fired at roughly P(model says `single`)².
    // Restoring EITHER arm re-creates it, and restoring it would look like a
    // safety tightening: an extra `= 'single'` reads as a narrower guard.
    for (const alias of ["p", "d"]) {
      expect(
        SUPERSESSION_TARGETS_SQL.includes(`${alias}.predicate_cardinality`),
        `the collision join is reading a per-ROW cardinality again for alias \`${alias}\` — that is a stochastic gate on an irreversible \`valid_to\` stamp, not a tighter one (ADR-0037 §3)`,
      ).toBe(false);
    }

    // What replaced it: ONE correlated lookup on the shared canonical
    // predicate, which is what makes the two sides unable to disagree.
    expect(SUPERSESSION_TARGETS_SQL).toContain("FROM brain_predicate_cardinality c");
    expect(SUPERSESSION_TARGETS_SQL).toContain("c.predicate_key = d.predicate_key");
    expect(SUPERSESSION_TARGETS_SQL).toContain("c.cardinality = 'single'");

    // `status = 'approved'` is not decoration. A `pending` row is the
    // correction-event proposer's output — a repeat-gated heuristic — and
    // reading it here would let that heuristic stamp `valid_to` with no human
    // anywhere in the loop, which is exactly what ADR-0037 §3(d) exists to stop.
    expect(
      SUPERSESSION_TARGETS_SQL,
      "the collision join stopped filtering cardinality entries to `approved` — a producer's PROPOSAL would then retire published beliefs with no human decision behind it",
    ).toContain("c.status = 'approved'");
  });

  it("the IRREVERSIBLE stamp re-asks the cardinality question too", () => {
    // `SUPERSEDE_STAMP_SQL` re-checks the whole collision from inside an
    // EXISTS, because the published rows are not covered by `DRAFT_FACTS_SQL`'s
    // FOR UPDATE. Asserted directly rather than through the builder, on the
    // tier guard's precedent one test up: both sides of a builder comparison
    // move together, so a hoist that dropped this arm from the re-check alone
    // would leave every other assertion green.
    expect(
      SUPERSEDE_STAMP_SQL,
      "the `valid_to` stamp's collision re-check lost the cardinality lookup — the statement that actually writes the irreversible column must re-ask the whole question",
    ).toContain("FROM brain_predicate_cardinality c");
  });

  it("requires POSITIVE evidence of difference, never a failure to match (#5030)", () => {
    // The narrowing, pinned as a REPLACEMENT. `object_key <> object_key` proves
    // only that two surfaces did not normalize together — true of `$499` and
    // `499 USD`, one belief spelled twice — and this is the statement that
    // stamps `valid_to`, for which the product has no inverse verb. Restoring
    // the key arm here is the single change that would make supersession
    // over-fire again, and it would look like a bug fix, because it makes
    // entity-valued rivals start superseding again.
    expect(
      SUPERSESSION_TARGETS_SQL.includes("object_key <>"),
      "the collision join is back on `object_key <>` — that is a failure to prove SAMENESS, not evidence of DIFFERENCE, and it stamps `valid_to` on beliefs nothing contradicted (ADR-0037 §2)",
    ).toBe(false);

    // The tag arm, whose deletion is invisible in every fixture that does not
    // MIX types in one slot. Without it `number:499` and `money:USD:499` read
    // as different and publish stamps over a producer that declared a currency
    // where another did not — reachable the day any producer declares one.
    expect(SUPERSESSION_TARGETS_SQL).toContain(
      "split_part(p.object_cmp, ':', 1) = split_part(d.object_cmp, ':', 1)",
    );
    // …the known-tag membership arm, and the separator arms beside it. This is
    // the statement that actually stamps `valid_to`, and both arms guard the
    // same class: a value no reader can interpret must never read as *provably
    // different*. `split_part` returns the whole string for a separator-less
    // value, so the membership test alone lets a bare tag name through —
    // measured on PG 16 before the `strpos` arms landed.
    expect(SUPERSESSION_TARGETS_SQL).toContain("split_part(p.object_cmp, ':', 1) IN ('money',");
    expect(SUPERSESSION_TARGETS_SQL).toContain("strpos(p.object_cmp, ':') > 0");
    expect(SUPERSESSION_TARGETS_SQL).toContain("strpos(d.object_cmp, ':') > 0");

    // And the grouping. Every arm of the difference test is `AND`-ed, so the
    // parentheses are redundant TODAY — they are what stops a later `OR` arm
    // (a restored key fallback is the obvious one) from binding looser than the
    // conjunction and re-widening the whole join. Migration 0187's `WHERE`
    // clause carries the same parenthesization for the same reason, and its
    // header records that the unparenthesized shape passed every assertion.
    expect(SUPERSESSION_TARGETS_SQL).toContain(
      "AND (p.object_cmp <> d.object_cmp\n      AND split_part(",
    );
  });

  it("guards the TIER on both sides, as an allowlist over the vocabulary (#5033)", () => {
    // The behavioural proof is `identity-consumers-pg.test.ts`'s
    // `tier-guarded-rival` block, which runs this join against a real schema
    // over five fixtures. These assertions pin the two properties that block
    // cannot see, because a corpus entry can only exercise the vocabulary that
    // exists today.
    //
    // 1. BOTH aliases. The guard is symmetric (ADR-0037 §4): a warehouse draft
    //    must not stamp an extracted incumbent either. Applying it to `p` alone
    //    is the natural half-implementation, and it reads as complete.
    for (const alias of ["p", "d"]) {
      expect(
        SUPERSESSION_TARGETS_SQL,
        `the tier guard is missing for alias \`${alias}\` — supersession is symmetric, and half a guard admits the direction ADR-0037 §4 calls autonomous supersession with the sympathetic side winning`,
      ).toContain(`${alias}.provenance->>'source' = ANY (ARRAY[`);
    }

    // 2. An ALLOWLIST, not `<> 'warehouse'`. The list is derived from the
    //    vocabulary's declared classes, so this is also what keeps a future
    //    warehouse-class member (`snowflake`) out of it without a second edit —
    //    and the derivation is asserted in `brain/__tests__/sources.test.ts`.
    //    The non-emptiness check is not ceremony: an empty list would make the
    //    loop below assert nothing while `ARRAY[]::text[]` still satisfies the
    //    `= ANY (ARRAY[` match above, so the whole assertion would go vacuous
    //    in the one direction that also silently disables supersession.
    expect(NON_WAREHOUSE_SOURCES.length).toBeGreaterThan(0);
    for (const source of NON_WAREHOUSE_SOURCES) {
      expect(SUPERSESSION_TARGETS_SQL).toContain(`'${source}'`);
    }
    // No warehouse-CLASS member may be in the array — its absence IS the guard.
    // Asserted on the DERIVATION rather than by grepping the statement for
    // `warehouse`: a legitimately non-warehouse future member spelled
    // `warehouse_notes` (declared `class: "human"`) belongs in the allowlist,
    // and a string grep would fail it with a message accusing the author of
    // deleting the guard.
    for (const source of NON_WAREHOUSE_SOURCES) {
      expect(
        [source, isWarehouseDerivedSource(source)],
        "a warehouse-class source is in the collision join's allowlist — that is the tier guard deleted, spelled as an addition",
      ).toEqual([source, false]);
    }

    // 3. The absent-key carve-out, which is the arm a reader would delete as
    //    redundant. `provenance->>'source'` is NULL for a row with no `source`
    //    key, and `NULL = ANY (…)` is NULL — so without this disjunct the guard
    //    silently stops such a row superseding OR being superseded. That shape
    //    predates the tier lane and no import ever touched it;
    //    `correction.ts`'s `unrecognizedSourceKind` makes exactly the same
    //    carve-out, in as many words, and calls closing it *a regression
    //    dressed as a fix*. `promotion-pg.test.ts` is where it is falsified.
    for (const alias of ["p", "d"]) {
      expect(SUPERSESSION_TARGETS_SQL).toContain(`NOT jsonb_exists(${alias}.provenance, 'source')`);
    }

    // 4. The IRREVERSIBLE statement carries the guard too, asserted DIRECTLY
    //    rather than through the builder. The test below proves the stamp's
    //    re-check `toContain(supersessionCollisionPredicate("d","p"))` — but
    //    both sides of that comparison come from one builder, so it moves with
    //    any change to it. Concretely: hoist the tier arms out of
    //    `supersessionCollisionPredicate` and into `supersessionCollisionJoin`
    //    — a plausible tidy-up, since the docstring calls this the collision
    //    JOIN's guard — and the targets SELECT keeps them, every `-pg` fixture
    //    keeps passing (the stamp only ever sees rows the targets SELECT
    //    already filtered), the builder comparison keeps passing, and the
    //    re-check silently loses its tier arm.
    for (const alias of ["p", "d"]) {
      expect(
        SUPERSEDE_STAMP_SQL,
        `the \`valid_to\` stamp's collision re-check lost the tier guard for alias \`${alias}\` — the statement that actually writes the irreversible column must re-ask the whole question, not a subset of it`,
      ).toContain(`${alias}.provenance->>'source' = ANY (ARRAY[`);
    }
  });

  it("the held-back diagnostic is the collision's COMPLEMENT, not a second copy of it (#5033)", () => {
    // The statement exists because a tier-blocked pair otherwise leaves no
    // trace at all. What it must not become is a second spelling of "what
    // collides" — the drift `supersessionCollisionJoin`'s header forbids at
    // length — so it is built from the same two pieces as the shipped
    // predicate: the identity core, plus the same tier arms, negated.
    //
    // Asserted by CONSTRUCTION rather than by re-listing arms: every arm of the
    // targets SELECT's join that is not a tier arm must appear here verbatim.
    for (const arm of [
      "p.subject_key = d.subject_key",
      "p.predicate_key = d.predicate_key",
      "p.object_cmp <> d.object_cmp",
      // ⚠️ The SUBJECT arm (#5032), and its absence here was a real gap rather
      // than an omission of taste: MEASURED, deleting
      // `subjectNotDifferentSql` from `collisionCorePredicate` was green on
      // every suite a default `bun run test` executes — this file loads the
      // publish adapter and already pins the object arm three lines up, so it
      // was the natural owner and did not own it. Note the `shippedArms` loop
      // below cannot close this: both sides of that comparison are built from
      // `collisionCorePredicate`, so a deleted arm vanishes from both and the
      // loop stays green.
      "p.subject_cmp <> d.subject_cmp",
      "c.cardinality = 'single'",
      "c.status = 'approved'",
      "p.status = 'published'",
      "p.valid_to IS NULL",
    ]) {
      expect(
        TIER_HELD_BACK_COUNT_SQL,
        `the held-back count and the collision join disagree about \`${arm}\` — the diagnostic would then report pairs the transaction never considered, or miss ones it did`,
      ).toContain(arm);
    }

    // It runs before the promote UPDATEs, so it carries the draft-side
    // predicate exactly as the targets SELECT does — the two must ask about the
    // same rows for their answers to partition the collisions.
    expect(TIER_HELD_BACK_COUNT_SQL).toContain(supersedingDraftPredicate("d"));
    // …and it is scoped to the SAME draft id list the targets SELECT was given.
    // Measured: replacing this arm with a param-preserving no-op broke no test
    // in any of the four suites, and the consequence is a false alarm in a
    // durable record — held-back pairs counted for drafts this publish never
    // offered (classifier-refused ones, or leftovers from a prior batch),
    // reported as "provable collisions were NOT superseded".
    expect(TIER_HELD_BACK_COUNT_SQL).toContain("d.id = ANY($2::uuid[])");

    // …and the OTHER direction, which the arm list above cannot give: the
    // shipped predicate must be the core PLUS the two tier arms and NOTHING
    // else. Without this, an arm added directly to
    // `supersessionCollisionPredicate` — a plausible place to put one — breaks
    // the partition silently: the diagnostic would then count pairs that never
    // would have collided anyway and report them as "provable collisions were
    // NOT superseded", a false alarm claiming beliefs were withheld when
    // nothing was.
    //
    // Asserted arm by arm rather than as a PREFIX. A prefix match catches only
    // an arm inserted between the core and the first tier arm; appending one
    // AFTER the tier arms — the natural place to append — was measured to break
    // nothing in any of the four suites.
    const tierArm = (alias: string) => `(NOT jsonb_exists(${alias}.provenance, 'source')`;
    const shippedArms = supersessionCollisionPredicate("d", "p")
      .split("\n     AND ")
      .map((arm) => arm.trim());
    for (const arm of shippedArms) {
      // The two tier arms are the ONLY ones the count may not share — it
      // negates them. Everything else must appear verbatim.
      if (arm.startsWith(tierArm("p")) || arm.startsWith(tierArm("d"))) continue;
      expect(
        TIER_HELD_BACK_COUNT_SQL,
        `the collision predicate carries an arm the held-back count does not (\`${arm}\`) — the two no longer partition the collisions, so the diagnostic will report pairs the transaction never considered`,
      ).toContain(arm);
    }
    // The tier arms really are exactly two, so the skip above cannot silently
    // swallow a third arm someone spelled to look like one.
    expect(
      shippedArms.filter((arm) => arm.startsWith(tierArm("p")) || arm.startsWith(tierArm("d"))),
    ).toHaveLength(2);

    // ⚠️ `IS NOT TRUE`, never `NOT (…)`. `supersedableTierSql` is SQL NULL — not
    // false — for a `{"source": null}` provenance, so `NOT (…)` drops exactly
    // the population the guard is subtlest about and the diagnostic would go
    // blind to it. This repo has already paid for the same distinction in
    // `objectNotSameSql` and again in `subjectNotDifferentSql`.
    //
    // Pinned on the TIER negation specifically, not on a bare `) IS NOT TRUE`.
    // That looser spelling stopped meaning anything at #5032: the subject arm
    // inside `collisionCorePredicate` spells it too, so weakening THIS negation
    // to `NOT (…)` would have left the assertion green on somebody else's arm.
    //
    // Reconstructed from the arms extracted above rather than re-spelled —
    // `supersedableTierSql` is private, and a hand-written copy here would be
    // the second spelling this whole block exists to forbid.
    const tierArms = shippedArms.filter(
      (arm) => arm.startsWith(tierArm("p")) || arm.startsWith(tierArm("d")),
    );
    expect(TIER_HELD_BACK_COUNT_SQL).toContain(
      `AND (${tierArms[0]} AND ${tierArms[1]}) IS NOT TRUE`,
    );
    expect(
      /AND NOT \(\(NOT jsonb_exists/.test(TIER_HELD_BACK_COUNT_SQL),
      "the held-back count negates the tier guard with `NOT (…)` — that is NULL for a null-valued `source`, so the one population this diagnostic most needs to see disappears from it",
    ).toBe(false);
  });

  it("the held-back count runs behind a SAVEPOINT and cannot fail the publish (#5033)", async () => {
    // The statement produces one log line and one report field. Everything else
    // in this transaction is the publish, and `admin-publish.ts` runs every
    // adapter inside ONE transaction — so an unguarded failure here would roll
    // back a complete, correct publish because a diagnostic could not be
    // computed. Postgres also aborts the whole transaction on any statement
    // error (`25P02`), which is why a bare catch is not enough and the
    // savepoint is.
    const { tx, calls, savepoints } = txWithDrafts([singleDraft("a")], {
      supersessions: [],
      heldBackFails: true,
    });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    // The publish COMMITS, and reports the promotion it really performed.
    expect(report.promoted).toBe(1);
    // `null` — UNKNOWN, never a fabricated 0 and never a failure. A durable
    // record saying "nothing was held back" on no evidence would re-create the
    // ambiguity the field exists to remove.
    expect(report.supersessionHeldBack).toBeNull();
    // The savepoint was taken and rolled back to, in that order. Without the
    // ROLLBACK the transaction stays aborted and every later statement fails,
    // so its presence is the whole mechanism rather than a detail.
    // The tier savepoint was taken and rolled back to, and the SECOND
    // diagnostic then ran inside its OWN savepoint rather than inheriting the
    // aborted state — which is why they are not one savepoint: a shared one
    // would leave the transaction aborted after the first failure and the
    // second statement would fail for a reason that has nothing to do with it.
    expect(savepoints).toEqual([
      "SAVEPOINT brain_tier_held_back",
      "ROLLBACK TO SAVEPOINT brain_tier_held_back",
      "SAVEPOINT brain_cardinality_held_back",
    ]);
    // …and the promote UPDATE still ran AFTER the rollback.
    expect(updates(calls)).toHaveLength(1);
  });

  it("the SECOND diagnostic can fail independently — which is why they are two savepoints (#5027)", async () => {
    // The other direction, and without it the two-savepoint decision is proven
    // one way only. A SHARED savepoint would leave the transaction aborted after
    // the first diagnostic failed, so the second would fail for a reason that
    // has nothing to do with it — and here the first SUCCEEDS, so a shared
    // savepoint would look fine until the day the tier count is the one that
    // breaks.
    const { tx, calls, savepoints } = txWithDrafts([singleDraft("a")], {
      supersessions: [],
      heldBack: 2,
      uncuratedFails: true,
    });
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    // The publish COMMITS, and the FIRST diagnostic's answer survives the
    // second one's failure — a shared savepoint would have rolled it back.
    expect(report.promoted).toBe(1);
    expect(report.supersessionHeldBack).toBe(2);
    expect(savepoints).toEqual([
      "SAVEPOINT brain_tier_held_back",
      "SAVEPOINT brain_cardinality_held_back",
      "ROLLBACK TO SAVEPOINT brain_cardinality_held_back",
    ]);
    expect(updates(calls)).toHaveLength(1);
  });

  it("collides on the identity keys and on no surface column (#5020)", () => {
    // The pivot, asserted as a REPLACEMENT rather than an addition. Matching
    // both would let a surface arm survive beside a key arm, which is the one
    // shape that reads as fixed and is not: an AND-ed `p.subject = d.subject`
    // re-imposes byte-exactness on top of the key and the join silently
    // no-ops on exactly the phrasing mismatch #5020 exists to close.
    // The WHOLE arm, both sides — `p.subject_key = d.subject` contains
    // `p.subject_key` and is a mixed arm that silently restores byte-exactness
    // on one side of the comparison.
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.subject_key = d.subject_key");
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.predicate_key = d.predicate_key");
    // The object arm moved off the key entirely in #5030 — see the test above
    // for why. It is still a materialized column and still never a surface, so
    // the surface sweep below covers it on the same terms.
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.object_cmp <> d.object_cmp");
    // A slot column can only be named `<role>_key` here, so a bare `p.subject`
    // is a surviving surface arm. `\b` alone is enough — `_` is a word
    // character, so `\bp\.subject\b` cannot match inside `p.subject_key`; the
    // `(?!_key)` is belt-and-braces against a future `-`-separated spelling.
    // BOTH aliases are swept, which is what the mixed arm above needs.
    for (const alias of ["p", "d"]) {
      for (const surface of ["subject", "predicate", "object"]) {
        expect(
          new RegExp(`\\b${alias}\\.${surface}\\b(?!_key)`).test(SUPERSESSION_TARGETS_SQL),
          `the collision join still compares ${alias}'s ${surface} SURFACE. Identity is the materialized key (ADR-0037 §1); a surface arm — even on ONE side of a comparison whose other side is a key — restores the byte-exactness the keys replaced, and the join goes back to no-op'ing on a phrasing mismatch.`,
        ).toBe(false);
      }
    }
  });

  it("supersession is NOT retraction — the stamp never touches the tombstone or the review verdict", () => {
    // `invalidated_at` may appear only as a WHERE predicate; the SET list is
    // `valid_to` + `updated_at` and nothing else. A stamp that also tombstoned
    // would delete the fact from as-of reads, which supersession must not do.
    //
    // Sliced from the UPDATE rather than from the start of the statement: since
    // #5324 the collision stamp OPENS with the `live_pair` CTE, which names
    // `invalidated_at` and `status` legitimately (it re-evaluates the whole
    // collision). A `slice(0, indexOf("WHERE"))` over the whole string would
    // therefore read the CTE as the SET list and fail on a correct statement —
    // and, worse, would keep passing if the CTE were ever removed.
    const update = SUPERSEDE_STAMP_SQL.slice(SUPERSEDE_STAMP_SQL.indexOf("  UPDATE brain_facts p"));
    const setList = update.slice(0, update.indexOf("WHERE"));
    expect(setList).toContain("valid_to = now()");
    expect(setList).not.toContain("invalidated_at");
    expect(setList).not.toContain("status");
    // And it re-checks every predicate so it is correct standalone.
    expect(SUPERSEDE_STAMP_SQL).toContain("status = 'published'");
    expect(SUPERSEDE_STAMP_SQL).toContain("invalidated_at IS NULL");
    expect(SUPERSEDE_STAMP_SQL).toContain("valid_to IS NULL");
  });

  it("the collision stamp CONTAINS the explicit stamp plus one predicate — one spelling of the valid_to write", () => {
    // #4912 requires ONE spelling of the `valid_to` write; #5024 needed publish
    // to re-check the collision and `correct_fact` not to, because a human
    // correction has no colliding draft and never did. Both come out of one
    // builder (`stampUpdateSql`), and this is what says so: the collision
    // statement contains the explicit statement CHARACTER FOR CHARACTER with the
    // re-check spliced in ahead of `RETURNING`, and nothing else changed.
    //
    // Comparing the STRINGS rather than asserting each carries the same
    // predicates — a checklist would pass while the two SET clauses drifted, and
    // the SET clause is the write.
    //
    // ⚠️ `toContain` where this used to be `toBe`, because #5324 made the
    // collision arm WRAP the shared UPDATE in a CTE rather than merely extend
    // it. That is a real weakening of one assertion and it is paid for by the
    // splice being exact: the only permitted difference is `RECHECK`, so a
    // second SET clause or a changed target predicate still fails here.
    const RECHECK = `
     AND EXISTS (
       SELECT 1
         FROM live_pair lp
        WHERE lp.old_id = p.id)`;
    expect(SUPERSEDE_STAMP_EXPLICIT_SQL).toContain("\n   RETURNING");
    expect(SUPERSEDE_STAMP_SQL).toContain(
      SUPERSEDE_STAMP_EXPLICIT_SQL.replace("\n   RETURNING", `${RECHECK}\n   RETURNING`),
    );

    // The explicit arm has no `$3`, so `correction.ts` binding two params is not
    // an under-supply that Postgres would reject.
    expect(SUPERSEDE_STAMP_EXPLICIT_SQL).not.toContain("$3");
    // …and the collision arm's `$3` is the PAIR LIST (#5324), which is what makes
    // the re-check per-pair. A `$3::uuid[]` here is the per-target form restored.
    expect(SUPERSEDE_STAMP_SQL).toContain("jsonb_array_elements($3::jsonb)");
    expect(
      SUPERSEDE_STAMP_SQL.includes("$3::uuid[]"),
      "the stamp is back on a flat `$3::uuid[]` draft list — that is the per-TARGET re-check, which cannot attribute a stamp to the draft that caused it (#5324)",
    ).toBe(false);
  });

  it("the collision re-check uses the SAME arms as the targets SELECT, and drops only the draft-side one", () => {
    // The re-check must not be a paraphrase — `supersessionCollisionPredicate`
    // is the one place the arms are written, and this proves the stamp got them
    // from there rather than restating them. Since #5324 the arms live in the
    // `live_pair` CTE rather than inline in the `EXISTS`; what must not change is
    // that they are the SAME arms and that they are evaluated inside the one
    // statement that writes.
    const cte = SUPERSEDE_STAMP_SQL.slice(
      SUPERSEDE_STAMP_SQL.indexOf("  live_pair AS ("),
      SUPERSEDE_STAMP_SQL.indexOf("  stamped AS ("),
    );
    expect(cte).toContain(supersessionCollisionPredicate("d", "p"));

    // …and that it deliberately does NOT carry the draft-side predicate. The
    // stamp runs AFTER the promote UPDATEs, so every superseding row is
    // `published` by then and `d.status = 'draft'` would match zero rows —
    // silently disabling the whole guard while looking stricter than the
    // alternative. This is the assertion that would have caught it.
    expect(cte).not.toContain(supersedingDraftPredicate("d"));
    expect(cte).not.toContain("d.status = 'draft'");

    // ⚠️ ONE statement, and that is the property #5324 rests on rather than a
    // formatting note: Postgres gives every arm of a `WITH` the same snapshot,
    // so the pair list and the stamp decision cannot disagree. Splitting this
    // into a SELECT followed by an UPDATE re-opens the READ COMMITTED window
    // #5024 closed — each statement takes a fresh snapshot — while looking like
    // a readability fix.
    expect(SUPERSEDE_STAMP_SQL.trim().startsWith("WITH offered_pair AS (")).toBe(true);
    expect(SUPERSEDE_STAMP_SQL.split(";")).toHaveLength(1);
  });
});

describe("brainFactStatusClause / readFilter", () => {
  it("gates non-admin reads to published", () => {
    expect(brainFactStatusClause("published", "f")).toBe("f.status = 'published'");
    expect(brainFactStatusClause(undefined, "f")).toBe("f.status = 'published'");
  });

  it("overlays draft+published in developer mode", () => {
    expect(brainFactStatusClause("developer", "f")).toBe(
      "f.status IN ('published', 'draft')",
    );
  });

  it("is the same definition the REGISTERED entry exposes", async () => {
    // One statement of the read gate. The tuple's `readFilter` delegates to the
    // helper rather than restating the clause — a parallel copy would let the
    // agent's published-mode read and this helper drift apart silently.
    const registry = makeService(CONTENT_MODE_TABLES);
    for (const mode of ["published", "developer"] as const) {
      expect(await Effect.runPromise(registry.readFilter("brain_facts", mode, "f"))).toBe(
        brainFactStatusClause(mode, "f"),
      );
    }
  });
});

describe("registration", () => {
  it("registers under exactly the table name the adapter reports", () => {
    // `tables.ts` spells the key as a LITERAL (the ESM-cycle TDZ forbids
    // importing the const), and `promotedCountsFromReports` matches an exotic
    // entry's `key` against the report's `table`. A drift between the two
    // spellings would silently report 0 promoted facts forever, so it is
    // pinned here rather than left to the duplication being obviously fine.
    const entry = CONTENT_MODE_TABLES.find((e) => e.key === BRAIN_FACTS_TABLE);
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("exotic");
  });

  it("does NOT register brain_episodes — evidence is not review-gated", async () => {
    // 0180 gives `brain_episodes` no `status` column at all: episodes are
    // append-only evidence, and only the CLAIMS drawn from them ride the gate.
    // Registering it would emit SQL against a column that does not exist.
    const registry = makeService(CONTENT_MODE_TABLES);
    const exit = await Effect.runPromise(
      Effect.either(registry.readFilter("brain_episodes", "published", "e")),
    );
    expect(exit._tag).toBe("Left");
  });
});
