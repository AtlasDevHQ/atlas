/**
 * Platform backup routes — automated backups and disaster recovery.
 *
 * Mounted at /api/v1/platform/backups. All routes require `platform_admin` role.
 *
 * Provides:
 * - GET    /              — list backups with status, size, age
 * - POST   /              — trigger manual backup
 * - POST   /:id/verify    — verify backup integrity
 * - POST   /:id/restore   — request restore (returns confirmation token)
 * - POST   /:id/restore/confirm — execute restore with confirmation token
 * - GET    /config        — current schedule and retention config
 * - PUT    /config        — update schedule/retention
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
} from "@atlas/api/lib/effect/services";
import { BACKUP_STATUSES } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("platform-backups");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BackupEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  sizeBytes: z.number().nullable(),
  status: z.enum(BACKUP_STATUSES),
  storagePath: z.string(),
  retentionExpiresAt: z.string(),
  errorMessage: z.string().nullable(),
});

const BackupConfigSchema = z.object({
  schedule: z.string().openapi({ description: "Cron expression for automated backups", example: "0 3 * * *" }),
  retentionDays: z.number().min(1).max(365).openapi({ description: "Days to retain backups", example: 30 }),
  storagePath: z.string().openapi({ description: "Backup storage path", example: "./backups" }),
});

const CRON_5_FIELD = /^(\*|[\d,\-/]+)(\s+(\*|[\d,\-/]+)){4}$/;

const UpdateConfigSchema = z.object({
  schedule: z.string().regex(CRON_5_FIELD, "Invalid cron expression — must be 5 space-separated fields").optional().openapi({ description: "Cron expression", example: "0 3 * * *" }),
  retentionDays: z.number().min(1).max(365).optional().openapi({ description: "Retention days", example: 30 }),
  storagePath: z.string().refine((p) => !p.includes(".."), "Path must not contain '..'").optional().openapi({ description: "Storage path", example: "./backups" }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listBackupsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Platform Admin — Backups"],
  summary: "List backups",
  description: "SaaS only. Returns all backups with status, size, and retention info.",
  responses: {
    200: {
      description: "Backups list",
      content: { "application/json": { schema: z.object({ backups: z.array(BackupEntrySchema) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createBackupRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Platform Admin — Backups"],
  summary: "Create manual backup",
  description: "SaaS only. Trigger an immediate backup of the internal database.",
  responses: {
    200: {
      description: "Backup created",
      content: { "application/json": { schema: z.object({ message: z.string(), backup: BackupEntrySchema }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const verifyBackupRoute = createRoute({
  method: "post",
  path: "/{id}/verify",
  tags: ["Platform Admin — Backups"],
  summary: "Verify backup integrity",
  description: "SaaS only. Decompress and validate the pg_dump header of a backup file.",
  responses: {
    200: {
      description: "Verification result",
      content: { "application/json": { schema: z.object({ verified: z.boolean(), message: z.string() }) } },
    },
    400: { description: "Backup not in verifiable state", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled or backup not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const requestRestoreRoute = createRoute({
  method: "post",
  path: "/{id}/restore",
  tags: ["Platform Admin — Backups"],
  summary: "Request backup restore",
  description: "SaaS only. Returns a confirmation token that must be passed to the confirm endpoint. The confirm step creates a pre-restore backup automatically before restoring.",
  responses: {
    200: {
      description: "Confirmation token",
      content: { "application/json": { schema: z.object({ confirmationToken: z.string(), message: z.string() }) } },
    },
    400: { description: "Backup not in restorable state", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled or backup not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const confirmRestoreRoute = createRoute({
  method: "post",
  path: "/{id}/restore/confirm",
  tags: ["Platform Admin — Backups"],
  summary: "Confirm and execute restore",
  description: "SaaS only. Execute the restore operation using the confirmation token from the request endpoint.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ confirmationToken: z.string().openapi({ description: "Token from restore request" }) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Restore completed",
      content: { "application/json": { schema: z.object({ restored: z.boolean(), preRestoreBackupId: z.string(), message: z.string() }) } },
    },
    400: { description: "Invalid or expired token", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getConfigRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Platform Admin — Backups"],
  summary: "Get backup configuration",
  description: "SaaS only. Returns the current backup schedule, retention policy, and storage path.",
  responses: {
    200: {
      description: "Current configuration",
      content: { "application/json": { schema: BackupConfigSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateConfigRoute = createRoute({
  method: "put",
  path: "/config",
  tags: ["Platform Admin — Backups"],
  summary: "Update backup configuration",
  description: "SaaS only. Update the backup schedule, retention policy, or storage path.",
  request: { body: { required: true, content: { "application/json": { schema: UpdateConfigSchema } } } },
  responses: {
    200: {
      description: "Configuration updated",
      content: { "application/json": { schema: z.object({ message: z.string(), config: BackupConfigSchema }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Lazy import — ee module may not be installed
// ---------------------------------------------------------------------------

type BackupsModule = typeof import("@atlas/ee/backups/index");

async function loadBackups(): Promise<BackupsModule | null> {
  try {
    return await import("@atlas/ee/backups/index");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      return null;
    }
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load backups module — unexpected error",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBackupEntry(row: {
  id: string;
  created_at: string;
  size_bytes: string | null;
  status: string;
  storage_path: string;
  retention_expires_at: string;
  error_message: string | null;
}) {
  return {
    id: row.id,
    createdAt: row.created_at,
    sizeBytes: row.size_bytes ? parseInt(row.size_bytes, 10) : null,
    status: row.status as "in_progress" | "completed" | "failed" | "verified",
    storagePath: row.storage_path,
    retentionExpiresAt: row.retention_expires_at,
    errorMessage: row.error_message,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformBackups = createPlatformRouter();

// ── List backups ─────────────────────────────────────────────────────

platformBackups.openapi(listBackupsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const backups = yield* Effect.promise(() => loadBackups());
    if (!backups) {
      return c.json({ error: "not_available", message: "Backups require enterprise features to be enabled.", requestId }, 404);
    }

    const rows = yield* backups.listBackups(100);
    return c.json({ backups: rows.map(toBackupEntry) }, 200);
  }), { label: "list backups" });
});

// ── Create backup ────────────────────────────────────────────────────

platformBackups.openapi(createBackupRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const backupsMod = yield* Effect.promise(() => loadBackups());
    if (!backupsMod) {
      return c.json({ error: "not_available", message: "Backups require enterprise features to be enabled.", requestId }, 404);
    }

    const result = yield* backupsMod.createBackup();
    log.info({ backupId: result.id, requestId }, "Manual backup created by platform admin");

    logAdminAction({
      actionType: ADMIN_ACTIONS.backup.create,
      targetType: "backup",
      targetId: result.id,
      scope: "platform",
      metadata: { backupId: result.id },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    const row = yield* backupsMod.getBackupById(result.id);
    const backup = row ? toBackupEntry(row) : {
      id: result.id,
      createdAt: new Date().toISOString(),
      sizeBytes: result.sizeBytes,
      status: result.status,
      storagePath: result.storagePath,
      retentionExpiresAt: new Date().toISOString(),
      errorMessage: null,
    };
    return c.json({ message: "Backup created successfully.", backup }, 200);
  }), { label: "create backup" });
});

// ── Verify backup ────────────────────────────────────────────────────

platformBackups.openapi(verifyBackupRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const backupsMod = yield* Effect.promise(() => loadBackups());
    if (!backupsMod) {
      return c.json({ error: "not_available", message: "Backups require enterprise features to be enabled.", requestId }, 404);
    }

    const backupId = c.req.param("id");

    const verifyResult = yield* backupsMod.verifyBackup(backupId).pipe(Effect.either);
    if (verifyResult._tag === "Left") {
      const message = verifyResult.left.message;
      if (message.includes("not found")) {
        return c.json({ error: "not_found", message: "Backup not found.", requestId }, 404);
      }
      if (message.includes("Cannot verify")) {
        return c.json({ error: "invalid_state", message, requestId }, 400);
      }
      throw verifyResult.left;
    }
    log.info({ backupId, verified: verifyResult.right.verified, requestId }, "Backup verification completed");

    logAdminAction({
      actionType: ADMIN_ACTIONS.backup.verify,
      targetType: "backup",
      targetId: backupId,
      scope: "platform",
      metadata: { verified: verifyResult.right.verified, message: verifyResult.right.message },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json(verifyResult.right, 200);
  }), { label: "verify backup" });
});

// ── Request restore ──────────────────────────────────────────────────

platformBackups.openapi(requestRestoreRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const backupsMod = yield* Effect.promise(() => loadBackups());
    if (!backupsMod) {
      return c.json({ error: "not_available", message: "Backups require enterprise features to be enabled.", requestId }, 404);
    }

    const backupId = c.req.param("id");

    const restoreResult = yield* backupsMod.requestRestore(backupId).pipe(Effect.either);
    if (restoreResult._tag === "Left") {
      const message = restoreResult.left.message;
      if (message.includes("not found")) {
        return c.json({ error: "not_found", message: "Backup not found.", requestId }, 404);
      }
      if (message.includes("Cannot restore")) {
        return c.json({ error: "invalid_state", message, requestId }, 400);
      }
      throw restoreResult.left;
    }
    log.warn({ backupId, requestId }, "Restore requested by platform admin");

    logAdminAction({
      actionType: ADMIN_ACTIONS.backup.requestRestore,
      targetType: "backup",
      targetId: backupId,
      scope: "platform",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json(restoreResult.right, 200);
  }), { label: "request restore" });
});

// ── Confirm restore ──────────────────────────────────────────────────

platformBackups.openapi(confirmRestoreRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const backupsMod = yield* Effect.promise(() => loadBackups());
    if (!backupsMod) {
      return c.json({ error: "not_available", message: "Backups require enterprise features to be enabled.", requestId }, 404);
    }

    const body = c.req.valid("json");

    return yield* backupsMod.executeRestore(body.confirmationToken).pipe(
      Effect.map((result) => {
        log.warn({ backupId: c.req.param("id"), preRestoreBackupId: result.preRestoreBackupId, requestId }, "Database restore executed by platform admin");

        logAdminAction({
          actionType: ADMIN_ACTIONS.backup.confirmRestore,
          targetType: "backup",
          targetId: c.req.param("id"),
          scope: "platform",
          metadata: { preRestoreBackupId: result.preRestoreBackupId },
          ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        });

        return c.json(result, 200);
      }),
      Effect.catchAll((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Invalid or expired") || message.includes("expired")) {
          return Effect.succeed(c.json({ error: "invalid_token", message, requestId }, 400));
        }
        return Effect.die(err);
      }),
    );
  }), { label: "execute restore" });
});

// ── Get config ───────────────────────────────────────────────────────

platformBackups.openapi(getConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const backupsMod = yield* Effect.promise(() => loadBackups());
    if (!backupsMod) {
      return c.json({ error: "not_available", message: "Backups require enterprise features to be enabled.", requestId }, 404);
    }

    const config = yield* backupsMod.getBackupConfig();
    return c.json({
      schedule: config.schedule,
      retentionDays: config.retention_days,
      storagePath: config.storage_path,
    }, 200);
  }), { label: "read backup config" });
});

// ── Update config ────────────────────────────────────────────────────

platformBackups.openapi(updateConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const backupsMod = yield* Effect.promise(() => loadBackups());
    if (!backupsMod) {
      return c.json({ error: "not_available", message: "Backups require enterprise features to be enabled.", requestId }, 404);
    }

    const body = c.req.valid("json");

    const oldConfig = yield* backupsMod.getBackupConfig();
    yield* backupsMod.updateBackupConfig(body);
    const config = yield* backupsMod.getBackupConfig();
    log.info({ config, requestId }, "Backup config updated by platform admin");

    logAdminAction({
      actionType: ADMIN_ACTIONS.backup.updateConfig,
      targetType: "backup",
      targetId: "config",
      scope: "platform",
      metadata: {
        previousConfig: {
          schedule: oldConfig.schedule,
          retentionDays: oldConfig.retention_days,
          storagePath: oldConfig.storage_path,
        },
        newConfig: {
          schedule: config.schedule,
          retentionDays: config.retention_days,
          storagePath: config.storage_path,
        },
      },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({
      message: "Configuration updated.",
      config: {
        schedule: config.schedule,
        retentionDays: config.retention_days,
        storagePath: config.storage_path,
      },
    }, 200);
  }), { label: "update backup config" });
});

export { platformBackups };
