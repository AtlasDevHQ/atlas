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

/** A tx double whose UPDATE reports `rowCount` from an injectable function. */
function tx(drafts: readonly unknown[], rowCountFor: (ids: readonly string[]) => number): ModeTxClient {
  return {
    query: async (sql, params = []) => {
      if (/^\s*UPDATE/i.test(sql)) {
        return { rows: [], rowCount: rowCountFor((params[1] ?? []) as readonly string[]) };
      }
      return { rows: [...drafts] };
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
