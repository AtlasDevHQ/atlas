/**
 * What the source cleanup SAYS about refused alias edges (#5112).
 *
 * The sweep is the irreversible act: after it, the source's own
 * `brain_vocabulary_edge` rows are gone and the payloads on `region_migrations`
 * are the last copy of N approved human review decisions. #5036's disclosure fired
 * in phase 2, up to seven days earlier, in a different process's log stream — so
 * nothing spoke at the moment the loss became permanent.
 *
 * ## Why this is a separate file from `cleanup.test.ts`
 *
 * `cleanup.test.ts` imports `../cleanup` STATICALLY. Import declarations are
 * hoisted above every `mock.module` call in the file, and `cleanup.ts` calls
 * `createLogger()` at MODULE SCOPE — so by the time the logger mock lands, the real
 * logger is already bound. Its DB and misrouting mocks work anyway because their
 * exports are only reached at call time; the logger's is not.
 *
 * The fix is a DYNAMIC import after the mocks, which is what this file does. It is
 * a separate file rather than a conversion of that one because the isolated runner
 * gives each file its own process, so the two mock sets cannot interfere — and
 * rewriting a 600-line suite's import to chase a log assertion is a worse trade
 * than a focused file that states its own premise.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// ── Mocks (before the dynamic import below) ─────────────────────────

interface ClientResponder {
  pattern: string;
  rows?: Record<string, unknown>[];
  rowCount?: number;
}
let clientResponders: ClientResponder[] = [];
const clientQueries: Array<{ sql: string; params: unknown[] }> = [];

function clientQuery(
  sql: string,
  params?: unknown[],
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  clientQueries.push({ sql, params: params ?? [] });
  for (const responder of clientResponders) {
    if (!sql.includes(responder.pattern)) continue;
    return Promise.resolve({
      rows: responder.rows ?? [],
      rowCount: responder.rowCount ?? responder.rows?.length ?? 0,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

// ⚠️ THE COMPLETE SURFACE via `buildInternalDbMockDefaults`, not a hand-written
// subset. `mock.module` replaces the WHOLE module, so any export left out becomes
// `undefined` — and `cleanup.ts` reaches `migrate.ts`, `bundle-scope.ts` and
// `misrouting.ts`, so a transitive `import { x }` of an unmocked name is a load-time
// failure in a file with nothing to do with this one. The first draft here listed
// eight keys against ~90 exports and worked only by luck; its sibling in the same
// commit (`admin-migrate-import-errors.test.ts`) already used the helper.
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: async () => [] }),
  getInternalDB: () => ({
    query: clientQuery,
    connect: async () => ({ query: clientQuery, release: () => {} }),
    end: async () => {},
    on: () => {},
  }),
}));

/**
 * `info` and `warn` in SEPARATE sinks.
 *
 * Which channel carried the line is part of what these tests claim: the `info` is
 * the routine deletion audit that fires for every cleanup, while the `warn` says
 * an irreversible thing just happened to a human's approved decision. One merged
 * sink would pass a mutation that swapped them, which is this repo's recorded
 * "helper that merges what the test asserts" shape.
 */
const infos: Array<{ payload: Record<string, unknown>; message: string }> = [];
const warns: Array<{ payload: Record<string, unknown>; message: string }> = [];

// Every value export of `lib/logger`, matching the two sibling suites rather than
// being the one file that supplies a single key.
void mock.module("@atlas/api/lib/logger", () => {
  const record =
    (sink: Array<{ payload: Record<string, unknown>; message: string }>) =>
    (payload: unknown, message?: unknown) =>
      sink.push({
        payload: (payload ?? {}) as Record<string, unknown>,
        message: typeof message === "string" ? message : String(payload),
      });
  const logger = {
    info: record(infos),
    warn: record(warns),
    error: () => {},
    debug: () => {},
    level: "info",
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    setLogLevel: () => true,
    getRequestContext: () => undefined,
    withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  };
});

void mock.module("@atlas/api/lib/residency/misrouting", () => ({
  getApiRegion: () => null,
  getMisroutedCount: () => 0,
  _resetMisroutedCount: () => {},
  _resetRegionCache: () => {},
  isStrictRoutingEnabled: () => false,
  detectMisrouting: async () => ({ misrouted: false }),
}));

// ── DYNAMIC, after the mocks — see the file docstring ───────────────

const { cleanupMigrationSourceData } = await import("../cleanup");

beforeEach(() => {
  clientResponders = [];
  clientQueries.length = 0;
  infos.length = 0;
  warns.length = 0;
});

/**
 * An eligible, past-grace migration whose workspace has moved away.
 *
 * `vocabulary_edges_refused` is passed through verbatim — `undefined` answers the
 * column as ABSENT, which is what a row written before migration 0204 looks like.
 */
function eligible(
  vocabularyEdgesRefused: number | null | undefined,
  /**
   * How many payloads the row actually holds — `COALESCE(jsonb_array_length(...), 0)`
   * in the real query, so `0` covers both "column NULL" and "empty array".
   *
   * Defaults to matching `refused`, i.e. the complete-recovery case, so a caller that
   * does not care about the split gets the state where the recovery instruction is
   * unconditionally true.
   */
  vocabularyRefusalsRecorded: number = vocabularyEdgesRefused ?? 0,
): void {
  clientResponders.push(
    {
      pattern: "FROM region_migrations WHERE id",
      rows: [
        {
          status: "completed",
          source_cleaned_at: null,
          vocabulary_edges_refused: vocabularyEdgesRefused,
          vocabulary_refusals_recorded: vocabularyRefusalsRecorded,
        },
      ],
    },
    { pattern: "FROM organization", rows: [{ region: "eu-west" }] },
  );
}

const run = () =>
  cleanupMigrationSourceData({ id: "mig-1", workspaceId: "org-1", sourceRegion: "us-east" });

const REFUSAL_WARN = "DELETED the brain_vocabulary_edge rows";

function auditEvent(): Record<string, unknown> | undefined {
  return infos.find((i) => i.payload.event === "region_migration_source_cleaned")?.payload;
}

describe("source cleanup — refused alias edges (#5112)", () => {
  it("⭐ reads the count on the SAME `FOR UPDATE` row lock, not a second query", async () => {
    // The existing eligibility re-check already holds the lock that pins the
    // verdict to the deletes, so the count is read UNDER it. A second query would
    // be an extra round-trip per migration for a field the first one can carry —
    // and, worse, would read outside the lock.
    eligible(2);
    await run();

    const lockReads = clientQueries.filter((q) => q.sql.includes("FROM region_migrations WHERE id"));
    expect(lockReads).toHaveLength(1);
    expect(lockReads[0].sql).toContain("vocabulary_edges_refused");
    expect(lockReads[0].sql).toContain("FOR UPDATE");
  });

  it("⭐ carries the count on the deletion audit event AND warns separately", async () => {
    eligible(2);
    const result = await run();
    // Positive control: the deletes actually ran, so the event describes a real
    // deletion rather than a skip.
    expect(result.outcome).toBe("cleaned");

    const audit = auditEvent();
    expect(audit).toBeDefined();
    expect(audit).toMatchObject({ migrationId: "mig-1", vocabularyEdgesRefused: 2 });

    const warn = warns.find((w) => w.message.includes(REFUSAL_WARN));
    expect(warn).toBeDefined();
    expect(warn?.payload).toMatchObject({
      migrationId: "mig-1",
      vocabularyEdgesRefused: 2,
      vocabularyRefusalsRecorded: 2,
    });
    // Points at where the payloads still are — the only actionable part of the
    // line, and the reason it is not just a count.
    expect(warn?.message).toContain("vocabulary_refusals");
    expect(warn?.message).toContain("all on this migration");
  });

  it("⭐ does NOT promise payloads when NONE were recorded", async () => {
    // The state review round 1 caught: the column is NULL for a target that predated
    // the payload contract, and the first version of this warn told the operator to
    // re-author from it unconditionally — at the exact instant the originals stopped
    // existing. A recovery instruction pointing at an empty column is worse than none.
    eligible(3, 0);
    await run();

    const warn = warns.find((w) => w.message.includes(REFUSAL_WARN));
    expect(warn).toBeDefined();
    expect(warn?.payload).toMatchObject({
      vocabularyEdgesRefused: 3,
      vocabularyRefusalsRecorded: 0,
    });
    expect(warn?.message).toContain("NO recovery payload was recorded");
    expect(warn?.message).toContain("target region's own log is the only surviving copy");
    // ⚠️ And it must NOT say the payloads are here. This is the assertion that goes
    // red if the three-way branch collapses back to one message.
    expect(warn?.message).not.toContain("all on this migration");
  });

  it("⭐ reports a PARTIAL recording as partial", async () => {
    // The cap bit, or entries were screened out. Two numbers, deliberately unequal —
    // with `recorded === refused` this case is indistinguishable from the complete
    // one, which is the accidental equality the default argument above would give it.
    eligible(9, 4);
    await run();

    const warn = warns.find((w) => w.message.includes(REFUSAL_WARN));
    expect(warn?.payload).toMatchObject({
      vocabularyEdgesRefused: 9,
      vocabularyRefusalsRecorded: 4,
    });
    expect(warn?.message).toContain("Only 4 of the 9 recovery payloads");
    expect(warn?.message).toContain("the remainder exist only");
    expect(warn?.message).not.toContain("NO recovery payload was recorded");
  });

  it("⭐ does NOT warn on zero, but still reports the zero on the audit event", async () => {
    // `0` is a positive claim — the target answered and refused nothing — and it
    // belongs in the audit trail. What it must not do is fire the warn: a
    // disclosure that fires for every migration that lost nothing is alarm fatigue,
    // and dropping `&& > 0` from the guard is the mutation this catches.
    eligible(0);
    await run();

    expect(auditEvent()?.vocabularyEdgesRefused).toBe(0);
    expect(warns.filter((w) => w.message.includes(REFUSAL_WARN))).toEqual([]);
  });

  it("⭐ reports NULL — not 0 — for a row written before migration 0204", async () => {
    // UNKNOWN and "nothing was refused" are different sentences, and only one of
    // them this column can make for a pre-0204 row. Coercing to `0` would have the
    // audit trail assert that an old migration lost nothing, which it cannot know.
    eligible(undefined);
    await run();

    const audit = auditEvent();
    expect(audit).toBeDefined();
    // Present-and-null, not absent: a missing key and "we do not know" read
    // identically in a log aggregator, and only one of them is true.
    expect(audit).toHaveProperty("vocabularyEdgesRefused");
    expect(audit?.vocabularyEdgesRefused).toBeNull();
    // Unknown is not a reason to shout — there may be nothing to shout about.
    expect(warns.filter((w) => w.message.includes(REFUSAL_WARN))).toEqual([]);
  });

  it("says nothing about refusals when the cleanup was SKIPPED by the cutover guard", async () => {
    // The workspace is homed in the source region again, so nothing was deleted —
    // and a warn claiming the edges are gone would be false. The count is real and
    // non-zero here, so this is the input class where the guard on the DELETE path
    // is the only thing keeping the line honest.
    clientResponders.push(
      {
        pattern: "FROM region_migrations WHERE id",
        rows: [{ status: "completed", source_cleaned_at: null, vocabulary_edges_refused: 3 }],
      },
      { pattern: "FROM organization", rows: [{ region: "us-east" }] },
    );

    const result = await run();

    expect(result.outcome).toBe("workspace_active_in_source");
    expect(warns.filter((w) => w.message.includes(REFUSAL_WARN))).toEqual([]);
    // And the deletion audit event never fired at all — the skip has its own.
    expect(auditEvent()).toBeUndefined();
  });
});
