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

const pendingMigration = {
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
    expect(RegionMigrationSchema.parse(pendingMigration)).toEqual(pendingMigration);
  });

  test("RegionMigrationSchema parses an in_progress migration", () => {
    const inProgress = { ...pendingMigration, status: "in_progress" as const };
    expect(RegionMigrationSchema.parse(inProgress)).toEqual(inProgress);
  });

  test("RegionMigrationSchema parses a completed migration with null requestedBy", () => {
    const done = {
      ...pendingMigration,
      status: "completed" as const,
      requestedBy: null,
      completedAt: "2026-04-16T00:00:00.000Z",
      errorMessage: null,
    };
    expect(RegionMigrationSchema.parse(done)).toEqual(done);
  });

  test("RegionMigrationSchema parses a failed migration with populated errorMessage", () => {
    const failed = {
      ...pendingMigration,
      status: "failed" as const,
      completedAt: "2026-04-16T00:00:00.000Z",
      errorMessage: "connection to target region timed out",
    };
    expect(RegionMigrationSchema.parse(failed)).toEqual(failed);
  });

  test("RegionMigrationSchema parses a cancelled migration with legacy errorMessage", () => {
    const cancelled = {
      ...pendingMigration,
      status: "cancelled" as const,
      completedAt: "2026-04-16T00:00:00.000Z",
      errorMessage: "Cancelled by admin",
    };
    expect(RegionMigrationSchema.parse(cancelled)).toEqual(cancelled);
  });

  test("RegionMigrationSchema parses a cancelled migration with null errorMessage", () => {
    const cancelled = {
      ...pendingMigration,
      status: "cancelled" as const,
      completedAt: "2026-04-16T00:00:00.000Z",
      errorMessage: null,
    };
    expect(RegionMigrationSchema.parse(cancelled)).toEqual(cancelled);
  });

  test("round-trip (parse → serialize → parse) preserves migration fields", () => {
    const parsed = RegionMigrationSchema.parse(pendingMigration);
    const serialized = JSON.parse(JSON.stringify(parsed));
    expect(RegionMigrationSchema.parse(serialized)).toEqual(pendingMigration);
  });
});

// ---------------------------------------------------------------------------
// Cross-field invariant rejection — the point of the discriminated union.
// Before #1696 these invariants lived in field-level JSDoc; a row with
// { status: "pending", completedAt: "..." } would parse cleanly as long as
// each field passed its own type check. The discriminated union turns
// those drift combinations into parse failures.
// ---------------------------------------------------------------------------

describe("cross-field invariants", () => {
  test("pending with populated completedAt fails parse", () => {
    const drifted = {
      ...pendingMigration,
      status: "pending" as const,
      completedAt: "2026-04-16T00:00:00.000Z",
    };
    expect(RegionMigrationSchema.safeParse(drifted).success).toBe(false);
  });

  test("pending with populated errorMessage fails parse", () => {
    const drifted = {
      ...pendingMigration,
      status: "pending" as const,
      errorMessage: "something went wrong",
    };
    expect(RegionMigrationSchema.safeParse(drifted).success).toBe(false);
  });

  test("in_progress with populated completedAt fails parse", () => {
    const drifted = {
      ...pendingMigration,
      status: "in_progress" as const,
      completedAt: "2026-04-16T00:00:00.000Z",
    };
    expect(RegionMigrationSchema.safeParse(drifted).success).toBe(false);
  });

  test("failed without completedAt fails parse", () => {
    const drifted = {
      ...pendingMigration,
      status: "failed" as const,
      completedAt: null,
      errorMessage: "something broke",
    };
    expect(RegionMigrationSchema.safeParse(drifted).success).toBe(false);
  });

  test("failed without errorMessage fails parse", () => {
    const drifted = {
      ...pendingMigration,
      status: "failed" as const,
      completedAt: "2026-04-16T00:00:00.000Z",
      errorMessage: null,
    };
    expect(RegionMigrationSchema.safeParse(drifted).success).toBe(false);
  });

  test("completed with populated errorMessage fails parse", () => {
    const drifted = {
      ...pendingMigration,
      status: "completed" as const,
      completedAt: "2026-04-16T00:00:00.000Z",
      errorMessage: "something went wrong",
    };
    expect(RegionMigrationSchema.safeParse(drifted).success).toBe(false);
  });
});

describe("enum strict rejection", () => {
  test("unknown migration status fails parse", () => {
    const drifted = { ...pendingMigration, status: "queued" };
    expect(RegionMigrationSchema.safeParse(drifted).success).toBe(false);
  });

  test("all MIGRATION_STATUSES values parse with appropriate variant shape", () => {
    const byStatus = {
      pending: { ...pendingMigration, status: "pending" as const },
      in_progress: { ...pendingMigration, status: "in_progress" as const },
      completed: {
        ...pendingMigration,
        status: "completed" as const,
        completedAt: "2026-04-16T00:00:00.000Z",
        errorMessage: null,
      },
      failed: {
        ...pendingMigration,
        status: "failed" as const,
        completedAt: "2026-04-16T00:00:00.000Z",
        errorMessage: "boom",
      },
      cancelled: {
        ...pendingMigration,
        status: "cancelled" as const,
        completedAt: "2026-04-16T00:00:00.000Z",
        errorMessage: null,
      },
    } as const;
    for (const status of MIGRATION_STATUSES) {
      expect(RegionMigrationSchema.parse(byStatus[status]).status).toBe(status);
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
    const { id: _i, ...missing } = pendingMigration;
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
    const drifted = { ...pendingMigration, requestedBy: undefined };
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
    const response = { migration: pendingMigration };
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
