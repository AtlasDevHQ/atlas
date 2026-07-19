/**
 * Backup cadence resolver tests (#4457) — the schedule→window interpretation
 * shared by the scheduled-backup fiber (ee) and the /health tripwire (core).
 */

import { describe, it, expect } from "bun:test";
import {
  backupWindowKey,
  resolveBackupCadence,
  DEFAULT_BACKUP_SCHEDULE,
  SCHEDULED_BACKUP_CHECK_INTERVAL_MS,
} from "@atlas/api/lib/backups/cadence";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * HOUR;

describe("resolveBackupCadence", () => {
  it("daily 'M H * * *' → 24h cadence anchored at H:M", () => {
    expect(resolveBackupCadence("0 3 * * *")).toEqual({
      cadenceMs: DAY,
      anchorMs: 3 * HOUR,
      recognized: true,
    });
    expect(resolveBackupCadence("30 14 * * *")).toEqual({
      cadenceMs: DAY,
      anchorMs: 14 * HOUR + 30 * MINUTE,
      recognized: true,
    });
  });

  it("'M */N * * *' → N-hour cadence anchored at :M (the docs' every-6-hours example)", () => {
    expect(resolveBackupCadence("0 */6 * * *")).toEqual({
      cadenceMs: 6 * HOUR,
      anchorMs: 0,
      recognized: true,
    });
    expect(resolveBackupCadence("15 */2 * * *")).toEqual({
      cadenceMs: 2 * HOUR,
      anchorMs: 15 * MINUTE,
      recognized: true,
    });
  });

  it("hourly 'M * * * *' → 1h cadence anchored at :M", () => {
    expect(resolveBackupCadence("45 * * * *")).toEqual({
      cadenceMs: HOUR,
      anchorMs: 45 * MINUTE,
      recognized: true,
    });
  });

  it("'*/N * * * *' → N-minute cadence, floored at 10 minutes", () => {
    expect(resolveBackupCadence("*/30 * * * *")).toEqual({
      cadenceMs: 30 * MINUTE,
      anchorMs: 0,
      recognized: true,
    });
    // A 1-minute schedule can't turn backups into a load storm.
    expect(resolveBackupCadence("*/1 * * * *").cadenceMs).toBe(10 * MINUTE);
  });

  it("unrecognized shapes fall back to the daily 03:00 default with recognized:false", () => {
    for (const schedule of ["", "garbage", "0 3 * * 1", "0 3 1 * *", "* * *", "61 25 * * *"]) {
      const cadence = resolveBackupCadence(schedule);
      expect(cadence).toEqual({ cadenceMs: DAY, anchorMs: 3 * HOUR, recognized: false });
    }
    expect(resolveBackupCadence(null)).toEqual(resolveBackupCadence(DEFAULT_BACKUP_SCHEDULE));
  });

  it("the fiber check interval is well below every recognized cadence floor", () => {
    expect(SCHEDULED_BACKUP_CHECK_INTERVAL_MS).toBeLessThanOrEqual(10 * MINUTE);
  });
});

describe("backupWindowKey", () => {
  const daily = resolveBackupCadence("0 3 * * *");

  it("is stable within a window and changes across the boundary", () => {
    // 2026-07-18T03:00:00Z is a window boundary for the daily 03:00 anchor.
    const boundary = Date.parse("2026-07-18T03:00:00Z");
    const justBefore = backupWindowKey(boundary - 1, daily);
    const atBoundary = backupWindowKey(boundary, daily);
    const midWindow = backupWindowKey(boundary + 12 * HOUR, daily);
    const nextWindow = backupWindowKey(boundary + DAY, daily);

    expect(atBoundary).toBe(midWindow);
    expect(justBefore).not.toBe(atBoundary);
    expect(nextWindow).not.toBe(atBoundary);
  });

  it("is deterministic across callers (the cross-replica claim key)", () => {
    const now = Date.now();
    expect(backupWindowKey(now, daily)).toBe(backupWindowKey(now, resolveBackupCadence("0 3 * * *")));
  });

  it("embeds cadence + anchor so a schedule change starts a fresh key space", () => {
    const now = Date.now();
    const sixHourly = resolveBackupCadence("0 */6 * * *");
    expect(backupWindowKey(now, daily)).not.toBe(backupWindowKey(now, sixHourly));
    expect(backupWindowKey(now, daily)).toMatch(/^w86400000a10800000--?\d+$/);
  });

  it("rejects a fabricated cadence with a non-positive/NaN window length (an eternal-window key would silently stop backups)", () => {
    expect(() => backupWindowKey(Date.now(), { cadenceMs: 0, anchorMs: 0, recognized: true })).toThrow(
      "positive finite",
    );
    expect(() => backupWindowKey(Date.now(), { cadenceMs: Number.NaN, anchorMs: 0, recognized: true })).toThrow(
      "positive finite",
    );
  });
});
