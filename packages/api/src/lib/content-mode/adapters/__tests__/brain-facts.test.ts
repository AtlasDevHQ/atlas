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
  SUPERSEDE_STAMP_SQL,
  SUPERSESSION_TARGETS_SQL,
  brainFactStatusClause,
  brainFactsCountSql,
  promoteBrainFacts,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import { PublishPhaseError, type ModeTxClient } from "@atlas/api/lib/content-mode/port";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A transaction double that answers the draft SELECT, the evidence-grants
 * SELECT (#4823), and the supersession trio (#4912), and records every call.
 *
 * Routed on the SQL rather than on call ORDER: the adapter now issues up to
 * seven statements and an index-keyed double would silently feed draft rows to
 * the evidence query the moment the plan changed again.
 */
function txWithDrafts(
  drafts: readonly unknown[],
  opts: {
    readonly failOnUpdate?: boolean;
    readonly evidence?: readonly unknown[];
    /** `SUPERSESSION_TARGETS_SQL` rows: `{ draft_id, superseded_id }`. */
    readonly supersessions?: readonly unknown[];
    /** Overrides which old ids the stamp UPDATE confirms; defaults to all asked. */
    readonly stampConfirms?: readonly string[];
  } = {},
): { tx: ModeTxClient; calls: Call[] } {
  const calls: Call[] = [];
  const tx: ModeTxClient = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/^\s*UPDATE/i.test(sql)) {
        if (opts.failOnUpdate) throw new Error("update exploded");
        if (sql.includes("valid_to = now()")) {
          // The supersession stamp RETURNs the ids it actually stamped;
          // emulate pg by confirming every requested id unless a test narrows
          // it to model a concurrent retraction.
          const asked = params[1] as readonly string[];
          const confirmed = opts.stampConfirms ?? asked;
          return {
            rows: asked.filter((id) => confirmed.includes(id)).map((id) => ({ id })),
            rowCount: confirmed.length,
          };
        }
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
      if (sql.includes("superseded_id")) return { rows: [...(opts.supersessions ?? [])] };
      if (sql.includes("brain_edges")) return { rows: [...(opts.evidence ?? [])] };
      if (sql.includes("FOR UPDATE")) return { rows: [...drafts] };
      // Not a catch-all: a future eighth statement must FAIL here rather than
      // silently receive draft rows, which is how a shape mismatch would hide.
      throw new Error(`unrecognised statement in the tx double: ${sql}`);
    },
  };
  return { tx, calls };
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
    // The schema default, and the arm that never supersedes (#4912) — so every
    // pre-supersession test keeps its exact statement plan.
    predicate_cardinality: "multi",
    ...over,
  };
}

/** A `single`-cardinality draft — the only kind that can supersede (#4912). */
function singleDraft(id: string, over: Record<string, unknown> = {}) {
  return draft(id, { predicate_cardinality: "single", ...over });
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
    });
    // draft SELECT → evidence SELECT → one UPDATE (nothing widened).
    expect(calls).toHaveLength(3);
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
    });
    expect(calls).toHaveLength(1);
  });

  it("reports `refused: []` / `widened: []` / `superseded: []` rather than omitting them", async () => {
    // `undefined` means "this table has no such concept"; `[]` means "it does,
    // and nothing happened this run". `admin-publish.ts` distinguishes them.
    const { tx } = txWithDrafts([draft("ok")]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));
    expect(report.refused).toEqual([]);
    expect(report.widened).toEqual([]);
    expect(report.superseded).toEqual([]);
  });

  it("takes the draft-selection lock — read-then-write needs FOR UPDATE", async () => {
    // Without it, a concurrent publish could promote a row between our
    // classification and our UPDATE, dropping it from BOTH runs' counts.
    const { tx, calls } = txWithDrafts([draft("a")]);
    await run(promoteBrainFacts(tx, "ws-1"));
    expect(calls[0].sql).toMatch(/FOR UPDATE/i);
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
    expect(stamp?.params).toEqual(["ws-1", ["old-1"]]);
    const edge = calls.find((c) => /^\s*INSERT/i.test(c.sql));
    expect(edge?.sql).toContain("'supersedes'");
    expect(JSON.parse(String(edge?.params[1]))).toEqual([{ newId: "new-1", oldId: "old-1" }]);
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

  it("never even asks about collisions for a multi-cardinality batch", async () => {
    // `multi` values coexist and corroborate — the promotion must not spend a
    // round trip on a question whose answer it may not act on.
    const { tx, calls } = txWithDrafts([draft("m1"), draft("m2")]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.superseded).toEqual([]);
    expect(calls.some((c) => c.sql.includes("superseded_id"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("valid_to"))).toBe(false);
  });

  it("scopes the targets query to the single-cardinality drafts only", async () => {
    const { tx, calls } = txWithDrafts([draft("multi-1"), singleDraft("single-1")], {
      supersessions: [],
    });
    await run(promoteBrainFacts(tx, "ws-1"));

    const targets = calls.find((c) => c.sql.includes("superseded_id"));
    expect(targets?.params[1]).toEqual(["single-1"]);
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

  it("treats a draft with an unreadable cardinality as `multi` — it coexists, never destroys", async () => {
    // The conservative fallback (`draftCardinality`): a row missing the column
    // is query drift, and drift must not be able to retire a published belief.
    // No supersession statement runs at all.
    const missing = { ...draft("drifted") } as Record<string, unknown>;
    delete missing.predicate_cardinality;
    const { tx, calls } = txWithDrafts([missing]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(1);
    expect(report.superseded).toEqual([]);
    expect(calls.some((c) => c.sql.includes("superseded_id"))).toBe(false);
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
    // the contract: BOTH sides single, the rival published, live, and current,
    // and only a DIFFERENT object collides (same object = corroboration).
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.predicate_cardinality = 'single'");
    expect(SUPERSESSION_TARGETS_SQL).toContain("d.predicate_cardinality = 'single'");
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.status = 'published'");
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.invalidated_at IS NULL");
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.valid_to IS NULL");
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.object_key <> d.object_key");
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
    expect(SUPERSESSION_TARGETS_SQL).toContain("p.object_key <> d.object_key");
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
    const setList = SUPERSEDE_STAMP_SQL.slice(0, SUPERSEDE_STAMP_SQL.indexOf("WHERE"));
    expect(setList).toContain("valid_to = now()");
    expect(setList).not.toContain("invalidated_at");
    expect(setList).not.toContain("status");
    // And it re-checks every predicate so it is correct standalone.
    expect(SUPERSEDE_STAMP_SQL).toContain("status = 'published'");
    expect(SUPERSEDE_STAMP_SQL).toContain("invalidated_at IS NULL");
    expect(SUPERSEDE_STAMP_SQL).toContain("valid_to IS NULL");
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
