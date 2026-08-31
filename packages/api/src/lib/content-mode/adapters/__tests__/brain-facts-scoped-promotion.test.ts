/**
 * **Scoped promotion applies the same policy as unscoped promotion** (#5568).
 *
 * `promoteBrainFacts` grew an optional `factIds` scope so an approve can be
 * *addressable* — ADR-0043 promises the Company Keystone wizard's confirmation
 * screen is "the review gate wearing a friendlier skin — same table, **same
 * promotion adapter**, same audit row", which is unsatisfiable while the
 * adapter can only publish a workspace's entire draft backlog.
 *
 * The scope is therefore a **carve-out from "every publish is the one atomic
 * workspace-wide transaction"** (`docs/development/content-mode.md`), and a
 * carve-out is only as good as the thing it promises not to change. What it
 * promises is that the scope narrows WHICH rows are judged and nothing about
 * HOW: the same `classifyFactForPromotion` refusals, the same evidence-driven
 * grant widening, the same supersession stamping and edges, the same report.
 *
 * ## Why this file exists rather than one more case in `brain-facts.test.ts`
 *
 * A test that asserted the scoped arm's outcomes against hand-written
 * expectations would be a SECOND statement of the policy — and a second
 * statement of a policy is the thing that drifts. So every assertion here is a
 * COMPARISON: one fixture table of drafts, evidence, collisions and held-back
 * pairs; both arms run over it; the scoped report is checked against the
 * unscoped report's own answer for the same rows. If the policy changes, both
 * arms change together and these tests stay green — which is exactly right,
 * because the claim is equality, not any particular outcome.
 *
 * ⚠️ **The transaction double filters on the bound id lists**, rather than
 * answering every SELECT with the whole fixture. That is load-bearing: a double
 * that ignored `$2` would make the two arms identical by construction and this
 * whole file would prove nothing.
 *
 * The live-database half — that a real `id = ANY($2::uuid[])` reaches the same
 * rows against real `FOR UPDATE` semantics — is `lib/brain/__tests__/promotion-pg.test.ts`
 * territory. What is pinned HERE is the adapter's own contract.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  CARDINALITY_HELD_BACK_COUNT_SQL,
  DRAFT_FACTS_SCOPED_SQL,
  DRAFT_FACTS_SQL,
  SUPERSEDE_STAMP_SQL,
  TIER_HELD_BACK_COUNT_SQL,
  promoteBrainFacts,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import {
  IDENTITY_MUTATION_LOCK_RESET_SQL,
  IDENTITY_MUTATION_LOCK_SQL,
  IDENTITY_MUTATION_LOCK_TIMEOUT_SQL,
} from "@atlas/api/lib/brain/identity";
import type { PublishPhaseError, ModeTxClient } from "@atlas/api/lib/content-mode/port";

const WORKSPACE = "ws-1";
const EPISODE = "22222222-2222-4222-8222-222222222222";

/** A private channel's grant — one `org` is strictly wider than. */
const PRIVATE = "audience:chat-channel:slack:C0BKTMEDUN9";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

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
 * The one fixture table both arms run over.
 *
 * Chosen so the subset scope below straddles every per-fact arm of the policy
 * at once — a refusal, a widening, and a supersession — because a scope that
 * only ever covered plain promotions could not tell whether the other arms
 * survived being filtered.
 */
const DRAFTS = [
  /** Plain: promotes, no evidence, no rival. */
  draft("alpha"),
  /** Widens: privately granted, with `org`-granted evidence behind it (#4823). */
  draft("beta", { visible_to: [PRIVATE] }),
  /** Refused: `everyone` is storable and grants nobody — `GRANT_UNUSABLE`. */
  draft("gamma", { visible_to: ["everyone"] }),
  /** Supersedes a published rival (#4912). */
  draft("delta"),
  /** Plain, and present only so "everything else in the workspace" is non-empty. */
  draft("epsilon"),
] as const;

/** `EVIDENCE_GRANTS_SQL` rows, keyed by the fact they are evidence for. */
const EVIDENCE = [{ fact_id: "beta", visible_to: ["org"] }] as const;

/** `SUPERSESSION_TARGETS_SQL` rows: which draft retires which published rival. */
const SUPERSESSIONS = [{ draft_id: "delta", superseded_id: "old-delta" }] as const;

/**
 * Drafts the tier guard would report as provably-collided-but-withheld (#5033).
 *
 * Modelled as a per-draft SET rather than a flat number precisely so the count
 * the double returns is a FUNCTION of the offered ids — see the note on
 * {@link txOver}. A constant here would hide the one place the two arms are
 * legitimately allowed to disagree.
 */
const TIER_HELD_BACK_DRAFTS = new Set(["epsilon"]);

const stampPairKey = (pair: { readonly newId: string; readonly oldId: string }) =>
  `${pair.newId}->${pair.oldId}`;

/**
 * A transaction double over {@link DRAFTS} that answers each statement from the
 * ids that statement actually bound.
 *
 * Every arm filters. `DRAFT_FACTS_SCOPED_SQL` returns the fixture rows named by
 * `$2`; the targets SELECT, both held-back counts and the evidence join all
 * answer only about the ids they were handed. That is what real Postgres does,
 * and modelling it is the whole reason a comparison between the two arms means
 * anything.
 */
function txOver(): { tx: ModeTxClient; calls: Call[] } {
  const calls: Call[] = [];
  const tx: ModeTxClient = {
    query: async (sql, params = []) => {
      if (
        sql === IDENTITY_MUTATION_LOCK_TIMEOUT_SQL ||
        sql === IDENTITY_MUTATION_LOCK_RESET_SQL ||
        sql === IDENTITY_MUTATION_LOCK_SQL ||
        /^\s*(SAVEPOINT|ROLLBACK TO SAVEPOINT) /i.test(sql)
      ) {
        return { rows: [] };
      }
      calls.push({ sql, params });

      // The two draft reads, discriminated on statement IDENTITY. `===` rather
      // than a substring: both statements share a projection and a `FOR
      // UPDATE`, so any substring wide enough to match one matches the other
      // and the double would answer the scoped read with the whole workspace —
      // the exact failure this file exists to rule out.
      if (sql === DRAFT_FACTS_SQL) return { rows: [...DRAFTS] };
      if (sql === DRAFT_FACTS_SCOPED_SQL) {
        const scope = params[1] as readonly string[];
        return { rows: DRAFTS.filter((row) => scope.includes(row.id)) };
      }

      if (sql === SUPERSEDE_STAMP_SQL) {
        const pairs = JSON.parse(String(params[2])) as readonly {
          readonly newId: string;
          readonly oldId: string;
        }[];
        return {
          rows: pairs.map((pair) => ({ id: pair.oldId, new_id: pair.newId })),
          rowCount: pairs.length,
        };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        const target = params[1];
        const rowCount = Array.isArray(target)
          ? target.length
          : (JSON.parse(String(target)) as readonly unknown[]).length;
        return { rows: [], rowCount };
      }
      if (/^\s*INSERT/i.test(sql)) {
        const pairs = JSON.parse(String(params[1])) as readonly unknown[];
        return { rows: pairs.map((_, i) => ({ id: `edge-${i}` })) };
      }
      if (sql === TIER_HELD_BACK_COUNT_SQL) {
        const offered = params[1] as readonly string[];
        return {
          rows: [{ held_back: offered.filter((id) => TIER_HELD_BACK_DRAFTS.has(id)).length }],
        };
      }
      if (sql === CARDINALITY_HELD_BACK_COUNT_SQL) return { rows: [{ held_back: 0 }] };
      if (sql.includes("superseded_id")) {
        const offered = params[1] as readonly string[];
        return { rows: SUPERSESSIONS.filter((row) => offered.includes(row.draft_id)) };
      }
      if (sql.includes("brain_edges")) {
        const offered = params[1] as readonly string[];
        return { rows: EVIDENCE.filter((row) => offered.includes(row.fact_id)) };
      }
      throw new Error(`unrecognised statement in the scoped-promotion double: ${sql}`);
    },
  };
  return { tx, calls };
}

const run = <A>(e: Effect.Effect<A, PublishPhaseError, never>) => Effect.runPromise(e);

/** Both arms over one fresh double each, so neither can see the other's calls. */
async function bothArms(scope?: readonly string[]) {
  const unscoped = txOver();
  const scoped = txOver();
  return {
    unscoped: await run(promoteBrainFacts(unscoped.tx, WORKSPACE)),
    unscopedCalls: unscoped.calls,
    scoped: await run(promoteBrainFacts(scoped.tx, WORKSPACE, scope)),
    scopedCalls: scoped.calls,
  };
}

describe("scoped promotion — the policy is the unscoped one, filtered (#5568)", () => {
  it("a scope naming every draft is indistinguishable from no scope at all", async () => {
    // ⭐ The strongest form of the claim, and the one an implementation that
    // forgot an arm cannot pass: same rows in, byte-identical report out. Every
    // per-fact opinion — refusal, widening, supersession — is inside this
    // comparison, so an arm that silently skipped on the scoped path would show
    // up here as a diff rather than as a gap nobody wrote a test for.
    const { unscoped, scoped } = await bothArms(DRAFTS.map((row) => row.id));
    expect(scoped).toEqual(unscoped);
  });

  it("issues the scoped read only when scoped, and the unscoped read only when not", async () => {
    // The carve-out's byte-equivalence promise, asserted on the statement the
    // workspace-wide publish phase actually runs: an unscoped call must reach
    // `DRAFT_FACTS_SQL` with exactly `[orgId]`, unchanged by this slice.
    const { unscopedCalls, scopedCalls } = await bothArms(["alpha"]);

    expect(unscopedCalls[0].sql).toBe(DRAFT_FACTS_SQL);
    expect(unscopedCalls[0].params).toEqual([WORKSPACE]);
    expect(unscopedCalls.some((c) => c.sql === DRAFT_FACTS_SCOPED_SQL)).toBe(false);

    expect(scopedCalls[0].sql).toBe(DRAFT_FACTS_SCOPED_SQL);
    expect(scopedCalls[0].params).toEqual([WORKSPACE, ["alpha"]]);
    expect(scopedCalls.some((c) => c.sql === DRAFT_FACTS_SQL)).toBe(false);
  });

  describe("a subset scope straddling a refusal, a widening and a supersession", () => {
    /** One id per per-fact arm of the policy, plus none of the rest. */
    const SUBSET = ["beta", "gamma", "delta"] as const;

    it("refuses the same fact for the same reasons", async () => {
      const { unscoped, scoped } = await bothArms(SUBSET);
      expect(scoped.refused).toEqual(
        (unscoped.refused ?? []).filter((r) => SUBSET.includes(r.rowId as (typeof SUBSET)[number])),
      );
      // …and it is a real refusal being compared, not two empty lists agreeing.
      expect(scoped.refused?.map((r) => r.rowId)).toEqual(["gamma"]);
    });

    it("widens the same grant by the same principals", async () => {
      const { unscoped, scoped } = await bothArms(SUBSET);
      expect(scoped.widened).toEqual(
        (unscoped.widened ?? []).filter((w) => SUBSET.includes(w.rowId as (typeof SUBSET)[number])),
      );
      expect(scoped.widened?.map((w) => w.rowId)).toEqual(["beta"]);
    });

    it("supersedes the same published rival, and records the same edge pair", async () => {
      const { unscoped, scoped, scopedCalls } = await bothArms(SUBSET);
      expect(scoped.superseded).toEqual(
        (unscoped.superseded ?? []).filter((s) =>
          SUBSET.includes(s.rowId as (typeof SUBSET)[number]),
        ),
      );
      expect(scoped.superseded).toEqual([{ rowId: "delta", superseded: ["old-delta"] }]);
      // The arbitration RECORD, not only the report: a scoped approve that
      // stamped `valid_to` without writing the `supersedes` edge would retire a
      // belief with no graph trace, which is the one outcome #4912 forbids.
      const edges = scopedCalls.filter((c) => /^\s*INSERT/i.test(c.sql));
      expect(edges).toHaveLength(1);
      expect(JSON.parse(String(edges[0].params[1]))).toEqual([
        { newId: "delta", oldId: "old-delta" },
      ]);
      expect(stampPairKey({ newId: "delta", oldId: "old-delta" })).toBe("delta->old-delta");
    });

    it("promotes exactly the scoped subset, in the unscoped arm's order", async () => {
      const { unscoped, scoped } = await bothArms(SUBSET);
      // Order matters: `promotedIds` rides into the durable audit row, so two
      // runs over the same rows must not write two different arrays.
      expect(scoped.promotedIds).toEqual(
        (unscoped.promotedIds ?? []).filter((id) =>
          SUBSET.includes(id as (typeof SUBSET)[number]),
        ),
      );
      expect(scoped.promoted).toBe(2); // beta + delta; gamma was refused
      expect(unscoped.promoted).toBe(4);
    });

    it("never touches a row outside the scope, on any statement", async () => {
      // The carve-out's actual promise to the tenant, asserted at the level it
      // has to hold: not "the report omits them" but "no statement was handed
      // their id". `alpha` and `epsilon` are promotable and would have been
      // published by the unscoped arm.
      const { scopedCalls } = await bothArms(SUBSET);
      const outside = ["alpha", "epsilon"];
      for (const call of scopedCalls) {
        const bound = JSON.stringify(call.params);
        for (const id of outside) {
          expect(bound).not.toContain(id);
        }
      }
    });

    it("counts held-back collisions over the offered rows only — the one honest divergence", async () => {
      // NOT an equality, and it is here rather than absent because the
      // difference is the point. `supersessionHeldBack` answers "of the drafts
      // this transaction offered, how many provable collisions did the tier
      // guard withhold" — so a narrower offer is a smaller number, and a scoped
      // approve that reported the workspace-wide count would be describing work
      // it did not do. `epsilon` is the held-back draft and is outside SUBSET.
      const { unscoped, scoped } = await bothArms(SUBSET);
      expect(unscoped.supersessionHeldBack).toBe(1);
      expect(scoped.supersessionHeldBack).toBe(0);
    });
  });

  describe("the two draft statements share one body (#5568)", () => {
    /**
     * The unscoped statement, pinned as a literal.
     *
     * ⚠️ Deliberately hand-written rather than derived from `draftFactsSql()`,
     * which would make the assertion `x === x`. This is the byte-equivalence
     * promise the carve-out rests on — the workspace-wide publish phase issues
     * the statement it issued before the scope existed — so it has to be
     * checkable against something that does not move when the builder does.
     */
    const PINNED_UNSCOPED = `
  SELECT id::text AS id,
         subject,
         predicate,
         object,
         source_episode_id::text AS source_episode_id,
         provenance,
         visible_to
    FROM brain_facts
   WHERE workspace_id = $1
     AND status = 'draft'
     AND invalidated_at IS NULL
   ORDER BY ingested_at
     FOR UPDATE
`;

    it("leaves the unscoped statement byte-identical to what publish issued before", () => {
      expect(DRAFT_FACTS_SQL).toBe(PINNED_UNSCOPED);
    });

    it("differs by exactly the one scope predicate, and nothing else", () => {
      // ⭐ The assertion the shared builder exists for. When the two statements
      // were separate literals, adding a column to the projection reached the
      // unscoped arm only — and the scoped arm would then classify every fact
      // against a row missing it. No behavioural test can catch that: a
      // transaction double answers both statements from the same fixture rows
      // regardless of what each one projects. So the guarantee has to be made
      // about the STATEMENTS, here.
      const unscoped = DRAFT_FACTS_SQL.split("\n");
      const scoped = DRAFT_FACTS_SCOPED_SQL.split("\n");
      const added = scoped.filter((line) => !unscoped.includes(line));
      const removed = unscoped.filter((line) => !scoped.includes(line));

      expect(added).toEqual(["     AND id = ANY($2::uuid[])"]);
      expect(removed).toEqual([]);
      expect(scoped.length).toBe(unscoped.length + 1);
    });
  });

  describe("the empty scope", () => {
    it("approves NOTHING, and is not a spelling of unscoped", async () => {
      // ⚠️ The footgun this parameter is most likely to be misused into: a
      // reviewer ticks no boxes, the caller passes `[]`, and a permissive
      // `factIds?.length ? … : …` publishes the tenant's entire backlog. The
      // adapter distinguishes `undefined` from `[]`, and this is what says so.
      const { tx, calls } = txOver();
      const report = await run(promoteBrainFacts(tx, WORKSPACE, []));

      expect(report.promoted).toBe(0);
      expect(report.promotedIds).toEqual([]);
      expect(report.refused).toEqual([]);
      expect(report.widened).toEqual([]);
      expect(report.superseded).toEqual([]);
      // One statement — the scoped read — and no UPDATE at all.
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toBe(DRAFT_FACTS_SCOPED_SQL);
      expect(calls[0].params).toEqual([WORKSPACE, []]);
    });
  });

  describe("ids the scope names that are not promotable drafts", () => {
    it("promotes the rest rather than failing, and reports which landed", async () => {
      // Already-published, retracted and out-of-workspace ids are all
      // legitimately absent — a reviewer on a slightly stale page must still be
      // able to approve the rows that ARE there. `promotedIds` is the caller's
      // answer to "which of mine landed".
      const { tx } = txOver();
      const report = await run(
        promoteBrainFacts(tx, WORKSPACE, ["alpha", "not-a-draft", "also-gone"]),
      );

      expect(report.promoted).toBe(1);
      expect(report.promotedIds).toEqual(["alpha"]);
      expect(report.refused).toEqual([]);
    });

    it("deduplicates a repeated id rather than binding it twice", async () => {
      const { tx, calls } = txOver();
      const report = await run(promoteBrainFacts(tx, WORKSPACE, ["alpha", "alpha"]));

      expect(calls[0].params).toEqual([WORKSPACE, ["alpha"]]);
      expect(report.promotedIds).toEqual(["alpha"]);
      expect(report.promoted).toBe(1);
    });
  });
});
