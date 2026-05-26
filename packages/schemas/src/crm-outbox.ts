/**
 * CRM outbox wire-format schemas (#2735, slice 9 of 1.6.0).
 *
 * Single source of truth for the platform crm-outbox surface
 * (`/api/v1/platform/crm-outbox`) — used by both route-layer OpenAPI
 * validation and web-layer response parsing via `useAdminFetch`.
 *
 * The `OUTBOX_STATUSES` tuple comes from `@useatlas/types` so adding a
 * new status propagates without a second edit.
 *
 * Uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so a field
 * rename in `@useatlas/types` breaks this file at compile time instead
 * of passing through to runtime.
 */
import { z } from "zod";
import type {
  CrmOutboxRow,
  CrmOutboxRowDetail,
  OutboxStatus,
} from "@useatlas/types";

// Local literal tuple instead of importing the value-export tuple from
// `@useatlas/types`. The template scaffold installs `@useatlas/types`
// from the registry — adding a new value export forces a publish-first
// merge dance for every PR (#useatlas/types-scaffold-gotcha). The
// `satisfies` constraint pins this tuple to the same union as the
// canonical `OutboxStatus` so adding a state in
// `@useatlas/types/crm-outbox.ts` fails compile here until both sides match.
//
// Re-exported so consumers reach for the schemas copy (which is
// scaffold-copied as source) rather than the types copy (registry).
export const OUTBOX_STATUSES = [
  "pending",
  "in_flight",
  "done",
  "dead",
] as const satisfies readonly OutboxStatus[];

const OutboxStatusEnum = z.enum(OUTBOX_STATUSES);

export const CrmOutboxRowSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  eventType: z.string(),
  status: OutboxStatusEnum,
  attempts: z.number(),
  lastError: z.string().nullable(),
  twentyPersonId: z.string().nullable(),
  twentyNoteId: z.string().nullable(),
  processedAt: z.string().nullable(),
  retryAfter: z.string().nullable(),
  claimedAt: z.string().nullable(),
}) satisfies z.ZodType<CrmOutboxRow>;

export const CrmOutboxRowDetailSchema = CrmOutboxRowSchema.extend({
  fullLastError: z.string().nullable(),
  payload: z.unknown(),
}) satisfies z.ZodType<CrmOutboxRowDetail>;

export const CrmOutboxListResponseSchema = z.object({
  rows: z.array(CrmOutboxRowSchema),
});
