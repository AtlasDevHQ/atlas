/**
 * Admin migration import route.
 *
 * Mounted under /api/v1/admin/migrate. Receives an export bundle produced by
 * `atlas export` (via the `atlas migrate-import` CLI) and imports workspace
 * data into the active org. Idempotent — re-importing skips data that already
 * exists in the target workspace.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB, type InternalPoolClient } from "@atlas/api/lib/db/internal";
import { EXPORT_BUNDLE_VERSION, type ExportBundle, type ImportResult } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-migrate");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates top-level bundle structure and required fields on each element. */
export function validateBundle(body: unknown): { ok: true; bundle: ExportBundle } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const obj = body as Record<string, unknown>;

  if (!obj.manifest || typeof obj.manifest !== "object") {
    return { ok: false, error: "Missing or invalid 'manifest' field." };
  }

  const manifest = obj.manifest as Record<string, unknown>;
  if (manifest.version !== EXPORT_BUNDLE_VERSION) {
    return { ok: false, error: `Unsupported bundle version: ${String(manifest.version)}. Expected ${EXPORT_BUNDLE_VERSION}.` };
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

  // Validate required fields on each conversation element
  for (let i = 0; i < obj.conversations.length; i++) {
    const c = obj.conversations[i] as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || typeof c.id !== "string" || !Array.isArray(c.messages)) {
      return { ok: false, error: `conversations[${i}]: must have 'id' (string) and 'messages' (array).` };
    }
  }

  // Validate required fields on each semantic entity
  for (let i = 0; i < obj.semanticEntities.length; i++) {
    const e = obj.semanticEntities[i] as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || typeof e.name !== "string" || typeof e.entityType !== "string" || typeof e.yamlContent !== "string") {
      return { ok: false, error: `semanticEntities[${i}]: must have 'name', 'entityType', and 'yamlContent' (strings).` };
    }
  }

  // Validate required fields on each learned pattern
  for (let i = 0; i < obj.learnedPatterns.length; i++) {
    const p = obj.learnedPatterns[i] as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || typeof p.patternSql !== "string") {
      return { ok: false, error: `learnedPatterns[${i}]: must have 'patternSql' (string).` };
    }
  }

  // Validate required fields on each setting
  for (let i = 0; i < obj.settings.length; i++) {
    const s = obj.settings[i] as Record<string, unknown> | null;
    if (!s || typeof s !== "object" || typeof s.key !== "string" || typeof s.value !== "string") {
      return { ok: false, error: `settings[${i}]: must have 'key' and 'value' (strings).` };
    }
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
    "active organization. Idempotent — re-importing skips data that already exists.",
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
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Import logic (runs inside a transaction)
// ---------------------------------------------------------------------------

export async function importBundle(
  client: InternalPoolClient,
  bundle: ExportBundle,
  orgId: string,
): Promise<ImportResult> {
  const result: ImportResult = {
    conversations: { imported: 0, skipped: 0 },
    semanticEntities: { imported: 0, skipped: 0 },
    learnedPatterns: { imported: 0, skipped: 0 },
    settings: { imported: 0, skipped: 0 },
  };

  // --- 1. Conversations + Messages ---
  for (const conv of bundle.conversations) {
    const existing = await client.query(
      "SELECT id FROM conversations WHERE id = $1 AND org_id = $2",
      [conv.id, orgId],
    );

    if (existing.rows.length > 0) {
      result.conversations.skipped++;
      continue;
    }

    await client.query(
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
    );

    for (const msg of conv.messages) {
      await client.query(
        `INSERT INTO messages (id, conversation_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [msg.id, conv.id, msg.role, JSON.stringify(msg.content), msg.createdAt],
      );
    }

    result.conversations.imported++;
  }

  // --- 2. Semantic Entities ---
  for (const entity of bundle.semanticEntities) {
    const existing = await client.query(
      "SELECT id FROM semantic_entities WHERE org_id = $1 AND entity_type = $2 AND name = $3",
      [orgId, entity.entityType, entity.name],
    );

    if (existing.rows.length > 0) {
      result.semanticEntities.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO semantic_entities (org_id, entity_type, name, yaml_content, connection_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, entity.entityType, entity.name, entity.yamlContent, entity.connectionId],
    );
    result.semanticEntities.imported++;
  }

  // --- 3. Learned Patterns ---
  for (const pattern of bundle.learnedPatterns) {
    const existing = await client.query(
      "SELECT id FROM learned_patterns WHERE org_id = $1 AND pattern_sql = $2",
      [orgId, pattern.patternSql],
    );

    if (existing.rows.length > 0) {
      result.learnedPatterns.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO learned_patterns (org_id, pattern_sql, description, source_entity, confidence, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, pattern.patternSql, pattern.description, pattern.sourceEntity, pattern.confidence, pattern.status],
    );
    result.learnedPatterns.imported++;
  }

  // --- 4. Settings ---
  for (const setting of bundle.settings) {
    // Skip if key already exists (don't override target workspace settings)
    const existing = await client.query(
      "SELECT key FROM settings WHERE key = $1 AND org_id = $2",
      [setting.key, orgId],
    );

    if (existing.rows.length > 0) {
      result.settings.skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO settings (key, value, org_id)
       VALUES ($1, $2, $3)`,
      [setting.key, setting.value, orgId],
    );
    result.settings.imported++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminMigrate = createAdminRouter();
adminMigrate.use(requireOrgContext());

adminMigrate.openapi(importRoute, async (c) => {
  const { orgId } = c.get("orgContext");
  const requestId = c.get("requestId") as string;

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

  // Run entire import inside a transaction for atomicity
  const pool = getInternalDB();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await importBundle(client, bundle, orgId);
    await client.query("COMMIT");

    log.info({ requestId, orgId, result }, "Migration import complete");
    return c.json(result, 200);
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      log.warn({ err: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)), requestId }, "Rollback failed");
    });
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Migration import failed, rolled back");
    return c.json({ error: "import_failed", message: `Import failed — all changes rolled back. ${detail}`, requestId }, 500);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Internal import endpoint — for cross-region migration (service-to-service)
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { createHash, timingSafeEqual } from "crypto";

/** Timing-safe string comparison — prevents timing attacks on secret values. */
function timingSafeCompare(a: string, b: string): boolean {
  const aHash = createHash("sha256").update(a).digest();
  const bHash = createHash("sha256").update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

/**
 * Internal import router — accepts ATLAS_INTERNAL_SECRET for auth instead of
 * admin session auth. Used by the migration executor to transfer workspace
 * data between regional API instances.
 *
 * POST /api/v1/internal/migrate/import
 *   Headers: X-Atlas-Internal-Token: <ATLAS_INTERNAL_SECRET>
 *   Body: { orgId: string, ...ExportBundle }
 */
export const internalMigrate = new Hono();

internalMigrate.post("/import", async (c) => {
  const requestId = crypto.randomUUID();
  const token = c.req.header("X-Atlas-Internal-Token");
  const secret = process.env.ATLAS_INTERNAL_SECRET;

  if (!secret) {
    log.error({ requestId }, "ATLAS_INTERNAL_SECRET not configured — internal import unavailable");
    return c.json({ error: "not_configured", message: "Internal import is not configured.", requestId }, 503);
  }

  if (!token || !timingSafeCompare(token, secret)) {
    log.warn({ requestId }, "Invalid internal token on cross-region import attempt");
    return c.json({ error: "unauthorized", message: "Invalid internal token.", requestId }, 401);
  }

  const body = await c.req.json() as Record<string, unknown>;
  const orgId = body.orgId;
  if (!orgId || typeof orgId !== "string") {
    return c.json({ error: "bad_request", message: "Missing 'orgId' in request body.", requestId }, 400);
  }

  // Validate the bundle (orgId is separate from bundle payload)
  const validation = validateBundle(body);
  if (!validation.ok) {
    return c.json({ error: "bad_request", message: validation.error, requestId }, 400);
  }

  const { bundle } = validation;
  log.info(
    { requestId, orgId, source: bundle.manifest.source.label, counts: bundle.manifest.counts },
    "Starting internal cross-region import",
  );

  const pool = getInternalDB();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await importBundle(client, bundle, orgId);
    await client.query("COMMIT");

    log.info({ requestId, orgId, result }, "Internal cross-region import complete");
    return c.json(result, 200);
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      log.warn({ err: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)), requestId }, "Rollback failed");
    });
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Internal import failed, rolled back");
    return c.json({ error: "import_failed", message: `Import failed — all changes rolled back. ${detail}`, requestId }, 500);
  } finally {
    client.release();
  }
});
