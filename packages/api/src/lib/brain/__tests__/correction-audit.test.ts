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
 *     in metadata; NOT emitted for a refusal or a not-found (#4934's recorded
 *     non-goal — `admin_action_log` consumers may read the table as
 *     success-only);
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
 *   - and a SOURCE-LEVEL guard that discovers every `correctFact` caller and
 *     pins that none of them writes an audit row of its own. That is the half
 *     that makes "a third entry point cannot land uncovered" true by
 *     construction rather than by review diligence — the failure mode #4934
 *     was, at one entry point, exactly this.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, mock } from "bun:test";

// --- logger: every VALUE export stubbed (mock-all-exports) -----------------
type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];
const recorder = {
  error: (payload: unknown, message: string) => logCalls.push({ level: "error", payload, message }),
  warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
  info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
  debug: (payload: unknown, message: string) => logCalls.push({ level: "debug", payload, message }),
};
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => recorder,
  getLogger: () => ({ ...recorder, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
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
/** Set if anything calls the FIRE-AND-FORGET variant — nothing here may. */
let fireAndForgetCalls = 0;

void mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: {
    brainFact: { retract: "brain_fact.retract", correct: "brain_fact.correct" },
  },
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
 * `retract` and the vouch verbs. `supersede` runs the whole reconcile path and
 * is pinned there; its audit row rides the SAME expression as `pin`'s (every
 * non-retract verb maps to `brain_fact.correct`), so what is left untested here
 * is reconcile, not the audit mapping.
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

beforeEach(() => {
  logCalls.length = 0;
  committed.length = 0;
  attempted.length = 0;
  fireAndForgetCalls = 0;
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
        workspaceId: WS,
        correctionEpisodeId: EPISODE,
        invalidatedAt: NOW.toISOString(),
        flaggedForReReview: ["dep-1"],
      },
    });
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
    let release: (() => void) | undefined;
    auditBehaviour = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        // Resolve on a later microtask+macrotask so a non-awaiting caller
        // returns first and the assertion below sees an empty list.
        setTimeout(() => resolve(), 5);
      });

    const outcome = await correctFact(
      { ctx: admin, factId: FACT, verb: "pin", requestId: "req-6" },
      fakeTransaction(),
    );

    expect(outcome.kind).toBe("corrected");
    expect(committed).toHaveLength(1);
    release?.();
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
    // The underlying cause must reach the line — an `err`-less "audit failed"
    // is not actionable, and CLAUDE.md requires the caught error be narrowed
    // and logged rather than dropped.
    expect(failure?.payload).toMatchObject({
      workspaceId: WS,
      factId: FACT,
      verb: "retract",
      correctionEpisodeId: EPISODE,
      requestId: "req-7",
      err: "internal DB circuit breaker is open",
    });
    // The message is a recovery instruction: it must name what SURVIVES, or an
    // operator reads it as "the correction was lost".
    expect(failure?.message).toContain("brain_episodes");
    expect(failure?.message).toContain("admin_action");
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
    expect((errors[0]?.payload as { err?: string } | undefined)?.err).toContain("timed out");
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
  "packages/cli/src",
  "ee",
  "plugins",
];

/** `packages/api/src/lib/brain/__tests__` → repo root: six levels up. */
const REPO_ROOT = join(import.meta.dir, "../../../../../..");

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // A root that vanished is a shrunken guard, not a pass — the ROOTS
    // assertion below turns this into a failure rather than silence.
    return;
  }
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
    if (full.includes(`${"__tests__"}/`)) continue;
    out.push(full);
  }
}

/**
 * Comments and string literals stripped, strings FIRST so a `//` inside a URL
 * cannot eat the rest of its line. Both matter here: this file's own prose
 * names `logAdminAction` repeatedly, and a log message naming its own helper is
 * an ordinary thing to write.
 */
function strip(source: string): string {
  return source
    .replace(/`(?:\\.|[^`\\])*`/gs, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

describe("source guard: the machinery is the ONLY audit-writing layer for corrections", () => {
  const MACHINERY = join(REPO_ROOT, "packages/api/src/lib/brain/correction.ts");

  test("every walked root exists — a filtered-away root is a shrunken guard", () => {
    for (const root of ROOTS) {
      const full = join(REPO_ROOT, root);
      expect(() => statSync(full), `walked root missing: ${root}`).not.toThrow();
    }
  });

  test("no caller of correctFact writes an audit row of its own", () => {
    const files: string[] = [];
    for (const root of ROOTS) walk(join(REPO_ROOT, root), files);

    const callers = files.filter((file) => {
      if (file === MACHINERY) return false;
      return /\bcorrectFact\s*\(/.test(strip(readFileSync(file, "utf8")));
    });

    // Discovery must actually find the known entry points, or the sweep is
    // vacuous and would pass on an empty result set.
    const relative = callers.map((f) => f.slice(REPO_ROOT.length + 1));
    expect(relative).toContain("packages/api/src/api/routes/admin-brain-facts.ts");
    expect(relative).toContain("packages/api/src/lib/tools/correct-fact.ts");

    const offenders = callers.filter((file) =>
      /\blogAdminAction(Await)?\s*\(/.test(strip(readFileSync(file, "utf8"))),
    );
    expect(
      offenders.map((f) => f.slice(REPO_ROOT.length + 1)),
      "an entry point onto correctFact writes its own admin_action_log row — that is either the #4934 " +
        "double-log or a second metadata shape for one decision. The row belongs to lib/brain/correction.ts",
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
