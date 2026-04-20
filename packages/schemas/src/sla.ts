/**
 * SLA monitoring wire-format schemas.
 *
 * Powers `/api/v1/platform/sla` family. Replaces duplicate schemas in
 * `packages/api/src/api/routes/platform-sla.ts` and
 * `packages/web/src/ui/lib/admin-schemas.ts`.
 *
 * `SLAAlert.type` + `SLAAlert.status` tighten to their canonical tuples
 * (`SLA_ALERT_TYPES` / `SLA_ALERT_STATUSES` in `@useatlas/types`) so a new
 * alert type added to the tuple propagates automatically to the route
 * OpenAPI contract and the web parse without a second edit.
 *
 * `WorkspaceSLASummary.errorRatePct` / `uptimePct` and
 * `SLAThresholds.errorRatePct` use `.min(0).max(100).transform(asPercentage)`
 * so a drifted response (scale mixup, NaN, negative) fails parse instead of
 * silently branding as `Percentage` (#1685). Timestamps go through
 * `IsoTimestampSchema` (#1697).
 */
import { z } from "zod";
import {
  SLA_ALERT_STATUSES,
  SLA_ALERT_TYPES,
  asPercentage,
  type SLAAlert,
  type SLAMetricPoint,
  type SLAThresholds,
  type WorkspaceSLADetail,
  type WorkspaceSLASummary,
} from "@useatlas/types";
import { IsoTimestampSchema } from "./common";

const PercentageSchema = z
  .number()
  .min(0)
  .max(100)
  .transform((n) => asPercentage(n));

export const SLAMetricPointSchema = z.object({
  timestamp: IsoTimestampSchema,
  value: z.number(),
}) satisfies z.ZodType<SLAMetricPoint, unknown>;

export const WorkspaceSLASummarySchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  latencyP50Ms: z.number(),
  latencyP95Ms: z.number(),
  latencyP99Ms: z.number(),
  errorRatePct: PercentageSchema,
  uptimePct: PercentageSchema,
  totalQueries: z.number(),
  failedQueries: z.number(),
  lastQueryAt: IsoTimestampSchema.nullable(),
}) satisfies z.ZodType<WorkspaceSLASummary, unknown>;

export const WorkspaceSLADetailSchema = z.object({
  summary: WorkspaceSLASummarySchema,
  latencyTimeline: z.array(SLAMetricPointSchema),
  errorTimeline: z.array(SLAMetricPointSchema),
}) satisfies z.ZodType<WorkspaceSLADetail, unknown>;

export const SLAAlertSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  type: z.enum(SLA_ALERT_TYPES),
  status: z.enum(SLA_ALERT_STATUSES),
  currentValue: z.number(),
  threshold: z.number(),
  message: z.string(),
  firedAt: IsoTimestampSchema,
  resolvedAt: IsoTimestampSchema.nullable(),
  acknowledgedAt: IsoTimestampSchema.nullable(),
  acknowledgedBy: z.string().nullable(),
}) satisfies z.ZodType<SLAAlert, unknown>;

export const SLAThresholdsSchema = z.object({
  latencyP99Ms: z.number(),
  errorRatePct: PercentageSchema,
}) satisfies z.ZodType<SLAThresholds, unknown>;

// ---------------------------------------------------------------------------
// Composite response shapes
// ---------------------------------------------------------------------------

interface SLAWorkspacesResponse {
  workspaces: WorkspaceSLASummary[];
  hoursBack: number;
}

interface SLAAlertsResponse {
  alerts: SLAAlert[];
}

export const SLAWorkspacesResponseSchema = z.object({
  workspaces: z.array(WorkspaceSLASummarySchema),
  hoursBack: z.number(),
}) satisfies z.ZodType<SLAWorkspacesResponse, unknown>;

export const SLAAlertsResponseSchema = z.object({
  alerts: z.array(SLAAlertSchema),
}) satisfies z.ZodType<SLAAlertsResponse, unknown>;
