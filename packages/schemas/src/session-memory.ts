/**
 * Durable session-memory wire schemas (#3758, ADR-0020) — SSOT for the API
 * route validation + web response parsing of the read/reset affordance.
 *
 * Uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) so a field drifting from
 * the `@useatlas/types` shape is a compile error. Timestamp fields go through
 * `IsoTimestampSchema` (#1697). `value` is an arbitrary JSONB payload, so it
 * stays `z.unknown()`.
 */
import { z } from "zod";
import { IsoTimestampSchema } from "./common";
import type { SessionMemorySlot, SessionMemoryView } from "@useatlas/types";

export const SessionMemorySlotSchema = z.object({
  namespace: z.string(),
  value: z.unknown(),
  updatedAt: IsoTimestampSchema,
}) satisfies z.ZodType<SessionMemorySlot, unknown>;

export const SessionMemoryViewSchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  updatedAt: IsoTimestampSchema,
  slots: z.array(SessionMemorySlotSchema),
}) satisfies z.ZodType<SessionMemoryView, unknown>;

/** Response shape of the admin Session Memory list (`GET /admin/session-memory`). */
export const SessionMemoryListResponseSchema = z.object({
  sessions: z.array(SessionMemoryViewSchema),
});

/** Response shape of the in-conversation memory read (`GET /conversations/{id}/memory`). */
export const SessionMemorySlotsResponseSchema = z.object({
  slots: z.array(SessionMemorySlotSchema),
});

/** Response shape of a reset (`DELETE` on either surface). */
export const SessionMemoryResetResponseSchema = z.object({
  cleared: z.number().int().nonnegative(),
});
