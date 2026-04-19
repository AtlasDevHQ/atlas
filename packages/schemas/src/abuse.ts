/**
 * Abuse-prevention wire-format schemas.
 *
 * Single source of truth for the admin abuse surface (`/api/v1/admin/abuse`).
 * The route layer imports these for OpenAPI response validation; the web
 * layer imports them for `useAdminFetch` response parsing. Before this
 * package, both layers kept their own Zod copies that drifted silently.
 *
 * The enum tuples (`ABUSE_LEVELS`, `ABUSE_TRIGGERS`) come from
 * `@useatlas/types` so a new level or trigger added to the TS union
 * propagates here without manual duplication.
 */
import { z } from "zod";
import {
  ABUSE_LEVELS,
  ABUSE_TRIGGERS,
  type AbuseEvent,
  type AbuseStatus,
  type AbuseThresholdConfig,
  type AbuseDetail,
  type AbuseInstance,
  type AbuseCounters,
} from "@useatlas/types";

const LevelEnum = z.enum(ABUSE_LEVELS);
const TriggerEnum = z.enum(ABUSE_TRIGGERS);

export const AbuseEventSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  level: LevelEnum,
  trigger: TriggerEnum,
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  actor: z.string(),
}) satisfies z.ZodType<AbuseEvent>;

export const AbuseStatusSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string().nullable(),
  level: LevelEnum,
  trigger: TriggerEnum.nullable(),
  message: z.string().nullable(),
  updatedAt: z.string(),
  events: z.array(AbuseEventSchema),
}) satisfies z.ZodType<AbuseStatus>;

export const AbuseThresholdConfigSchema = z.object({
  queryRateLimit: z.number(),
  queryRateWindowSeconds: z.number(),
  errorRateThreshold: z.number(),
  uniqueTablesLimit: z.number(),
  throttleDelayMs: z.number(),
}) satisfies z.ZodType<AbuseThresholdConfig>;

export const AbuseCountersSchema = z.object({
  queryCount: z.number(),
  errorCount: z.number(),
  errorRatePct: z.number().nullable(),
  uniqueTablesAccessed: z.number(),
  escalations: z.number(),
}) satisfies z.ZodType<AbuseCounters>;

export const AbuseInstanceSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  peakLevel: LevelEnum,
  events: z.array(AbuseEventSchema),
}) satisfies z.ZodType<AbuseInstance>;

export const AbuseDetailSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string().nullable(),
  level: LevelEnum,
  trigger: TriggerEnum.nullable(),
  message: z.string().nullable(),
  updatedAt: z.string(),
  counters: AbuseCountersSchema,
  thresholds: AbuseThresholdConfigSchema,
  currentInstance: AbuseInstanceSchema,
  priorInstances: z.array(AbuseInstanceSchema),
}) satisfies z.ZodType<AbuseDetail>;
