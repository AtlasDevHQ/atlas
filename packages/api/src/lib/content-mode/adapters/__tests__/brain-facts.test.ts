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
 * A transaction double that answers the draft SELECT and the evidence-grants
 * SELECT (#4823), and records every call.
 *
 * Routed on the SQL rather than on call ORDER: the adapter now issues up to
 * four statements and an index-keyed double would silently feed draft rows to
 * the evidence query the moment the plan changed again.
 */
function txWithDrafts(
  drafts: readonly unknown[],
  opts: { readonly failOnUpdate?: boolean; readonly evidence?: readonly unknown[] } = {},
): { tx: ModeTxClient; calls: Call[] } {
  const calls: Call[] = [];
  const tx: ModeTxClient = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
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
      if (sql.includes("brain_edges")) return { rows: [...(opts.evidence ?? [])] };
      if (sql.includes("FOR UPDATE")) return { rows: [...drafts] };
      // Not a catch-all: a future fifth statement must FAIL here rather than
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
    ...over,
  };
}

const run = <A>(e: Effect.Effect<A, PublishPhaseError, never>) => Effect.runPromise(e);

describe("promoteBrainFacts", () => {
  it("promotes every promotable draft and reports the count", async () => {
    const { tx, calls } = txWithDrafts([draft("fact-a"), draft("fact-b")]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report).toEqual({ table: "brain_facts", promoted: 2, refused: [], widened: [] });
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

    expect(report).toEqual({ table: "brain_facts", promoted: 0, refused: [], widened: [] });
    expect(calls).toHaveLength(1);
  });

  it("reports `refused: []` / `widened: []` rather than omitting them", async () => {
    // `undefined` means "this table has no such concept"; `[]` means "it does,
    // and nothing happened this run". `admin-publish.ts` distinguishes them.
    const { tx } = txWithDrafts([draft("ok")]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));
    expect(report.refused).toEqual([]);
    expect(report.widened).toEqual([]);
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
