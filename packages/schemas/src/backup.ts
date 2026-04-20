/**
 * Backup wire-format schemas.
 *
 * Single source of truth for the platform backups surface
 * (`/api/v1/platform/backups` and `/config`) — used by both route-layer
 * OpenAPI validation and web-layer response parsing via `useAdminFetch`.
 *
 * Before #1648, the route copy pinned `status` to `z.enum(BACKUP_STATUSES)`
 * while the web copy silently relaxed it to `z.string()`. The status
 * column is the drift-prone part of the shape — a new state introduced
 * in `@atlas/ee/backups` would have passed the web parse untyped and
 * failed silently in `BackupsTable`. Pinning here closes that gap.
 *
 * The `BACKUP_STATUSES` tuple comes from `@useatlas/types` so adding a
 * new status propagates without a second edit.
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
  BACKUP_STATUSES,
  type BackupEntry,
  type BackupConfig,
} from "@useatlas/types";

const BackupStatusEnum = z.enum(BACKUP_STATUSES);

export const BackupEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  sizeBytes: z.number().nullable(),
  status: BackupStatusEnum,
  storagePath: z.string(),
  retentionExpiresAt: z.string(),
  errorMessage: z.string().nullable(),
}) satisfies z.ZodType<BackupEntry>;

export const BackupConfigSchema = z.object({
  schedule: z.string(),
  retentionDays: z.number(),
  storagePath: z.string(),
}) satisfies z.ZodType<BackupConfig>;
