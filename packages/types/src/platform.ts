/**
 * Platform admin types for cross-tenant management.
 *
 * Used by the platform admin console to manage workspaces,
 * monitor resource usage, and detect noisy neighbors.
 */

export type WorkspaceStatus = "active" | "suspended" | "deleted";
export type PlanTier = "free" | "trial" | "team" | "enterprise";

export const WORKSPACE_STATUSES = ["active", "suspended", "deleted"] as const;
export const PLAN_TIERS = ["free", "trial", "team", "enterprise"] as const;

export interface PlatformWorkspace {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  planTier: PlanTier;
  byot: boolean;
  members: number;
  conversations: number;
  queriesLast24h: number;
  connections: number;
  scheduledTasks: number;
  stripeCustomerId: string | null;
  trialEndsAt: string | null;
  suspendedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface PlatformWorkspaceDetail extends PlatformWorkspace {
  users: PlatformWorkspaceUser[];
}

export interface PlatformWorkspaceUser {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

export interface PlatformStats {
  totalWorkspaces: number;
  activeWorkspaces: number;
  suspendedWorkspaces: number;
  totalUsers: number;
  totalQueries24h: number;
  mrr: number;
}

export interface NoisyNeighbor {
  workspaceId: string;
  workspaceName: string;
  planTier: PlanTier;
  metric: "queries" | "tokens" | "storage";
  value: number;
  median: number;
  ratio: number;
}
