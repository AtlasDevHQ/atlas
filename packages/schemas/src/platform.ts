/**
 * Platform admin wire-format schemas.
 *
 * Single source of truth for the cross-tenant platform admin surface
 * (`/api/v1/platform/stats`, `/workspaces`, `/noisy-neighbors`,
 * `/workspaces/:id`) — used by both route-layer OpenAPI validation and
 * web-layer response parsing.
 *
 * Before #1648, the route copies in `platform-admin.ts` pinned `status`,
 * `planTier`, and `metric` to strict `z.enum(TUPLE)` while the web
 * copies silently relaxed them all to `z.string()`. Three enum columns,
 * three drift traps — a new plan tier, a new workspace status, or a new
 * noisy-neighbor metric would have passed the web parse untyped and
 * silently broken the platform admin table. Pinning here closes that gap.
 *
 * Tuples (`WORKSPACE_STATUSES`, `PLAN_TIERS`, `NOISY_NEIGHBOR_METRICS`,
 * `ATLAS_ROLES`) come from `@useatlas/types` so adding a new value
 * propagates here without a second edit.
 *
 * Uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so a field
 * rename in `@useatlas/types` breaks this file at compile time instead
 * of passing through to runtime.
 *
 * Strict `z.enum(TUPLE)` matches the `@hono/zod-openapi` extractor's
 * expectations — it cannot serialize `ZodCatch` wrappers — and keeps the
 * generated OpenAPI spec describing the genuine output shape.
 */
import { z } from "zod";
import {
  WORKSPACE_STATUSES,
  PLAN_TIERS,
  NOISY_NEIGHBOR_METRICS,
  ATLAS_ROLES,
  type PlatformStats,
  type PlatformWorkspace,
  type PlatformWorkspaceUser,
  type NoisyNeighbor,
} from "@useatlas/types";

const WorkspaceStatusEnum = z.enum(WORKSPACE_STATUSES);
const PlanTierEnum = z.enum(PLAN_TIERS);
const NoisyMetricEnum = z.enum(NOISY_NEIGHBOR_METRICS);
const AtlasRoleEnum = z.enum(ATLAS_ROLES);

export const PlatformStatsSchema = z.object({
  totalWorkspaces: z.number(),
  activeWorkspaces: z.number(),
  suspendedWorkspaces: z.number(),
  totalUsers: z.number(),
  totalQueries24h: z.number(),
  mrr: z.number(),
}) satisfies z.ZodType<PlatformStats>;

export const PlatformWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: WorkspaceStatusEnum,
  planTier: PlanTierEnum,
  byot: z.boolean(),
  members: z.number(),
  conversations: z.number(),
  queriesLast24h: z.number(),
  connections: z.number(),
  scheduledTasks: z.number(),
  stripeCustomerId: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  region: z.string().nullable(),
  regionAssignedAt: z.string().nullable(),
  createdAt: z.string(),
}) satisfies z.ZodType<PlatformWorkspace>;

export const PlatformWorkspaceUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: AtlasRoleEnum,
  createdAt: z.string(),
}) satisfies z.ZodType<PlatformWorkspaceUser>;

export const NoisyNeighborSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  planTier: PlanTierEnum,
  metric: NoisyMetricEnum,
  value: z.number(),
  median: z.number(),
  ratio: z.number(),
}) satisfies z.ZodType<NoisyNeighbor>;
