/**
 * Platform admin types for cross-tenant management.
 *
 * Used by the platform admin console to manage workspaces,
 * monitor resource usage, and detect noisy neighbors.
 */

import type { AtlasRole } from "./auth";
import type { AbuseLevel } from "./abuse";

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
  /**
   * True when the workspace ID is in `ATLAS_LOADTEST_ALLOWED_ORGS` — the
   * env-driven allowlist that lets designated load-test workspaces
   * bypass abuse-prevention escalation (#2166) and mint MCP load-test
   * JWTs. Optional + additive: omitted on consumers that haven't picked
   * up this @useatlas/types release yet, treated as `false` in the UI.
   * Source of truth: `lib/auth/load-test-allowlist.ts:isLoadTestWorkspace`.
   */
  neverSuspend?: boolean;
  /**
   * Current in-memory abuse level for the workspace, sourced from
   * `lib/security/abuse.ts:checkAbuseStatus`. Independent of
   * `status` (the `workspace_status` DB column flipped by admin
   * actions) — a workspace can be DB-active but abuse-suspended,
   * which is exactly the divergence this field exists to expose so
   * `/admin/platform` no longer looks healthy while chat is blocked
   * by the abuse path. Optional + additive: omitted on consumers
   * pre-dating this release; treat missing as `"none"`.
   */
  abuseLevel?: AbuseLevel;
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

/**
 * Per-plugin health snapshot included in `PlatformOverview.pluginHealth`.
 * Mirrors the in-memory registry's `describe()` shape, narrowed to what
 * the dashboard needs.
 */
export interface PlatformPluginHealth {
  id: string;
  name: string;
  types: string[];
  status: string;
}

/**
 * Wire shape for `GET /api/v1/platform/overview` (#2489). Deployment-wide
 * scaffold the workspace `/admin` Overview must NOT surface:
 * disk-bundled entities, plugin registry, plugin health, and the pool
 * capacity warnings string.
 */
export interface PlatformOverview {
  /** Deployment-scaffold entity count from `discoverEntities(root)`. */
  entities: number;
  /** Plugin registry size. */
  plugins: number;
  pluginHealth: PlatformPluginHealth[];
  /** Disk-scan warnings (per-file YAML parse failures). */
  warnings?: string[];
  /** Pool capacity warnings — deployment-wide config; never on /admin. */
  poolWarnings?: string[];
  /** Echoed from the request for log correlation. */
  requestId: string;
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
