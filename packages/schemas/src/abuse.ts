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
 *
 * Every schema uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) — the
 * `as` cast silently green-lights any shape, while `satisfies` forces the
 * object's inferred schema to be assignable to `ZodType<T>`. A field
 * rename in `@useatlas/types` then breaks this file at compile time
 * instead of passing through to runtime.
 *
 * Level/trigger enums are strict `z.enum(TUPLE)` — they match the TS union
 * exactly and fail parse on drift. `abuse_events.level` + `trigger_type`
 * are unconstrained `TEXT` columns (no DB `CHECK`), which is the real
 * hardening gap; #1653 tracks that follow-up. Keeping the Zod layer
 * strict here matches the `@hono/zod-openapi` extractor's expectations
 * (the extractor cannot serialize `ZodCatch` wrappers) and keeps the
 * OpenAPI spec describing the genuine output shape — `"none" | "warning"
 * | "throttled" | "suspended"`, not "any string." A drifted row in
 * practice would require either a manual DB INSERT or an out-of-band
 * code change, both caught earlier than the admin-page boundary.
 */
import { z } from "zod";
import {
  ABUSE_LEVELS,
  ABUSE_TRIGGERS,
  ABUSE_EVENTS_STATUSES,
  asPercentage,
  asRatio,
  type AbuseEvent,
  type AbuseStatus,
  type AbuseThresholdConfig,
  type AbuseDetail,
  type AbuseInstance,
  type AbuseCounters,
  type Percentage,
  type Ratio,
} from "@useatlas/types";

const LevelEnum = z.enum(ABUSE_LEVELS);
const TriggerEnum = z.enum(ABUSE_TRIGGERS);
const EventsStatusEnum = z.enum(ABUSE_EVENTS_STATUSES);

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
  // `eventsStatus` is optional on the wire so existing list consumers
  // (pre-#1682) keep parsing; new consumers treat absent as "ok" — see the
  // type comment on `AbuseStatus.eventsStatus`.
  eventsStatus: EventsStatusEnum.optional(),
}) satisfies z.ZodType<AbuseStatus>;

// `errorRateThreshold` is branded `Ratio` (#1685). `z.number().min(0).max(1)`
// enforces the 0–1 scale at the wire boundary — a drifted payload that
// sneaks a percentage value into the ratio slot fails parse rather than
// silently branding as a `Ratio` of 50 that would then compare wrong
// against every `Percentage` the engine produces. `.transform` brands the
// in-range value so call sites cannot substitute a raw `number`.
export const AbuseThresholdConfigSchema = z.object({
  queryRateLimit: z.number(),
  queryRateWindowSeconds: z.number(),
  errorRateThreshold: z.number().min(0).max(1).transform((n): Ratio => asRatio(n)),
  uniqueTablesLimit: z.number(),
  throttleDelayMs: z.number(),
}) satisfies z.ZodType<AbuseThresholdConfig, unknown>;

// `errorRatePct` is branded `Percentage` (#1685). Same wire-boundary range
// + cast pattern as `errorRateThreshold` above; `.nullable()` keeps the
// "baseline pending" null-pass-through for queryCount < 10.
export const AbuseCountersSchema = z.object({
  queryCount: z.number(),
  errorCount: z.number(),
  errorRatePct: z
    .number()
    .min(0)
    .max(100)
    .transform((n): Percentage => asPercentage(n))
    .nullable(),
  uniqueTablesAccessed: z.number(),
  escalations: z.number(),
}) satisfies z.ZodType<AbuseCounters, unknown>;

// `AbuseInstance` is nominally branded at the TS layer (#1684) so only the
// factory + this parser may mint values. `.transform((v) => v as ...)` is
// the wire-boundary cast: the Zod object literal's Output is a plain
// object, the `.transform` Output is the branded interface. `satisfies`
// keeps the structural drift guard — a field rename in `@useatlas/types`
// still breaks this file at compile time. Input is widened to `unknown`
// because `.transform` produces a schema whose Input (what `.parse()`
// accepts) differs from its Output (what `.parse()` returns); the
// single-generic `z.ZodType<AbuseInstance>` collapses them into the same
// type and rejects the transform.
export const AbuseInstanceSchema = z
  .object({
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    peakLevel: LevelEnum,
    events: z.array(AbuseEventSchema),
  })
  .transform((v): AbuseInstance => v as unknown as AbuseInstance) satisfies z.ZodType<
    AbuseInstance,
    unknown
  >;

// Structurally mirrors `AbuseDetail extends Omit<AbuseStatus, "events">` —
// using `.omit().extend()` keeps the identity fields coupled to
// `AbuseStatusSchema` so a rename in AbuseStatus propagates here without
// a second manual edit. Previously this duplicated the identity fields
// inline, reintroducing the exact drift surface this package exists to
// close.
export const AbuseDetailSchema = AbuseStatusSchema.omit({ events: true }).extend({
  counters: AbuseCountersSchema,
  thresholds: AbuseThresholdConfigSchema,
  currentInstance: AbuseInstanceSchema,
  priorInstances: z.array(AbuseInstanceSchema),
  eventsStatus: EventsStatusEnum,
}) satisfies z.ZodType<AbuseDetail>;
