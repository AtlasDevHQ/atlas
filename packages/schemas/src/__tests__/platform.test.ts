import { describe, expect, test } from "bun:test";
import {
  PlatformStatsSchema,
  PlatformWorkspaceSchema,
  PlatformWorkspaceUserSchema,
  NoisyNeighborSchema,
} from "../platform";
import { WORKSPACE_STATUSES, PLAN_TIERS, NOISY_NEIGHBOR_METRICS, ATLAS_ROLES } from "@useatlas/types";

const validStats = {
  totalWorkspaces: 42,
  activeWorkspaces: 38,
  suspendedWorkspaces: 3,
  totalUsers: 210,
  totalQueries24h: 15_300,
  mrr: 3495,
};

const validWorkspace = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  status: "active" as const,
  planTier: "starter" as const,
  byot: false,
  members: 8,
  conversations: 110,
  queriesLast24h: 342,
  connections: 3,
  scheduledTasks: 2,
  stripeCustomerId: "cus_123",
  trialEndsAt: null,
  suspendedAt: null,
  deletedAt: null,
  region: "us-east",
  regionAssignedAt: "2026-04-10T12:00:00.000Z",
  createdAt: "2026-03-01T00:00:00.000Z",
};

const validUser = {
  id: "user_1",
  name: "Ada Lovelace",
  email: "ada@acme.test",
  role: "admin" as const,
  createdAt: "2026-03-02T00:00:00.000Z",
};

const validNeighbor = {
  workspaceId: "org_1",
  workspaceName: "Acme",
  planTier: "starter" as const,
  metric: "queries" as const,
  value: 12_000,
  median: 3000,
  ratio: 4,
};

describe("happy-path parses", () => {
  test("PlatformStatsSchema parses valid stats", () => {
    expect(PlatformStatsSchema.parse(validStats)).toEqual(validStats);
  });

  test("PlatformWorkspaceSchema parses an active workspace", () => {
    expect(PlatformWorkspaceSchema.parse(validWorkspace)).toEqual(validWorkspace);
  });

  test("PlatformWorkspaceSchema parses a suspended workspace", () => {
    const suspended = {
      ...validWorkspace,
      id: "org_2",
      status: "suspended" as const,
      suspendedAt: "2026-04-15T00:00:00.000Z",
    };
    expect(PlatformWorkspaceSchema.parse(suspended)).toEqual(suspended);
  });

  test("PlatformWorkspaceUserSchema parses an admin user", () => {
    expect(PlatformWorkspaceUserSchema.parse(validUser)).toEqual(validUser);
  });

  test("NoisyNeighborSchema parses a flagged neighbor", () => {
    expect(NoisyNeighborSchema.parse(validNeighbor)).toEqual(validNeighbor);
  });

  test("round-trip (parse → serialize → parse) preserves workspace fields", () => {
    const parsed = PlatformWorkspaceSchema.parse(validWorkspace);
    const serialized = JSON.parse(JSON.stringify(parsed));
    expect(PlatformWorkspaceSchema.parse(serialized)).toEqual(validWorkspace);
  });
});

// ---------------------------------------------------------------------------
// Enum strict rejection — three enum columns on PlatformWorkspace
// (status, planTier) and NoisyNeighbor (metric, planTier). Web previously
// relaxed all four to z.string(); tightening to z.enum(TUPLE) means a new
// plan tier or workspace status added in `@useatlas/types` fails parse at
// useAdminFetch time, surfacing `schema_mismatch` instead of silently
// rendering an unstyled badge in the platform admin table.
// ---------------------------------------------------------------------------

describe("enum strict rejection", () => {
  test("unknown workspace status fails parse", () => {
    const drifted = { ...validWorkspace, status: "archived" };
    expect(PlatformWorkspaceSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown plan tier fails parse", () => {
    const drifted = { ...validWorkspace, planTier: "legacy-enterprise" };
    expect(PlatformWorkspaceSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown noisy metric fails parse", () => {
    const drifted = { ...validNeighbor, metric: "iops" };
    expect(NoisyNeighborSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown user role fails parse", () => {
    const drifted = { ...validUser, role: "moderator" };
    expect(PlatformWorkspaceUserSchema.safeParse(drifted).success).toBe(false);
  });

  test("all WORKSPACE_STATUSES values parse", () => {
    for (const status of WORKSPACE_STATUSES) {
      expect(PlatformWorkspaceSchema.parse({ ...validWorkspace, status }).status).toBe(status);
    }
  });

  test("all PLAN_TIERS values parse", () => {
    for (const planTier of PLAN_TIERS) {
      expect(PlatformWorkspaceSchema.parse({ ...validWorkspace, planTier }).planTier).toBe(planTier);
    }
  });

  test("all NOISY_NEIGHBOR_METRICS values parse", () => {
    for (const metric of NOISY_NEIGHBOR_METRICS) {
      expect(NoisyNeighborSchema.parse({ ...validNeighbor, metric }).metric).toBe(metric);
    }
  });

  test("all ATLAS_ROLES values parse as PlatformWorkspaceUser.role", () => {
    for (const role of ATLAS_ROLES) {
      expect(PlatformWorkspaceUserSchema.parse({ ...validUser, role }).role).toBe(role);
    }
  });

  test("canonical tuples match expected values", () => {
    expect(WORKSPACE_STATUSES).toEqual(["active", "suspended", "deleted"]);
    expect(PLAN_TIERS).toEqual(["free", "trial", "starter", "pro", "business"]);
    expect(NOISY_NEIGHBOR_METRICS).toEqual(["queries", "tokens", "storage"]);
    expect(ATLAS_ROLES).toEqual(["member", "admin", "owner", "platform_admin"]);
  });
});

describe("structural rejection", () => {
  test("PlatformWorkspaceSchema rejects missing region field", () => {
    const { region: _r, ...missing } = validWorkspace;
    expect(PlatformWorkspaceSchema.safeParse(missing).success).toBe(false);
  });

  test("PlatformStatsSchema rejects non-numeric totalWorkspaces", () => {
    const drifted = { ...validStats, totalWorkspaces: "42" };
    expect(PlatformStatsSchema.safeParse(drifted).success).toBe(false);
  });

  test("NoisyNeighborSchema rejects missing ratio", () => {
    const { ratio: _r, ...missing } = validNeighbor;
    expect(NoisyNeighborSchema.safeParse(missing).success).toBe(false);
  });
});
