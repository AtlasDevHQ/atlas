/**
 * What the source cleanup SAYS about refused decisions (#5112, all three sections
 * since #5557).
 *
 * The sweep is the irreversible act: after it, the source's own
 * `brain_vocabulary_edge`, `brain_vocabulary_proposal` and
 * `brain_predicate_cardinality` rows are gone and the payloads on
 * `region_migrations` are the last copy of N human review decisions. #5036's
 * disclosure fired in phase 2, up to seven days earlier, in a different process's log
 * stream — so nothing spoke at the moment the loss became permanent.
 *
 * ## The three sections are read INDEPENDENTLY, and that is most of this file
 *
 * #5533 shipped the two vocabulary-memory payload columns with no delete-time
 * reader at all, which is the gap #5557 closes. The cheap way to close it is one
 * summed verdict over all three — and that is wrong in a way no total can express: a
 * migration that recorded every edge payload and no cardinality payload is COMPLETE
 * for one section and EMPTY for the other, so a summed "partial" would send the
 * operator to a column holding nothing for the decision they are chasing. Every
 * cross-section case below exists to keep the three verdicts, tables and columns from
 * being folded into one.
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

/** One section's two numbers, as the locked row would answer them. */
interface SectionRow {
  /**
   * `undefined` answers the count column as ABSENT, which is what a row written
   * before that section's migration looks like (0204 for edges, 0212 for the two
   * #5533 sections).
   */
  readonly refused?: number | null;
  /**
   * How many payloads the row actually holds — `COALESCE(jsonb_array_length(...), 0)`
   * in the real query, so `0` covers both "column NULL" and "empty array".
   *
   * Defaults to matching `refused`, i.e. the complete-recovery case, so a caller that
   * does not care about the split gets the state where the recovery instruction is
   * unconditionally true.
   */
  readonly recorded?: number;
}

/**
 * An eligible, past-grace migration whose workspace has moved away.
 *
 * ⚠️ A SECTION LEFT OUT answers BOTH its columns as absent — the pre-migration row.
 * That is the useful default rather than zeros: a test about one section then says
 * nothing about the other two, and cannot accidentally assert that they were read as
 * "nothing refused" when the code has not looked at them at all.
 */
function eligible(sections: {
  readonly edges?: SectionRow;
  readonly proposals?: SectionRow;
  readonly cardinalities?: SectionRow;
}): void {
  const row: Record<string, unknown> = { status: "completed", source_cleaned_at: null };
  const put = (s: SectionRow | undefined, countColumn: string, recordedColumn: string) => {
    if (!s) return;
    row[countColumn] = s.refused;
    row[recordedColumn] = s.recorded ?? s.refused ?? 0;
  };
  put(sections.edges, "vocabulary_edges_refused", "vocabulary_refusals_recorded");
  put(
    sections.proposals,
    "vocabulary_proposals_refused",
    "vocabulary_proposal_refusals_recorded",
  );
  put(
    sections.cardinalities,
    "predicate_cardinalities_refused",
    "predicate_cardinality_refusals_recorded",
  );
  clientResponders.push(
    { pattern: "FROM region_migrations WHERE id", rows: [row] },
    { pattern: "FROM organization", rows: [{ region: "eu-west" }] },
  );
}

const run = () =>
  cleanupMigrationSourceData({ id: "mig-1", workspaceId: "org-1", sourceRegion: "us-east" });

const REFUSAL_WARN = "DELETED the brain_vocabulary_edge rows";
const PROPOSAL_WARN = "DELETED the brain_vocabulary_proposal rows";
const CARDINALITY_WARN = "DELETED the brain_predicate_cardinality rows";

/**
 * ⚠️ `brain_vocabulary_edge` is a PREFIX of nothing here, but `brain_vocabulary_proposal`
 * is not a prefix of `brain_vocabulary_edge` either — the three markers are mutually
 * exclusive substrings, which is what lets `warnsFor` be an honest per-section filter.
 * Checked deliberately: a marker that matched two sections would make every
 * "exactly one warn" assertion below vacuous.
 */
function warnsFor(marker: string): Array<{ payload: Record<string, unknown>; message: string }> {
  return warns.filter((w) => w.message.includes(marker));
}

function warnFor(marker: string): { payload: Record<string, unknown>; message: string } | undefined {
  return warnsFor(marker)[0];
}

function auditEvent(): Record<string, unknown> | undefined {
  return infos.find((i) => i.payload.event === "region_migration_source_cleaned")?.payload;
}

describe("source cleanup — refused alias edges (#5112)", () => {
  it("⭐ reads ALL SIX refusal columns on the SAME `FOR UPDATE` row lock, not a second query", async () => {
    // The existing eligibility re-check already holds the lock that pins the
    // verdict to the deletes, so the counts are read UNDER it. A second query would
    // be an extra round-trip per migration for fields the first one can carry —
    // and, worse, would read outside the lock.
    eligible({ edges: { refused: 2 } });
    await run();

    const lockReads = clientQueries.filter((q) => q.sql.includes("FROM region_migrations WHERE id"));
    expect(lockReads).toHaveLength(1);
    expect(lockReads[0].sql).toContain("FOR UPDATE");
    // ⚠️ Every payload column by name (#5557). A section listed in the audit table
    // but missing from the SELECT reads back `undefined`, which the module narrows
    // to "count unknown, nothing recorded" — i.e. silence, the exact failure this
    // issue closes, reintroduced with no symptom.
    for (const column of [
      "vocabulary_edges_refused",
      "vocabulary_refusals",
      "vocabulary_proposals_refused",
      "vocabulary_proposal_refusals",
      "predicate_cardinalities_refused",
      "predicate_cardinality_refusals",
    ]) {
      expect(lockReads[0].sql).toContain(column);
    }
  });

  it("⭐ carries the count on the deletion audit event AND warns separately", async () => {
    eligible({ edges: { refused: 2 } });
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
    eligible({ edges: { refused: 3, recorded: 0 } });
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
    eligible({ edges: { refused: 9, recorded: 4 } });
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
    eligible({ edges: { refused: 0 } });
    await run();

    expect(auditEvent()?.vocabularyEdgesRefused).toBe(0);
    expect(warns.filter((w) => w.message.includes(REFUSAL_WARN))).toEqual([]);
  });

  it("⭐ reports NULL — not 0 — for a row written before migration 0204", async () => {
    // UNKNOWN and "nothing was refused" are different sentences, and only one of
    // them this column can make for a pre-0204 row. Coercing to `0` would have the
    // audit trail assert that an old migration lost nothing, which it cannot know.
    eligible({ edges: { refused: undefined } });
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
    // and a warn claiming the rows are gone would be false. Every count is real and
    // non-zero here, so this is the input class where the guard on the DELETE path
    // is the only thing keeping all three lines honest.
    clientResponders.push(
      {
        pattern: "FROM region_migrations WHERE id",
        rows: [
          {
            status: "completed",
            source_cleaned_at: null,
            vocabulary_edges_refused: 3,
            vocabulary_proposals_refused: 2,
            predicate_cardinalities_refused: 1,
          },
        ],
      },
      { pattern: "FROM organization", rows: [{ region: "us-east" }] },
    );

    const result = await run();

    expect(result.outcome).toBe("workspace_active_in_source");
    expect(warnsFor(REFUSAL_WARN)).toEqual([]);
    expect(warnsFor(PROPOSAL_WARN)).toEqual([]);
    expect(warnsFor(CARDINALITY_WARN)).toEqual([]);
    // And the deletion audit event never fired at all — the skip has its own.
    expect(auditEvent()).toBeUndefined();
  });
});

describe("source cleanup — the two #5533 sections get the same audit (#5557)", () => {
  it("⭐ the three section markers are mutually exclusive", () => {
    // The premise every "exactly one warn" assertion below rests on. If one marker
    // were a substring of another's message, `warnsFor` would return two entries for
    // one section and the isolation cases would pass without isolating anything.
    for (const [a, b] of [
      [REFUSAL_WARN, PROPOSAL_WARN],
      [PROPOSAL_WARN, CARDINALITY_WARN],
      [REFUSAL_WARN, CARDINALITY_WARN],
    ]) {
      expect(a.includes(b)).toBe(false);
      expect(b.includes(a)).toBe(false);
    }
  });

  it("⭐ warns about refused alias-PROPOSAL decisions, naming that section's own table and column", async () => {
    eligible({ proposals: { refused: 4 } });
    const result = await run();
    expect(result.outcome).toBe("cleaned");

    const warn = warnFor(PROPOSAL_WARN);
    expect(warn).toBeDefined();
    expect(warn?.payload).toMatchObject({
      migrationId: "mig-1",
      section: "brainVocabularyProposals",
      vocabularyProposalsRefused: 4,
      vocabularyProposalRefusalsRecorded: 4,
    });
    expect(warn?.message).toContain("region_migrations.vocabulary_proposal_refusals");
    expect(warn?.message).toContain("all on this migration");
    // ⚠️ AND NOT the edge section's table or column. A warn that names
    // `brain_vocabulary_edge` while reporting a refused proposal decision sends the
    // operator to a table that does not hold it — the defect `migrate.ts`'s
    // pre-cutover disclosure was made per-section to avoid, one phase later.
    expect(warn?.message).not.toContain("brain_vocabulary_edge");
    expect(warn?.message).not.toContain("region_migrations.vocabulary_refusals");
    // And the edge section, absent from this row, stays silent.
    expect(warnsFor(REFUSAL_WARN)).toEqual([]);
  });

  it("⭐ warns about refused predicate-CARDINALITY decisions, naming that section's own table and column", async () => {
    eligible({ cardinalities: { refused: 5, recorded: 2 } });
    await run();

    const warn = warnFor(CARDINALITY_WARN);
    expect(warn).toBeDefined();
    expect(warn?.payload).toMatchObject({
      section: "brainPredicateCardinalities",
      predicateCardinalitiesRefused: 5,
      predicateCardinalityRefusalsRecorded: 2,
    });
    expect(warn?.message).toContain("Only 2 of the 5 recovery payloads");
    expect(warn?.message).toContain("region_migrations.predicate_cardinality_refusals");
    expect(warn?.message).not.toContain("brain_vocabulary_edge");
    expect(warn?.message).not.toContain("brain_vocabulary_proposal");
  });

  it("⭐ each section gets its OWN three-state verdict, not one summed over the three", async () => {
    // The case a total cannot express, and the whole argument for three warns.
    // Summed this row is 5 refused / 2 recorded — "partial" — which is true of
    // neither section: the edges are COMPLETE and the cardinalities have NOTHING.
    // A summed line would tell an operator chasing a cardinality decision that some
    // payloads are on the row, and point them at a column holding none.
    eligible({
      edges: { refused: 2, recorded: 2 },
      cardinalities: { refused: 3, recorded: 0 },
    });
    await run();

    const edge = warnFor(REFUSAL_WARN);
    expect(edge?.message).toContain("all on this migration");
    expect(edge?.message).not.toContain("NO recovery payload was recorded");

    const cardinality = warnFor(CARDINALITY_WARN);
    expect(cardinality?.message).toContain("NO recovery payload was recorded");
    expect(cardinality?.message).not.toContain("all on this migration");

    // Neither says "partial", which is what the sum would have said for both.
    for (const warn of [edge, cardinality]) {
      expect(warn?.message).not.toContain("recovery payloads are on this migration's");
    }
    // Exactly two lines: the proposal section is absent from this row and unknown,
    // and unknown is not a reason to shout.
    expect(warnsFor(PROPOSAL_WARN)).toEqual([]);
  });

  it("⭐ carries all six numbers on the ONE deletion audit event", async () => {
    // One event, not three: this is the deletion audit, and an operator correlating
    // a sweep reads a single line. The three sections are distinguished by key, which
    // is why the keys are written out rather than derived from column names.
    eligible({
      edges: { refused: 2, recorded: 1 },
      proposals: { refused: 4, recorded: 4 },
      cardinalities: { refused: 0 },
    });
    await run();

    const audit = auditEvent();
    expect(audit).toMatchObject({
      vocabularyEdgesRefused: 2,
      vocabularyRefusalsRecorded: 1,
      vocabularyProposalsRefused: 4,
      vocabularyProposalRefusalsRecorded: 4,
      predicateCardinalitiesRefused: 0,
      predicateCardinalityRefusalsRecorded: 0,
    });
    // Every number distinct from the ones around it where it can be, so a crossed
    // section→key mapping cannot round-trip clean.
    expect(
      infos.filter((i) => i.payload.event === "region_migration_source_cleaned"),
    ).toHaveLength(1);
  });

  it("⭐ reports the new sections as NULL — not 0 — for a row written before migration 0212", async () => {
    // The #5533 columns did not exist before 0212, and every migration completed
    // before it has them absent. `0` there would be the audit trail asserting that
    // an old migration refused no vocabulary decisions, which it cannot know — and
    // `COALESCE(..., 0)` on the PAYLOAD column deliberately does not extend to the
    // COUNT column, which is the distinction this pins.
    eligible({ edges: { refused: 1 } });
    await run();

    const audit = auditEvent();
    expect(audit).toHaveProperty("vocabularyProposalsRefused");
    expect(audit).toHaveProperty("predicateCardinalitiesRefused");
    expect(audit?.vocabularyProposalsRefused).toBeNull();
    expect(audit?.predicateCardinalitiesRefused).toBeNull();
    // The payload halves are `0` — "no payload is recoverable" is a claim the
    // COALESCE can make for an absent column, unlike the count.
    expect(audit?.vocabularyProposalRefusalsRecorded).toBe(0);
    expect(audit?.predicateCardinalityRefusalsRecorded).toBe(0);
    expect(warnsFor(PROPOSAL_WARN)).toEqual([]);
    expect(warnsFor(CARDINALITY_WARN)).toEqual([]);
  });

  it("⭐ does NOT warn for a section that refused zero while another section did refuse", async () => {
    // Alarm fatigue, per section. Dropping `refused <= 0` from the loop guard fires
    // a line about a section that lost nothing on every migration that lost
    // something anywhere — and the one-section version of this case cannot catch it,
    // because with nothing refused anywhere the loop emits nothing either way.
    eligible({ edges: { refused: 3 }, proposals: { refused: 0 } });
    await run();

    expect(warnsFor(REFUSAL_WARN)).toHaveLength(1);
    expect(warnsFor(PROPOSAL_WARN)).toEqual([]);
    expect(auditEvent()?.vocabularyProposalsRefused).toBe(0);
  });

  it("⭐ the routine completion `info` carries all three counts, and is not the warn", async () => {
    // The `info` fires for every migration and an operator grepping it is looking at
    // row counts; the warns say something irreversible happened. Both channels
    // carrying all three sections is the point — one channel carrying both messages
    // is the mutation this catches.
    eligible({
      edges: { refused: 1 },
      proposals: { refused: 2 },
      cardinalities: { refused: 3 },
    });
    await run();

    const completed = infos.find((i) => i.message === "Source-region data cleanup completed");
    expect(completed).toBeDefined();
    expect(completed?.payload).toMatchObject({
      vocabularyEdgesRefused: 1,
      vocabularyProposalsRefused: 2,
      predicateCardinalitiesRefused: 3,
    });
    // Routine line, so counts only — the recovery sentences live on the warns.
    expect(completed?.message).not.toContain("DELETED");
    expect(warnsFor(REFUSAL_WARN)).toHaveLength(1);
    expect(warnsFor(PROPOSAL_WARN)).toHaveLength(1);
    expect(warnsFor(CARDINALITY_WARN)).toHaveLength(1);
  });
});
