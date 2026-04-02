/**
 * Admin migration import route.
 *
 * Mounted under /api/v1/admin/migrate. Receives an export bundle from
 * `atlas migrate-import` and imports workspace data into the active org.
 * Idempotent — re-importing skips conversations that already exist.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";
import type {
  ExportBundle,
  ExportedConversation,
  ExportedSemanticEntity,
  ExportedLearnedPattern,
  ExportedSetting,
  ImportResult,
} from "@useatlas/types";

const log = createLogger("admin-migrate");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateBundle(body: unknown): { ok: true; bundle: ExportBundle } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const obj = body as Record<string, unknown>;

  if (!obj.manifest || typeof obj.manifest !== "object") {
    return { ok: false, error: "Missing or invalid 'manifest' field." };
  }

  const manifest = obj.manifest as Record<string, unknown>;
  if (manifest.version !== 1) {
    return { ok: false, error: `Unsupported bundle version: ${String(manifest.version)}. Expected 1.` };
  }

  if (!Array.isArray(obj.conversations)) {
    return { ok: false, error: "Missing or invalid 'conversations' field. Expected an array." };
  }
  if (!Array.isArray(obj.semanticEntities)) {
    return { ok: false, error: "Missing or invalid 'semanticEntities' field. Expected an array." };
  }
  if (!Array.isArray(obj.learnedPatterns)) {
    return { ok: false, error: "Missing or invalid 'learnedPatterns' field. Expected an array." };
  }
  if (!Array.isArray(obj.settings)) {
    return { ok: false, error: "Missing or invalid 'settings' field. Expected an array." };
  }

  return { ok: true, bundle: obj as unknown as ExportBundle };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ImportResultSchema = z.object({
  conversations: z.object({ imported: z.number(), skipped: z.number() }),
  semanticEntities: z.object({ imported: z.number(), skipped: z.number() }),
  learnedPatterns: z.object({ imported: z.number(), skipped: z.number() }),
  settings: z.object({ imported: z.number(), skipped: z.number() }),
});

const importRoute = createRoute({
  method: "post",
  path: "/import",
  tags: ["Admin — Migration"],
  summary: "Import a migration bundle",
  description:
    "Receives an export bundle from `atlas export` and imports workspace data " +
    "(conversations, semantic entities, learned patterns, settings) into the " +
    "active organization. Idempotent — re-importing skips existing conversations.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            manifest: z.object({
              version: z.number(),
              exportedAt: z.string(),
              source: z.object({
                label: z.string(),
                apiUrl: z.string().optional(),
              }),
              counts: z.object({
                conversations: z.number(),
                messages: z.number(),
                semanticEntities: z.number(),
                learnedPatterns: z.number(),
                settings: z.number(),
              }),
            }),
            conversations: z.array(z.unknown()),
            semanticEntities: z.array(z.unknown()),
            learnedPatterns: z.array(z.unknown()),
            settings: z.array(z.unknown()),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Import summary with imported/skipped counts",
      content: { "application/json": { schema: ImportResultSchema } },
    },
    400: {
      description: "Invalid bundle format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminMigrate = createAdminRouter();
adminMigrate.use(requireOrgContext());

adminMigrate.openapi(importRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = c.get("orgContext");
      const requestId = c.get("requestId");

      // Validate bundle structure
      const body = c.req.valid("json");
      const validation = validateBundle(body);
      if (!validation.ok) {
        return c.json({ error: "bad_request", message: validation.error, requestId }, 400);
      }

      const { bundle } = validation;
      log.info(
        {
          requestId,
          orgId,
          source: bundle.manifest.source.label,
          counts: bundle.manifest.counts,
        },
        "Starting migration import",
      );

      const result: ImportResult = {
        conversations: { imported: 0, skipped: 0 },
        semanticEntities: { imported: 0, skipped: 0 },
        learnedPatterns: { imported: 0, skipped: 0 },
        settings: { imported: 0, skipped: 0 },
      };

      // --- 1. Conversations + Messages ---
      for (const conv of bundle.conversations as ExportedConversation[]) {
        // Check if conversation already exists (idempotent by original ID)
        const existing = yield* Effect.promise(() =>
          internalQuery<{ id: string }>(
            "SELECT id FROM conversations WHERE id = $1 AND org_id = $2",
            [conv.id, orgId],
          ),
        );

        if (existing.length > 0) {
          result.conversations.skipped++;
          continue;
        }

        // Insert conversation
        yield* Effect.promise(() =>
          internalQuery<Record<string, unknown>>(
            `INSERT INTO conversations (id, user_id, title, surface, connection_id, starred, created_at, updated_at, org_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              conv.id,
              conv.userId,
              conv.title,
              conv.surface ?? "web",
              conv.connectionId,
              conv.starred ?? false,
              conv.createdAt,
              conv.updatedAt,
              orgId,
            ],
          ),
        );

        // Insert messages
        for (const msg of conv.messages) {
          yield* Effect.promise(() =>
            internalQuery<Record<string, unknown>>(
              `INSERT INTO messages (id, conversation_id, role, content, created_at)
               VALUES ($1, $2, $3, $4, $5)`,
              [msg.id, conv.id, msg.role, JSON.stringify(msg.content), msg.createdAt],
            ),
          );
        }

        result.conversations.imported++;
      }

      // --- 2. Semantic Entities ---
      for (const entity of bundle.semanticEntities as ExportedSemanticEntity[]) {
        // Check if entity already exists by (org, type, name)
        const existing = yield* Effect.promise(() =>
          internalQuery<{ id: string }>(
            "SELECT id FROM semantic_entities WHERE org_id = $1 AND entity_type = $2 AND name = $3",
            [orgId, entity.entityType, entity.name],
          ),
        );

        if (existing.length > 0) {
          result.semanticEntities.skipped++;
          continue;
        }

        yield* Effect.promise(() =>
          internalQuery<Record<string, unknown>>(
            `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [orgId, entity.entityType, entity.name, entity.yamlContent, entity.connectionId],
          ),
        );
        result.semanticEntities.imported++;
      }

      // --- 3. Learned Patterns ---
      for (const pattern of bundle.learnedPatterns as ExportedLearnedPattern[]) {
        // Check if pattern with identical SQL already exists
        const existing = yield* Effect.promise(() =>
          internalQuery<{ id: string }>(
            "SELECT id FROM learned_patterns WHERE org_id = $1 AND pattern_sql = $2",
            [orgId, pattern.patternSql],
          ),
        );

        if (existing.length > 0) {
          result.learnedPatterns.skipped++;
          continue;
        }

        yield* Effect.promise(() =>
          internalQuery<Record<string, unknown>>(
            `INSERT INTO learned_patterns (org_id, pattern_sql, description, source_entity, confidence, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [orgId, pattern.patternSql, pattern.description, pattern.sourceEntity, pattern.confidence, pattern.status],
          ),
        );
        result.learnedPatterns.imported++;
      }

      // --- 4. Settings ---
      for (const setting of bundle.settings as ExportedSetting[]) {
        // Upsert: skip if already set (don't override target workspace settings)
        const existing = yield* Effect.promise(() =>
          internalQuery<{ key: string }>(
            "SELECT key FROM settings WHERE key = $1 AND org_id = $2",
            [setting.key, orgId],
          ),
        );

        if (existing.length > 0) {
          result.settings.skipped++;
          continue;
        }

        yield* Effect.promise(() =>
          internalQuery<Record<string, unknown>>(
            `INSERT INTO settings (key, value, org_id)
             VALUES ($1, $2, $3)`,
            [setting.key, setting.value, orgId],
          ),
        );
        result.settings.imported++;
      }

      log.info({ requestId, orgId, result }, "Migration import complete");
      return c.json(result, 200);
    }),
    { label: "migrate import" },
  );
});
