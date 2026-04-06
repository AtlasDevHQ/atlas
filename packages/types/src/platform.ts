/**
 * Platform admin types for cross-tenant management.
 *
 * Used by the platform admin console to manage workspaces,
 * monitor resource usage, and detect noisy neighbors.
 */

import type { AtlasRole } from "./auth";

/** Resolved deploy mode — binary value after auto-detection. */
export type DeployMode = "saas" | "self-hosted";

/** Raw deploy mode setting — includes "auto" for auto-detection. */
export type DeployModeSetting = "saas" | "self-hosted" | "auto";

export const WORKSPACE_STATUSES = ["active", "suspended", "deleted"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const PLAN_TIERS = ["free", "trial", "starter", "pro", "business"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const NOISY_NEIGHBOR_METRICS = ["queries", "tokens", "storage"] as const;
export type NoisyNeighborMetric = (typeof NOISY_NEIGHBOR_METRICS)[number];

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
  region: string | null;
  regionAssignedAt: string | null;
  createdAt: string;
}

export interface PlatformWorkspaceDetail {
  workspace: PlatformWorkspace;
  users: PlatformWorkspaceUser[];
}

export interface PlatformWorkspaceUser {
  id: string;
  name: string;
  email: string;
  role: AtlasRole;
  createdAt: string;
}

export interface PlatformStats {
  totalWorkspaces: number;
  activeWorkspaces: number;
  suspendedWorkspaces: number;
  totalUsers: number;
  totalQueries24h: number;
  /** Monthly recurring revenue in USD (estimated from plan tiers). */
  mrr: number;
}

export interface NoisyNeighbor {
  workspaceId: string;
  workspaceName: string;
  planTier: PlanTier;
  metric: NoisyNeighborMetric;
  value: number;
  median: number;
  /** value / median — always > 3 for flagged neighbors. */
  ratio: number;
}
