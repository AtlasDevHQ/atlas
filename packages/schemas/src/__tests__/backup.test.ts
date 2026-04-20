import { describe, expect, test } from "bun:test";
import { BackupEntrySchema, BackupConfigSchema } from "../backup";
import { BACKUP_STATUSES } from "@useatlas/types";

const validEntry = {
  id: "bkp_1",
  createdAt: "2026-04-19T03:00:00.000Z",
  sizeBytes: 1_048_576,
  status: "completed" as const,
  storagePath: "./backups/bkp_1.sql.gz",
  retentionExpiresAt: "2026-05-19T03:00:00.000Z",
  errorMessage: null,
};

const inProgressEntry = {
  ...validEntry,
  id: "bkp_2",
  status: "in_progress" as const,
  sizeBytes: null,
};

const failedEntry = {
  ...validEntry,
  id: "bkp_3",
  status: "failed" as const,
  sizeBytes: null,
  errorMessage: "pg_dump exited with code 1",
};

const validConfig = {
  schedule: "0 3 * * *",
  retentionDays: 30,
  storagePath: "./backups",
};

describe("happy-path parses", () => {
  test("BackupEntrySchema parses a completed backup", () => {
    expect(BackupEntrySchema.parse(validEntry)).toEqual(validEntry);
  });

  test("BackupEntrySchema parses an in-progress backup with null size", () => {
    expect(BackupEntrySchema.parse(inProgressEntry)).toEqual(inProgressEntry);
  });

  test("BackupEntrySchema parses a failed backup with error message", () => {
    expect(BackupEntrySchema.parse(failedEntry)).toEqual(failedEntry);
  });

  test("BackupConfigSchema parses default config", () => {
    expect(BackupConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  test("round-trip (parse → serialize → parse) preserves fields", () => {
    const parsed = BackupEntrySchema.parse(validEntry);
    const serialized = JSON.parse(JSON.stringify(parsed));
    expect(BackupEntrySchema.parse(serialized)).toEqual(validEntry);
  });
});

// ---------------------------------------------------------------------------
// Enum strict rejection — the whole point of this migration. Web previously
// relaxed `status` to z.string(); pinning it to BACKUP_STATUSES means an
// unknown state added in `@atlas/ee/backups` fails parse at useAdminFetch
// time and surfaces a `schema_mismatch` banner instead of leaking through
// into the platform backups table as untyped text.
// ---------------------------------------------------------------------------

describe("enum strict rejection", () => {
  test("unknown status fails parse", () => {
    const drifted = { ...validEntry, status: "restoring" };
    expect(BackupEntrySchema.safeParse(drifted).success).toBe(false);
  });

  test("all BACKUP_STATUSES values parse", () => {
    for (const status of BACKUP_STATUSES) {
      expect(BackupEntrySchema.parse({ ...validEntry, status }).status).toBe(status);
    }
  });

  test("BACKUP_STATUSES tuple contains the expected canonical states", () => {
    expect(BACKUP_STATUSES).toEqual(["in_progress", "completed", "failed", "verified"]);
  });
});

describe("structural rejection", () => {
  test("BackupEntrySchema rejects missing retentionExpiresAt", () => {
    const { retentionExpiresAt: _r, ...missing } = validEntry;
    expect(BackupEntrySchema.safeParse(missing).success).toBe(false);
  });

  test("BackupEntrySchema rejects non-nullable errorMessage as undefined", () => {
    const drifted = { ...validEntry, errorMessage: undefined };
    expect(BackupEntrySchema.safeParse(drifted).success).toBe(false);
  });

  test("BackupConfigSchema rejects non-numeric retentionDays", () => {
    const drifted = { ...validConfig, retentionDays: "30" };
    expect(BackupConfigSchema.safeParse(drifted).success).toBe(false);
  });
});
