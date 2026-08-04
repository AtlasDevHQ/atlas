/**
 * The "log" half of the brain-facts promotion adapter (#4769).
 *
 * Split into its own file for the same reason `lib/brain/__tests__/acl-logging.test.ts`
 * is: asserting on a logger needs `mock.module("@atlas/api/lib/logger")` installed
 * before the module under test is imported, and the sibling adapter suite
 * deliberately runs with no module mocking at all.
 *
 * Why it is worth a file. Both log lines here are the ONLY artifact of their
 * event, and both could be deleted with every other suite staying green:
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
): ModeTxClient {
  return {
    query: async (sql, params = []) => {
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
