/**
 * The "log" half of the brain-facts promotion adapter (#4769).
 *
 * Split into its own file for the same reason `lib/brain/__tests__/acl-logging.test.ts`
 * is: asserting on a logger needs `mock.module("@atlas/api/lib/logger")` installed
 * before the module under test is imported, and the sibling adapter suite
 * deliberately runs with no module mocking at all.
 *
 * Why it is worth a file. Every log line here is the ONLY artifact of its
 * event, and each could be deleted with every other suite staying green:
 *
 *   - `logGrantAnomalies` is what makes a partly-malformed grant OBSERVABLE.
 *     Such a grant is promotable (its one valid token does real work), so no
 *     refusal records it; the module header claims promotion is where the other
 *     half of #4797's gap narrows, and this call is that claim's entire
 *     substance. An earlier cut of the sibling test captured `console.warn` and
 *     never asserted on it — which pinned nothing, and would not have noticed
 *     that the logger doesn't write to `console.warn` in the first place.
 *   - The promoted-vs-classified divergence warn fires only when the `FOR UPDATE`
 *     assumption has broken. Rows in that state are neither promoted-and-counted
 *     nor refused-and-reported: the exact silent under-report this adapter
 *     exists to prevent.
 *   - The tier-guard held-back line (#5033) reports a collision that was found,
 *     proven, and then deliberately NOT acted on. Nothing else records it: the
 *     pair is filtered inside the collision predicate, so it reaches neither the
 *     `PromotionReport` nor the shortfall warn, and an empty `superseded` reads
 *     identically to "nothing collided". It is `info`, not `warn`, because the
 *     guard working is not a fault — but it must be SOMETHING, because the
 *     alternative is the only irreversible operation in the product having a
 *     refusal mode that emits nothing at all.
 *   - `readHeldBackCount`'s drift warn, and the advisory-count failure warn
 *     beside it, are the strongest instances of this file's own thesis: they
 *     fire when the line above STOPS being able to fire, and nothing else in
 *     the repo would notice a diagnostic that quietly went blind.
 *
 * Every VALUE export of `lib/logger.ts` is stubbed, per the mock-all-exports
 * rule — a partial factory works until some module in the import graph reaches
 * a missing name, then fails at link time in an unrelated file.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";

type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: (payload: unknown, message: string) => logCalls.push({ level: "error", payload, message }),
    warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
    info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
    debug: (payload: unknown, message: string) => logCalls.push({ level: "debug", payload, message }),
  }),
  getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: (token: string) => token,
}));

const { promoteBrainFacts } = await import("@atlas/api/lib/content-mode/adapters/brain-facts");
// Imported the same way as the module under test rather than statically: a
// static import is hoisted above the `mock.module` call above, and while
// `identity.ts` happens not to pull the logger today, "happens not to" is the
// property that changes silently.
const {
  IDENTITY_MUTATION_LOCK_SQL,
  IDENTITY_MUTATION_LOCK_TIMEOUT_SQL,
  IDENTITY_MUTATION_LOCK_RESET_SQL,
} = await import("@atlas/api/lib/brain/identity");
const { PublishPhaseError } = await import("@atlas/api/lib/content-mode/port");
type ModeTxClient = import("@atlas/api/lib/content-mode/port").ModeTxClient;

const EPISODE = "22222222-2222-4222-8222-222222222222";

/** Makes the held-back COUNT statement throw, as a timeout or deadlock would. */
const EXPLODE = "explode";

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
 * A tx double whose UPDATE reports `rowCount` from an injectable function, and
 * which answers the evidence-grants SELECT (#4823) separately from the draft
 * SELECT — feeding draft rows to the evidence query would trip its own
 * shape-drift warning and pollute every assertion in this file.
 */
function tx(
  drafts: readonly unknown[],
  rowCountFor: (ids: readonly string[]) => number,
  evidence: readonly unknown[] = [],
  /**
   * `TIER_HELD_BACK_COUNT_SQL`'s single column (#5033).
   *
   * `undefined` used to keep the statement UNRECOGNISED, so a regression that
   * started issuing it unconditionally would fail loudly. Since #5027 issuing it
   * unconditionally is the SHIPPED behaviour and not a regression: a draft
   * carries no cardinality opinion, so the adapter cannot tell from the rows
   * whether anything in the batch could supersede and must ask. `undefined` now
   * means "answer 0" — the statement runs, finds nothing, and reports nothing.
   */
  // `string` covers the `"explode"` sentinel below — spelling the literal in the
  // union as well is `no-redundant-type-constituents`, and the extra arm would
  // buy nothing anyway: a string is exactly what a drifting driver hands back,
  // which is the OTHER thing this parameter models.
  heldBack?: number | string | null,
  /**
   * `SUPERSESSION_TARGETS_SQL` rows. Empty by default — this file is about the
   * held-back count, and the two numbers on that log line must be sourced
   * independently or `superseding` is 0 by construction.
   */
  targets: readonly { draft_id: string; superseded_id: string }[] = [],
  /**
   * `CARDINALITY_HELD_BACK_COUNT_SQL`'s single column (#5027) — provable
   * collisions held back because their canonical predicate is uncurated.
   *
   * Defaults to 0 rather than `undefined`, because the statement now runs on
   * every publish that has a promotable draft and a double that refused it
   * would fail every test in the file for a reason unrelated to what it asserts.
   */
  uncurated = 0,
): ModeTxClient {
  return {
    query: async (sql, params = []) => {
      // Transaction control for the advisory count, matched on the statement
      // PREFIX and placed first. ⚠️ It has to come before the `held_back` arm:
      // the savepoint is named `brain_tier_held_back`, so a substring match
      // would answer `SAVEPOINT …` with a COUNT row and the savepoint path
      // would be modelled by nothing while every test stayed green.
      if (/^\s*SAVEPOINT /i.test(sql) || /^\s*ROLLBACK TO SAVEPOINT /i.test(sql)) {
        return { rows: [] };
      }
      // TWO statements name `held_back` since #5027 — the tier count and the
      // uncurated-cardinality count — over the same collision core. Told apart
      // on `IS NOT TRUE`, #5033's three-valued negation, which #5027's count
      // does not use (`cardinalitySingleSql` is an `EXISTS`, negated with a bare
      // `NOT`). Without the discriminator the cardinality statement would be
      // handed the tier fixture's value, including its EXPLODE sentinel, and
      // every assertion in this block would be about the wrong statement.
      if (sql.includes("held_back")) {
        if (!sql.includes("IS NOT TRUE")) return { rows: [{ held_back: uncurated }] };
        // The sentinel: any other string is a driver-shape case the reader
        // must degrade on, so the failure needs a value no real driver returns.
        if (heldBack === EXPLODE) throw new Error("held-back count exploded");
        // `=== undefined`, deliberately NOT `??`: `null` is a DRIFT case a test
        // drives on purpose (a count that did not read back), and `??` would
        // launder it into a clean 0 — which is the exact fabrication the
        // `supersessionHeldBack: number | null` field exists to refuse.
        return { rows: [{ held_back: heldBack === undefined ? 0 : heldBack }] };
      }
      if (sql.includes("superseded_id")) return { rows: [...targets] };
      // The supersedes-edge batch insert RETURNs one id per inserted edge.
      if (/^\s*INSERT/i.test(sql)) {
        const pairs = JSON.parse(String(params[1])) as readonly unknown[];
        return { rows: pairs.map((_, i) => ({ id: `edge-${i}` })) };
      }
      // The identity-mutation advisory lock (#5024) — void, and nothing here
      // reads it. The sibling double records it; this one does not need to,
      // since every assertion in this file is about log output.
      if (
        sql === IDENTITY_MUTATION_LOCK_SQL ||
        sql === IDENTITY_MUTATION_LOCK_TIMEOUT_SQL ||
        sql === IDENTITY_MUTATION_LOCK_RESET_SQL
      ) {
        return { rows: [] };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        // The supersession stamp RETURNs the ids it actually stamped; confirm
        // every one asked for, so a driven target does not additionally trip
        // the shortfall warn and pollute the assertions in this file.
        if (sql.includes("valid_to = now()")) {
          const asked = params[1] as readonly string[];
          return { rows: asked.map((id) => ({ id })), rowCount: asked.length };
        }
        // The plain promote binds an id array; the widening one binds a jsonb
        // string of `{id, grant}` entries. Both report a row per target.
        const target = params[1];
        const ids = Array.isArray(target)
          ? (target as readonly string[])
          : (JSON.parse(String(target)) as { id: string }[]).map((e) => e.id);
        return { rows: [], rowCount: rowCountFor(ids) };
      }
      if (sql.includes("brain_edges")) return { rows: [...evidence] };
      if (sql.includes("FOR UPDATE")) return { rows: [...drafts] };
      // Same tripwire as the sibling double: a future fifth statement must fail
      // loudly rather than silently receive draft rows, which here would
      // corrupt every log assertion in the file instead of failing.
      throw new Error(`unrecognised statement in the tx double: ${sql}`);
    },
  };
}

const run = <A,>(e: Effect.Effect<A, InstanceType<typeof PublishPhaseError>, never>) =>
  Effect.runPromise(e);

const warns = () => logCalls.filter((c) => c.level === "warn");

beforeEach(() => {
  logCalls.length = 0;
});

describe("promoteBrainFacts — grant-anomaly observation (#4797)", () => {
  it("logs a promotable grant that carries a token outside the grammar", async () => {
    const report = await run(
      promoteBrainFacts(
        tx([draft("mixed", { visible_to: ["user:u1", "everyone"] })], (ids) => ids.length),
        "ws-1",
      ),
    );
    // Promoted, NOT refused — the valid token grants real access.
    expect(report.promoted).toBe(1);
    expect(report.refused).toEqual([]);

    const anomaly = warns().find((c) => c.message.includes("outside the grammar"));
    expect(anomaly).toBeDefined();
    // Names the offending token and the row, or an operator cannot act on it.
    expect(JSON.stringify(anomaly?.payload)).toContain("everyone");
    expect(JSON.stringify(anomaly?.payload)).toContain("mixed");
  });

  it("stays silent for a clean grant", async () => {
    // An anomaly line on every ordinary publish is noise that trains an
    // operator to ignore the signal.
    await run(promoteBrainFacts(tx([draft("clean")], (ids) => ids.length), "ws-1"));
    expect(warns().some((c) => c.message.includes("outside the grammar"))).toBe(false);
  });

  it("does not log an anomaly for a REFUSED fact", async () => {
    // A wholly-unusable grant is already reported as a refusal; logging it as an
    // anomaly too would double-report the same row under two different framings.
    await run(promoteBrainFacts(tx([draft("bad", { visible_to: ["everyone"] })], () => 0), "ws-1"));
    expect(warns().some((c) => c.message.includes("outside the grammar"))).toBe(false);
    expect(warns().some((c) => c.message.includes("refused to promote facts"))).toBe(true);
  });
});

describe("promoteBrainFacts — promoted/classified divergence", () => {
  it("warns when the UPDATE touches fewer rows than were classified promotable", async () => {
    // Only reachable if the FOR UPDATE assumption broke or the driver
    // under-reported. Either way the difference is rows that are neither
    // promoted-and-counted nor refused-and-reported — never silent.
    const report = await run(
      promoteBrainFacts(tx([draft("a"), draft("b")], () => 1), "ws-1"),
    );
    expect(report.promoted).toBe(1);
    const divergence = warns().find((c) =>
      c.message.includes("does not match the classified-promotable set"),
    );
    expect(divergence).toBeDefined();
    expect(divergence?.payload).toMatchObject({ expected: 2, actual: 1 });
  });

  it("is silent on the normal path", async () => {
    await run(promoteBrainFacts(tx([draft("a"), draft("b")], (ids) => ids.length), "ws-1"));
    expect(
      warns().some((c) => c.message.includes("does not match the classified-promotable set")),
    ).toBe(false);
  });
});

describe("promoteBrainFacts — grant widening is stated out loud (#4823)", () => {
  const PRIVATE = "audience:chat-channel:slack:C0BKTMEDUN9";
  const infos = () => logCalls.filter((c) => c.level === "info");

  it("records WHICH facts were widened and WITH WHAT", async () => {
    // The only artifact of the event. Over-restriction is invisible by
    // construction — nobody can report a fact they cannot read — so if this
    // line goes missing, a publish silently changing who can see a claim
    // becomes unobservable in both directions.
    await run(
      promoteBrainFacts(
        tx([draft("c3", { visible_to: [PRIVATE] })], (ids) => ids.length, [
          { fact_id: "c3", visible_to: ["org"] },
        ]),
        "ws-1",
      ),
    );
    const widened = infos().find((c) => c.message.includes("widened grants"));
    expect(widened).toBeDefined();
    expect(widened?.payload).toMatchObject({
      workspaceId: "ws-1",
      widenedCount: 1,
      widened: [{ rowId: "c3", added: ["org"] }],
      sampleTruncated: false,
    });
  });

  it("samples the log line but reports the true count", async () => {
    // `added` carries `user:` and `audience:` tokens, and the first publish
    // after a history backfill can widen a lot at once. The complete list is
    // `PromotionReport.widened`, which reaches `logAdminAction`'s durable jsonb.
    const drafts = Array.from({ length: 25 }, (_, i) =>
      draft(`f${i}`, { visible_to: [PRIVATE] }),
    );
    const report = await run(
      promoteBrainFacts(
        tx(drafts, (ids) => ids.length, drafts.map((d) => ({ fact_id: d.id, visible_to: ["org"] }))),
        "ws-1",
      ),
    );
    expect(report.widened).toHaveLength(25);

    const line = infos().find((c) => c.message.includes("widened grants"));
    expect(line?.payload).toMatchObject({ widenedCount: 25, sampleTruncated: true });
    expect((line?.payload as { widened: unknown[] }).widened).toHaveLength(20);
  });

  it("reports a malformed token in an EVIDENCE episode's grant, attributed to the EPISODE", async () => {
    // The quiet way a widening comes out short: `parseGrant` drops `everyone`,
    // the fact publishes narrower than intended, and `reconcile.ts`'s
    // ingest-time anomaly log fired on a different row at a different time and
    // could not know it would later cost this fact readers.
    await run(
      promoteBrainFacts(
        tx([draft("f", { visible_to: [PRIVATE] })], (ids) => ids.length, [
          { fact_id: "f", episode_id: "ep-public", visible_to: ["everyone", "org"] },
        ]),
        "ws-1",
      ),
    );
    const anomaly = warns().find((c) => c.message.includes("outside the grammar"));
    // Attributed to `brain_episodes`, not `brain_facts` — the fix is in the
    // deriver that emitted the episode grant, not in the fact.
    expect(anomaly?.payload).toMatchObject({ table: "brain_episodes", rowId: "ep-public" });
  });

  it("reports one bad episode ONCE, however many drafts it is evidence for", async () => {
    // An episode can back many drafts. N byte-identical warnings for one bad
    // grant makes a single mistyped `audience:` prefix read as a fleet-wide
    // problem, and a post-backfill first publish is when N is largest.
    await run(
      promoteBrainFacts(
        tx(
          [draft("a", { visible_to: [PRIVATE] }), draft("b", { visible_to: [PRIVATE] })],
          (ids) => ids.length,
          [
            { fact_id: "a", episode_id: "ep-shared", visible_to: ["everyone", "org"] },
            { fact_id: "b", episode_id: "ep-shared", visible_to: ["everyone", "org"] },
          ],
        ),
        "ws-1",
      ),
    );
    expect(warns().filter((c) => c.message.includes("outside the grammar"))).toHaveLength(1);
  });

  it("stays silent when no grant changed", async () => {
    await run(
      promoteBrainFacts(
        tx([draft("plain")], (ids) => ids.length, [{ fact_id: "plain", visible_to: ["org"] }]),
        "ws-1",
      ),
    );
    expect(infos().some((c) => c.message.includes("widened grants"))).toBe(false);
  });

  it("names the FACTS whose evidence grant would not load as an array", async () => {
    // Query drift on the evidence side is fail-closed — the fact keeps its own
    // narrower grant and still publishes — which is exactly why it must be
    // said: the outcome is indistinguishable from "there was no wider
    // evidence", and unlike a refusal the fact is NOT re-offered next publish.
    const report = await run(
      promoteBrainFacts(
        tx([draft("f", { visible_to: [PRIVATE] })], (ids) => ids.length, [
          { fact_id: "f", visible_to: "org" },
        ]),
        "ws-1",
      ),
    );
    expect(report.promoted).toBe(1);
    const drift = warns().find((c) => c.message.includes("did not load as an array"));
    expect(drift?.payload).toMatchObject({ workspaceId: "ws-1", factIds: ["f"], factIdCount: 1 });
  });

  it("reports an unattributable evidence row separately — it sends you to a different file", async () => {
    // No usable `fact_id` means the SELECT's shape changed; a non-array
    // `visible_to` means the COLUMN's did. Reporting them alike would send each
    // investigation to the wrong place.
    await run(
      promoteBrainFacts(
        tx([draft("f", { visible_to: [PRIVATE] })], (ids) => ids.length, [{ nope: 1 }, null]),
        "ws-1",
      ),
    );
    const drift = warns().find((c) => c.message.includes("no usable fact_id"));
    expect(drift?.payload).toMatchObject({ workspaceId: "ws-1", unusableRows: 2 });
    expect(warns().some((c) => c.message.includes("did not load as an array"))).toBe(false);
  });

  it("attributes a shortfall to the statement that under-delivered", async () => {
    // A shortfall on the WIDENING update means facts whose ACL should have
    // changed are still drafts — a different incident from a shortfall on the
    // plain promote, and one pair of totals cannot tell them apart.
    await run(
      promoteBrainFacts(
        tx(
          [draft("plain"), draft("wide", { visible_to: [PRIVATE] })],
          (ids) => (ids.includes("wide") ? 0 : ids.length),
          [{ fact_id: "wide", visible_to: ["org"] }],
        ),
        "ws-1",
      ),
    );
    const divergence = warns().find((c) =>
      c.message.includes("does not match the classified-promotable set"),
    );
    expect(divergence?.payload).toMatchObject({
      expected: 2,
      actual: 1,
      plainExpected: 1,
      plainActual: 1,
      widenedExpected: 1,
      widenedActual: 0,
    });
  });
});

describe("promoteBrainFacts — the tier guard states what it held back (#5033)", () => {
  /** A `single` draft — the only cardinality that reaches the supersession block. */
  const single = (id: string) => draft(id, { predicate_cardinality: "single" });
  const infos = () => logCalls.filter((c) => c.level === "info");

  it("says a provable collision was withheld because its predicate is UNCURATED (#5027)", async () => {
    // ⭐ The only artifact of the event, and after this slice the overwhelmingly
    // common one: `single` requires positive evidence and there is no backfill,
    // so until a human curates a predicate every workspace supersedes NOTHING.
    // Without this line "supersession stopped completely" is indistinguishable
    // from "the cardinality read is broken" — and it silently neutralized the
    // tier line one commit earlier, which reads a constant 0 while the
    // vocabulary is empty (the cardinality arm sits inside the collision core
    // both counts join on).
    const report = await run(
      promoteBrainFacts(tx([single("a")], (ids) => ids.length, [], 0, [], 3), "ws-1"),
    );

    // The publish is UNAFFECTED — nothing is withheld from the promotion, only
    // from the consequence.
    expect(report.promoted).toBe(1);

    const line = infos().find((c) => c.message.includes("not curated"));
    expect(line?.payload).toMatchObject({ workspaceId: "ws-1", uncurated: 3, superseding: 0 });
    // The message has to say what an operator should DO, because unlike the tier
    // refusal this one is fixable: the number answers "how many beliefs would
    // this publish retire if you curated their predicates?"
    expect(line?.message).toContain("curating the predicate");
    // …and it has to disclose that the fix is RETROACTIVE. A curator reading
    // "these three become supersedable" and not "every existing pair at that
    // predicate does" is being told half of a destructive, irreversible change.
    expect(line?.message).toContain("retroactively");
    // NOT in the durable record. `supersessionHeldBack` is a per-publish record
    // of a permanent tier refusal; a count that is large-and-shrinking for every
    // workspace during the vocabulary's first months does not belong in one.
    expect(report.supersessionHeldBack).toBe(0);
  });

  it("stays silent when nothing was held back for want of curation", async () => {
    // The prohibition half. Without it the test above is satisfied by a line
    // that fires on every publish, which is a line an operator learns to ignore.
    await run(promoteBrainFacts(tx([single("a")], (ids) => ids.length, [], 0, [], 0), "ws-1"));
    expect(infos().find((c) => c.message.includes("not curated"))).toBeUndefined();
  });

  it("says a provable collision was withheld on tier grounds, and why", async () => {
    // ⭐ The only artifact of the event. The pair is filtered inside the
    // collision predicate, so it never reaches `supersessionPairs`, never
    // reaches the shortfall warn, and leaves `report.superseded` empty — which
    // is byte-identical to "nothing collided". Without this line an operator
    // cannot tell an authoritative fact was defended from nothing having
    // happened.
    const report = await run(
      promoteBrainFacts(
        tx([single("a"), single("b")], (ids) => ids.length, [], 2, [
          { draft_id: "a", superseded_id: "old-1" },
        ]),
        "ws-1",
      ),
    );
    // The publish itself is UNAFFECTED — the guard withholds a consequence, not
    // a promotion. Asserted here because a line that fired while also blocking
    // the publish would be a different, much worse bug.
    expect(report.promoted).toBe(2);
    expect(report.superseded).toEqual([{ rowId: "a", superseded: ["old-1"] }]);

    const line = infos().find((c) => c.message.includes("were NOT superseded"));
    // `superseding` is sourced INDEPENDENTLY of `heldBack` — from the targets
    // SELECT, which this case answers with one pair. Asserting it as 0 beside a
    // double that returns no targets would be 0 by construction, and a mutation
    // replacing `supersessionPairs.length` with a literal would survive. The
    // number is what lets an operator read "2 held back OUT OF 3 collisions".
    expect(line?.payload).toMatchObject({ workspaceId: "ws-1", heldBack: 2, superseding: 1 });
    // Both refusal reasons are named. An operator reading "tier-1" alone would
    // go looking for a warehouse producer that does not exist yet, when the
    // likelier cause today is a region-imported source kind this region cannot
    // classify.
    expect(line?.message).toContain("warehouse-derived");
    expect(line?.message).toContain("cannot classify");
    // …and it points at where the pair actually IS, which is the whole reason
    // a count is enough.
    expect(line?.message).toContain("in-tension-with");
  });

  it("stays silent when nothing was held back", async () => {
    // The prohibition half. A line that fired on every publish would be noise
    // an operator learns to skim, which is the same as not logging it.
    await run(
      promoteBrainFacts(tx([single("a")], (ids) => ids.length, [], 0), "ws-1"),
    );
    expect(infos().some((c) => c.message.includes("were NOT superseded"))).toBe(false);
    expect(
      warns().some((c) => c.message.includes("did not read back as a non-negative integer")),
    ).toBe(false);
  });

  it("warns when the count itself does not read back — a diagnostic that stopped diagnosing", async () => {
    // `readHeldBackCount` degrades to 0 rather than inventing a number, because
    // the value drives one advisory line. But degrading SILENTLY would mean
    // pairs withheld with no trace and no trace of the missing trace — so the
    // drift gets its own warn, and the publish still commits.
    const report = await run(
      promoteBrainFacts(tx([single("a")], (ids) => ids.length, [], null), "ws-1"),
    );
    expect(report.promoted).toBe(1);
    // Drift is UNKNOWN too, and for the sharper reason: it is persistent, so a
    // fabricated 0 here would be a standing lie in every later audit row rather
    // than one bad record.
    expect(report.supersessionHeldBack).toBeNull();
    const drift = warns().find((c) =>
      c.message.includes("did not read back as a non-negative integer"),
    );
    // `heldBackRaw`, not `heldBack`: the info line carries a NUMBER under
    // `heldBack`, and one structured field with two types is an alert that
    // mis-fires or silently no-ops.
    expect(drift?.payload).toMatchObject({ workspaceId: "ws-1", heldBackRaw: null });
    // Degraded to 0, so the advisory line does NOT also fire with a fabricated
    // count beside the warning that says the count is untrustworthy.
    expect(infos().some((c) => c.message.includes("were NOT superseded"))).toBe(false);
  });

  it("warns — and still commits the publish — when the count STATEMENT fails", async () => {
    // The savepoint's whole reason. `admin-publish.ts` runs every adapter in
    // one transaction, so an unguarded failure here would roll back a complete,
    // correct publish because a diagnostic could not be computed — telemetry
    // destroying the operation it describes. The reachable causes are ordinary:
    // a statement timeout, a deadlock against `reconcile.ts`, statement drift.
    const report = await run(
      promoteBrainFacts(tx([single("a")], (ids) => ids.length, [], EXPLODE), "ws-1"),
    );
    expect(report.promoted).toBe(1);
    // UNKNOWN, not 0 — the audit row must not claim a number nobody computed.
    expect(report.supersessionHeldBack).toBeNull();

    // Never silent — and the message says the publish is FINE, because the
    // operator's first question on seeing it is whether they lost a publish.
    const lost = warns().find((c) => c.message.includes("could not be computed"));
    expect(lost?.payload).toMatchObject({ workspaceId: "ws-1" });
    expect(JSON.stringify(lost?.payload)).toContain("exploded");
    expect(lost?.message).toContain("NO trace");
    expect(lost?.message).toContain("publish itself is unaffected");
    // …and it does NOT also emit the held-back line with a fabricated 0.
    expect(infos().some((c) => c.message.includes("were NOT superseded"))).toBe(false);
  });

  it("accepts the count as a string — `pg` may hand an aggregate back that way", async () => {
    await run(
      promoteBrainFacts(tx([single("a")], (ids) => ids.length, [], "3"), "ws-1"),
    );
    expect(
      warns().some((c) => c.message.includes("did not read back as a non-negative integer")),
    ).toBe(false);
    expect(
      infos().find((c) => c.message.includes("were NOT superseded"))?.payload,
    ).toMatchObject({ heldBack: 3 });
  });
});
