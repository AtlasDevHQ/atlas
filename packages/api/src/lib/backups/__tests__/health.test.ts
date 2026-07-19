/**
 * Scheduled-backup /health tripwire tests (#4457).
 *
 * The probe answers "is the newest verified backup older than the cadence
 * window?" straight from the DB — independently of the fiber — so a
 * gated-off / broken scheduler surfaces as `overdue` instead of booting
 * green forever.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────────────

let enterpriseEnabled = true;
void mock.module("@atlas/api/lib/effect/enterprise-config", () => ({
  isEnterpriseEnabled: () => enterpriseEnabled,
}));

let hasDb = true;
let queryResults: Record<string, unknown>[][] = [];
let queryError: Error | null = null;
let queryCall = 0;
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasDb,
  internalQuery: async () => {
    if (queryError) throw queryError;
    const rows = queryResults[queryCall] ?? [];
    queryCall++;
    return rows;
  },
  internalExecute: async () => {},
  getInternalDB: () => ({}),
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
  _resetPool: () => {},
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { getScheduledBackupHealth, _resetScheduledBackupHealthCache } = await import(
  "@atlas/api/lib/backups/health"
);

const HOUR = 60 * 60 * 1000;

const priorEnabled = process.env.ATLAS_BACKUP_SCHEDULED_ENABLED;
const priorSchedule = process.env.ATLAS_BACKUP_SCHEDULE;

function resetAll() {
  _resetScheduledBackupHealthCache();
  enterpriseEnabled = true;
  hasDb = true;
  queryResults = [];
  queryError = null;
  queryCall = 0;
  delete process.env.ATLAS_BACKUP_SCHEDULED_ENABLED;
  delete process.env.ATLAS_BACKUP_SCHEDULE;
}

afterAll(() => {
  if (priorEnabled === undefined) delete process.env.ATLAS_BACKUP_SCHEDULED_ENABLED;
  else process.env.ATLAS_BACKUP_SCHEDULED_ENABLED = priorEnabled;
  if (priorSchedule === undefined) delete process.env.ATLAS_BACKUP_SCHEDULE;
  else process.env.ATLAS_BACKUP_SCHEDULE = priorSchedule;
});

// Probe issues [config SELECT, last-verified SELECT] via Promise.all.
const queueProbe = (schedule: string | null, lastVerifiedAt: string | null) => {
  queryResults = [
    schedule ? [{ schedule }] : [],
    [{ last: lastVerifiedAt }],
  ];
};

// ── Tests ──────────────────────────────────────────────────────────

describe("getScheduledBackupHealth — expectation gate", () => {
  beforeEach(resetAll);

  it("not expected when enterprise is disabled", async () => {
    enterpriseEnabled = false;
    expect(await getScheduledBackupHealth()).toEqual({ expected: false });
  });

  it("not expected without an internal DB", async () => {
    hasDb = false;
    expect(await getScheduledBackupHealth()).toEqual({ expected: false });
  });

  it("not expected when the scheduled path is env-disabled (mirrors the fiber gate)", async () => {
    process.env.ATLAS_BACKUP_SCHEDULED_ENABLED = "false";
    expect(await getScheduledBackupHealth()).toEqual({ expected: false });
  });
});

describe("getScheduledBackupHealth — overdue tripwire", () => {
  beforeEach(resetAll);

  it("healthy when the newest verified backup is inside cadence + grace", async () => {
    queueProbe("0 3 * * *", new Date(Date.now() - 2 * HOUR).toISOString());
    const health = await getScheduledBackupHealth();
    expect(health.expected).toBe(true);
    if (health.expected) {
      expect(health.overdue).toBe(false);
      expect(health.cadenceMs).toBe(24 * HOUR);
    }
  });

  it("overdue when the newest verified backup is older than cadence + grace", async () => {
    queueProbe("0 3 * * *", new Date(Date.now() - 40 * HOUR).toISOString());
    const health = await getScheduledBackupHealth();
    expect(health.expected).toBe(true);
    if (health.expected) {
      expect(health.overdue).toBe(true);
      expect(health.message).toContain("older than the configured cadence");
    }
  });

  it("overdue with a distinct message when no verified backup exists at all", async () => {
    queueProbe("0 3 * * *", null);
    const health = await getScheduledBackupHealth();
    expect(health.expected).toBe(true);
    if (health.expected) {
      expect(health.overdue).toBe(true);
      expect(health.lastVerifiedAt).toBeNull();
      expect(health.message).toContain("No verified backup recorded");
    }
  });

  it("uses the DB-configured schedule for the cadence (an every-6-hours config tightens the window)", async () => {
    queueProbe("0 */6 * * *", new Date(Date.now() - 10 * HOUR).toISOString());
    const health = await getScheduledBackupHealth();
    expect(health.expected).toBe(true);
    if (health.expected) {
      expect(health.cadenceMs).toBe(6 * HOUR);
      // 10h old > 6h * 1.25 grace → overdue under the tightened cadence.
      expect(health.overdue).toBe(true);
    }
  });

  it("a missing backups table reads as none-yet, not a probe failure", async () => {
    queryError = new Error('relation "backups" does not exist');
    const health = await getScheduledBackupHealth();
    expect(health.expected).toBe(true);
    if (health.expected) {
      expect(health.overdue).toBe(true);
      expect(health.message).toContain("No verified backup recorded");
    }
  });

  it("any other probe failure reports overdue (fail loud, never fail silent)", async () => {
    queryError = new Error("connection refused");
    const health = await getScheduledBackupHealth();
    expect(health.expected).toBe(true);
    if (health.expected) {
      expect(health.overdue).toBe(true);
      expect(health.message).toContain("probe failed");
    }
  });
});

describe("getScheduledBackupHealth — cache", () => {
  beforeEach(resetAll);

  it("serves the cached probe within the TTL (one DB round-trip per window)", async () => {
    queueProbe("0 3 * * *", new Date().toISOString());
    await getScheduledBackupHealth();
    const callsAfterFirst = queryCall;
    await getScheduledBackupHealth();
    expect(queryCall).toBe(callsAfterFirst);
  });
});
