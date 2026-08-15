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
  type CoverageEnumeration,
  type EnumeratedSurveyUnit,
} from "@atlas/api/lib/brain/coverage-enumeration";
import { enumerateSlackCoverage } from "@atlas/api/lib/brain/ingest/slack/coverage";
import {
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
 * rows the tests seed. Three public channels; the perimeter fixture puts the bot
 * in only some of them, and the two sets are deliberately different sizes so a
 * union that dropped one side still changes a count.
 */
const VENDOR_ROSTER: readonly SlackConversationInfo[] = [
  { id: "C0INSIDE", name: "general", isPrivate: false, isMember: true, isArchived: false },
  { id: "C0OUTSIDE", name: "random", isPrivate: false, isMember: false, isArchived: false },
  { id: "C0THIRD", name: "incidents", isPrivate: false, isMember: false, isArchived: false },
];

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
    const success = (units: readonly EnumeratedSurveyUnit[]): CoverageEnumeration => ({
      ok: true,
      units,
      degraded: [],
    });

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
      expect(second.retired).toBe(1);
      expect((await readCoverageUnits(WORKSPACE, "chat")).map((r) => r.unitId)).toEqual(["C0KEEP"]);
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
      expect(report).toMatchObject({ status: "failure", written: 0, retired: 0 });

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
      expect(afterUnprobed[0]?.vendorActivityAt).toBe(firstReading.toISOString());
      expect(afterUnprobed[0]?.vendorActivityCheckedAt).toBe(CYCLE_1.toISOString());

      const secondReading = new Date("2026-08-01T08:00:00.000Z");
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "chat",
        cycleAt: CYCLE_2,
        outcome: success([unit({ unitId: "C0A", activity: { probed: true, at: secondReading } })]),
      });
      const afterProbe = await readCoverageUnits(WORKSPACE, "chat");
      expect(afterProbe[0]?.vendorActivityAt).toBe(secondReading.toISOString());
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
      // 1 perimeter row + 2 roster-only channels = 3. The two sets are different
      // sizes, so an implementation returning either alone changes this number.
      expect(outcome.units.length).toBe(3);
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
    });

    it("MUTATION — removing a channel from the vendor roster shrinks the denominator", async () => {
      await seedChannel({ channelId: "C0INSIDE", name: "general" });
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
      expect(full.ok && full.units.length).toBe(3);
      expect(short.ok && short.units.length).toBe(2);
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

    it("reports a truncated roster as a MARK and keeps the prefix", async () => {
      let page = 0;
      const outcome = await enumerateSlackCoverage({
        workspaceId: WORKSPACE,
        token: "t",
        deps: {
          fetchConversationsListPage: async () => {
            page++;
            return {
              ok: true,
              channels: [
                {
                  id: `C0PAGE${page}`,
                  name: `c${page}`,
                  isPrivate: false,
                  isMember: false,
                  isArchived: false,
                },
              ],
              nextCursor: "more",
            };
          },
          fetchConversationHistoryPage: async () => historyPage(null),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.degraded).toEqual(["chat-public-roster-truncated"]);
      expect(outcome.units.length).toBeGreaterThan(0);
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
        Object.keys(SEMANTIC_LAYER).map((name) => ({ name, table: name, description: null })),
      loadEnrollableDimensions: async (_ws: string, entity: string) =>
        (SEMANTIC_LAYER[entity] ?? null)?.map((name) => ({
          name,
          kind: "dimension" as const,
          type: null,
          description: null,
        })) ?? null,
    };

    async function seedEnrollment(entity: string, dimension: string) {
      await pool.query(
        `INSERT INTO brain_enrollment (workspace_id, entity, dimension, enrolled_by)
         VALUES ($1, $2, $3, 'user-1')`,
        [WORKSPACE, entity, dimension],
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
      const outcome = await enumerateWarehouseCoverage({ workspaceId: WORKSPACE, deps });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const byId = new Map(outcome.units.map((u) => [u.unitId, u]));
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
      expect(outcome.units.every((u) => u.deliberateAct)).toBe(true);
      expect(outcome.units.some((u) => u.vendorReportsPublic)).toBe(false);
      await persistCoverageSnapshot({
        workspaceId: WORKSPACE,
        sourceClass: "warehouse",
        cycleAt: CYCLE_1,
        outcome,
      });
      const rows = await readCoverageUnits(WORKSPACE, "warehouse");
      expect(rows.every((r) => r.label !== null)).toBe(true);
    });

    it("declares NO vendor activity — the contract says `absent`", async () => {
      const outcome = await enumerateWarehouseCoverage({ workspaceId: WORKSPACE, deps });
      expect(outcome.ok && outcome.units.every((u) => u.activity.probed === false)).toBe(true);
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
