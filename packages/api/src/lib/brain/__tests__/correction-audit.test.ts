/**
 * The `admin_action_log` row a correction emits (#4934).
 *
 * `correct_fact` has two entry points onto one write — the admin HTTP routes
 * and the agent tool — and #4915 wired the audit vocabulary to only the first.
 * An owner correcting a fact through chat therefore produced the immutable
 * in-brain correction episode and NO row in the forensic trail, while the same
 * verb through the console produced both. #4934 moved the write down into
 * `correctFact`, so the row is emitted once, by the machinery, for every entry
 * point present or future.
 *
 * Split from `correction.test.ts` for the reason `acl-logging.test.ts` and
 * `grant-sweep-logging.test.ts` are split from theirs: it needs
 * `mock.module("@atlas/api/lib/logger")` and `mock.module("@atlas/api/lib/audit")`
 * installed before the module under test is imported, and the sibling suite
 * deliberately runs with no module mocking at all.
 *
 * What is pinned here, and why each half is load-bearing:
 *
 *   - the ROW: emitted exactly once for a `corrected` outcome, with retract's
 *     dedicated action type and the other verbs riding `correct` with the verb
 *     in metadata; NOT emitted for a refusal or a not-found. That is a SCOPE
 *     call, not a semantic one (#4934 non-goal) — the table is not success-only
 *     (`AdminActionEntry.status` takes `"failure"`, and `sso.enforcement_block`
 *     audits a refusal that way), so auditing refused corrections is legitimate
 *     and can be added later with its own decision about volume;
 *   - AWAITED, not fire-and-forget. `logAdminAction` posts its insert into the
 *     internal-DB circuit breaker and returns, so an open breaker discards the
 *     row with nothing but a counter — the silent gap #4937 found on the
 *     adjacent publish path, and here it would silently reproduce the exact bug
 *     #4934 fixes. Both halves are pinned: that the write completes before
 *     `correctFact` resolves, and that a FAILED write is surfaced at ERROR
 *     rather than swallowed;
 *   - BOUNDED. `logAdminActionAwait` goes through `internalQuery`, which
 *     bypasses the breaker on purpose, and the internal pool sets no statement
 *     timeout — so an awaited-but-unbounded write lets a degraded internal DB
 *     hold a chat turn open indefinitely;
 *   - and a SOURCE-LEVEL guard that discovers every DIRECT `correctFact(` call
 *     site and pins that none of them writes an audit row of its own. That is
 *     the half that makes "a third entry point cannot land uncovered" true by
 *     construction rather than by review diligence — the failure mode #4934
 *     was, at one entry point, exactly this. Its reach is direct call sites in
 *     five roots: an aliased import (`const fn = correctFact`), a re-export, or
 *     a thin wrapper module is invisible to it. Broaden the regexes if one
 *     appears; do not delete the guard.
 *
 * The RESOLVED row — `actor_id`, `actor_email`, `org_id`, `request_id`, which
 * `resolveEntry` derives from the request context this file stubs away — and
 * `supersede`'s metadata live in `correction-audit-pg.test.ts`, against live
 * Postgres. Neither is knowable through a mocked `lib/audit`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, mock } from "bun:test";
import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";

// --- logger: every VALUE export stubbed (mock-all-exports) -----------------
type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];
const recorder = {
  error: (payload: unknown, message: string) => logCalls.push({ level: "error", payload, message }),
  warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
  info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
  debug: (payload: unknown, message: string) => logCalls.push({ level: "debug", payload, message }),
};
/**
 * What `getRequestContext()` returns. `undefined` models a caller outside any
 * request; a context WITHOUT a `user` models the canonical scheduler shape,
 * which resolves to `actor_id: "unknown"` just as an absent context does.
 */
let requestContext: { requestId: string; user?: { id: string } } | undefined;

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => recorder,
  getLogger: () => ({ ...recorder, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => requestContext,
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: (token: string) => token,
}));

// --- audit: the seam under test -------------------------------------------
interface AuditRow {
  readonly actionType: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata?: Record<string, unknown>;
}
/** Rows that COMMITTED — pushed only after the write's promise settles. */
const committed: AuditRow[] = [];
/** Every call, recorded on entry — lets a test see a write that never landed. */
const attempted: AuditRow[] = [];
/** Swap to make the awaited write hang or reject. Default: commits promptly. */
let auditBehaviour: (row: AuditRow) => Promise<void> = async () => {};
/** How many times anything called the FIRE-AND-FORGET variant — must stay 0. */
let fireAndForgetCalls = 0;
/**
 * Makes every read of `ADMIN_ACTIONS` throw, so the emitter's never-throws
 * contract is exercised on a SYNCHRONOUS throw raised while BUILDING the audit
 * entry — before any write is attempted. Moving the entry literal out of the
 * `try` turns the test that uses this red, which is what it is for.
 *
 * NOT a model of a partial `mock.module` (66 files mock
 * `@atlas/api/lib/audit`): an omitted named export fails at LINK time in bun
 * with `SyntaxError: Export named 'X' not found`, before any test body runs, so
 * no `try` could catch it and no correction is in flight to be affected. The
 * hazard this guards is the general one — any synchronous throw in entry
 * construction landing on an already-committed correction.
 *
 * The trap fires on the FIRST property read (`.brainFact`), which is enough
 * because `correction.ts` reads the catalog at emit time. A future module-scope
 * `const { brainFact } = ADMIN_ACTIONS` would move the throw to import time and
 * turn this into a load failure instead of a contract test.
 */
let breakAdminActions = false;

// The REAL catalog, not a hand-written copy. A copy would keep this suite green
// through a rename of `ADMIN_ACTIONS.brainFact.retract` while production emitted
// a new vocabulary — the exact drift a forensic-trail test exists to catch.
//
// Reaching past the mocked `@atlas/api/lib/audit` barrel into its submodule is
// safe because `lib/audit/actions.ts` is a constant catalog with ZERO imports:
// it cannot cycle back through the mock or drag a transitive graph in. Static
// rather than dynamic because an async `mock.module` factory deadlocks bun's
// loader.
void mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: new Proxy(REAL_ADMIN_ACTIONS, {
    get(target, key, receiver: unknown) {
      if (breakAdminActions) throw new TypeError("partial mock: ADMIN_ACTIONS is not defined");
      return Reflect.get(target, key, receiver) as unknown;
    },
  }),
  logAdminAction: () => {
    fireAndForgetCalls += 1;
  },
  logAdminActionAwait: async (row: AuditRow) => {
    attempted.push(row);
    await auditBehaviour(row);
    committed.push(row);
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
}));

const {
  CORRECTION_EPISODE_INSERT_SQL,
  DEPENDENT_FACTS_SQL,
  DERIVES_FROM_EDGE_SQL,
  MERGE_PROVENANCE_MARKER_SQL,
  RETRACT_FACT_SQL,
  correctFact,
} = await import("@atlas/api/lib/brain/correction");
const { INSERT_PROVENANCE_EDGE_SQL } = await import("@atlas/api/lib/brain/reconcile");
const { SLACK_SOURCE, WAREHOUSE_SOURCE } = await import("@atlas/api/lib/brain/sources");
type CorrectionDeps = Parameters<typeof correctFact>[1];

const WS = "ws-audit";
const FACT = "11111111-1111-4111-8111-111111111111";
const EPISODE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-31T09:00:00.000Z");

const admin = {
  origin: "authenticated",
  workspaceId: WS,
  userId: "admin-1",
  role: "admin",
  audienceIds: [] as string[],
} as const;

/**
 * The narrowest store the two audited verbs need: a statement dispatcher, the
 * same identity-not-paraphrase idea as `correction.test.ts`'s fake, trimmed to
 * `retract` and the vouch verbs.
 *
 * `supersede` is deliberately NOT here — it runs the whole reconcile path, and
 * faking that would be a second, drifting copy of `correction.test.ts`'s store.
 * Its `actionType` rides the same expression as `pin`'s, but its
 * `supersededBy` / `validTo` metadata are conditional spreads no other verb can
 * produce, so "same expression" does NOT cover them. They are pinned in
 * `correction-audit-pg.test.ts`, against the live schema, where reconcile runs
 * for real.
 */
function fakeTransaction(
  options: { dependents?: readonly string[]; warehouseDerived?: boolean } = {},
): CorrectionDeps {
  const dependents = options.dependents ?? [];
  const source = options.warehouseDerived === true ? WAREHOUSE_SOURCE : SLACK_SOURCE;
  return {
    now: () => NOW,
    newCorrectionId: () => "corr-1",
    withTransaction: async <T,>(
      fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>,
    ): Promise<T> =>
      fn({
        query: async (sql: string) => {
          if (sql.startsWith("SELECT f.id::text")) {
            return {
              rows: [
                {
                  id: FACT,
                  subject: "Ana",
                  predicate: "leads",
                  object: "Platform",
                  status: "published",
                  predicate_cardinality: "single",
                  provenance: { source },
                  visible_to: ["org"],
                  valid_to: null,
                  // Postgres computes this in `correctionTargetSql` as
                  // `NOT brainFactCurrentClause("f")` (#4939), and
                  // `readTargetRow` refuses a row without it rather than
                  // defaulting — a missing value would otherwise silently
                  // disable the vouch refusal. `false` matches the
                  // `valid_to: null` above: no end date means still current.
                  window_closed: false,
                  source_episode_id: "ep-src",
                },
              ],
            };
          }
          if (sql === CORRECTION_EPISODE_INSERT_SQL) return { rows: [{ id: EPISODE }] };
          if (sql === RETRACT_FACT_SQL) {
            return { rows: [{ id: FACT, invalidated_at: NOW.toISOString() }] };
          }
          if (sql === DERIVES_FROM_EDGE_SQL) return { rows: [] };
          if (sql === INSERT_PROVENANCE_EDGE_SQL) return { rows: [] };
          if (sql === DEPENDENT_FACTS_SQL) return { rows: dependents.map((id) => ({ id })) };
          if (sql === MERGE_PROVENANCE_MARKER_SQL) {
            const ids = dependents.length > 0 ? dependents : [FACT];
            return { rows: ids.map((id) => ({ id })) };
          }
          throw new Error(`fake store: unexpected statement ${sql.slice(0, 60)}`);
        },
      }),
  } satisfies CorrectionDeps;
}

/**
 * The `err` field off a recorded log line, as an `Error`. A named throw rather
 * than `call?.payload?.err`, which would compare `undefined` to `undefined` and
 * pass on a line that never fired.
 */
function errOf(call: LogCall | undefined): Error {
  if (call === undefined) throw new Error("expected a log line, got none");
  // A real narrow, not an assertion: `payload as { err?: unknown }` would throw
  // `Cannot destructure property 'err' of null` on a null payload — the
  // confusing failure this helper exists to replace.
  const err =
    typeof call.payload === "object" && call.payload !== null && "err" in call.payload
      ? call.payload.err
      : undefined;
  if (!(err instanceof Error)) {
    throw new Error(`log line carried no Error in \`err\`: ${describe_(call.payload)}`);
  }
  return err;
}

/**
 * Poll until `predicate` holds, or throw. Generous cap because the bound is
 * only there to turn "never happens" into a failure rather than a hang — it is
 * not the thing being measured, so it costs nothing to make it far larger than
 * any plausible scheduling delay.
 */
async function waitFor(predicate: () => boolean, capMs = 2_000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition did not hold within ${capMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** `JSON.stringify` that cannot itself throw on a circular ref or a BigInt. */
function describe_(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // intentionally ignored: this is a diagnostic for an assertion that is
    // already failing; a serializer error must not replace the real message.
    return String(value);
  }
}

beforeEach(() => {
  logCalls.length = 0;
  committed.length = 0;
  attempted.length = 0;
  fireAndForgetCalls = 0;
  breakAdminActions = false;
  requestContext = { requestId: "req-ctx", user: { id: "admin-1" } };
  auditBehaviour = async () => {};
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

describe("the correction audit row", () => {
  test("retract emits exactly one brain_fact.retract row, from the machinery", async () => {
    const outcome = await correctFact(
      { ctx: admin, factId: FACT, verb: "retract", requestId: "req-1" },
      fakeTransaction({ dependents: ["dep-1"] }),
    );

    expect(outcome.kind).toBe("corrected");
    expect(committed).toHaveLength(1);
    expect(committed[0]).toEqual({
      actionType: "brain_fact.retract",
      targetType: "brainFact",
      targetId: FACT,
      metadata: {
        verb: "retract",
        flaggedForReReview: ["dep-1"],
        workspaceId: WS,
        correctionEpisodeId: EPISODE,
        invalidatedAt: NOW.toISOString(),
      },
    });

    // Key ORDER, which `toEqual` above does not check (#4939). The admin
    // action-log table renders `Object.entries(metadata).slice(0, 3)` in a
    // truncating cell, so a key that lands fourth is invisible on the surface
    // an operator opens — and this row is the flagged facts' ONLY durable
    // record, since no queue lists them. Nothing else in the metadata has that
    // property: every other key is recoverable from the response, the fact
    // row, or the request context.
    const keys = Object.keys(committed[0]?.metadata ?? {});
    expect(
      keys.indexOf("flaggedForReReview"),
      `\`flaggedForReReview\` is at index ${keys.indexOf("flaggedForReReview")} of ${JSON.stringify(keys)} — the action-log preview shows only the first three, so it would not be visible where an operator looks for it`,
    ).toBeLessThan(3);

    // The FIRE-AND-FORGET variant is the one that silently drops rows when the
    // internal-DB breaker is open. Nothing on this path may reach for it.
    expect(fireAndForgetCalls).toBe(0);
  });

  test("the non-retract verbs ride brain_fact.correct with the verb in metadata", async () => {
    for (const verb of ["pin", "re-authority"] as const) {
      committed.length = 0;
      const outcome = await correctFact(
        { ctx: admin, factId: FACT, verb, requestId: "req-2" },
        fakeTransaction(),
      );
      expect(outcome.kind).toBe("corrected");
      expect(committed).toHaveLength(1);
      expect(committed[0]).toEqual({
        actionType: "brain_fact.correct",
        targetType: "brainFact",
        targetId: FACT,
        // The conditional keys stay OFF when there is nothing to say — a `pin`
        // neither tombstones, supersedes, nor closes a validity window, and a
        // row asserting `invalidatedAt: null` reads as a decision that was made.
        metadata: { verb, workspaceId: WS, correctionEpisodeId: EPISODE },
      });
    }
  });

  test("a retract with no dependents omits flaggedForReReview rather than logging an empty list", async () => {
    await correctFact(
      { ctx: admin, factId: FACT, verb: "retract", requestId: "req-3" },
      fakeTransaction(),
    );
    expect(committed).toHaveLength(1);
    expect(committed[0]?.metadata).not.toHaveProperty("flaggedForReReview");
    expect(committed[0]?.metadata).toMatchObject({ invalidatedAt: NOW.toISOString() });
  });

  test("BOTH refusal shapes go unaudited — nothing happened to record", async () => {
    // Two structurally different refusals, and covering only one is how a
    // widening slips in: the AUTHORITY refusal returns before the transaction
    // is ever opened, while the tier-1 refusal throws `CorrectionRefusedError`
    // from INSIDE it — a separate return path, through the rollback catch,
    // where an audit call would go unnoticed by a test that only exercises the
    // early return.
    const outcome = await correctFact(
      {
        ctx: { ...admin, userId: "member-1", role: "member" },
        factId: FACT,
        verb: "pin",
        requestId: "req-4a",
      },
      fakeTransaction(),
    );
    expect(outcome.kind).toBe("refused");

    const rolledBack = await correctFact(
      { ctx: admin, factId: FACT, verb: "pin", requestId: "req-4b" },
      fakeTransaction({ warehouseDerived: true }),
    );
    expect(rolledBack.kind).toBe("refused");

    expect(attempted).toHaveLength(0);
    expect(fireAndForgetCalls).toBe(0);
  });

  test("a NOT-FOUND correction is not audited", async () => {
    const deps: CorrectionDeps = {
      ...fakeTransaction(),
      withTransaction: async <T,>(
        fn: (tx: { query: () => Promise<{ rows: unknown[] }> }) => Promise<T>,
      ): Promise<T> => fn({ query: async () => ({ rows: [] }) }),
    };
    const outcome = await correctFact(
      { ctx: admin, factId: FACT, verb: "pin", requestId: "req-5" },
      deps,
    );
    expect(outcome.kind).toBe("not-found");
    expect(attempted).toHaveLength(0);
    expect(fireAndForgetCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Awaited, bounded, and loud — the #4937 swallow class
// ---------------------------------------------------------------------------

describe("the write is awaited, bounded, and never swallowed", () => {
  test("the row has COMMITTED by the time correctFact resolves", async () => {
    // The mutation this catches: `void emitCorrectionAudit(...)` instead of
    // `await`. A fire-and-forget write still records an ATTEMPT synchronously,
    // so asserting on `attempted` would pass either way — only the settled
    // `committed` list can tell the difference.
    auditBehaviour = () =>
      // A macrotask, not a microtask: an `await`-less caller drains the
      // microtask queue before returning, so a resolved-on-a-tick write would
      // land in `committed` either way and the assertion would be vacuous.
      new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });

    const outcome = await correctFact(
      { ctx: admin, factId: FACT, verb: "pin", requestId: "req-6" },
      fakeTransaction(),
    );

    expect(outcome.kind).toBe("corrected");
    expect(committed).toHaveLength(1);
  });

  test("a FAILED write is logged at ERROR — never swallowed — and the correction still stands", async () => {
    auditBehaviour = async () => {
      throw new Error("internal DB circuit breaker is open");
    };

    const outcome = await correctFact(
      { ctx: admin, factId: FACT, verb: "retract", requestId: "req-7" },
      fakeTransaction(),
    );

    // The correction committed; reporting failure would invite a retry that
    // mints a SECOND correction episode for one human decision.
    expect(outcome.kind).toBe("corrected");
    expect(committed).toHaveLength(0);

    const errors = logCalls.filter((c) => c.level === "error");
    expect(errors).toHaveLength(1);
    const [failure] = errors;
    // Everything needed to reconstruct the lost row BY HAND has to be on the
    // line that says it is gone — the row was the actor-attributed record, so
    // `actorId` in particular is not decoration.
    expect(failure?.payload).toMatchObject({
      workspaceId: WS,
      actorId: "admin-1",
      factId: FACT,
      verb: "retract",
      correctionEpisodeId: EPISODE,
      requestId: "req-7",
    });
    // The Error OBJECT, not `err.message`: pino's `scrubErrSerializer` then
    // captures the stack and, for a pg rejection, `code`/`detail`/`constraint`.
    // An `err`-less "audit failed" is not actionable at all — `errOf` throws
    // rather than letting a missing field pass as a match.
    expect(errOf(failure).message).toBe("internal DB circuit breaker is open");
    // The message is a recovery instruction: it must name what SURVIVES, or an
    // operator reads it as "the correction was lost".
    expect(failure?.message).toContain("brain_episodes");
    expect(failure?.message).toContain("admin_action");
    // …and it must NOT claim the row is definitely gone. A deadline does not
    // cancel an insert, so an operator told "not committed" may hand-insert a
    // duplicate forensic row.
    expect(failure?.message).toContain("may not have been committed");
  });

  test("a HUNG write is bounded — a degraded internal DB cannot hold the turn open", async () => {
    // Without the deadline this never settles: `logAdminActionAwait` goes
    // through `internalQuery`, which bypasses the circuit breaker, and the
    // internal pool sets no statement timeout.
    auditBehaviour = () => new Promise<void>(() => {});

    const outcome = await correctFact(
      { ctx: admin, factId: FACT, verb: "pin", requestId: "req-8" },
      { ...fakeTransaction(), auditWriteTimeoutMs: 20 },
    );

    expect(outcome.kind).toBe("corrected");
    expect(committed).toHaveLength(0);
    const errors = logCalls.filter((c) => c.level === "error");
    expect(errors).toHaveLength(1);
    expect(errOf(errors[0]).message).toContain("timed out");
  });

  test("a write that FAILS after the deadline still surfaces its real cause", async () => {
    // `Promise.race` discards the losing branch's outcome, so without a
    // continuation the pg error explaining a slow write is dropped and the only
    // line an operator ever sees is "timed out" — which names the symptom and
    // never the cause.
    auditBehaviour = () =>
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('relation "admin_action_log" does not exist')), 40);
      });

    await correctFact(
      { ctx: admin, factId: FACT, verb: "pin", requestId: "req-late" },
      { ...fakeTransaction(), auditWriteTimeoutMs: 10 },
    );
    // Polled, not slept. A fixed sleep couples the assertion to the scheduler:
    // under a 4-way-sharded CI runner or a WSL2 stall the second line can land
    // after the sleep expires, and the test then fails for a timing reason
    // rather than a behavioural one. There is also no intermediate count
    // assertion, for the mirror-image reason — the rejection can land EARLY.
    await waitFor(() => logCalls.filter((c) => c.level === "error").length === 2);

    const errors = logCalls.filter((c) => c.level === "error");
    expect(errors).toHaveLength(2);
    const late = errors.find((c) => c.message.includes("after its deadline"));
    expect(late).toBeDefined();
    expect(errOf(late).message).toContain("admin_action_log");
    // The line that reports DEFINITIVE loss must carry the same reconstruction
    // fields as the uncertain one — it is the more important of the two.
    expect(late?.payload).toMatchObject({
      actorId: "admin-1",
      verb: "pin",
      correctionEpisodeId: EPISODE,
      requestId: "req-late",
    });
  });

  test("a throw while BUILDING the entry cannot escape onto a committed correction", async () => {
    // The never-throws contract has to be structural, not a comment, because a
    // leak lands on an ALREADY-COMMITTED correction and reaches a caller whose
    // error copy says "nothing was changed — retry"
    // (`lib/tools/correct-fact.ts`), which mints a second correction episode
    // for one human decision. The realistic trigger is not the audit write at
    // all: it is a partial `mock.module` elsewhere leaving `ADMIN_ACTIONS`
    // undefined, i.e. a throw BEFORE the write is even attempted — so the entry
    // literal has to be inside the try, not just the `await`.
    breakAdminActions = true;

    const outcome = await correctFact(
      { ctx: admin, factId: FACT, verb: "retract", requestId: "req-break" },
      fakeTransaction(),
    );

    expect(outcome.kind).toBe("corrected");
    expect(attempted).toHaveLength(0);

    const errors = logCalls.filter((c) => c.level === "error");
    expect(errors).toHaveLength(1);
    // The recovery instruction has to branch. On this path the writer was never
    // called, so `logAdminActionAwait`'s pre-insert `admin_action` pino line was
    // never emitted either — telling an operator to go look for it, or to check
    // `admin_action_log`, sends them after records that do not exist and invites
    // a hand-inserted duplicate row.
    expect(errors[0]?.message).toContain("could not even be BUILT");
    expect(errors[0]?.message).not.toContain("Check admin_action_log");
    expect(errors[0]?.payload).toMatchObject({ writeAttempted: false, actorId: "admin-1" });
    expect(errOf(errors[0]).message).toContain("ADMIN_ACTIONS");
  });

  test("a WRITE failure gets the other recovery instruction — the pino line does exist", async () => {
    // The counterpart to the test above: once `logAdminActionAwait` has been
    // called its pre-insert pino line exists, and the write may still land, so
    // the operator is told to check before re-creating anything.
    auditBehaviour = async () => {
      const pgish = Object.assign(new Error("relation does not exist"), {
        code: "42P01",
        constraint: "pk_admin_action_log",
      });
      throw pgish;
    };

    await correctFact(
      { ctx: admin, factId: FACT, verb: "pin", requestId: "req-pg" },
      fakeTransaction(),
    );

    const errors = logCalls.filter((c) => c.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("may not have been committed");
    // The top-level lift, under stable keys this assertion pins. #4941 also put
    // `code`/`constraint` on `scrubErrSerializer`'s whitelist, so they survive
    // on the serialized `err` too — but that serializer is opt-in per pino
    // instance, and this payload must carry the diagnostics either way.
    expect(errors[0]?.payload).toMatchObject({
      writeAttempted: true,
      pgCode: "42P01",
      pgConstraint: "pk_admin_action_log",
    });
  });

  test("an out-of-range deadline falls back to the real bound instead of timing out instantly", async () => {
    // Both ends, and they fail the SAME way. `??` only catches nullish, so `0`,
    // a negative or `NaN` would mean "time out immediately". And `Infinity` —
    // the natural spelling of "no deadline for this test" — is worse than it
    // looks: `setTimeout` clamps anything past 2^31-1 to ONE millisecond, with
    // nothing but a `TimeoutOverflowWarning` on stderr. A deadline that silently
    // drops every audit row while looking configured is the failure this guards.
    for (const [label, ms] of [
      ["zero", 0],
      ["negative", -1],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["past the 32-bit timer ceiling", 3_000_000_000],
    ] as const) {
      committed.length = 0;
      logCalls.length = 0;
      auditBehaviour = () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });

      await correctFact(
        { ctx: admin, factId: FACT, verb: "pin", requestId: `req-${label}` },
        { ...fakeTransaction(), auditWriteTimeoutMs: ms },
      );

      expect(committed, `deadline ${label} dropped the row`).toHaveLength(1);
      expect(logCalls.filter((c) => c.level === "error")).toHaveLength(0);
      // Falling back SILENTLY would be the CLAUDE.md silent-fallback shape and,
      // practically, a mis-specified seam that turns into a five-second mystery.
      // The rejected value has to appear, or the line cannot say what was wrong.
      const warns = logCalls.filter((c) => c.level === "warn" && c.message.includes("out of range"));
      expect(warns, `deadline ${label} was substituted silently`).toHaveLength(1);
      expect(warns[0]?.payload).toMatchObject({ requested: ms, using: 5_000 });
    }
  });

  test("a write with no resolvable ACTOR warns — an unattributed row is worse than none", async () => {
    // `resolveEntry` falls back to the literal `"unknown"` actor with no
    // complaint, so the module header's "a third entry point inherits the audit
    // trail" is true of the ROW and not of its attribution.
    //
    // Both shapes, because the second is the one that actually happens: a
    // scheduler fiber or a background session resume runs inside
    // `withRequestContext({ requestId })` with NO user, and a guard that only
    // checked for a missing context would wave it through — producing a row that
    // exists and lies, which is a worse artifact than the missing row #4934
    // fixed.
    for (const ctxShape of [undefined, { requestId: "req-sched" }] as const) {
      logCalls.length = 0;
      requestContext = ctxShape;
      await correctFact(
        { ctx: admin, factId: FACT, verb: "pin", requestId: "req-noactor" },
        fakeTransaction(),
      );
      const warns = logCalls.filter(
        (c) => c.level === "warn" && c.message.includes("actor 'unknown'"),
      );
      expect(warns, `no warning for context ${JSON.stringify(ctxShape)}`).toHaveLength(1);
      expect(warns[0]?.message).toContain("withRequestContext");
      // The warn is a finding an operator has to act on, so it carries the same
      // reconstruction fields as the failure lines.
      expect(warns[0]?.payload).toMatchObject({ actorId: "admin-1", factId: FACT, verb: "pin" });
    }
  });

  test("a resolvable actor produces NO warning — the guard is not always-on noise", async () => {
    // Without this the warn test above passes on a guard that fires
    // unconditionally, which would be alert fatigue on every single correction.
    await correctFact(
      { ctx: admin, factId: FACT, verb: "pin", requestId: "req-ok" },
      fakeTransaction(),
    );
    expect(logCalls.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  test("the LOCAL OPERATOR is exempt — `actor unknown` is the correct row there", async () => {
    // `unauthenticated-local` is a deployment that has DECLARED it has no ids to
    // record; `correctFact`'s authority gate lets it through for exactly that
    // reason. Warning on it would fire on every correction in a
    // correctly-configured self-hosted deployment, and a guard that cries wolf
    // on the happy path is a guard someone deletes.
    requestContext = undefined;
    const localOperator = {
      origin: "unauthenticated-local",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    } as const;

    const outcome = await correctFact(
      { ctx: localOperator, factId: FACT, verb: "pin", requestId: "req-local" },
      fakeTransaction(),
    );

    expect(outcome.kind).toBe("corrected");
    expect(committed).toHaveLength(1);
    expect(logCalls.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  test("a prompt write CLEARS its deadline timer instead of leaving it armed", async () => {
    // The timer is cleared in a `finally`. Left armed, a 5s timer holds the
    // event loop open on EVERY correction — on the agent-tool path that is a
    // per-chat-turn cost, and it is invisible to every other assertion in this
    // file because the race has already settled on the winning branch.
    // `process.getActiveResourcesInfo()` does NOT see it (verified: the leak
    // mutation stays green through that lens), so the timer functions
    // themselves are what gets observed.
    type SetTimeoutFn = typeof globalThis.setTimeout;
    type ClearTimeoutFn = typeof globalThis.clearTimeout;
    const realSetTimeout: SetTimeoutFn = globalThis.setTimeout;
    const realClearTimeout: ClearTimeoutFn = globalThis.clearTimeout;
    const created = new Set<ReturnType<SetTimeoutFn>>();
    const cleared = new Set<unknown>();
    globalThis.setTimeout = ((...args: Parameters<SetTimeoutFn>) => {
      const handle = realSetTimeout(...args);
      created.add(handle);
      return handle;
    }) as SetTimeoutFn;
    globalThis.clearTimeout = ((handle: Parameters<ClearTimeoutFn>[0]) => {
      cleared.add(handle);
      realClearTimeout(handle);
    }) as ClearTimeoutFn;

    try {
      await correctFact(
        { ctx: admin, factId: FACT, verb: "pin", requestId: "req-9" },
        fakeTransaction(),
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    // The deadline timer is the only one this path arms; if that ever stops
    // being true the assertion is still the right one — every timer armed
    // during a correction must be disarmed by the time it returns.
    expect(created.size).toBeGreaterThan(0);
    expect([...created].filter((h) => !cleared.has(h))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Source guard: one call site, discovered rather than enumerated
// ---------------------------------------------------------------------------

/**
 * Roots walked by the caller sweep. ASSERTED, not `existsSync`-filtered, for
 * `publish-caller-supersession-wiring.test.ts`'s reason: a root that silently
 * filters away shrinks the guarded surface, which is the same failure shape as
 * the bug being guarded. Criterion for membership: a plausible surface for a
 * new `correct_fact` entry point that can reach `@atlas/api/lib/**` — the API
 * package itself, the MCP server, the enterprise seams, the CLI, and the
 * plugin tree.
 */
const ROOTS = [
  "packages/api/src",
  "packages/mcp/src",
  // The CLI's TypeScript is split across three trees and ten-plus files under
  // `lib`/`bin` import `@atlas/api/lib` — walking only `src` would have left
  // the criterion above claiming coverage it did not have.
  "packages/cli/src",
  "packages/cli/lib",
  "packages/cli/bin",
  "ee",
  "plugins",
];

/** `packages/api/src/lib/brain/__tests__` → repo root: six levels up. */
const REPO_ROOT = join(import.meta.dir, "../../../../../..");

/**
 * Held in a constant so THIS file's own path — which contains the segment —
 * cannot be rewritten by a careless find-and-replace over the literal, and so
 * the exclusion reads as a rule rather than a magic string.
 */
const TEST_DIR = "__tests__";

function walk(dir: string, out: string[]): void {
  // Deliberately UNGUARDED. A swallowed `readdirSync` — EACCES, ELOOP, a
  // directory removed mid-walk — silently shrinks the swept surface while the
  // suite stays green, which is the same failure shape as the bug being
  // guarded. The ROOTS assertion only covers the five top-level roots, so it is
  // no substitute; letting a subdirectory failure throw is.
  const entries: string[] = readdirSync(dir);
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    // Tests routinely stub both sides; they are not entry points.
    if (entry.includes(".test.")) continue;
    if (full.includes(`${TEST_DIR}/`)) continue;
    out.push(full);
  }
}

/**
 * Comments and string literals stripped.
 *
 * The comment half has a real in-tree case: `lib/brain/candidates.ts` names
 * `correctFact({ verb: … })` in a `//` line comment, so without it the sweep
 * enrols a phantom caller. The string half is prophylactic — nothing in-tree
 * exercises it today, but an `ADMIN_ACTIONS.brainFact` mention inside a log
 * message is an ordinary thing to write and would read as a reach for the
 * vocabulary.
 *
 * Strings go first so a `//` inside a URL cannot eat the rest of its line. That
 * ordering has a cost the {@link STRIP_ALLOWLIST} canary exists to pay: a lone
 * backtick makes the template-literal regex pair with the NEXT backtick in the
 * file and blank everything between, across lines. Over-stripping is the
 * dangerous direction — it produces a silent false NEGATIVE, exactly the bug
 * being guarded — so the canary compares raw discovery against stripped
 * discovery and fails on any delta it does not expect.
 */
function strip(source: string): string {
  return source
    .replace(/`(?:\\.|[^`\\])*`/gs, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

const CALLS_CORRECT_FACT = /\bcorrectFact\s*\(/;

/**
 * Files whose RAW source names `correctFact(` but whose stripped source does
 * not — i.e. the mentions `strip` is supposed to remove. Every entry is a
 * documented non-caller; anything else appearing in the delta means `strip`
 * has started eating code, and the sweep has quietly stopped guarding.
 */
const STRIP_ALLOWLIST = new Set(["packages/api/src/lib/brain/candidates.ts"]);

describe("source guard: the machinery is the ONLY audit-writing layer for corrections", () => {
  const MACHINERY = join(REPO_ROOT, "packages/api/src/lib/brain/correction.ts");

  test("every walked root exists — a filtered-away root is a shrunken guard", () => {
    for (const root of ROOTS) {
      const full = join(REPO_ROOT, root);
      expect(() => statSync(full), `walked root missing: ${root}`).not.toThrow();
    }
  });

  test("`strip` removes prose, not code — the discovery delta is the allowlist", () => {
    // The defeat this catches, reproduced before it was written: one unbalanced
    // backtick anywhere in a file makes the `/gs` template regex pair with the
    // next backtick in the FILE and blank everything between. 13 of the ~1000
    // walked files already have an odd backtick count. A third entry point
    // landing inside such a region would call `correctFact` AND
    // `logAdminAction` and be invisible to the sweep below — a silent false
    // negative, which is the failure mode the sweep exists to prevent.
    const files: string[] = [];
    for (const root of ROOTS) walk(join(REPO_ROOT, root), files);

    const delta = files
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return CALLS_CORRECT_FACT.test(source) && !CALLS_CORRECT_FACT.test(strip(source));
      })
      .map((f) => f.slice(REPO_ROOT.length + 1))
      .filter((f) => !STRIP_ALLOWLIST.has(f));

    expect(
      delta,
      "`strip` removed a real `correctFact(` call site. Either the file has an unbalanced backtick and " +
        "the template-literal regex ate code, or the mention is a new documented non-caller that belongs " +
        "in STRIP_ALLOWLIST. Do NOT widen the allowlist without reading the file",
    ).toEqual([]);
  });

  test("correctFact's DIRECT callers are discovered, and the known two are among them", () => {
    const files: string[] = [];
    for (const root of ROOTS) walk(join(REPO_ROOT, root), files);

    const callers = files
      .filter((file) => file !== MACHINERY)
      .filter((file) => CALLS_CORRECT_FACT.test(strip(readFileSync(file, "utf8"))))
      .map((f) => f.slice(REPO_ROOT.length + 1));

    // Discovery must actually find the known entry points, or the sweep is
    // vacuous and would pass on an empty result set.
    expect(callers).toContain("packages/api/src/api/routes/admin-brain-facts.ts");
    expect(callers).toContain("packages/api/src/lib/tools/correct-fact.ts");
  });

  test("lib/brain/correction.ts is the ONLY file that reaches for the correction vocabulary", () => {
    // Swept over EVERY walked file, not just `correctFact`'s callers. The
    // header's promise is "two entry points cannot drift into two metadata
    // shapes", and a bulk-import path or a migration backfill that emitted
    // `ADMIN_ACTIONS.brainFact.correct` WITHOUT calling `correctFact` produces
    // exactly that second shape while never appearing in the caller set.
    //
    // The CATALOG reference, not the string value, and that is not the weaker
    // check: `AdminActionType` is the union of `ADMIN_ACTIONS`' values, so a
    // hand-written `"brain_fact.correct"` does not type-check.
    //
    // On RAW source, deliberately. `strip` exists to stop prose enrolling a
    // phantom caller, but here the cost/benefit inverts: over-stripping (the
    // unbalanced-backtick defeat the canary above documents) would hide a real
    // second emitter, while a comment merely MENTIONING the vocabulary is a
    // fair thing to have to explain. There are none today.
    const files: string[] = [];
    for (const root of ROOTS) walk(join(REPO_ROOT, root), files);

    const offenders = files
      .filter((file) => file !== MACHINERY)
      .filter((file) => /\bADMIN_ACTIONS\.brainFact\b/.test(readFileSync(file, "utf8")))
      .map((f) => f.slice(REPO_ROOT.length + 1))
      // The catalog defines the vocabulary; it is not an emitter.
      .filter((f) => f !== "packages/api/src/lib/audit/actions.ts");

    expect(
      offenders,
      "a second file reaches for the correction audit vocabulary. If it WRITES a row, that is the #4934 " +
        "double-log or a second metadata shape for one decision — the row belongs to " +
        "lib/brain/correction.ts. If it only READS the vocabulary (an audit-log filter, a console label " +
        "map), add it to this test's exemption list beside lib/audit/actions.ts. Do not delete the sweep",
    ).toEqual([]);
  });

  test("the machinery reaches for the AWAITED audit helper, never the fire-and-forget one", () => {
    // The regression this exists for: swapping `logAdminActionAwait` back to
    // `logAdminAction` compiles, passes every outcome test above that only
    // counts rows in the happy path, and silently drops the row whenever the
    // internal-DB circuit breaker is open — reproducing #4934 in the one
    // condition where the forensic trail matters most.
    const source = strip(readFileSync(MACHINERY, "utf8"));
    expect(source).toMatch(/\blogAdminActionAwait\s*\(/);
    expect(source).not.toMatch(/\blogAdminAction\s*\(/);
    // …and the deadline is on it. An awaited write with no bound is worse than
    // a fire-and-forget one: it converts a dropped row into a hung chat turn.
    expect(source).toMatch(/Promise\.race\s*\(/);
    expect(source).toMatch(/AUDIT_WRITE_TIMEOUT_MS/);
  });
});
