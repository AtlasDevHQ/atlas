/**
 * The "and says so in the log" half of `class-contract.ts`'s stated posture
 * (#5212) — every fail-closed arm withholds *loudly*.
 *
 * Split into its own file because it needs `mock.module("@atlas/api/lib/logger")`
 * installed before the module under test is imported, and `class-contract.test.ts`
 * deliberately runs with no module mocking at all.
 *
 * ## Why this file exists rather than trusting the log calls to stay put
 *
 * Measured, not suspected. Deleting ONE `warnUnresolvable` call left the
 * sibling suite at 21 pass / 0 fail; deleting ALL THREE did too. So the entire
 * loudness half of the module header's claim — "every one of those arms fails
 * CLOSED and says so in the log … withhold, loudly" — had no test, and the
 * payload decisions under it (the `null` spelling, the truncation, the
 * consequence text, the `{...meta}` spread) had none either.
 *
 * That is the same gap `acl-logging.test.ts` was created for, in the same words:
 * the ENFORCEMENT is structural and entirely independent of the REPORTING, so a
 * suite that only checks the returned decision cannot see the log disappear. It
 * matters more here than the usual logging test, because the fail-closed answer
 * is deliberately indistinguishable from a correct one at a glance — a class
 * that quietly stops being surveyed looks exactly like a class that has nothing
 * to survey, and the warn is the only thing that says which.
 *
 * Every VALUE export of `lib/logger.ts` is stubbed, per the mock-all-exports
 * rule: a partial factory works right up until some module in the import graph
 * reaches a missing name, and then fails at link time in a file that has nothing
 * to do with this one.
 */

import { beforeEach, describe, expect, test, mock } from "bun:test";

type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: (payload: unknown, message: string) =>
      logCalls.push({ level: "error", payload, message }),
    warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
    info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
    debug: (payload: unknown, message: string) =>
      logCalls.push({ level: "debug", payload, message }),
  }),
  getLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    level: "info",
  }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: (token: string) => token,
}));

const { classDenominator, coverageLabelPolicy, stalenessVerdict } = await import(
  "@atlas/api/lib/brain/class-contract"
);
const { CHAT_CLASS, EMAIL_CLASS, EPISODE_SOURCE_CLASSES } = await import(
  "@atlas/api/lib/brain/sources"
);

const META = { workspaceId: "ws_5212", requestId: "req_5212" } as const;
const UNIT = { deliberateAct: false, vendorReportsPublic: false } as const;

/** The payload shape the module actually emits, as a reader-friendly type. */
type WarnPayload = {
  workspaceId?: string;
  requestId?: string;
  derivation?: string;
  classValue?: string;
  classValueLength?: number;
};

function warns(): ReadonlyArray<{ payload: WarnPayload; message: string }> {
  return logCalls
    .filter((c) => c.level === "warn")
    .map((c) => ({ payload: c.payload as WarnPayload, message: c.message }));
}

beforeEach(() => {
  logCalls.length = 0;
});

describe("the fail-closed arms log, one line per derivation", () => {
  test("each derivation emits exactly one warn NAMING ITSELF", () => {
    // Deleting any ONE of the three `warnUnresolvable` calls has to fail here.
    // A test that only counted warns in total would survive deleting one and
    // adding a duplicate elsewhere; keying on `derivation` is what makes each
    // call site individually load-bearing.
    coverageLabelPolicy("docs", UNIT, META);
    stalenessVerdict("docs", META);
    classDenominator("docs", META);

    expect(warns().map((w) => w.payload.derivation)).toEqual([
      "coverageLabelPolicy",
      "stalenessVerdict",
      "classDenominator",
    ]);
    expect(logCalls.every((c) => c.level === "warn")).toBe(true);
  });

  test("the message states the CONSEQUENCE, and a different one per derivation", () => {
    // "Failing closed" describes the mechanism; an operator needs to know which
    // part of the page just went quiet. Asserted as three DISTINCT messages
    // rather than three matching greps, because a single generic sentence would
    // satisfy any per-derivation substring check that was loose enough.
    coverageLabelPolicy("docs", UNIT, META);
    stalenessVerdict("docs", META);
    classDenominator("docs", META);

    const messages = warns().map((w) => w.message);
    expect(new Set(messages).size).toBe(3);
    expect(messages[0]).toContain("will be named");
    expect(messages[1]).toContain("measured lag");
    expect(messages[2]).toContain("falls out of every ratio");
    // Each still identifies the subsystem and the posture, so a log search for
    // the class of event finds all three.
    for (const message of messages) {
      expect(message).toContain("brain class contract");
      expect(message).toContain("failing closed");
    }
  });

  test("correlation context survives the spread, and a caller cannot shadow the diagnostics", () => {
    // `workspaceId` is required on the meta type precisely so this line can do
    // its job in a 3-region multi-tenant deploy. The shadow half matters
    // because the diagnostic fields come AFTER `...meta` in the spread: a
    // caller passing its own `derivation` must not be able to relabel which
    // derivation reported.
    const hostile = { ...META, derivation: "not-this-one", classValue: "not-this-either" };
    classDenominator("docs", hostile as typeof META);

    const [warn] = warns();
    expect(warn?.payload.workspaceId).toBe("ws_5212");
    expect(warn?.payload.requestId).toBe("req_5212");
    expect(warn?.payload.derivation).toBe("classDenominator");
    expect(warn?.payload.classValue).toBe("docs");
  });
});

describe("the logged class value is legible and bounded", () => {
  test("`null` is spelled out — it is the likeliest real input, not a curiosity", () => {
    // The plausible production producer of an unresolvable class is
    // `episodeSourceClassOf(row.source)`, which returns `null` for exactly the
    // region-import lane these arms exist for. Under a bare `typeof` that logs
    // as "object" — indistinguishable from the two cases below, so the highest
    // probability input produced the least legible line.
    classDenominator(null, META);
    classDenominator({ class: "chat" }, META);
    classDenominator(["chat"], META);
    classDenominator(undefined, META);

    expect(warns().map((w) => w.payload.classValue)).toEqual([
      "null",
      "object",
      "object",
      "undefined",
    ]);
  });

  test("an unbounded stored value is TRUNCATED, and its true length still travels", () => {
    // `brain_episodes.source` is plain `text` with no CHECK and the region
    // import restores it verbatim, so this value has no bound at rest. An
    // oversized field pushes the structured ones past log-aggregation size
    // limits — which would drop the `workspaceId` the line above exists to
    // carry — so the same posture as `error-scrub.ts`.
    const huge = "z".repeat(5_000);
    classDenominator(huge, META);

    const [warn] = warns();
    const logged = warn?.payload.classValue ?? "";
    expect(logged.length).toBeLessThan(200);
    expect(logged.startsWith("zzz")).toBe(true);
    expect(logged.endsWith("…")).toBe(true);
    // The length is what makes the truncation diagnosable rather than
    // misleading: without it an operator cannot tell a 129-char value from a
    // 5,000-char one.
    expect(warn?.payload.classValueLength).toBe(5_000);
  });

  test("a short value is logged whole, with no length field to read as truncation", () => {
    classDenominator("docs", META);
    const [warn] = warns();
    expect(warn?.payload.classValue).toBe("docs");
    expect(warn?.payload.classValueLength).toBe(4);
  });
});

describe("a RESOLVABLE class is silent", () => {
  test("no warn for any real class, through any derivation", () => {
    // The noise regression, and the half that a "does it log?" test cannot
    // catch on its own. `coverageLabelPolicy` is called per SURVEY UNIT, so a
    // warn on the resolvable path is one line per channel per page render —
    // which is how a genuinely useful signal becomes one an operator filters
    // out. Swept over the whole class set so a new class cannot start warning
    // on its own contract.
    for (const cls of EPISODE_SOURCE_CLASSES) {
      coverageLabelPolicy(cls, UNIT, META);
      coverageLabelPolicy(cls, { deliberateAct: true, vendorReportsPublic: true }, META);
      stalenessVerdict(cls, META);
      classDenominator(cls, META);
    }
    expect(logCalls).toEqual([]);
  });

  test("the non-surveyable refusal is silent too — it is a decision, not a degradation", () => {
    // `human` returns `count-only` / `non-surveyable-class`, which is the
    // module working as designed rather than something an operator must act on.
    // Warning here would put a line in the log for every correctly-refused
    // unit and teach the reader to ignore the arm that does matter.
    expect(coverageLabelPolicy("human", { deliberateAct: true, vendorReportsPublic: true }, META))
      .toEqual({ policy: "count-only", reason: "non-surveyable-class" });
    expect(logCalls).toEqual([]);
    // …while the shape it is most confusable with — an unresolvable class,
    // same `count-only` policy — is loud. That contrast is the whole point.
    coverageLabelPolicy("docs", UNIT, META);
    expect(warns().length).toBe(1);
  });

  test("an ordinary withhold on a real class is silent", () => {
    // A mailbox nobody named is the single commonest decision this module will
    // ever make. If that logged, nothing else in the file would be findable.
    expect(coverageLabelPolicy(EMAIL_CLASS, UNIT, META)).toEqual({
      policy: "count-only",
      reason: "no-clause",
    });
    expect(coverageLabelPolicy(CHAT_CLASS, UNIT, META)).toEqual({
      policy: "count-only",
      reason: "no-clause",
    });
    expect(logCalls).toEqual([]);
  });
});

describe("the log is optional context, never a precondition", () => {
  test("every derivation works with no meta at all, and still logs", () => {
    // `meta` is optional-or-complete: a caller omits it entirely rather than
    // passing a partial one. The arms must not depend on it — a fail-closed
    // answer that needed request context to be produced would fail OPEN in
    // exactly the callers least likely to have it.
    expect(coverageLabelPolicy("docs", UNIT)).toEqual({
      policy: "count-only",
      reason: "unresolvable-class",
    });
    expect(stalenessVerdict("docs")).toEqual({
      kind: "unverified-since",
      reason: "unresolvable-class",
    });
    expect(classDenominator("docs")).toEqual({ surveyable: false, reason: "unresolvable-class" });

    expect(warns().length).toBe(3);
    for (const warn of warns()) {
      expect(warn.payload.workspaceId).toBeUndefined();
      expect(warn.payload.derivation).toBeDefined();
    }
  });
});
