import { describe, expect, test } from "bun:test";
import {
  RegionPickerItemSchema,
  RegionStatusSchema,
  WorkspaceRegionSchema,
  RegionMigrationSchema,
  RegionsResponseSchema,
  AssignmentsResponseSchema,
  MigrationStatusResponseSchema,
} from "../residency";
import { MIGRATION_STATUSES } from "@useatlas/types";

const validPicker = {
  id: "us-east",
  label: "US East",
  isDefault: true,
};

const validStatus = {
  region: "us-east",
  label: "US East",
  workspaceCount: 42,
  healthy: true,
};

const validAssignment = {
  workspaceId: "org_1",
  region: "us-east",
  assignedAt: "2026-04-10T12:00:00.000Z",
};

const validMigration = {
  id: "mig_1",
  workspaceId: "org_1",
  sourceRegion: "us-east",
  targetRegion: "eu-west",
  status: "pending" as const,
  requestedBy: "user_1",
  requestedAt: "2026-04-15T00:00:00.000Z",
  completedAt: null,
  errorMessage: null,
};

describe("happy-path parses", () => {
  test("RegionPickerItemSchema parses a picker entry", () => {
    expect(RegionPickerItemSchema.parse(validPicker)).toEqual(validPicker);
  });

  test("RegionStatusSchema parses a region-status row", () => {
    expect(RegionStatusSchema.parse(validStatus)).toEqual(validStatus);
  });

  test("WorkspaceRegionSchema parses an assignment", () => {
    expect(WorkspaceRegionSchema.parse(validAssignment)).toEqual(validAssignment);
  });

  test("RegionMigrationSchema parses a pending migration", () => {
    expect(RegionMigrationSchema.parse(validMigration)).toEqual(validMigration);
  });

  test("RegionMigrationSchema parses a completed migration with null requestedBy", () => {
    const done = {
      ...validMigration,
      status: "completed" as const,
      requestedBy: null,
      completedAt: "2026-04-16T00:00:00.000Z",
    };
    expect(RegionMigrationSchema.parse(done)).toEqual(done);
  });

  test("RegionMigrationSchema parses a failed migration with populated errorMessage", () => {
    const failed = {
      ...validMigration,
      status: "failed" as const,
      completedAt: "2026-04-16T00:00:00.000Z",
      errorMessage: "connection to target region timed out",
    };
    expect(RegionMigrationSchema.parse(failed)).toEqual(failed);
  });

  test("round-trip (parse → serialize → parse) preserves migration fields", () => {
    const parsed = RegionMigrationSchema.parse(validMigration);
    const serialized = JSON.parse(JSON.stringify(parsed));
    expect(RegionMigrationSchema.parse(serialized)).toEqual(validMigration);
  });
});

// ---------------------------------------------------------------------------
// Enum strict rejection — the central win of this migration. Route
// previously pinned `status` to `z.enum(MIGRATION_STATUSES)` while web
// hand-typed `z.enum(["pending", …])`. A 6th status added in
// `@useatlas/types` would silently pass the route and fail the web parse.
// Pinning both sides to the same canonical tuple (sourced from types)
// closes that drift trap.
// ---------------------------------------------------------------------------

describe("enum strict rejection", () => {
  test("unknown migration status fails parse", () => {
    const drifted = { ...validMigration, status: "queued" };
    expect(RegionMigrationSchema.safeParse(drifted).success).toBe(false);
  });

  test("all MIGRATION_STATUSES values parse", () => {
    for (const status of MIGRATION_STATUSES) {
      expect(RegionMigrationSchema.parse({ ...validMigration, status }).status).toBe(status);
    }
  });

  test("canonical tuple matches expected values", () => {
    expect(MIGRATION_STATUSES).toEqual([
      "pending",
      "in_progress",
      "completed",
      "failed",
      "cancelled",
    ]);
  });
});

describe("structural rejection", () => {
  test("RegionMigrationSchema rejects missing id", () => {
    const { id: _i, ...missing } = validMigration;
    expect(RegionMigrationSchema.safeParse(missing).success).toBe(false);
  });

  test("RegionStatusSchema rejects non-boolean healthy", () => {
    const drifted = { ...validStatus, healthy: "yes" };
    expect(RegionStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("RegionStatusSchema rejects fractional workspaceCount", () => {
    const drifted = { ...validStatus, workspaceCount: 1.5 };
    expect(RegionStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("RegionStatusSchema rejects negative workspaceCount", () => {
    const drifted = { ...validStatus, workspaceCount: -3 };
    expect(RegionStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("WorkspaceRegionSchema rejects non-string assignedAt", () => {
    const drifted = { ...validAssignment, assignedAt: 123 };
    expect(WorkspaceRegionSchema.safeParse(drifted).success).toBe(false);
  });

  test("RegionPickerItemSchema rejects missing isDefault", () => {
    const { isDefault: _d, ...missing } = validPicker;
    expect(RegionPickerItemSchema.safeParse(missing).success).toBe(false);
  });

  test("RegionMigrationSchema rejects undefined on nullable field", () => {
    // Zod's `.nullable()` accepts null but not undefined. This guards the
    // route-serialization / web-parse contract — the API emits explicit
    // null, not a missing key, so the distinction matters.
    const drifted = { ...validMigration, requestedBy: undefined };
    expect(RegionMigrationSchema.safeParse(drifted).success).toBe(false);
  });
});

describe("composite response shapes", () => {
  test("RegionsResponseSchema parses a list + default", () => {
    const response = { regions: [validStatus], defaultRegion: "us-east" };
    expect(RegionsResponseSchema.parse(response)).toEqual(response);
  });

  test("AssignmentsResponseSchema parses a list", () => {
    const response = { assignments: [validAssignment] };
    expect(AssignmentsResponseSchema.parse(response)).toEqual(response);
  });

  test("MigrationStatusResponseSchema parses a null migration", () => {
    const response = { migration: null };
    expect(MigrationStatusResponseSchema.parse(response)).toEqual(response);
  });

  test("MigrationStatusResponseSchema parses a migration", () => {
    const response = { migration: validMigration };
    expect(MigrationStatusResponseSchema.parse(response)).toEqual(response);
  });

  test("RegionsResponseSchema rejects missing defaultRegion", () => {
    const drifted = { regions: [validStatus] };
    expect(RegionsResponseSchema.safeParse(drifted).success).toBe(false);
  });

  test("AssignmentsResponseSchema rejects non-array assignments", () => {
    const drifted = { assignments: validAssignment };
    expect(AssignmentsResponseSchema.safeParse(drifted).success).toBe(false);
  });

  test("MigrationStatusResponseSchema rejects missing migration key", () => {
    // Distinct from `{ migration: null }`, which is the happy path — the
    // API emits `null` explicitly when no migration exists.
    const drifted = {};
    expect(MigrationStatusResponseSchema.safeParse(drifted).success).toBe(false);
  });
});
