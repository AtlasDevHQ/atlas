/**
 * Denominator snapshots against a real Postgres (#5213, ADR-0041).
 *
 * ## The claims that need a database, and why a double cannot own them
 *
 * **(a) The migration's CHECKs.** `state` is stored beside the two columns it is
 * derived from, and what makes that redundancy safe rather than rot is
 * `ck_brain_coverage_snapshot_state_is_evidence` — ADR-0040 rule 3 as a
 * constraint. Only a real server can refuse the row. So can it refuse a `human`
 * unit, which is the one disclosure ADR-0041 names ("individual persons").
 *
 * **(b) A FAILED CYCLE NEVER ZEROES THE ROSTER.** This is the AC that a scripted
 * double structurally cannot answer: the assertion is that a statement did NOT
 * reach a table it never names, and a fake `persist` written to leave rows alone
 * is asserting its own script (#5000's trap). Every negative below therefore
 * sits beside a POSITIVE CONTROL from the same call — a successful cycle either
 * side of the failed one, proving the write path was live the whole time.
 *
 * **(c) The sweep retires what a cycle did not re-observe.** Keyed on `cycle_at`
 * inside the write's own transaction, so nothing outside the database can
 * demonstrate that the delete reaches exactly the un-restamped rows.
 *
 * ## Adversarial fixtures, by ADR-0041's charter
 *
 * *"Test vendor rosters are authored independently of the snapshots the page
 * reads … A fixture where roster and snapshot come from one literal cannot
 * falsify."* So {@link VENDOR_ROSTER} below is a hand-authored Slack response —
 * the vendor's answer — and the perimeter rows are seeded separately through
 * SQL. Nothing derives one from the other, which is what lets the four named
 * mutations redden:
 *
 *   - remove an enumerated unit from the roster → the denominator drops (loud
 *     understatement);
 *   - plant vendor activity newer than our newest episode → the lag is present
 *     in the row rather than structurally zero;
 *   - sicken the activity probe → the reading is absent AND a map edge appears,
 *     which is "unverified since" rather than "current";
 *   - take away the roster scope → the perimeter half still enumerates and the
 *     map edge says why.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { identityAlias, slotKey } from "@atlas/api/lib/brain/identity";
import {
  persistCoverageSnapshot,
  readActivityProbeRotation,
  readCoverageSnapshot,
  readCoverageUnits,
  recordClassScanFailure,
  type CoverageEnumeration,
  type EnumeratedSurveyUnit,
} from "@atlas/api/lib/brain/coverage-enumeration";
import {
  CHAT_ACTIVITY_PROBES_PER_CYCLE,
  PUBLIC_ROSTER_MAX_PAGES,
  enumerateSlackCoverage,
} from "@atlas/api/lib/brain/ingest/slack/coverage";
import {
  WAREHOUSE_COVERAGE_MAX_ENTITIES,
  enumerateWarehouseCoverage,
  warehouseSurveyUnitId,
} from "@atlas/api/lib/brain/coverage-warehouse";
import { slackEpisodeSourceId } from "@atlas/api/lib/brain/ingest/slack/config";
import { warehouseEpisodeSourceId } from "@atlas/api/lib/brain/warehouse-producer";
import type {
  SlackConversationInfo,
  SlackConversationsListPage,
  SlackHistoryPage,
  SlackReadError,
} from "@atlas/api/lib/slack/api";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-coverage";
const OTHER_WORKSPACE = "ws-coverage-other";

/** A cycle instant, and one strictly LATER — the sweep compares them. */
const CYCLE_1 = new Date("2026-08-01T09:00:00.000Z");
const CYCLE_2 = new Date("2026-08-01T10:00:00.000Z");

/**
 * The VENDOR's answer, authored by hand and never derived from the perimeter
 * rows the tests seed.
 *
 * ⚠️ The union fixtures seed a perimeter channel that is NOT in this roster
 * (`G0PRIVATE`), and that is what makes a count assertion mean anything. An
 * earlier version seeded only channels this list already contains, so the
 * perimeter set was a SUBSET and |union| == |roster| — a union that returned the
 * roster alone passed every count. The comment claimed otherwise; the fixture is
 * what was wrong.
 */
const VENDOR_ROSTER: readonly SlackConversationInfo[] = [
  { id: "C0INSIDE", name: "general", isPrivate: false, isMember: true, isArchived: false },
  { id: "C0OUTSIDE", name: "random", isPrivate: false, isMember: false, isArchived: false },
  { id: "C0THIRD", name: "incidents", isPrivate: false, isMember: false, isArchived: false },
];

/** A successful enumeration with no map edges — the fixture shorthand. */
const success = (units: readonly EnumeratedSurveyUnit[]): CoverageEnumeration => ({
  ok: true,
  units,
  degraded: [],
});

function unit(over: Partial<EnumeratedSurveyUnit> & { unitId: string }): EnumeratedSurveyUnit {
  return {
    label: null,
    inPerimeter: false,
    deliberateAct: false,
    vendorReportsPublic: false,
    newestEvidenceAt: null,
    activity: { probed: false },
    ...over,
  };
}

describeIfPg("coverage denominator snapshots (#5213, ADR-0041)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_5213_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await pool.query(`DELETE FROM brain_coverage_snapshot`);
    await pool.query(`DELETE FROM brain_coverage_cycle`);
    await pool.query(`DELETE FROM brain_slack_channel`);
    await pool.query(`DELETE FROM brain_enrollment`);
    await pool.query(`DELETE FROM brain_facts`);
    await pool.query(`DELETE FROM brain_episodes`);
  });

  // -------------------------------------------------------------------------
  // (a) The migration — real-PG smoke on the constraints that carry the rules
  // -------------------------------------------------------------------------

  describe("the migration's constraints", () => {
    async function insertRow(over: Record<string, unknown> = {}) {
      const row = {
        workspace_id: WORKSPACE,
        source_class: "chat",
        unit_id: "C0INSIDE",
        state: "enumerated",
        in_perimeter: false,
        unit_label: null,
        deliberate_act: false,
        vendor_reports_public: false,
        newest_evidence_at: null,
        vendor_activity_at: null,
        vendor_activity_checked_at: null,
        cycle_at: CYCLE_1.toISOString(),
        ...over,
      };
      await pool.query(
        `INSERT INTO brain_coverage_snapshot
           (workspace_id, source_class, unit_id, state, in_perimeter, unit_label,
            deliberate_act, vendor_reports_public, newest_evidence_at,
            vendor_activity_at, vendor_activity_checked_at, cycle_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          row.workspace_id,
          row.source_class,
          row.unit_id,
          row.state,
          row.in_perimeter,
          row.unit_label,
          row.deliberate_act,
          row.vendor_reports_public,
          row.newest_evidence_at,
          row.vendor_activity_at,
          row.vendor_activity_checked_at,
          row.cycle_at,
        ],
      );
    }

    it("admits an honest row, so every refusal below has a positive control", async () => {
      await insertRow();
      const { rows } = await pool.query(`SELECT 1 FROM brain_coverage_snapshot`);
      expect(rows.length).toBe(1);
    });

    it("REFUSES `surveyed` with no observed evidence — green is evidence", async () => {
      await expect(
        insertRow({ state: "surveyed", in_perimeter: true, newest_evidence_at: null }),
      ).rejects.toThrow(/ck_brain_coverage_snapshot_state_is_evidence/);
    });

    it("REFUSES `surveyed` outside the perimeter, however much evidence there is", async () => {
      await expect(
        insertRow({
          state: "surveyed",
          in_perimeter: false,
          newest_evidence_at: CYCLE_1.toISOString(),
        }),
      ).rejects.toThrow(/ck_brain_coverage_snapshot_state_is_evidence/);
    });

    it("REFUSES `enumerated` when BOTH halves hold — the derivation is an equality", async () => {
      // The other direction. Without it the CHECK would be an implication, and a
      // writer that stamped everything `enumerated` would satisfy it — turning
      // the surveyed count to zero on a workspace that is fully surveyed.
      await expect(
        insertRow({
          state: "enumerated",
          in_perimeter: true,
          newest_evidence_at: CYCLE_1.toISOString(),
        }),
      ).rejects.toThrow(/ck_brain_coverage_snapshot_state_is_evidence/);
    });

    it("REFUSES a `human` survey unit — its units would be people", async () => {
      await expect(insertRow({ source_class: "human" })).rejects.toThrow(
        /ck_brain_coverage_snapshot_class/,
      );
    });

    it("REFUSES an activity reading with no reading time", async () => {
      await expect(
        insertRow({ vendor_activity_at: CYCLE_1.toISOString(), vendor_activity_checked_at: null }),
      ).rejects.toThrow(/ck_brain_coverage_snapshot_activity_attributed/);
    });

    it("REFUSES an empty unit id and an empty label", async () => {
      await expect(insertRow({ unit_id: "" })).rejects.toThrow(
        /ck_brain_coverage_snapshot_unit_present/,
      );
      await expect(insertRow({ unit_label: "" })).rejects.toThrow(
        /ck_brain_coverage_snapshot_label_present/,
      );
    });

    it("REFUSES an unrecognised `state` value", async () => {
      // ⚠️ Its own test, because `state = 'bogus'` with `in_perimeter = false`
      // and no evidence SATISFIES the evidence CHECK — `('bogus' = 'surveyed')`
      // is false and so is the right-hand side. Only the value CHECK refuses it,
      // so the evidence tests above cannot stand in for this one.
      await expect(insertRow({ state: "bogus" })).rejects.toThrow(
        /ck_brain_coverage_snapshot_state/,
      );
    });

    it("REFUSES a `human` CYCLE row too, not only a human unit", async () => {
      // The cycle table's own CHECK. Without it a `human` cycle record could
      // exist with no units, which the page renders as a class that FAILED to
      // enumerate rather than one that has no universe.
      await expect(
        pool.query(
          `INSERT INTO brain_coverage_cycle (workspace_id, source_class, last_attempt_at)
           VALUES ($1, 'human', now())`,
          [WORKSPACE],
        ),
      ).rejects.toThrow(/ck_brain_coverage_cycle_class/);
    });

    it("REFUSES a NULL element among the map-edge marks", async () => {
      // A NULL reads as an arm matching nothing, silently dropping one map edge
      // — the direction where the map looks MORE complete than it is.
      await expect(
        pool.query(
          `INSERT INTO brain_coverage_cycle (workspace_id, source_class, last_attempt_at, degraded_arms)
           VALUES ($1, 'chat', now(), ARRAY['chat-public-roster-truncated', NULL]::text[])`,
          [WORKSPACE],
        ),
      ).rejects.toThrow(/ck_brain_coverage_cycle_arms_no_null/);
    });

    it("REFUSES a cycle row with an empty error and an empty map-edge mark", async () => {
      await expect(
        pool.query(
          `INSERT INTO brain_coverage_cycle (workspace_id, source_class, last_attempt_at, last_error)
           VALUES ($1, 'chat', now(), '')`,
          [WORKSPACE],
        ),
      ).rejects.toThrow(/ck_brain_coverage_cycle_error_present/);
      await expect(
        pool.query(
          `INSERT INTO brain_coverage_cycle (workspace_id, source_class, last_attempt_at, degraded_arms)
           VALUES ($1, 'chat', now(), ARRAY['']::text[])`,
          [WORKSPACE],
        ),
      ).rejects.toThrow(/ck_brain_coverage_cycle_arms_present/);
    });
  });

  // -------------------------------------------------------------------------
  // (b) The write — the never-zero rule, the sweep, the label gate
  // -------------------------------------------------------------------------

  describe("persistCoverageSnapshot", () => {
    it("writes a dated roster and derives each unit's state", async () => {
      const report = await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          unit({
            unitId: "C0INSIDE",
            inPerimeter: true,
            deliberateAct: true,
            newestEvidenceAt: new Date("2026-07-31T00:00:00.000Z"),
          }),
          unit({ unitId: "C0OUTSIDE", vendorReportsPublic: true, label: "random" }),
          unit({ unitId: "C0THIRD", inPerimeter: true, deliberateAct: true, label: "incidents" }),
        ]),
      });
      // THREE DIFFERENT numbers, deliberately: `written`, `surveyed` and
      // `labelled` are 3/1/2, so an implementation returning any one of them for
      // all three cannot pass.
      expect(report).toMatchObject({ status: "success", written: 3, surveyed: 1, labelled: 2 });

      const rows = await readCoverageUnits(WORKSPACE, "chat");
      expect(rows.find((r) => r.unitId === "C0INSIDE")?.state).toBe("surveyed");
      // In the perimeter and producing nothing — the M1 state, kept distinct.
      const third = rows.find((r) => r.unitId === "C0THIRD");
      expect(third?.state).toBe("enumerated");
      expect(third?.inPerimeter).toBe(true);
    });

    it("stores a label ONLY when a clause admits it", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "email",
        cycleAt: CYCLE_1,
        outcome: success([
          // A mailbox nobody named. ADR-0041: "naming a mailbox is naming a
          // person" — counted, never named, even though the enumerator supplied
          // a label.
          unit({ unitId: "mbx-1", label: "cfo@example.com" }),
          // The same class, under the deliberate-act clause — the POSITIVE
          // CONTROL. Without it "no label was stored" is satisfied by a writer
          // that stores no labels at all.
          unit({ unitId: "mbx-2", label: "shared-inbox@example.com", deliberateAct: true }),
        ]),
      });
      const rows = await readCoverageUnits(WORKSPACE, "email");
      expect(rows.find((r) => r.unitId === "mbx-1")?.label).toBeNull();
      expect(rows.find((r) => r.unitId === "mbx-2")?.label).toBe("shared-inbox@example.com");
    });

    it("refuses the vendor-public clause for a class whose contract declares it closed", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "transcript",
        cycleAt: CYCLE_1,
        outcome: success([
          // The caller asserts the vendor calls it public; `CLASS_CONTRACTS
          // .transcript.vendorPublic` is false and the policy ANDs the two.
          unit({ unitId: "rec-1", label: "Board review", vendorReportsPublic: true }),
          unit({ unitId: "rec-2", label: "All hands", deliberateAct: true }),
        ]),
      });
      const rows = await readCoverageUnits(WORKSPACE, "transcript");
      expect(rows.find((r) => r.unitId === "rec-1")?.label).toBeNull();
      expect(rows.find((r) => r.unitId === "rec-2")?.label).toBe("All hands");
    });

    it("SWEEPS the units a later cycle did not re-observe, and only those", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0KEEP" }), unit({ unitId: "C0GONE" })]),
      });
      const second = await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: success([unit({ unitId: "C0KEEP" })]),
      });
      expect(second.status === "success" && second.retired).toBe(1);
      expect((await readCoverageUnits(WORKSPACE, "chat")).map((r) => r.unitId)).toEqual(["C0KEEP"]);
    });

    it("MUTATION — a COLLAPSE is loud, not only a total wipe", async () => {
      // The zero-only condition could not see 500 -> 1: 499 rows retired under a
      // clean success with a fresh date is the same loud-understatement failure
      // one degree short of zero. Asserted through the sweep's own count rather
      // than the log, because the count is what the ratio is computed from.
      const many = Array.from({ length: 10 }, (_v, i) => `C0M${i}`);
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success(many.map((id) => unit({ unitId: id }))),
      });
      const collapsed = await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: success([unit({ unitId: "C0M0" })]),
      });
      // ⚠️ Assert the PRODUCTION verdict, not the test's own arithmetic. An
      // earlier version recomputed `written * 4 < retired` in the assertion,
      // which is a test asserting itself: reverting the condition to
      // `written === 0` left it green. `collapsed` is the module's answer.
      expect(collapsed).toMatchObject({
        status: "success",
        written: 1,
        retired: 9,
        collapsed: true,
      });
    });

    it("an ORDINARY shrink is NOT a collapse — the ratio has a quiet side", async () => {
      // The control. Without it "the collapse condition fires" is satisfied by a
      // condition that fires on every retirement, which would make the escalation
      // noise and train a reader to ignore it.
      const many = Array.from({ length: 10 }, (_v, i) => `C0N${i}`);
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success(many.map((id) => unit({ unitId: id }))),
      });
      const shrunk = await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: success(many.slice(0, 8).map((id) => unit({ unitId: id }))),
      });
      expect(shrunk).toMatchObject({
        status: "success",
        written: 8,
        retired: 2,
        collapsed: false,
      });
    });

    it("never sweeps ANOTHER workspace's or another class's roster", async () => {
      await persistCoverageSnapshot({
        workspaceId: OTHER_WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0NEIGHBOUR" })]),
      });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "warehouse",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "5:plans:tier" })]),
      });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: success([]),
      });
      expect((await readCoverageUnits(OTHER_WORKSPACE, "chat")).length).toBe(1);
      expect((await readCoverageUnits(WORKSPACE, "warehouse")).length).toBe(1);
      expect((await readCoverageUnits(WORKSPACE, "chat")).length).toBe(0);
    });

    it("a FAILED cycle leaves the prior dated roster exactly as it was", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          unit({ unitId: "C0A", label: "general", deliberateAct: true }),
          unit({ unitId: "C0B" }),
        ]),
      });
      const report = await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: { ok: false, error: "Slack refused: token_revoked — reconnect Slack." },
      });
      // The failure arm carries NO counts at all — `{ status: "failure" }` and
      // nothing else. `toMatchObject({ written: 0 })` would have been the wrong
      // assertion anyway: it says "the write reported zero", where the claim is
      // that the write reported no number because it did not write.
      expect(report).toEqual({ status: "failure" });

      // The roster is untouched — same units, same cycle stamp.
      const rows = await readCoverageUnits(WORKSPACE, "chat");
      expect(rows.map((r) => r.unitId).toSorted()).toEqual(["C0A", "C0B"]);
      const { rows: stamps } = await pool.query<{ cycle_at: Date }>(
        `SELECT DISTINCT cycle_at FROM brain_coverage_snapshot WHERE workspace_id = $1`,
        [WORKSPACE],
      );
      expect(stamps.length).toBe(1);
      expect(stamps[0]!.cycle_at.toISOString()).toBe(CYCLE_1.toISOString());

      // …and the surface can say WHY, and SINCE WHEN.
      const [snapshot] = await readCoverageSnapshot(WORKSPACE);
      expect(snapshot).toMatchObject({
        sourceClass: "chat",
        surveyed: 0,
        enumerated: 2,
        asOf: CYCLE_1.toISOString(),
        lastAttemptAt: CYCLE_2.toISOString(),
      });
      expect(snapshot?.unavailableReason).toContain("token_revoked");
    });

    it("stores a PLACEHOLDER for an empty error rather than tripping its own CHECK", async () => {
      // ⚠️ `new Error().message` is `''`, and `ck_brain_coverage_cycle_error_present`
      // refuses it — so passing it through would make the one statement whose
      // entire job is recording a failure THROW, and a visible failure would
      // become an invisible one through the constraint written to guarantee
      // every red dot carries a message.
      const report = await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: { ok: false, error: "   " },
      });
      expect(report).toEqual({ status: "failure" });
      const [snapshot] = await readCoverageSnapshot(WORKSPACE);
      expect(snapshot?.unavailableReason).toContain("without reporting a reason");
      // The POSITIVE CONTROL on the same reader: a real message is NOT replaced.
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: { ok: false, error: "Slack refused: token_revoked." },
      });
      expect((await readCoverageSnapshot(WORKSPACE))[0]?.unavailableReason).toBe(
        "Slack refused: token_revoked.",
      );
    });

    it("strips a NUL through persistCoverageSnapshot too, not only the class-wide writer", async () => {
      // The rule is shared (`storableErrorText`), and the shared-ness is the
      // point — but only ONE writer was proven. This arm is the one that runs
      // for every tenant, and node-pg REFUSES a NUL parameter outright, so an
      // unstripped one turns a visible failure invisible.
      const report = await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: { ok: false, error: `slack token \u0000 revoked` },
      });
      expect(report).toEqual({ status: "failure" });
      const reason = (await readCoverageSnapshot(WORKSPACE))[0]?.unavailableReason;
      expect(reason).toContain("revoked");
      expect(reason).not.toContain("\u0000");
    });

    it("a later SUCCESS clears the failure and re-dates the statement", async () => {
      // The positive control for the test above: without it, "the roster
      // survived a failure" is satisfied by a write path that never writes.
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: { ok: false, error: "Slack refused: ratelimited." },
      });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: success([unit({ unitId: "C0A" })]),
      });
      const [snapshot] = await readCoverageSnapshot(WORKSPACE);
      expect(snapshot?.unavailableReason).toBeNull();
      expect(snapshot?.asOf).toBe(CYCLE_2.toISOString());
      expect(snapshot?.enumerated).toBe(1);
    });

    it("a never-succeeded class reports NO date rather than a zero roster", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: { ok: false, error: "No Slack connection for this workspace." },
      });
      const [snapshot] = await readCoverageSnapshot(WORKSPACE);
      // The class APPEARS — driven off the cycle table, not the roster — with a
      // null date. An inner join would have deleted the one row whose job is to
      // say something went wrong.
      expect(snapshot?.asOf).toBeNull();
      expect(snapshot?.unavailableReason).toContain("No Slack connection");
    });

    it("keeps an unprobed unit's previous vendor reading, and lets a probe overwrite it", async () => {
      const firstReading = new Date("2026-07-30T12:00:00.000Z");
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0A", activity: { probed: true, at: firstReading } })]),
      });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: success([unit({ unitId: "C0A", activity: { probed: false } })]),
      });
      const afterUnprobed = await readCoverageUnits(WORKSPACE, "chat");
      expect(afterUnprobed[0]?.activity).toEqual({
        probed: true,
        at: firstReading.toISOString(),
        checkedAt: CYCLE_1.toISOString(),
      });

      const secondReading = new Date("2026-08-01T08:00:00.000Z");
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: success([unit({ unitId: "C0A", activity: { probed: true, at: secondReading } })]),
      });
      const afterProbe = await readCoverageUnits(WORKSPACE, "chat");
      expect(afterProbe[0]?.activity).toEqual({
        probed: true,
        at: secondReading.toISOString(),
        checkedAt: CYCLE_2.toISOString(),
      });
    });

    it("is ATOMIC — a mid-loop refusal leaves the prior roster and its date intact", async () => {
      // The module's headline claim: "a page can never read a half-swept roster
      // stamped with a fresh success." The unit with the empty id violates
      // `ck_brain_coverage_snapshot_unit_present` partway through the loop, AFTER
      // a legal unit has already been upserted in the same transaction.
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0OLD1" }), unit({ unitId: "C0OLD2" })]),
      });
      await expect(
        persistCoverageSnapshot({
          workspaceId: WORKSPACE,
          sourceClass: "chat",
          cycleAt: CYCLE_2,
          outcome: success([unit({ unitId: "C0NEW" }), unit({ unitId: "" })]),
        }),
      ).rejects.toThrow(/ck_brain_coverage_snapshot_unit_present/);

      // Nothing from the aborted cycle survived: not the legal unit that was
      // written before the bad one, and not a re-dated stamp.
      const rows = await readCoverageUnits(WORKSPACE, "chat");
      expect(rows.map((r) => r.unitId).toSorted()).toEqual(["C0OLD1", "C0OLD2"]);
      const { rows: stamps } = await pool.query<{ cycle_at: Date }>(
        `SELECT DISTINCT cycle_at FROM brain_coverage_snapshot WHERE workspace_id = $1`,
        [WORKSPACE],
      );
      expect(stamps.length).toBe(1);
      expect(stamps[0]!.cycle_at.toISOString()).toBe(CYCLE_1.toISOString());
      // …and the cycle record still says the LAST SUCCESS, not this attempt.
      expect((await readCoverageSnapshot(WORKSPACE))[0]?.asOf).toBe(CYCLE_1.toISOString());
    });

    it("a probed-and-now-EMPTY channel OVERWRITES its old reading, it does not keep it", async () => {
      // The third case, and the one the COALESCE got wrong. An empty history
      // page is a real reading — "this channel has never had a message" — so
      // believing it whole is the point. Keeping the old `at` while advancing
      // `checked_at` asserted "asked just now, newest message is <old date>" for
      // a channel with none, and no later probe of an empty channel could ever
      // overwrite it.
      const firstReading = new Date("2026-07-30T12:00:00.000Z");
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0A", activity: { probed: true, at: firstReading } })]),
      });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: success([unit({ unitId: "C0A", activity: { probed: true, at: null } })]),
      });
      expect((await readCoverageUnits(WORKSPACE, "chat"))[0]?.activity).toEqual({
        probed: true,
        at: null,
        checkedAt: CYCLE_2.toISOString(),
      });
    });

    it("records the map edges on success and keeps them across a failure", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: { ok: true, units: [unit({ unitId: "C0A" })], degraded: ["chat-public-roster-unreadable"] },
      });
      expect((await readCoverageSnapshot(WORKSPACE))[0]?.degraded).toEqual([
        "chat-public-roster-unreadable",
      ]);
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: { ok: false, error: "Slack refused: ratelimited." },
      });
      // The marks describe the last SUCCESSFUL map. Clearing them on a failure
      // would replace "there are channels we cannot see" with a clean edge
      // nobody established.
      expect((await readCoverageSnapshot(WORKSPACE))[0]?.degraded).toEqual([
        "chat-public-roster-unreadable",
      ]);
    });

    it("the probe rotation is perimeter-only and oldest-reading-first", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          unit({ unitId: "C0OLD", inPerimeter: true, activity: { probed: true, at: null } }),
          unit({ unitId: "C0NEVER", inPerimeter: true }),
          unit({ unitId: "C0OUT" }),
        ]),
      });
      const due = await readActivityProbeRotation({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        limit: 10,
      });
      // Never-probed first, then the oldest reading. The out-of-perimeter
      // channel is absent — a history read there is refused by Slack, so it is
      // not a gap.
      expect(due).toEqual(["C0NEVER", "C0OLD"]);
    });

    it("the probe rotation is SCOPED and BOUNDED", async () => {
      // Three assertions in one, because the three mutations are one line apart:
      // dropping `workspace_id = $1`, dropping `source_class = $2`, dropping the
      // LIMIT. The last one matters most — `CHAT_ACTIVITY_PROBES_PER_CYCLE` is
      // the ONLY thing bounding Slack calls per cycle.
      // ⚠️ `C0AA` sorts BETWEEN `C0A` and `C0B`, and that ordering is the whole
      // test: with `LIMIT 2` an unscoped query returns `[C0A, C0AA]` and the
      // assertion reddens. A neighbour sorting after `C0C` would be cut by the
      // LIMIT before the workspace predicate ever mattered — which is what the
      // first version did, and it left `workspace_id = $1` deletable and green.
      // Measured against a real server, not reasoned.
      await persistCoverageSnapshot({
        workspaceId: OTHER_WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0AA", inPerimeter: true })]),
      });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "warehouse",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "5:plans:tier", inPerimeter: true })]),
      });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          unit({ unitId: "C0A", inPerimeter: true }),
          unit({ unitId: "C0B", inPerimeter: true }),
          unit({ unitId: "C0C", inPerimeter: true }),
        ]),
      });
      const due = await readActivityProbeRotation({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        limit: 2,
      });
      expect(due).toEqual(["C0A", "C0B"]);
      expect(due).not.toContain("C0AA");
      expect(due).not.toContain("5:plans:tier");
    });
  });

  describe("recordClassScanFailure — the arm persist cannot reach", () => {
    it("moves the ATTEMPT for every workspace holding the class, and only that class", async () => {
      // ⚠️ The defect this exists for: when `listWorkspaces()` throws there is no
      // workspace list, so the per-workspace write never runs and NOTHING moves.
      // The page then keeps rendering a clean, dated, CURRENT statement for as
      // long as the scan keeps failing — the same shape the write-failure arm was
      // fixed for, one arm over.
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0A" }), unit({ unitId: "C0B" })]),
      });
      await persistCoverageSnapshot({
        workspaceId: OTHER_WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0N" })]),
      });
      // A DIFFERENT class of the same workspace — the control that catches an
      // UPDATE missing its `source_class` predicate.
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "warehouse",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "5:plans:tier" })]),
      });

      const touched = await recordClassScanFailure({
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        error: "Atlas could not list the workspaces to enumerate for chat coverage (chat_cache unreadable)",
      });
      expect(touched).toBe(2);

      const mine = new Map(
        (await readCoverageSnapshot(WORKSPACE)).map((c) => [c.sourceClass, c]),
      );
      expect(mine.get("chat")).toMatchObject({
        asOf: CYCLE_1.toISOString(),
        lastAttemptAt: CYCLE_2.toISOString(),
      });
      expect(mine.get("chat")?.unavailableReason).toContain("chat_cache unreadable");
      // The warehouse row is untouched — same workspace, different class.
      expect(mine.get("warehouse")).toMatchObject({
        lastAttemptAt: CYCLE_1.toISOString(),
        unavailableReason: null,
      });
      // …and the OTHER workspace's chat row WAS told, because a class-wide scan
      // failure is class-wide.
      expect((await readCoverageSnapshot(OTHER_WORKSPACE))[0]?.lastAttemptAt).toBe(
        CYCLE_2.toISOString(),
      );

      // The ROSTER is untouched — this records an attempt, it does not zero.
      expect((await readCoverageUnits(WORKSPACE, "chat")).map((r) => r.unitId).toSorted()).toEqual([
        "C0A",
        "C0B",
      ]);
    });

    it("SKIPS a workspace that switched the cycle off, and tells the rest", async () => {
      // The settings registry promises that turning it off "freezes the coverage
      // page at its last reading". A failed attempt stamped on a frozen row
      // breaks that promise with a statement that is simply false: that tenant's
      // cycle would never have run.
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0A" })]),
      });
      await persistCoverageSnapshot({
        workspaceId: OTHER_WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0N" })]),
      });
      const touched = await recordClassScanFailure({
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        includeWorkspace: (workspaceId) => workspaceId !== OTHER_WORKSPACE,
        error: "chat_cache unreadable",
      });
      expect(touched).toBe(1);
      // The opted-OUT tenant's row is untouched — same date, no reason.
      expect((await readCoverageSnapshot(OTHER_WORKSPACE))[0]).toMatchObject({
        lastAttemptAt: CYCLE_1.toISOString(),
        unavailableReason: null,
      });
      // The POSITIVE CONTROL from the same call: the other one WAS told.
      expect((await readCoverageSnapshot(WORKSPACE))[0]?.lastAttemptAt).toBe(
        CYCLE_2.toISOString(),
      );
    });

    it("INVENTS no row for a workspace that has never been enumerated", async () => {
      // An upsert here would assert Atlas tried to enumerate a workspace it never
      // established exists — and would put a row on the page for a tenant with no
      // Slack at all.
      const touched = await recordClassScanFailure({
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        error: "chat_cache unreadable",
      });
      expect(touched).toBe(0);
      expect(await readCoverageSnapshot(WORKSPACE)).toEqual([]);
    });

    it("stores a message the CHECK accepts, even for an empty or NUL-bearing one", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0A" })]),
      });
      // Empty → the placeholder, not a CHECK violation.
      await recordClassScanFailure({ sourceClass: "chat", cycleAt: CYCLE_2, error: "" });
      expect((await readCoverageSnapshot(WORKSPACE))[0]?.unavailableReason).toContain(
        "without reporting a reason",
      );
      // A NUL byte is what node-pg REFUSES outright, so an unstripped one would
      // make the failure-recording statement throw — a visible failure turned
      // invisible by the machinery meant to record it.
      await recordClassScanFailure({
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        error: `slack token \u0000 revoked`,
      });
      const reason = (await readCoverageSnapshot(WORKSPACE))[0]?.unavailableReason;
      expect(reason).toContain("revoked");
      expect(reason).not.toContain("\u0000");
    });
  });

  // -------------------------------------------------------------------------
  // (b2) The reads the PAGE composes its numbers from
  // -------------------------------------------------------------------------

  describe("readCoverageSnapshot", () => {
    it("attributes each class's counts to THAT class, across classes and workspaces", async () => {
      // ⚠️ The gap this closes: every other test reads a workspace holding ONE
      // class, so dropping `ON s.source_class = c.source_class` — or
      // `WHERE workspace_id = $1` from the SUBQUERY, a cross-tenant count leak —
      // left them all green. The neighbour's SEVEN units are what make the leak
      // move a number rather than merely exist.
      await persistCoverageSnapshot({
        workspaceId: OTHER_WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          unit({ unitId: "C0N1" }),
          unit({ unitId: "C0N2" }),
          unit({ unitId: "C0N3" }),
          unit({ unitId: "C0N4" }),
          unit({ unitId: "C0N5" }),
          unit({ unitId: "C0N6" }),
          unit({ unitId: "C0N7" }),
        ]),
      });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          // 2 surveyed, 3 enumerated, 2 of those blind. `surveyed` and `blind`
          // are EQUAL here, so this row alone cannot tell a `blind` FILTER
          // retargeted at the surveyed predicate from a correct one — the
          // WAREHOUSE row below (0 surveyed, 1 blind) is what kills that
          // mutation, and the two rows are unequal on every field for exactly
          // that reason.
          unit({ unitId: "C0S1", inPerimeter: true, newestEvidenceAt: CYCLE_1 }),
          unit({ unitId: "C0S2", inPerimeter: true, newestEvidenceAt: CYCLE_1 }),
          unit({ unitId: "C0BLIND1", inPerimeter: true }),
          unit({ unitId: "C0BLIND2", inPerimeter: true }),
          unit({ unitId: "C0OUT1" }),
        ]),
      });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "warehouse",
        cycleAt: CYCLE_2,
        outcome: success([unit({ unitId: "5:plans:tier", inPerimeter: true })]),
      });

      const snapshot = await readCoverageSnapshot(WORKSPACE);
      const byClass = new Map(snapshot.map((c) => [c.sourceClass, c]));
      expect(snapshot.length).toBe(2);
      expect(byClass.get("chat")).toMatchObject({
        surveyed: 2,
        enumerated: 3,
        inPerimeterWithoutEvidence: 2,
        asOf: CYCLE_1.toISOString(),
      });
      // The warehouse row: DIFFERENT numbers and a DIFFERENT date, so a join
      // that mixed the classes changes every field rather than none.
      expect(byClass.get("warehouse")).toMatchObject({
        surveyed: 0,
        enumerated: 1,
        inPerimeterWithoutEvidence: 1,
        asOf: CYCLE_2.toISOString(),
      });
      // The neighbour's 7 units reach neither row.
      expect(byClass.get("chat")?.surveyed).not.toBe(7);
      expect(byClass.get("chat")?.enumerated).not.toBe(7);
    });

    it("counts `inPerimeterWithoutEvidence` as a SUBSET of enumerated, never beside it", async () => {
      // The M1 sentence — invited, configured, reading nothing — and the field
      // that had no assertion anywhere. `enumerated` (3) and `blind` (1) are
      // unequal, so dropping `in_perimeter` from the blind FILTER moves it;
      // `surveyed` and `blind` are both 1, so this row does not discriminate
      // those two and does not claim to.
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          unit({ unitId: "C0BLIND", inPerimeter: true }),
          unit({ unitId: "C0OUT1" }),
          unit({ unitId: "C0OUT2" }),
          unit({ unitId: "C0SURVEYED", inPerimeter: true, newestEvidenceAt: CYCLE_1 }),
        ]),
      });
      const [snapshot] = await readCoverageSnapshot(WORKSPACE);
      expect(snapshot).toMatchObject({
        surveyed: 1,
        enumerated: 3,
        inPerimeterWithoutEvidence: 1,
      });
      // `surveyed + enumerated` IS the universe (4 units seeded). Adding
      // `inPerimeterWithoutEvidence` on top would make it 5 — counting the blind
      // unit twice, which is the mistake the subset relation exists to prevent.
      expect(snapshot!.surveyed + snapshot!.enumerated).toBe(4);
    });
  });

  describe("readCoverageUnits", () => {
    it("orders surveyed first, then by label, with the unnamed rows last", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          unit({ unitId: "C0ZULU", label: "zulu", deliberateAct: true }),
          unit({ unitId: "C0UNNAMED" }),
          unit({ unitId: "C0ALPHA", label: "alpha", deliberateAct: true }),
          unit({
            unitId: "C0SURVEYED",
            label: "surveyed",
            deliberateAct: true,
            inPerimeter: true,
            newestEvidenceAt: CYCLE_1,
          }),
        ]),
      });
      // A page-facing decision, so it is asserted rather than sorted away:
      // surveyed first (what Atlas actually reads), then alphabetical, then the
      // rows a reader can do nothing with individually.
      expect((await readCoverageUnits(WORKSPACE, "chat")).map((r) => r.unitId)).toEqual([
        "C0SURVEYED",
        "C0ALPHA",
        "C0ZULU",
        "C0UNNAMED",
      ]);
    });

    it("reports the vendor reading as the SAME tri-state the writer used", async () => {
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          unit({ unitId: "C0UNPROBED", inPerimeter: true }),
          unit({ unitId: "C0EMPTY", inPerimeter: true, activity: { probed: true, at: null } }),
          unit({
            unitId: "C0ACTIVE",
            inPerimeter: true,
            activity: { probed: true, at: new Date("2026-07-30T12:00:00.000Z") },
          }),
        ]),
      });
      const byId = new Map((await readCoverageUnits(WORKSPACE, "chat")).map((r) => [r.unitId, r]));
      // THREE distinct shapes. Collapsing to `(at, checkedAt)` made the middle
      // one — "we asked, the channel is empty", which is QUIET rather than
      // stale — indistinguishable from the first by anything but a null check
      // the page had to re-derive.
      expect(byId.get("C0UNPROBED")?.activity).toEqual({ probed: false });
      expect(byId.get("C0EMPTY")?.activity).toEqual({
        probed: true,
        at: null,
        checkedAt: CYCLE_1.toISOString(),
      });
      expect(byId.get("C0ACTIVE")?.activity).toEqual({
        probed: true,
        at: "2026-07-30T12:00:00.000Z",
        checkedAt: CYCLE_1.toISOString(),
      });
    });
  });

  // -------------------------------------------------------------------------
  // (c) The chat enumerator — adversarial roster vs. seeded perimeter
  // -------------------------------------------------------------------------

  describe("enumerateSlackCoverage", () => {
    async function seedChannel(over: {
      channelId: string;
      name?: string | null;
      isMember?: boolean;
      excluded?: boolean;
    }) {
      await pool.query(
        `INSERT INTO brain_slack_channel
           (workspace_id, channel_id, name, is_member, excluded_at, excluded_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          WORKSPACE,
          over.channelId,
          over.name ?? null,
          over.isMember ?? true,
          over.excluded === true ? CYCLE_1.toISOString() : null,
          over.excluded === true ? "admin-1" : null,
        ],
      );
    }

    async function seedEpisode(channelId: string, ts: string, occurredAt: Date) {
      await pool.query(
        `INSERT INTO brain_episodes
           (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
         VALUES ($1, 'slack', $2, 'U1', 'hello', $3::timestamptz, ARRAY['org'])`,
        [WORKSPACE, slackEpisodeSourceId(channelId, ts), occurredAt.toISOString()],
      );
    }

    const rosterPage = (
      channels: readonly SlackConversationInfo[],
    ): SlackConversationsListPage => ({ ok: true, channels, nextCursor: null });

    const historyPage = (ts: string | null): SlackHistoryPage => ({
      ok: true,
      messages: ts === null ? [] : [{ ts, text: "hi", user: "U1", subtype: null, botId: null }],
      nextCursor: null,
      dropped: 0,
    });

    it("unions the perimeter with the vendor roster, and states each unit's side", async () => {
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      // A PRIVATE perimeter channel, absent from the public roster by
      // construction — `types=public_channel` cannot return it. In production
      // this is the common case for an invited bot, and it is the sharpest
      // disclosure this enumerator performs: it is nameable, under the
      // DELIBERATE-ACT clause (someone invited the bot), while `vendorReportsPublic`
      // stays false.
      await seedChannel({ channelId: "G0PRIVATE", name: "leadership" });
      await seedEpisode("C0INSIDE", "1754000000.000100", new Date("2026-07-31T10:00:00.000Z"));

      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "xoxb-test",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const byId = new Map(outcome.units.map((u) => [u.unitId, u]));
      // 2 perimeter rows (one of them PRIVATE and absent from the roster) + 2
      // roster-only channels = 4. Roster alone is 3, perimeter alone is 2, so
      // returning either one changes this number — which the old fixture, whose
      // perimeter was a subset of the roster, could not detect.
      expect(outcome.units.length).toBe(4);
      expect(byId.get("C0INSIDE")).toMatchObject({ inPerimeter: true, deliberateAct: true });
      expect(byId.get("C0INSIDE")?.newestEvidenceAt?.toISOString()).toBe(
        "2026-07-31T10:00:00.000Z",
      );
      expect(byId.get("C0OUTSIDE")).toMatchObject({
        inPerimeter: false,
        deliberateAct: false,
        vendorReportsPublic: true,
        label: "random",
        newestEvidenceAt: null,
      });
      // The private one: in the perimeter, NOT vendor-public, and still carrying
      // a label — the deliberate-act clause doing the work, which is exactly the
      // split `CoverageLabelDecision` carries a clause for.
      expect(byId.get("G0PRIVATE")).toMatchObject({
        inPerimeter: true,
        deliberateAct: true,
        vendorReportsPublic: false,
        label: "leadership",
      });
    });

    it("MUTATION — removing a channel from the vendor roster shrinks the denominator", async () => {
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      await seedChannel({ channelId: "G0PRIVATE", name: "leadership" });
      const full = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      const short = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER.slice(0, 2)),
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      expect(full.ok && full.units.length).toBe(4);
      expect(short.ok && short.units.length).toBe(3);
    });

    it("MUTATION — vendor activity newer than our newest episode travels as a LAG", async () => {
      // The measurement ADR-0041 asks for: `vendor_activity_at` is read from
      // Slack, not from our own episodes, so a stalled ingest shows a gap. A
      // reading derived from `brain_episodes` would make these two equal, and
      // this assertion is what catches that.
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      await seedEpisode("C0INSIDE", "1753900000.000100", new Date("2026-07-30T00:00:00.000Z"));
      // Slack's newest message is a DAY later than our newest episode.
      const vendorTs = `${new Date("2026-07-31T00:00:00.000Z").getTime() / 1000}.000100`;

      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => historyPage(vendorTs),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // Nothing to probe yet — the rotation reads the PREVIOUS cycle's rows —
      // so land one cycle first, then enumerate again.
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome,
      });
      const second = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => historyPage(vendorTs),
        },
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const probed = second.units.find((u) => u.unitId === "C0INSIDE");
      expect(probed?.activity).toEqual({ probed: true, at: new Date("2026-07-31T00:00:00.000Z") });
      expect(probed?.newestEvidenceAt?.toISOString()).toBe("2026-07-30T00:00:00.000Z");
      // The lag is real and positive — the whole claim.
      expect(probed!.activity.probed && probed!.activity.at!.getTime()).toBeGreaterThan(
        probed!.newestEvidenceAt!.getTime(),
      );
    });

    it("MUTATION — a sick activity probe leaves NO reading and raises a map edge", async () => {
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: { ok: true, units: [unit({ unitId: "C0INSIDE", inPerimeter: true })], degraded: [] },
      });
      const sick: SlackReadError = { ok: false, error: "ratelimited", retryAfterSeconds: 5 };
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => sick,
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.degraded).toContain("chat-activity-unreadable");
      expect(outcome.units.find((u) => u.unitId === "C0INSIDE")?.activity).toEqual({
        probed: false,
      });
    });

    it("STOPS the rotation on a 429, and does NOT stop it on `not_in_channel`", async () => {
      // Both arms need MORE THAN ONE unit in the rotation, which is why neither
      // was falsifiable before: with one unit, `break` and `continue` are the
      // same program. The 429 stop is a real cost decision — up to 19 further
      // calls against a token the ingest pipeline shares — and its sibling must
      // NOT inherit it, or one departed channel silently drops every probe
      // behind it.
      for (const id of ["C0A", "C0B", "C0C"]) await seedChannel({ channelId: id, name: id });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([
          unit({ unitId: "C0A", inPerimeter: true }),
          unit({ unitId: "C0B", inPerimeter: true }),
          unit({ unitId: "C0C", inPerimeter: true }),
        ]),
      });

      let rateLimited = 0;
      await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => {
            rateLimited++;
            return { ok: false, error: "ratelimited", retryAfterSeconds: 30 };
          },
        },
      });
      expect(rateLimited).toBe(1);

      let departed = 0;
      await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => {
            departed++;
            return { ok: false, error: "not_in_channel", retryAfterSeconds: null };
          },
        },
      });
      // Three, not one — the two numbers differ, so `break`/`continue` swapped
      // either way moves one of them.
      expect(departed).toBe(3);
    });

    it("MUTATION — a message timestamp we cannot parse is NOT recorded as quiet", async () => {
      // The false all-clear: `slackTsToDate` returns null for an unparseable
      // `ts`, and folding that onto the empty page stored `{ at: NULL, checked:
      // now }` — which reads as "asked just now, never had a message", i.e.
      // never stale, on the one axis this probe exists to measure.
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success([unit({ unitId: "C0INSIDE", inPerimeter: true })]),
      });
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => ({
            ok: true,
            messages: [{ ts: "not-a-timestamp", text: "hi", user: "U1", subtype: null, botId: null }],
            nextCursor: null,
            dropped: 0,
          }),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // UNPROBED plus a map edge — not `{ probed: true, at: null }`, which is
      // what "quiet" looks like and is what this used to store.
      expect(outcome.units.find((u) => u.unitId === "C0INSIDE")?.activity).toEqual({
        probed: false,
      });
      expect(outcome.degraded).toContain("chat-activity-unreadable");
    });

    it("bounds the probe rotation at CHAT_ACTIVITY_PROBES_PER_CYCLE", async () => {
      // The constant is the ONLY thing bounding Slack calls per cycle, and
      // nothing pinned the value the enumerator passes — only the SQL LIMIT via
      // a test-supplied argument.
      const ids = Array.from(
        { length: CHAT_ACTIVITY_PROBES_PER_CYCLE + 5 },
        (_v, i) => `C0P${String(i).padStart(3, "0")}`,
      );
      for (const id of ids) await seedChannel({ channelId: id, name: id });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: success(ids.map((id) => unit({ unitId: id, inPerimeter: true }))),
      });
      let probes = 0;
      await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => {
            probes++;
            return historyPage(null);
          },
        },
      });
      expect(probes).toBe(CHAT_ACTIVITY_PROBES_PER_CYCLE);
    });

    it("`not_in_channel` is NOT a map edge — it resolves itself next scope refresh", async () => {
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: { ok: true, units: [unit({ unitId: "C0INSIDE", inPerimeter: true })], degraded: [] },
      });
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => ({
            ok: false,
            error: "not_in_channel",
            retryAfterSeconds: null,
          }),
        },
      });
      expect(outcome.ok && outcome.degraded).toEqual([]);
    });

    it("an EMPTY channel is a real reading, not an unprobed one — quiet is not stale", async () => {
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_1,
        outcome: { ok: true, units: [unit({ unitId: "C0INSIDE", inPerimeter: true })], degraded: [] },
      });
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      expect(outcome.ok && outcome.units.find((u) => u.unitId === "C0INSIDE")?.activity).toEqual({
        probed: true,
        at: null,
      });
    });

    it("MUTATION — a missing roster scope degrades to a MARK, and the perimeter still enumerates", async () => {
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => ({
            ok: false,
            error: "missing_scope",
            retryAfterSeconds: null,
          }),
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.degraded).toEqual(["chat-public-roster-unreadable"]);
      // The perimeter half is still a true statement — AC-2's "visibly, never
      // silently". And the channel is NOT vendor-public: the live roster is the
      // only source for that clause, so an unread roster fails closed.
      expect(outcome.units.map((u) => u.unitId)).toEqual(["C0INSIDE"]);
      expect(outcome.units[0]?.vendorReportsPublic).toBe(false);
    });

    it("a TRANSIENT roster failure refuses the whole cycle rather than retiring state-2 rows", async () => {
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => ({
            ok: false,
            error: "ratelimited",
            retryAfterSeconds: 30,
          }),
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain("ratelimited");
    });

    it("MUTATION — an id this deploy cannot recognise is DROPPED WITH A MARK, never silently", async () => {
      // The whole-roster version of this is the dangerous one: if Slack mints a
      // public-conversation id prefix the pattern does not admit, every row
      // fails, the roster empties, and the write sweeps the lot under a green
      // success. The mark is what stops a short count reading as a complete map.
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () =>
            rosterPage([
              ...VENDOR_ROSTER,
              // A shape this deploy's `SLACK_CHANNEL_ID_PATTERN` refuses.
              { id: "X9NEWKIND", name: "future", isPrivate: false, isMember: false, isArchived: false },
            ]),
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.degraded).toEqual(["chat-unit-ids-unrecognised"]);
      // The POSITIVE CONTROL: the recognisable channels are still enumerated, so
      // "the mark appears" is not satisfied by an enumeration that returned
      // nothing.
      expect(outcome.units.map((u) => u.unitId).toSorted()).toEqual([
        "C0INSIDE",
        "C0OUTSIDE",
        "C0THIRD",
      ]);
    });

    it("an EXCLUDED channel stays in the denominator, out of the perimeter, and nameable", async () => {
      await seedChannel({ channelId: "C0INSIDE", name: "general", excluded: true });
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => rosterPage(VENDOR_ROSTER),
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.units.find((u) => u.unitId === "C0INSIDE")).toMatchObject({
        inPerimeter: false,
        deliberateAct: true,
        label: "general",
      });
    });

    it("walks the CURSOR and stops at the page bound, keeping the prefix and a MARK", async () => {
      // ⚠️ The fake keys its output off the CURSOR IT RECEIVED, not off a call
      // counter. With a counter, deleting `cursor = result.nextCursor` in
      // production still produced fresh ids per call and the test stayed green —
      // while the real walk re-requested page 1 forever, saw 200 channels, and
      // understated the denominator by everything past it.
      const cursorsSeen: (string | undefined)[] = [];
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async (_token, params) => {
            cursorsSeen.push(params.cursor);
            const n = params.cursor === undefined ? 0 : Number(params.cursor);
            return {
              ok: true,
              channels: [
                {
                  id: `C0PAGE${n}`,
                  name: `c${n}`,
                  isPrivate: false,
                  isMember: false,
                  isArchived: false,
                },
              ],
              nextCursor: String(n + 1),
            };
          },
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.degraded).toEqual(["chat-public-roster-truncated"]);
      // Exactly the bound, and each page reached under the cursor the previous
      // one returned — an off-by-one or a dropped cursor moves BOTH numbers.
      expect(cursorsSeen).toEqual([
        undefined,
        ...Array.from({ length: PUBLIC_ROSTER_MAX_PAGES - 1 }, (_v, i) => String(i + 1)),
      ]);
      expect(outcome.units.length).toBe(PUBLIC_ROSTER_MAX_PAGES);
    });
  });

  // -------------------------------------------------------------------------
  // (d) The warehouse enumerator — enrolled is the perimeter, evidence is green
  // -------------------------------------------------------------------------

  describe("enumerateWarehouseCoverage", () => {
    /**
     * The SEMANTIC LAYER, authored by hand and independent of the enrollments
     * seeded through SQL — the same charter as the Slack roster above.
     */
    const SEMANTIC_LAYER: Record<string, readonly string[]> = {
      plans: ["status", "tier", "price"],
      accounts: ["arr_band"],
    };
    const deps = {
      loadEnrollableEntities: async () =>
        Object.keys(SEMANTIC_LAYER).map((name) => ({
          name,
          // The flat scope. This suite's subject is the DENOMINATOR, not group
          // routing — the group-scoped cases live in `coverage-enumeration`'s
          // own suite beside the unit-id argument they exercise.
          group: null,
          table: name,
          description: null,
        })),
      loadEnrollableDimensions: async (_ws: string, entity: string) =>
        (SEMANTIC_LAYER[entity] ?? null)?.map((name) => ({
          name,
          kind: "dimension" as const,
          type: null,
          description: null,
        })) ?? null,
    };

    async function seedEnrollment(entity: string, dimension: string, group = "") {
      await pool.query(
        `INSERT INTO brain_enrollment (workspace_id, entity, connection_group_id, dimension, enrolled_by)
         VALUES ($1, $2, $3, $4, 'user-1')`,
        [WORKSPACE, entity, group, dimension],
      );
    }

    async function seedWarehouseFact(entity: string, dimension: string, at: Date) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO brain_episodes
           (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
         VALUES ($1, 'warehouse', $2, 'system:warehouse-producer', 'snapshot', $3::timestamptz, ARRAY['org'])
         RETURNING id`,
        [WORKSPACE, warehouseEpisodeSourceId(entity, at), at.toISOString()],
      );
      await pool.query(
        `INSERT INTO brain_facts
           (workspace_id, subject, predicate, object, source_episode_id, provenance,
            visible_to, status, subject_key, predicate_key, object_key)
         VALUES ($1, 'Acme', $2, 'active', $3, '{"source":"warehouse","actor":"p"}'::jsonb,
                 ARRAY['org'], 'draft', $4, $5, $6)`,
        [
          WORKSPACE,
          dimension,
          rows[0]!.id,
          slotKey("Acme", identityAlias),
          slotKey(dimension, identityAlias),
          slotKey("active", identityAlias),
        ],
      );
    }

    it("counts EVERY (entity, dimension) pair, with enrollment as the perimeter", async () => {
      await seedEnrollment("plans", "status");
      const outcome = await enumerateWarehouseCoverage({ workspaceId: WORKSPACE, deps });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // 3 + 1 = 4 pairs, of which exactly 1 is enrolled. Three different numbers
      // again — 4 units, 1 in perimeter, 0 surveyed.
      expect(outcome.units.length).toBe(4);
      expect(outcome.units.filter((u) => u.inPerimeter).length).toBe(1);
      expect(outcome.units.filter((u) => u.newestEvidenceAt !== null).length).toBe(0);
    });

    it("one name in two connection groups is ONE survey unit per dimension (#5286)", async () => {
      // ⚠️ The roster is NAME-keyed while the entity list is now `(name, group)`,
      // and the asymmetry is deliberate: the evidence join recovers its entity
      // from a snapshot episode's `source_id` (`warehouse:<entity>@<instant>`),
      // which carries no group — as does every other key the producer writes. A
      // group-scoped unit id would key a roster nothing could ever join evidence
      // to, so every enrolled pair would read as producing nothing on the page
      // whose whole job is telling those two states apart.
      //
      // What that costs is this: two groups' same-named entities share their
      // units. Pushing both would write two rows for one `(workspace, class,
      // unit)` — a primary-key conflict that fails the cycle, or a denominator
      // that double-counts.
      const twoGroups = {
        ...deps,
        loadEnrollableEntities: async () => [
          { name: "plans", group: "g-eu", table: "plans", description: null },
          { name: "plans", group: "g-us", table: "plans", description: null },
        ],
        loadEnrollableDimensions: async (_ws: string, _entity: string, group?: string | null) =>
          // The two groups' copies declare DIFFERENT columns, which is the whole
          // reason each is read from its own group's YAML. The union is what the
          // producer could write about that name, and the union is the honest
          // denominator.
          (group === "g-eu"
            ? ["status", "tier"]
            : ["status", "region"]
          ).map((name) => ({ name, kind: "dimension" as const, type: null, description: null })),
      };

      // Enrolled in ONE of the two groups. `inPerimeter` is "enrolled in at
      // least one", because that is what makes the producer able to write about
      // the name at all.
      await seedEnrollment("plans", "status", "g-us");

      const outcome = await enumerateWarehouseCoverage({ workspaceId: WORKSPACE, deps: twoGroups });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // THREE units, not four: `status` appears in both groups and contributes
      // once, while `tier` and `region` each contribute their own.
      expect(outcome.units.map((u) => u.unitId).toSorted()).toEqual(
        [
          warehouseSurveyUnitId("plans", "region"),
          warehouseSurveyUnitId("plans", "status"),
          warehouseSurveyUnitId("plans", "tier"),
        ].toSorted(),
      );
      // No duplicate ids at all — the assertion that would fail on a cycle that
      // pushed one unit per (group, dimension).
      expect(new Set(outcome.units.map((u) => u.unitId)).size).toBe(outcome.units.length);
      expect(outcome.units.filter((u) => u.inPerimeter).map((u) => u.label)).toEqual([
        "plans.status",
      ]);
    });

    it("an ENROLLED pair with no fact yet is NOT surveyed — green is evidence", async () => {
      await seedEnrollment("plans", "status");
      await seedEnrollment("plans", "tier");
      await seedWarehouseFact("plans", "tier", new Date("2026-07-29T00:00:00.000Z"));

      const outcome = await enumerateWarehouseCoverage({ workspaceId: WORKSPACE, deps });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const byId = new Map(outcome.units.map((u) => [u.unitId, u]));
      const enrolledEmpty = byId.get(warehouseSurveyUnitId("plans", "status"));
      const enrolledFed = byId.get(warehouseSurveyUnitId("plans", "tier"));
      // NEGATIVE beside its POSITIVE CONTROL from the same call: without the
      // second, "no evidence found" is satisfied by a join that matches nothing.
      expect(enrolledEmpty?.newestEvidenceAt).toBeNull();
      expect(enrolledFed?.newestEvidenceAt?.toISOString()).toBe("2026-07-29T00:00:00.000Z");
      expect(enrolledEmpty?.inPerimeter).toBe(true);
    });

    it("attributes evidence to the right ENTITY, not just the right predicate", async () => {
      // `status` exists on `plans` only in this layer, so use the shared shape:
      // a fact emitted for `accounts` must not light up `plans`'s pair of the
      // same name. The producer's source-id prefix is what separates them.
      await seedWarehouseFact("accounts", "status", new Date("2026-07-29T00:00:00.000Z"));
      // The POSITIVE CONTROL, in the SAME call: an evidence join that matched
      // nothing at all would satisfy the negative below on its own, which is
      // exactly what this file's header preaches against.
      await seedWarehouseFact("plans", "tier", new Date("2026-07-28T00:00:00.000Z"));
      const outcome = await enumerateWarehouseCoverage({ workspaceId: WORKSPACE, deps });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const byId = new Map(outcome.units.map((u) => [u.unitId, u]));
      expect(byId.get(warehouseSurveyUnitId("plans", "tier"))?.newestEvidenceAt?.toISOString()).toBe(
        "2026-07-28T00:00:00.000Z",
      );
      expect(byId.get(warehouseSurveyUnitId("plans", "status"))?.newestEvidenceAt).toBeNull();
      // `accounts / status` is not in the semantic layer fixture, so it is not a
      // survey unit at all — the fact is orphaned, which is the honest result.
      expect(byId.has(warehouseSurveyUnitId("accounts", "status"))).toBe(false);
    });

    it("every warehouse unit is NAMEABLE — the admin authored the semantic layer", async () => {
      const outcome = await enumerateWarehouseCoverage({ workspaceId: WORKSPACE, deps });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // Under the DELIBERATE-ACT clause, with `vendorReportsPublic` false — the
      // contract declares this class closed on the vendor-public clause, and
      // pinning both is what catches a swap of which clause does the work.
      // The CARDINALITY control, in the same call: every one of these `every`/
      // `some` assertions is vacuously satisfied by an enumerator that returned
      // nothing at all.
      expect(outcome.units.length).toBe(4);
      expect(outcome.units.every((u) => u.deliberateAct)).toBe(true);
      expect(outcome.units.some((u) => u.vendorReportsPublic)).toBe(false);
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "warehouse",
        cycleAt: CYCLE_1,
        outcome,
      });
      const rows = await readCoverageUnits(WORKSPACE, "warehouse");
      expect(rows.length).toBe(4);
      expect(rows.every((r) => r.label !== null)).toBe(true);
    });

    it("declares NO vendor activity — the contract says `absent`", async () => {
      const outcome = await enumerateWarehouseCoverage({ workspaceId: WORKSPACE, deps });
      expect(outcome.ok && outcome.units.length).toBe(4);
      expect(outcome.ok && outcome.units.every((u) => u.activity.probed === false)).toBe(true);
    });

    it("MUTATION — one unreadable entity raises a MAP EDGE rather than shrinking silently", async () => {
      // The flattering direction, and the one the bound mark does NOT cover: a
      // broken entity removes its UNSURVEYED pairs from the denominator, so the
      // ratio rises while the page shows a fresher date.
      const outcome = await enumerateWarehouseCoverage({
        workspaceId: WORKSPACE,
        deps: {
          ...deps,
          loadEnrollableDimensions: async (ws: string, entity: string) => {
            if (entity === "plans") throw new Error("entity YAML is unparseable");
            return deps.loadEnrollableDimensions(ws, entity);
          },
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.degraded).toEqual(["warehouse-entity-unreadable"]);
      // The POSITIVE CONTROL: the OTHER entity's pair is still there, so
      // "no units" cannot satisfy this.
      expect(outcome.units.map((u) => u.unitId)).toEqual([
        warehouseSurveyUnitId("accounts", "arr_band"),
      ]);
    });

    it("MUTATION — an entity list past the bound is TRUNCATED with a mark, not silently", async () => {
      const wide = Array.from({ length: WAREHOUSE_COVERAGE_MAX_ENTITIES + 3 }, (_v, i) => ({
        name: `entity_${String(i).padStart(4, "0")}`,
        group: null,
        table: "t",
        description: null,
      }));
      const outcome = await enumerateWarehouseCoverage({
        workspaceId: WORKSPACE,
        deps: {
          ...deps,
          loadEnrollableEntities: async () => wide,
          loadEnrollableDimensions: async () => [
            { name: "dim", kind: "dimension" as const, type: null, description: null },
          ],
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.degraded).toEqual(["warehouse-entity-bound-reached"]);
      // The prefix, exactly — a bound that walked everything, or nothing, moves
      // this number in opposite directions.
      expect(outcome.units.length).toBe(WAREHOUSE_COVERAGE_MAX_ENTITIES);
    });

    it("an entity that vanished mid-cycle contributes nothing and raises NO edge", async () => {
      // `null` from `loadEnrollableDimensions` means "not in the published
      // layer" — a publish landing between the entity list and this read. Not an
      // error and not zero dimensions: the entity is gone, which is what the next
      // cycle will also say. Distinct from the THROW above, and the two must not
      // collapse.
      const outcome = await enumerateWarehouseCoverage({
        workspaceId: WORKSPACE,
        deps: {
          ...deps,
          loadEnrollableDimensions: async (ws: string, entity: string) =>
            entity === "plans" ? null : deps.loadEnrollableDimensions(ws, entity),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.degraded).toEqual([]);
      expect(outcome.units.map((u) => u.unitId)).toEqual([
        warehouseSurveyUnitId("accounts", "arr_band"),
      ]);
    });

    it("names the READ that failed, not just 'the semantic layer'", async () => {
      // Three inputs, three subjects. One catch around all three sent an admin
      // whose ENROLLMENT read failed to go and check their entity YAML — advice
      // they can follow forever without anything changing.
      const outcome = await enumerateWarehouseCoverage({
        workspaceId: WORKSPACE,
        deps: {
          ...deps,
          listEnrollments: async () => {
            throw new Error("brain_enrollment unreadable");
          },
        },
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain("warehouse enrollments");
      expect(outcome.error).toContain("brain_enrollment unreadable");
      // …and NOT the wrong subject, which is the half that makes this a real
      // assertion rather than a substring check that any message would pass.
      expect(outcome.error).not.toContain("published semantic layer");
    });

    it("a semantic-layer read failure REFUSES rather than reporting an empty universe", async () => {
      const outcome = await enumerateWarehouseCoverage({
        workspaceId: WORKSPACE,
        deps: {
          ...deps,
          loadEnrollableEntities: async () => {
            throw new Error("connection_group unreachable");
          },
        },
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain("connection_group unreachable");
    });
  });
});
