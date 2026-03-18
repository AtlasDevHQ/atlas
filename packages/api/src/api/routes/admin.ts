/**
 * Admin console API routes.
 *
 * Mounted at /api/v1/admin. All routes require admin role.
 * Browsing endpoints are read-only; health-check routes (POST) trigger
 * live probes. Connection CRUD routes persist encrypted URLs via encryptUrl/decryptUrl.
 * Plugin management routes handle enable/disable, config schema, and config updates.
 * User management routes handle roles, bans, and invitations via Better Auth
 * and the internal DB.
 */

import * as fs from "fs";
import * as path from "path";
import { Hono, type Context } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, encryptUrl, decryptUrl } from "@atlas/api/lib/db/internal";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { plugins } from "@atlas/api/lib/plugins/registry";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import { savePluginEnabled, savePluginConfig, getPluginConfig } from "@atlas/api/lib/plugins/settings";
import {
  getSettingsForAdmin,
  getSettingsRegistry,
  setSetting,
  deleteSetting,
} from "@atlas/api/lib/settings";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { ATLAS_ROLES } from "@atlas/api/lib/auth/types";
import {
  getSemanticRoot,
  isValidEntityName,
  readYamlFile,
  discoverEntities,
  findEntityFile,
} from "@atlas/api/lib/semantic-files";
import { runDiff } from "@atlas/api/lib/semantic-diff";
import { adminOrgs } from "./admin-orgs";

const log = createLogger("admin-routes");

/** Known auth error messages that indicate an expired session or token. */
const EXPIRED_AUTH_ERRORS = new Set([
  "Session expired",
  "Session expired (idle timeout)",
  "Invalid or expired token",
  "Session data is invalid",
]);

function authErrorCode(error: string): "session_expired" | "auth_error" {
  return EXPIRED_AUTH_ERRORS.has(error) ? "session_expired" : "auth_error";
}

const admin = new Hono();

// Mount organization management sub-router
admin.route("/organizations", adminOrgs);

// ---------------------------------------------------------------------------
// Admin auth preamble — reuses existing auth then enforces admin role.
// ---------------------------------------------------------------------------

/**
 * Authenticate the request and enforce admin role. Returns either:
 * - `{ error, status, headers? }` on failure (401/403/429/500)
 * - `{ authResult }` on success (authenticated admin user)
 *
 * The `headers` field is only present for 429 rate-limit responses.
 */
async function adminAuthPreamble(req: Request, requestId: string) {
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return { error: { error: "auth_error", message: "Authentication system error" }, status: 500 as const };
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    const code = authErrorCode(authResult.error);
    return { error: { error: code, message: authResult.error }, status: authResult.status as 401 | 403 | 500 };
  }

  // Enforce admin role — when auth mode is "none" (no auth configured, e.g.
  // local dev), treat the request as an implicit admin since there is no
  // identity boundary to enforce.
  if (authResult.mode !== "none" && (!authResult.user || (authResult.user.role !== "admin" && authResult.user.role !== "owner"))) {
    return { error: { error: "forbidden_role", message: "Admin role required." }, status: 403 as const };
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      error: { error: "rate_limited", message: "Too many requests. Please wait before trying again.", retryAfterSeconds },
      status: 429 as const,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  return { authResult };
}

// Path traversal guard, YAML helpers, entity discovery, and file finding
// are all imported from @atlas/api/lib/semantic-files above.

function discoverMetrics(root: string): Array<{ source: string; file: string; data: unknown }> {
  const metrics: Array<{ source: string; file: string; data: unknown }> = [];

  const defaultDir = path.join(root, "metrics");
  if (fs.existsSync(defaultDir)) {
    loadMetricsFromDir(defaultDir, "default", metrics);
  }

  const RESERVED_DIRS = new Set(["entities", "metrics"]);
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subMetrics = path.join(root, entry.name, "metrics");
        if (fs.existsSync(subMetrics)) {
          loadMetricsFromDir(subMetrics, entry.name, metrics);
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to scan semantic root for per-source metrics");
    }
  }

  return metrics;
}

function loadMetricsFromDir(dir: string, source: string, out: Array<{ source: string; file: string; data: unknown }>): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err : new Error(String(err)), dir, source }, "Failed to read metrics directory");
    return;
  }

  for (const file of files) {
    try {
      const raw = readYamlFile(path.join(dir, file));
      out.push({ source, file: file.replace(/\.yml$/, ""), data: raw });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), file, dir, source }, "Failed to parse metric YAML file");
    }
  }
}

/**
 * Load glossary from semantic/glossary.yml and per-source glossaries.
 */
function loadGlossary(root: string): unknown[] {
  const glossaries: unknown[] = [];

  const defaultFile = path.join(root, "glossary.yml");
  if (fs.existsSync(defaultFile)) {
    try {
      glossaries.push({ source: "default", data: readYamlFile(defaultFile) });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), file: defaultFile }, "Failed to parse glossary YAML");
    }
  }

  const RESERVED_DIRS = new Set(["entities", "metrics"]);
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subGlossary = path.join(root, entry.name, "glossary.yml");
        if (fs.existsSync(subGlossary)) {
          try {
            glossaries.push({ source: entry.name, data: readYamlFile(subGlossary) });
          } catch (err) {
            log.warn({ err: err instanceof Error ? err : new Error(String(err)), file: subGlossary, source: entry.name }, "Failed to parse per-source glossary YAML");
          }
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to scan semantic root for per-source glossaries");
    }
  }

  return glossaries;
}

// ---------------------------------------------------------------------------
// GET /overview — Dashboard data
// ---------------------------------------------------------------------------

admin.get("/overview", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const root = getSemanticRoot();
    const { entities, warnings } = discoverEntities(root);
    const metrics = discoverMetrics(root);
    const glossary = loadGlossary(root);
    const connList = connections.describe();
    const pluginList = plugins.describe();

    // Count glossary terms
    let glossaryTermCount = 0;
    for (const g of glossary) {
      const data = (g as { data: unknown }).data;
      if (Array.isArray(data)) glossaryTermCount += data.length;
      else if (data && typeof data === "object") {
        const terms = (data as Record<string, unknown>).terms;
        if (Array.isArray(terms)) glossaryTermCount += terms.length;
      }
    }

    const poolWarnings = connections.getPoolWarnings();

    return c.json({
      connections: connList.length,
      entities: entities.length,
      metrics: metrics.length,
      glossaryTerms: glossaryTermCount,
      plugins: pluginList.length,
      pluginHealth: pluginList.map((p) => ({
        id: p.id,
        name: p.name,
        types: p.types,
        status: p.status,
      })),
      ...(warnings.length > 0 && { warnings }),
      ...(poolWarnings.length > 0 && { poolWarnings }),
    });
  });
});

// ---------------------------------------------------------------------------
// Semantic Layer routes
// ---------------------------------------------------------------------------

// GET /semantic/entities — list all entities
admin.get("/semantic/entities", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const root = getSemanticRoot();
    const result = discoverEntities(root);
    return c.json({
      entities: result.entities,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    });
  });
});

// GET /semantic/entities/:name — full entity detail
admin.get("/semantic/entities/:name", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const name = c.req.param("name");

    // Path traversal protection
    if (!isValidEntityName(name)) {
      log.warn({ requestId, name }, "Rejected invalid entity name");
      return c.json({ error: "invalid_request", message: "Invalid entity name." }, 400);
    }

    const root = getSemanticRoot();
    const filePath = findEntityFile(root, name);
    if (!filePath) {
      return c.json({ error: "not_found", message: `Entity "${name}" not found.` }, 404);
    }

    // Defense-in-depth: verify resolved path is within semantic root
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(root))) {
      log.error({ requestId, name, resolved, root }, "Resolved entity path escaped semantic root");
      return c.json({ error: "forbidden", message: "Access denied." }, 403);
    }

    try {
      const raw = readYamlFile(filePath);
      return c.json({ entity: raw });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), filePath, entityName: name }, "Failed to parse entity YAML file");
      return c.json({ error: "internal_error", message: `Failed to parse entity file for "${name}".` }, 500);
    }
  });
});

// GET /semantic/metrics — list all metrics
admin.get("/semantic/metrics", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const root = getSemanticRoot();
    const metrics = discoverMetrics(root);
    return c.json({ metrics });
  });
});

// GET /semantic/glossary
admin.get("/semantic/glossary", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const root = getSemanticRoot();
    const glossary = loadGlossary(root);
    return c.json({ glossary });
  });
});

// GET /semantic/catalog
admin.get("/semantic/catalog", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const root = getSemanticRoot();
    const catalogFile = path.join(root, "catalog.yml");
    if (!fs.existsSync(catalogFile)) {
      return c.json({ catalog: null });
    }
    try {
      const raw = readYamlFile(catalogFile);
      return c.json({ catalog: raw });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), file: catalogFile }, "Failed to parse catalog YAML");
      return c.json({ error: "internal_error", message: "Failed to parse catalog file." }, 500);
    }
  });
});

// GET /semantic/raw/:file — serve raw YAML for top-level files (catalog.yml, glossary.yml)
// GET /semantic/raw/:dir/:file — serve raw YAML for subdirectory files (entities/x.yml, metrics/x.yml)

function serveRawYaml(c: Context, requestId: string, filePath: string) {
  // Validate: no traversal, must be .yml
  if (filePath.includes("..") || filePath.includes("\0") || filePath.includes("\\") || !filePath.endsWith(".yml")) {
    return c.json({ error: "invalid_request", message: "Invalid file path." }, 400);
  }

  const allowedPattern = /^(catalog|glossary)\.yml$|^(entities|metrics)\/[a-zA-Z0-9_-]+\.yml$/;
  if (!allowedPattern.test(filePath)) {
    return c.json({ error: "invalid_request", message: "File path not allowed." }, 400);
  }

  const root = getSemanticRoot();
  const resolved = path.resolve(root, filePath);
  if (!resolved.startsWith(path.resolve(root))) {
    log.error({ requestId, filePath, resolved, root }, "Raw YAML path escaped semantic root");
    return c.json({ error: "forbidden", message: "Access denied." }, 403);
  }

  if (!fs.existsSync(resolved)) {
    return c.json({ error: "not_found", message: `File "${filePath}" not found.` }, 404);
  }

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    return c.text(content);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), filePath }, "Failed to read raw YAML file");
    return c.json({ error: "internal_error", message: "Failed to read file." }, 500);
  }
}

admin.get("/semantic/raw/:dir/:file", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  const { authResult } = preamble;
  return withRequestContext({ requestId, user: authResult.user }, () => {
    return serveRawYaml(c, requestId, `${c.req.param("dir")}/${c.req.param("file")}`);
  });
});

admin.get("/semantic/raw/:file", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  const { authResult } = preamble;
  return withRequestContext({ requestId, user: authResult.user }, () => {
    return serveRawYaml(c, requestId, c.req.param("file"));
  });
});

// GET /semantic/stats — aggregate stats
admin.get("/semantic/stats", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const root = getSemanticRoot();
    const { entities, warnings } = discoverEntities(root);

    const totalColumns = entities.reduce((sum, e) => sum + e.columnCount, 0);
    const totalJoins = entities.reduce((sum, e) => sum + e.joinCount, 0);
    const totalMeasures = entities.reduce((sum, e) => sum + e.measureCount, 0);

    const noDescription = entities.filter((e) => !e.description.trim()).length;
    const noColumns = entities.filter((e) => e.columnCount === 0).length;
    const noJoins = entities.filter((e) => e.joinCount === 0).length;

    return c.json({
      totalEntities: entities.length,
      totalColumns,
      totalJoins,
      totalMeasures,
      coverageGaps: {
        noDescription,
        noColumns,
        noJoins,
      },
      ...(warnings.length > 0 && { warnings }),
    });
  });
});

// GET /semantic/diff — compare DB schema against YAML entities
admin.get("/semantic/diff", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const connectionId = c.req.query("connection") ?? "default";

    // Validate connection exists
    const registered = connections.list();
    if (!registered.includes(connectionId)) {
      return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
    }

    try {
      const result = await runDiff(connectionId);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), connectionId, requestId },
        "Schema diff failed",
      );
      return c.json({ error: "internal_error", message: `Schema diff failed: ${message}` }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// Org-scoped semantic entity CRUD (DB-backed)
// ---------------------------------------------------------------------------

const VALID_ENTITY_TYPES = new Set(["entity", "metric", "glossary", "catalog"]);

type SemanticEntityType = "entity" | "metric" | "glossary" | "catalog";

function validateEntityType(raw: string | undefined, defaultType: string = "entity"): SemanticEntityType | null {
  const value = raw ?? defaultType;
  return VALID_ENTITY_TYPES.has(value) ? value as SemanticEntityType : null;
}

// GET /semantic/org/entities — list entities for the active org
admin.get("/semantic/org/entities", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
    }

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." }, 501);
    }

    try {
      const { listEntities } = await import("@atlas/api/lib/db/semantic-entities");
      const rawType = c.req.query("type");
      if (rawType && !VALID_ENTITY_TYPES.has(rawType)) {
        return c.json({ error: "bad_request", message: `Invalid type. Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}` }, 400);
      }
      const entityType = rawType as "entity" | "metric" | "glossary" | "catalog" | undefined;
      const rows = await listEntities(orgId, entityType);
      return c.json({
        entities: rows.map((r) => ({
          name: r.name,
          entityType: r.entity_type,
          connectionId: r.connection_id,
          updatedAt: r.updated_at,
        })),
        total: rows.length,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to list org semantic entities");
      return c.json({ error: "internal_error", message: "Failed to list entities." }, 500);
    }
  });
});

// GET /semantic/org/entities/:name — get a single entity
admin.get("/semantic/org/entities/:name", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
    }

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." }, 501);
    }

    const name = c.req.param("name");
    const entityType = validateEntityType(c.req.query("type"));
    if (!entityType) {
      return c.json({ error: "bad_request", message: `Invalid type. Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}` }, 400);
    }
    try {
      const { getEntity } = await import("@atlas/api/lib/db/semantic-entities");
      const row = await getEntity(orgId, entityType, name);
      if (!row) {
        return c.json({ error: "not_found", message: `Entity "${name}" not found.` }, 404);
      }
      return c.json({
        name: row.name,
        entityType: row.entity_type,
        connectionId: row.connection_id,
        yamlContent: row.yaml_content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId, name }, "Failed to get org semantic entity");
      return c.json({ error: "internal_error", message: "Failed to get entity." }, 500);
    }
  });
});

// PUT /semantic/org/entities/:name — create or update an entity
admin.put("/semantic/org/entities/:name", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
    }

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." }, 501);
    }

    const name = c.req.param("name");
    let body: { yamlContent: string; entityType?: string; connectionId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }

    if (!body.yamlContent || typeof body.yamlContent !== "string") {
      return c.json({ error: "bad_request", message: "yamlContent (string) is required." }, 400);
    }

    const entityType = validateEntityType(body.entityType);
    if (!entityType) {
      return c.json({ error: "bad_request", message: `Invalid entityType. Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}` }, 400);
    }

    // Validate YAML is parseable and (for entities) has a table field
    try {
      const yamlMod = await import("js-yaml");
      const parsed = yamlMod.load(body.yamlContent);
      if (entityType === "entity") {
        if (!parsed || typeof parsed !== "object" || !("table" in (parsed as Record<string, unknown>))) {
          return c.json({ error: "bad_request", message: "Entity YAML must contain a 'table' field." }, 400);
        }
      }
    } catch (err) {
      return c.json({ error: "bad_request", message: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    try {
      const { upsertEntity } = await import("@atlas/api/lib/db/semantic-entities");
      const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
      const { syncEntityToDisk } = await import("@atlas/api/lib/semantic-sync");
      await upsertEntity(orgId, entityType, name, body.yamlContent, body.connectionId);
      invalidateOrgWhitelist(orgId);
      await syncEntityToDisk(orgId, name, entityType, body.yamlContent);

      log.info({ requestId, orgId, name, entityType }, "Org semantic entity upserted");
      return c.json({ ok: true, name, entityType });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId, name }, "Failed to upsert org semantic entity");
      return c.json({ error: "internal_error", message: "Failed to save entity." }, 500);
    }
  });
});

// DELETE /semantic/org/entities/:name — delete an entity
admin.delete("/semantic/org/entities/:name", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
    }

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." }, 501);
    }

    const name = c.req.param("name");
    const entityType = validateEntityType(c.req.query("type"));
    if (!entityType) {
      return c.json({ error: "bad_request", message: `Invalid type. Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}` }, 400);
    }
    try {
      const { deleteEntity } = await import("@atlas/api/lib/db/semantic-entities");
      const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
      const { syncEntityDeleteFromDisk } = await import("@atlas/api/lib/semantic-sync");
      const deleted = await deleteEntity(orgId, entityType, name);
      if (!deleted) {
        return c.json({ error: "not_found", message: `Entity "${name}" not found.` }, 404);
      }
      invalidateOrgWhitelist(orgId);
      await syncEntityDeleteFromDisk(orgId, name, entityType);

      log.info({ requestId, orgId, name, entityType }, "Org semantic entity deleted");
      return c.json({ ok: true, name, entityType });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId, name }, "Failed to delete org semantic entity");
      return c.json({ error: "internal_error", message: "Failed to delete entity." }, 500);
    }
  });
});

// POST /semantic/org/import — bulk import from org's disk directory to DB
admin.post("/semantic/org/import", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
    }

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." }, 501);
    }

    let body: { connectionId?: string } = {};
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = await c.req.json();
      } catch (err) {
        return c.json({ error: "bad_request", message: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }, 400);
      }
    }

    try {
      const { importFromDisk } = await import("@atlas/api/lib/semantic-sync");
      const result = await importFromDisk(orgId, {
        connectionId: body.connectionId,
      });

      log.info(
        { requestId, orgId, imported: result.imported, skipped: result.skipped, total: result.total },
        "Org semantic import completed",
      );
      return c.json(result);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to import org semantic entities");
      return c.json({ error: "internal_error", message: "Failed to import entities." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// Connection routes
// ---------------------------------------------------------------------------

// GET /connections — list connections
admin.get("/connections", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const connList = connections.describe();
    return c.json({ connections: connList });
  });
});

// GET /connections/pool — pool metrics for all connections
admin.get("/connections/pool", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const metrics = connections.getAllPoolMetrics();
    return c.json({ metrics });
  });
});

// GET /connections/pool/orgs — org-scoped pool metrics
admin.get("/connections/pool/orgs", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    try {
      const orgId = c.req.query("orgId");
      const metrics = connections.getOrgPoolMetrics(orgId || undefined);
      const config = connections.getOrgPoolConfig();
      return c.json({ metrics, config, orgCount: connections.listOrgs().length });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to retrieve org pool metrics");
      return c.json({ error: "metrics_failed", message: err instanceof Error ? err.message : "Failed to retrieve metrics" }, 500);
    }
  });
});

// POST /connections/pool/orgs/:orgId/drain — drain all pools for an org
admin.post("/connections/pool/orgs/:orgId/drain", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const orgId = c.req.param("orgId");
    try {
      const result = await connections.drainOrg(orgId);
      log.info({ orgId, drained: result.drained, requestId, userId: authResult.user?.id }, "Org pools drained via admin API");
      return c.json(result);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), orgId, requestId }, "Org pool drain failed");
      return c.json({ error: "drain_failed", message: err instanceof Error ? err.message : "Org drain failed" }, 500);
    }
  });
});

// POST /connections/:id/drain — drain and recreate a pool
admin.post("/connections/:id/drain", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");
    if (!connections.has(id)) {
      return c.json({ error: "not_found", message: `Connection "${id}" not found` }, 404);
    }
    try {
      const result = await connections.drain(id);
      if (!result.drained) {
        return c.json({ drained: false, message: result.message }, 409);
      }
      log.info({ connectionId: id, requestId, userId: authResult.user?.id }, "Pool drained via admin API");
      return c.json({ drained: true, message: result.message });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id, requestId }, "Pool drain failed");
      return c.json({ error: "drain_failed", message: err instanceof Error ? err.message : "Drain failed" }, 500);
    }
  });
});

// GET /cache/stats — cache hit/miss statistics
admin.get("/cache/stats", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const { getCache, cacheEnabled } = await import("@atlas/api/lib/cache/index");
  return withRequestContext({ requestId, user: authResult.user }, () => {
    if (!cacheEnabled()) {
      return c.json({ enabled: false, hits: 0, misses: 0, hitRate: 0, missRate: 0, entryCount: 0, maxSize: 0, ttl: 0 });
    }
    try {
      const stats = getCache().stats();
      const total = stats.hits + stats.misses;
      const hitRate = total > 0 ? stats.hits / total : 0;
      const missRate = total > 0 ? stats.misses / total : 0;
      return c.json({ enabled: true, ...stats, hitRate, missRate });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to retrieve cache stats");
      return c.json({ error: "internal_error", message: "Failed to retrieve cache statistics." }, 500);
    }
  });
});

// POST /cache/flush — flush all cache entries
admin.post("/cache/flush", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const { getCache, flushCache, cacheEnabled } = await import("@atlas/api/lib/cache/index");
  return withRequestContext({ requestId, user: authResult.user }, () => {
    if (!cacheEnabled()) {
      return c.json({ ok: false, flushed: 0, message: "Cache is disabled" });
    }
    try {
      const count = getCache().stats().entryCount;
      flushCache();
      log.info({ requestId, userId: authResult.user?.id, flushed: count }, "Cache flushed via admin API");
      return c.json({ ok: true, flushed: count, message: "Cache flushed" });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to flush cache");
      return c.json({ error: "internal_error", message: "Failed to flush cache." }, 500);
    }
  });
});

// POST /connections/test — test a connection URL without persisting
admin.post("/connections/test", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const body = await c.req.json().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in test connection request");
      return null;
    });
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required." }, 400);
    }

    const { url, schema } = body as Record<string, unknown>;
    if (!url || typeof url !== "string") {
      return c.json({ error: "invalid_request", message: "Connection URL is required." }, 400);
    }

    let dbType: string;
    try {
      dbType = detectDBType(url);
    } catch (err) {
      return c.json({ error: "invalid_request", message: err instanceof Error ? err.message : "Unsupported database URL scheme." }, 400);
    }

    // Register a temporary connection, test it, then always clean up
    const tempId = `_test_${Date.now()}`;
    try {
      connections.register(tempId, {
        url,
        description: undefined,
        schema: typeof schema === "string" ? schema : undefined,
      });
      const result = await connections.healthCheck(tempId);
      return c.json({ status: result.status, latencyMs: result.latencyMs, dbType });
    } catch (err) {
      return c.json({
        error: "connection_failed",
        message: `Connection test failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      }, 400);
    } finally {
      // _test_ prefix won't match the "default" guard — safe to force-delete
      const entry = connections.has(tempId);
      if (entry) {
        // Use internal delete to bypass the default-connection guard (which won't trigger anyway for _test_ IDs)
        connections.unregister(tempId);
      }
    }
  });
});

// POST /connections/:id/test — health check a connection
admin.post("/connections/:id/test", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");
    const registered = connections.list();
    if (!registered.includes(id)) {
      return c.json({ error: "not_found", message: `Connection "${id}" not found.` }, 404);
    }
    try {
      const result = await connections.healthCheck(id);
      return c.json(result);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id }, "Health check failed");
      return c.json({ error: "internal_error", message: "Health check failed." }, 500);
    }
  });
});

// POST /connections — create a new connection
admin.post("/connections", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL)." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const body = await c.req.json().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in create connection request");
      return null;
    });

    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required." }, 400);
    }

    const { id, url, description, schema } = body as Record<string, unknown>;

    if (!id || typeof id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(id)) {
      return c.json({ error: "invalid_request", message: "Connection ID must be lowercase alphanumeric with hyphens/underscores (e.g. 'warehouse')." }, 400);
    }
    if (id === "default") {
      return c.json({ error: "invalid_request", message: "Cannot create a connection with ID 'default'. The default connection is managed via ATLAS_DATASOURCE_URL." }, 400);
    }
    if (!url || typeof url !== "string") {
      return c.json({ error: "invalid_request", message: "Connection URL is required." }, 400);
    }

    // Detect database type (validates URL scheme)
    let dbType: string;
    try {
      dbType = detectDBType(url as string);
    } catch (err) {
      return c.json({ error: "invalid_request", message: err instanceof Error ? err.message : "Unsupported database URL scheme." }, 400);
    }

    // Check for duplicate
    if (connections.has(id as string)) {
      return c.json({ error: "conflict", message: `Connection "${id}" already exists.` }, 409);
    }

    // Test the connection before saving
    try {
      connections.register(id as string, {
        url: url as string,
        description: typeof description === "string" ? description : undefined,
        schema: typeof schema === "string" ? schema : undefined,
      });
      await connections.healthCheck(id as string);
    } catch (err) {
      // Rollback the registration if the health check fails
      connections.unregister(id as string);
      return c.json({
        error: "connection_failed",
        message: `Connection test failed: ${err instanceof Error ? err.message : "Unknown error"}. Fix the URL and try again.`,
      }, 400);
    }

    // Encrypt and persist to internal DB
    let encryptedUrl: string;
    try {
      encryptedUrl = encryptUrl(url as string);
    } catch (err) {
      connections.unregister(id as string);
      log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to encrypt connection URL");
      return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET." }, 500);
    }

    try {
      await internalQuery(
        `INSERT INTO connections (id, url, type, description, schema_name) VALUES ($1, $2, $3, $4, $5)`,
        [id, encryptedUrl, dbType, typeof description === "string" ? description : null, typeof schema === "string" ? schema : null],
      );
    } catch (err) {
      connections.unregister(id as string);
      log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id }, "Failed to persist connection");
      return c.json({ error: "internal_error", message: "Failed to save connection." }, 500);
    }

    // Rebuild whitelist for new connection
    _resetWhitelists();

    log.info({ requestId, connectionId: id, dbType, actorId: authResult.user?.id }, "Connection created");
    return c.json({
      id,
      dbType,
      description: typeof description === "string" ? description : null,
      maskedUrl: maskConnectionUrl(url as string),
    }, 201);
  });
});

// PUT /connections/:id — update connection config
admin.put("/connections/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL)." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");

    if (id === "default") {
      return c.json({ error: "forbidden", message: "Cannot modify the default connection. Update ATLAS_DATASOURCE_URL instead." }, 403);
    }

    // Check it exists in the DB (admin-managed), not just in the registry
    const existing = await internalQuery<{ id: string; url: string; type: string; description: string | null; schema_name: string | null }>(
      "SELECT id, url, type, description, schema_name FROM connections WHERE id = $1",
      [id],
    );
    if (existing.length === 0) {
      return c.json({ error: "not_found", message: `Connection "${id}" not found or is not admin-managed.` }, 404);
    }

    const body = await c.req.json().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in update connection request");
      return null;
    });

    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required." }, 400);
    }

    const { url, description, schema } = body as Record<string, unknown>;
    const current = existing[0];

    let currentUrl: string;
    try {
      currentUrl = decryptUrl(current.url);
    } catch (err) {
      log.error({ connectionId: id, err: err instanceof Error ? err.message : String(err) }, "Failed to decrypt stored connection URL");
      return c.json({ error: "decryption_failed", message: "Stored connection URL could not be decrypted. The encryption key may have changed." }, 500);
    }

    const newUrl = typeof url === "string" ? url : currentUrl;
    const newDescription = typeof description === "string" ? description : current.description;
    const newSchema = typeof schema === "string" ? (schema || null) : current.schema_name;
    const urlChanged = typeof url === "string" && url !== currentUrl;

    // Validate new URL scheme if changed
    let dbType = current.type;
    if (urlChanged) {
      try {
        dbType = detectDBType(newUrl);
      } catch (err) {
        return c.json({ error: "invalid_request", message: err instanceof Error ? err.message : "Unsupported database URL scheme." }, 400);
      }
    }

    // Re-test if URL changed
    if (urlChanged) {
      try {
        connections.register(id, {
          url: newUrl,
          description: newDescription ?? undefined,
          schema: newSchema ?? undefined,
        });
        await connections.healthCheck(id);
      } catch (err) {
        // Restore old connection
        try {
          connections.register(id, {
            url: currentUrl,
            description: current.description ?? undefined,
            schema: current.schema_name ?? undefined,
          });
        } catch (restoreErr) {
          log.error({ connectionId: id, err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) }, "Failed to restore previous connection after update failure — connection unregistered");
          connections.unregister(id);
        }
        return c.json({
          error: "connection_failed",
          message: `Connection test failed: ${err instanceof Error ? err.message : "Unknown error"}. Fix the URL and try again.`,
        }, 400);
      }
    } else {
      // Re-register with updated metadata (no URL change — no need to test)
      try {
        connections.register(id, {
          url: newUrl,
          description: newDescription ?? undefined,
          schema: newSchema ?? undefined,
        });
      } catch (err) {
        log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id }, "Failed to re-register connection with updated metadata");
        return c.json({ error: "internal_error", message: "Failed to update connection." }, 500);
      }
    }

    // Encrypt and update in DB — rollback registry on failure
    let encryptedNewUrl: string;
    try {
      encryptedNewUrl = encryptUrl(newUrl);
    } catch (err) {
      // Restore previous connection in registry
      try {
        connections.register(id, {
          url: currentUrl,
          description: current.description ?? undefined,
          schema: current.schema_name ?? undefined,
        });
      } catch (restoreErr) {
        log.error({ connectionId: id, requestId, err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) }, "Failed to restore previous connection after encryption failure — connection unregistered");
        connections.unregister(id);
      }
      log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to encrypt connection URL");
      return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET." }, 500);
    }

    try {
      await internalQuery(
        `UPDATE connections SET url = $1, type = $2, description = $3, schema_name = $4, updated_at = NOW() WHERE id = $5`,
        [encryptedNewUrl, dbType, newDescription, newSchema, id],
      );
    } catch (err) {
      // Restore old connection in registry to stay in sync with DB
      try {
        connections.register(id, {
          url: currentUrl,
          description: current.description ?? undefined,
          schema: current.schema_name ?? undefined,
        });
      } catch (restoreErr) {
        log.error({ connectionId: id, requestId, err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) }, "Failed to restore previous connection after DB update failure — connection unregistered");
        connections.unregister(id);
      }
      log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id }, "Failed to update connection in DB");
      return c.json({ error: "internal_error", message: "Failed to update connection." }, 500);
    }

    _resetWhitelists();

    log.info({ requestId, connectionId: id, urlChanged, actorId: authResult.user?.id }, "Connection updated");
    return c.json({
      id,
      dbType,
      description: newDescription,
      maskedUrl: maskConnectionUrl(newUrl),
    });
  });
});

// DELETE /connections/:id — remove connection
admin.delete("/connections/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL)." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");

    if (id === "default") {
      return c.json({ error: "forbidden", message: "Cannot delete the default connection." }, 403);
    }

    // Must exist in the DB (admin-managed)
    const existing = await internalQuery<{ id: string }>(
      "SELECT id FROM connections WHERE id = $1",
      [id],
    );
    if (existing.length === 0) {
      return c.json({ error: "not_found", message: `Connection "${id}" not found or is not admin-managed.` }, 404);
    }

    // Check for scheduled tasks referencing this connection
    try {
      const refs = await internalQuery<{ count: string }>(
        "SELECT COUNT(*) as count FROM scheduled_tasks WHERE connection_id = $1",
        [id],
      );
      const refCount = parseInt(String(refs[0]?.count ?? "0"), 10);
      if (refCount > 0) {
        return c.json({
          error: "conflict",
          message: `Cannot delete connection "${id}" — it is referenced by ${refCount} scheduled task(s). Remove or update those tasks first.`,
        }, 409);
      }
    } catch (err) {
      // scheduled_tasks table might not exist — not a blocker for delete
      log.debug({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Could not check scheduled task references (table may not exist)");
    }

    // Remove from DB and registry
    try {
      await internalQuery("DELETE FROM connections WHERE id = $1", [id]);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id }, "Failed to delete connection from DB");
      return c.json({ error: "internal_error", message: "Failed to delete connection." }, 500);
    }

    connections.unregister(id);

    log.info({ requestId, connectionId: id, actorId: authResult.user?.id }, "Connection deleted");
    return c.json({ success: true });
  });
});

// GET /connections/:id — get connection detail (including masked URL)
admin.get("/connections/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");

    if (!connections.has(id)) {
      return c.json({ error: "not_found", message: `Connection "${id}" not found.` }, 404);
    }

    const meta = connections.describe().find((m) => m.id === id);

    // If admin-managed, include masked URL and schema from DB
    let maskedUrl: string | null = null;
    let schema: string | null = null;
    let managed = false;
    if (hasInternalDB()) {
      try {
        const rows = await internalQuery<{ url: string; schema_name: string | null }>(
          "SELECT url, schema_name FROM connections WHERE id = $1",
          [id],
        );
        if (rows.length > 0) {
          managed = true;
          schema = rows[0].schema_name;
          try {
            maskedUrl = maskConnectionUrl(decryptUrl(rows[0].url));
          } catch (decryptErr) {
            log.error({ connectionId: id, err: decryptErr instanceof Error ? decryptErr.message : String(decryptErr) }, "Failed to decrypt stored connection URL");
            maskedUrl = "[encrypted — decryption failed]";
          }
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to fetch connection details from internal DB");
      }
    }

    return c.json({
      id,
      dbType: meta?.dbType ?? "unknown",
      description: meta?.description ?? null,
      health: meta?.health ?? null,
      maskedUrl,
      schema,
      managed,
    });
  });
});

// ---------------------------------------------------------------------------
// Audit routes
// ---------------------------------------------------------------------------

/** Escape ILIKE special characters so they are matched literally. */
function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/** Quote a value for safe CSV output (RFC 4180). */
function csvField(val: string | null | undefined): string {
  const s = val ?? "";
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

type AuditFilterResult =
  | { ok: true; conditions: string[]; params: unknown[]; paramIdx: number }
  | { ok: false; error: string; message: string; status: 400 };

/** Shared filter builder for audit list + export endpoints. */
function buildAuditFilters(query: (key: string) => string | undefined): AuditFilterResult {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  const user = query("user");
  if (user) {
    conditions.push(`a.user_id = $${paramIdx++}`);
    params.push(user);
  }

  const success = query("success");
  if (success === "true" || success === "false") {
    conditions.push(`a.success = $${paramIdx++}`);
    params.push(success === "true");
  }

  const from = query("from");
  if (from) {
    if (isNaN(Date.parse(from))) {
      return { ok: false, error: "invalid_request", message: `Invalid 'from' date format: "${from}". Use ISO 8601 (e.g. 2026-01-01).`, status: 400 };
    }
    conditions.push(`a.timestamp >= $${paramIdx++}`);
    params.push(from);
  }

  const to = query("to");
  if (to) {
    if (isNaN(Date.parse(to))) {
      return { ok: false, error: "invalid_request", message: `Invalid 'to' date format: "${to}". Use ISO 8601 (e.g. 2026-03-03).`, status: 400 };
    }
    conditions.push(`a.timestamp <= $${paramIdx++}`);
    params.push(to);
  }

  const connection = query("connection");
  if (connection) {
    conditions.push(`a.source_id = $${paramIdx++}`);
    params.push(connection);
  }

  const table = query("table");
  if (table) {
    conditions.push(`a.tables_accessed ? $${paramIdx++}`);
    params.push(table.toLowerCase());
  }

  const column = query("column");
  if (column) {
    conditions.push(`a.columns_accessed ? $${paramIdx++}`);
    params.push(column.toLowerCase());
  }

  const search = query("search");
  if (search) {
    const term = `%${escapeIlike(search)}%`;
    conditions.push(`(a.sql ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx} OR a.error ILIKE $${paramIdx})`);
    params.push(term);
    paramIdx++;
  }

  return { ok: true, conditions, params, paramIdx };
}

// GET /audit — query audit_log (paginated)
admin.get("/audit", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  // Auth before feature-availability check to avoid info disclosure
  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
    const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    // Queries the internal DB directly (not the analytics datasource),
    // so no validateSQL pipeline needed. Parameterized queries prevent injection.
    const filters = buildAuditFilters((k) => c.req.query(k));
    if (!filters.ok) {
      return c.json({ error: filters.error, message: filters.message }, filters.status);
    }
    const { conditions, params } = filters;
    let { paramIdx } = filters;

    // The JOIN is always needed because the search filter references u.email
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
      const countResult = await internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM audit_log a LEFT JOIN "user" u ON a.user_id = u.id ${whereClause}`,
        params,
      );
      const total = parseInt(String(countResult[0]?.count ?? "0"), 10);

      const rows = await internalQuery<{
        id: string;
        timestamp: string;
        user_id: string | null;
        sql: string;
        duration_ms: number;
        row_count: number | null;
        success: boolean;
        error: string | null;
        source_id: string | null;
        source_type: string | null;
        target_host: string | null;
        user_label: string | null;
        auth_mode: string;
        user_email: string | null;
        tables_accessed: string[] | null;
        columns_accessed: string[] | null;
      }>(
        `SELECT a.*, u.email AS user_email
         FROM audit_log a
         LEFT JOIN "user" u ON a.user_id = u.id
         ${whereClause} ORDER BY a.timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      );

      return c.json({ rows, total, limit, offset });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Audit query failed");
      return c.json({ error: "internal_error", message: "Failed to query audit log." }, 500);
    }
  });
});

// GET /audit/export — CSV export of audit_log (respects current filters)
admin.get("/audit/export", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const filters = buildAuditFilters((k) => c.req.query(k));
    if (!filters.ok) {
      return c.json({ error: filters.error, message: filters.message }, filters.status);
    }
    const { conditions, params } = filters;
    let { paramIdx } = filters;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const exportLimit = 10000;

    try {
      // Count total matching rows to detect truncation
      const countResult = await internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM audit_log a LEFT JOIN "user" u ON a.user_id = u.id ${whereClause}`,
        params,
      );
      const totalAvailable = parseInt(String(countResult[0]?.count ?? "0"), 10);

      const rows = await internalQuery<{
        id: string;
        timestamp: string;
        user_id: string | null;
        sql: string;
        duration_ms: number;
        row_count: number | null;
        success: boolean;
        error: string | null;
        source_id: string | null;
        user_email: string | null;
        tables_accessed: string[] | null;
        columns_accessed: string[] | null;
      }>(
        `SELECT a.id, a.timestamp, a.user_id, a.sql, a.duration_ms, a.row_count, a.success, a.error, a.source_id, a.tables_accessed, a.columns_accessed, u.email AS user_email
         FROM audit_log a
         LEFT JOIN "user" u ON a.user_id = u.id
         ${whereClause} ORDER BY a.timestamp DESC LIMIT $${paramIdx++}`,
        [...params, exportLimit],
      );

      const csvHeader = "id,timestamp,user,sql,duration_ms,row_count,success,error,connection,tables_accessed,columns_accessed\n";
      const csvRows = rows.map((r) => {
        const fields = [
          csvField(r.id),
          csvField(r.timestamp),
          csvField(r.user_email ?? r.user_id ?? ""),
          csvField(r.sql),
          String(r.duration_ms),
          String(r.row_count ?? ""),
          String(r.success),
          csvField(r.error),
          csvField(r.source_id),
          csvField(r.tables_accessed ? r.tables_accessed.join("; ") : null),
          csvField(r.columns_accessed ? r.columns_accessed.join("; ") : null),
        ];
        return fields.join(",");
      });

      const csv = csvHeader + csvRows.join("\n");
      const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      const truncated = totalAvailable > exportLimit;

      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          ...(truncated && {
            "X-Export-Truncated": "true",
            "X-Export-Total": String(totalAvailable),
            "X-Export-Limit": String(exportLimit),
          }),
        },
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Audit export failed");
      return c.json({ error: "internal_error", message: "Failed to export audit log." }, 500);
    }
  });
});

// GET /audit/stats — aggregate audit stats
admin.get("/audit/stats", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  // Auth before feature-availability check to avoid info disclosure
  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const totalResult = await internalQuery<{ total: string; errors: string }>(
        `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE NOT success) as errors FROM audit_log`,
      );

      const total = parseInt(String(totalResult[0]?.total ?? "0"), 10);
      const errors = parseInt(String(totalResult[0]?.errors ?? "0"), 10);
      const errorRate = total > 0 ? (errors / total) * 100 : 0;

      const dailyResult = await internalQuery<{ day: string; count: string }>(
        `SELECT DATE(timestamp) as day, COUNT(*) as count FROM audit_log WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY DATE(timestamp) ORDER BY day DESC`,
      );

      return c.json({
        totalQueries: total,
        totalErrors: errors,
        errorRate,
        queriesPerDay: dailyResult.map((r) => ({
          day: r.day,
          count: parseInt(String(r.count), 10),
        })),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Audit stats query failed");
      return c.json({ error: "internal_error", message: "Failed to query audit stats." }, 500);
    }
  });
});

// GET /audit/facets — distinct tables and columns for filter dropdowns
admin.get("/audit/facets", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    // Use allSettled so one failing query doesn't block the other
    const [tableResult, columnResult] = await Promise.allSettled([
      internalQuery<{ val: string }>(
        `SELECT DISTINCT jsonb_array_elements_text(tables_accessed) AS val FROM audit_log WHERE tables_accessed IS NOT NULL AND jsonb_typeof(tables_accessed) = 'array' ORDER BY val LIMIT 200`,
      ),
      internalQuery<{ val: string }>(
        `SELECT DISTINCT jsonb_array_elements_text(columns_accessed) AS val FROM audit_log WHERE columns_accessed IS NOT NULL AND jsonb_typeof(columns_accessed) = 'array' ORDER BY val LIMIT 200`,
      ),
    ]);

    if (tableResult.status === "rejected") {
      log.warn({ err: tableResult.reason }, "Failed to load table facets");
    }
    if (columnResult.status === "rejected") {
      log.warn({ err: columnResult.reason }, "Failed to load column facets");
    }

    return c.json({
      tables: tableResult.status === "fulfilled" ? tableResult.value.map((r) => r.val) : [],
      columns: columnResult.status === "fulfilled" ? columnResult.value.map((r) => r.val) : [],
    });
  });
});

// ---------------------------------------------------------------------------
// Audit analytics routes
// ---------------------------------------------------------------------------

/** Build WHERE clause from optional `from` and `to` query params. */
function analyticsDateRange(c: { req: { query(name: string): string | undefined } }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  const from = c.req.query("from");
  if (from) {
    if (isNaN(Date.parse(from))) return { error: `Invalid 'from' date format. Use ISO 8601 (e.g. 2026-01-01).` } as const;
    conditions.push(`timestamp >= $${idx++}`);
    params.push(from);
  }

  const to = c.req.query("to");
  if (to) {
    if (isNaN(Date.parse(to))) return { error: `Invalid 'to' date format. Use ISO 8601 (e.g. 2026-01-01).` } as const;
    conditions.push(`timestamp <= $${idx++}`);
    params.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params, nextIdx: idx } as const;
}

// GET /audit/analytics/volume — queries per day over date range
admin.get("/audit/analytics/volume", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const range = analyticsDateRange(c);
    if ("error" in range) return c.json({ error: "invalid_request", message: range.error }, 400);

    try {
      const rows = await internalQuery<{ day: string; count: string; errors: string }>(
        `SELECT DATE(timestamp) as day, COUNT(*) as count, COUNT(*) FILTER (WHERE NOT success) as errors
         FROM audit_log ${range.where}
         GROUP BY DATE(timestamp) ORDER BY day`,
        range.params,
      );
      return c.json({
        volume: rows.map((r) => ({
          day: r.day,
          count: parseInt(String(r.count), 10),
          errors: parseInt(String(r.errors), 10),
        })),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Audit analytics volume query failed");
      return c.json({ error: "internal_error", message: "Failed to query volume analytics." }, 500);
    }
  });
});

// GET /audit/analytics/slow — top 20 queries by average duration
admin.get("/audit/analytics/slow", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const range = analyticsDateRange(c);
    if ("error" in range) return c.json({ error: "invalid_request", message: range.error }, 400);

    try {
      const rows = await internalQuery<{
        query: string;
        avg_duration: string;
        max_duration: string;
        count: string;
      }>(
        `SELECT LEFT(sql, 200) as query,
                ROUND(AVG(duration_ms)) as avg_duration,
                MAX(duration_ms) as max_duration,
                COUNT(*) as count
         FROM audit_log ${range.where}
         GROUP BY LEFT(sql, 200)
         ORDER BY AVG(duration_ms) DESC
         LIMIT 20`,
        range.params,
      );
      return c.json({
        queries: rows.map((r) => ({
          query: r.query,
          avgDuration: parseInt(String(r.avg_duration), 10),
          maxDuration: parseInt(String(r.max_duration), 10),
          count: parseInt(String(r.count), 10),
        })),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Audit analytics slow query failed");
      return c.json({ error: "internal_error", message: "Failed to query slow analytics." }, 500);
    }
  });
});

// GET /audit/analytics/frequent — top 20 queries by execution count
admin.get("/audit/analytics/frequent", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const range = analyticsDateRange(c);
    if ("error" in range) return c.json({ error: "invalid_request", message: range.error }, 400);

    try {
      const rows = await internalQuery<{
        query: string;
        count: string;
        avg_duration: string;
        error_count: string;
      }>(
        `SELECT LEFT(sql, 200) as query,
                COUNT(*) as count,
                ROUND(AVG(duration_ms)) as avg_duration,
                COUNT(*) FILTER (WHERE NOT success) as error_count
         FROM audit_log ${range.where}
         GROUP BY LEFT(sql, 200)
         ORDER BY COUNT(*) DESC
         LIMIT 20`,
        range.params,
      );
      return c.json({
        queries: rows.map((r) => ({
          query: r.query,
          count: parseInt(String(r.count), 10),
          avgDuration: parseInt(String(r.avg_duration), 10),
          errorCount: parseInt(String(r.error_count), 10),
        })),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Audit analytics frequent query failed");
      return c.json({ error: "internal_error", message: "Failed to query frequency analytics." }, 500);
    }
  });
});

// GET /audit/analytics/errors — error count grouped by error message pattern
admin.get("/audit/analytics/errors", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const range = analyticsDateRange(c);
    if ("error" in range) return c.json({ error: "invalid_request", message: range.error }, 400);

    const errorCondition = range.where
      ? `${range.where} AND NOT success`
      : "WHERE NOT success";

    try {
      const rows = await internalQuery<{ error: string; count: string }>(
        `SELECT COALESCE(LEFT(error, 150), 'Unknown error') as error,
                COUNT(*) as count
         FROM audit_log ${errorCondition}
         GROUP BY COALESCE(LEFT(error, 150), 'Unknown error')
         ORDER BY COUNT(*) DESC
         LIMIT 20`,
        range.params,
      );
      return c.json({
        errors: rows.map((r) => ({
          error: r.error,
          count: parseInt(String(r.count), 10),
        })),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Audit analytics errors query failed");
      return c.json({ error: "internal_error", message: "Failed to query error analytics." }, 500);
    }
  });
});

// GET /audit/analytics/users — per-user stats
admin.get("/audit/analytics/users", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const range = analyticsDateRange(c);
    if ("error" in range) return c.json({ error: "invalid_request", message: range.error }, 400);

    try {
      const rows = await internalQuery<{
        user_id: string;
        user_email: string | null;
        count: string;
        avg_duration: string;
        error_count: string;
      }>(
        `SELECT COALESCE(a.user_id, 'anonymous') as user_id,
                u.email as user_email,
                COUNT(*) as count,
                ROUND(AVG(a.duration_ms)) as avg_duration,
                COUNT(*) FILTER (WHERE NOT a.success) as error_count
         FROM audit_log a
         LEFT JOIN "user" u ON a.user_id = u.id
         ${range.where}
         GROUP BY COALESCE(a.user_id, 'anonymous'), u.email
         ORDER BY COUNT(*) DESC
         LIMIT 50`,
        range.params,
      );
      return c.json({
        users: rows.map((r) => {
          const count = parseInt(String(r.count), 10);
          const errorCount = parseInt(String(r.error_count), 10);
          return {
            userId: r.user_id,
            userEmail: r.user_email,
            count,
            avgDuration: parseInt(String(r.avg_duration), 10),
            errorCount,
            errorRate: count > 0 ? errorCount / count : 0,
          };
        }),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Audit analytics users query failed");
      return c.json({ error: "internal_error", message: "Failed to query user analytics." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// Plugin routes
// ---------------------------------------------------------------------------

// GET /plugins — list installed plugins
admin.get("/plugins", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const pluginList = plugins.describe();
    return c.json({ plugins: pluginList, manageable: hasInternalDB() });
  });
});

// POST /plugins/:id/health — trigger health check
admin.post("/plugins/:id/health", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");
    const plugin = plugins.get(id);
    if (!plugin) {
      return c.json({ error: "not_found", message: `Plugin "${id}" not found.` }, 404);
    }

    if (!plugin.healthCheck) {
      return c.json({
        healthy: true,
        message: "Plugin does not implement healthCheck.",
        status: plugins.getStatus(id),
      });
    }

    try {
      const result = await plugin.healthCheck();
      return c.json({ ...result, status: plugins.getStatus(id) });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), pluginId: id }, "Plugin health check threw an exception");
      return c.json({
        error: "internal_error",
        healthy: false,
        message: "Plugin health check failed unexpectedly.",
        status: plugins.getStatus(id),
      }, 500);
    }
  });
});

// POST /plugins/:id/enable — enable a plugin
admin.post("/plugins/:id/enable", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");
    const plugin = plugins.get(id);
    if (!plugin) {
      return c.json({ error: "not_found", message: `Plugin "${id}" not found.` }, 404);
    }

    plugins.enable(id);

    let persisted = false;
    let warning: string | undefined;
    if (hasInternalDB()) {
      try {
        await savePluginEnabled(id, true);
        persisted = true;
      } catch (err) {
        log.error({ err: err instanceof Error ? err : new Error(String(err)), pluginId: id }, "Failed to persist plugin enabled state");
        warning = "Plugin enabled in memory but could not be persisted. State will reset on restart.";
      }
    } else {
      warning = "No internal database — state will reset on restart.";
    }

    return c.json({ id, enabled: true, status: plugins.getStatus(id), persisted, warning });
  });
});

// POST /plugins/:id/disable — disable a plugin
admin.post("/plugins/:id/disable", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");
    const plugin = plugins.get(id);
    if (!plugin) {
      return c.json({ error: "not_found", message: `Plugin "${id}" not found.` }, 404);
    }

    plugins.disable(id);

    let persisted = false;
    let warning: string | undefined;
    if (hasInternalDB()) {
      try {
        await savePluginEnabled(id, false);
        persisted = true;
      } catch (err) {
        log.error({ err: err instanceof Error ? err : new Error(String(err)), pluginId: id }, "Failed to persist plugin disabled state");
        warning = "Plugin disabled in memory but could not be persisted. State will reset on restart.";
      }
    } else {
      warning = "No internal database — state will reset on restart.";
    }

    return c.json({ id, enabled: false, status: plugins.getStatus(id), persisted, warning });
  });
});

// GET /plugins/:id/schema — return config schema and current values
admin.get("/plugins/:id/schema", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");
    const plugin = plugins.get(id);
    if (!plugin) {
      return c.json({ error: "not_found", message: `Plugin "${id}" not found.` }, 404);
    }

    const schema: ConfigSchemaField[] = typeof plugin.getConfigSchema === "function"
      ? plugin.getConfigSchema()
      : [];

    // Build current values from plugin config + DB overrides
    const pluginConfig = plugin.config != null && typeof plugin.config === "object"
      ? (plugin.config as Record<string, unknown>)
      : {};
    const dbOverrides = await getPluginConfig(id);
    const merged = { ...pluginConfig, ...dbOverrides };

    // Mask secret values — use fixed placeholder to avoid leaking prefixes
    const MASKED_PLACEHOLDER = "••••••••";
    const maskedValues: Record<string, unknown> = {};
    const secretKeys = new Set(schema.filter((f) => f.secret).map((f) => f.key));
    for (const [key, value] of Object.entries(merged)) {
      if (secretKeys.has(key) && typeof value === "string" && value.length > 0) {
        maskedValues[key] = MASKED_PLACEHOLDER;
      } else {
        maskedValues[key] = value;
      }
    }

    return c.json({
      id,
      schema,
      values: maskedValues,
      hasSchema: schema.length > 0,
      manageable: hasInternalDB(),
    });
  });
});

// PUT /plugins/:id/config — update plugin configuration
admin.put("/plugins/:id/config", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const id = c.req.param("id");
    const plugin = plugins.get(id);
    if (!plugin) {
      return c.json({ error: "not_found", message: `Plugin "${id}" not found.` }, 404);
    }

    if (!hasInternalDB()) {
      return c.json({
        error: "no_internal_db",
        message: "Internal database required to save plugin configuration. Config is read-only.",
      }, 409);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "Request body must be valid JSON." }, 400);
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "invalid_request", message: "Request body must be a JSON object." }, 400);
    }

    // Validate against schema if plugin provides one
    const MASKED_PLACEHOLDER = "••••••••";
    if (typeof plugin.getConfigSchema === "function") {
      const schema = plugin.getConfigSchema();
      const schemaKeys = new Set(schema.map((f) => f.key));
      const errors: string[] = [];

      // Restore masked secret values from original config
      const pluginConfig = plugin.config != null && typeof plugin.config === "object"
        ? (plugin.config as Record<string, unknown>)
        : {};
      const dbOverrides = await getPluginConfig(id);
      const originals = { ...pluginConfig, ...dbOverrides };

      for (const field of schema) {
        const value = body[field.key];

        // If a secret field has the masked placeholder, restore the original value
        if (field.secret && value === MASKED_PLACEHOLDER) {
          if (originals[field.key] !== undefined) {
            body[field.key] = originals[field.key];
          }
          continue;
        }

        if (field.required && (value === undefined || value === null || value === "")) {
          errors.push(`"${field.key}" is required.`);
          continue;
        }

        if (value === undefined || value === null) continue;

        switch (field.type) {
          case "string":
            if (typeof value !== "string") errors.push(`"${field.key}" must be a string.`);
            break;
          case "number":
            if (typeof value !== "number") errors.push(`"${field.key}" must be a number.`);
            break;
          case "boolean":
            if (typeof value !== "boolean") errors.push(`"${field.key}" must be a boolean.`);
            break;
          case "select":
            if (field.options && !field.options.includes(String(value))) {
              errors.push(`"${field.key}" must be one of: ${field.options.join(", ")}.`);
            }
            break;
        }
      }

      if (errors.length > 0) {
        return c.json({
          error: "validation_error",
          message: "Config validation failed.",
          details: errors,
        }, 400);
      }

      // Strip keys not in the schema to prevent saving unvalidated data
      for (const key of Object.keys(body)) {
        if (!schemaKeys.has(key)) {
          delete body[key];
        }
      }
    }

    try {
      await savePluginConfig(id, body);
      log.info({ pluginId: id, requestId }, "Plugin config updated");
      return c.json({
        id,
        message: "Configuration saved. Changes take effect on next restart.",
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), pluginId: id }, "Failed to save plugin config");
      return c.json({ error: "internal_error", message: "Failed to save plugin configuration." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// Password change required — any authenticated managed-auth user (not admin-only)
// ---------------------------------------------------------------------------

// GET /me/password-status — check if current user must change password
admin.get("/me/password-status", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  // Light auth: authenticate but don't require admin role
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch {
    return c.json({ error: "auth_error", message: "Authentication system error" }, 500);
  }
  if (!authResult.authenticated) {
    const code = authErrorCode(authResult.error);
    return c.json({ error: code, message: authResult.error }, authResult.status);
  }
  const user = authResult.user;
  if (authResult.mode !== "managed" || !user) {
    return c.json({ passwordChangeRequired: false });
  }

  if (!hasInternalDB()) return c.json({ passwordChangeRequired: false });

  return withRequestContext({ requestId, user }, async () => {
    try {
      const rows = await internalQuery<{ password_change_required: boolean }>(
        `SELECT password_change_required FROM "user" WHERE id = $1`,
        [user.id],
      );
      return c.json({ passwordChangeRequired: rows[0]?.password_change_required === true });
    } catch {
      return c.json({ passwordChangeRequired: false });
    }
  });
});

// POST /me/password — change password and clear the flag
admin.post("/me/password", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch {
    return c.json({ error: "auth_error", message: "Authentication system error" }, 500);
  }
  if (!authResult.authenticated) {
    const code = authErrorCode(authResult.error);
    return c.json({ error: code, message: authResult.error }, authResult.status);
  }
  const user = authResult.user;
  if (authResult.mode !== "managed" || !user) {
    return c.json({ error: "not_available", message: "Password change requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user }, async () => {
    const body = await c.req.json().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in password change request");
      return null;
    });
    const currentPassword = body?.currentPassword;
    const newPassword = body?.newPassword;

    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return c.json({ error: "invalid_request", message: "currentPassword and newPassword are required." }, 400);
    }
    if (newPassword.length < 8) {
      return c.json({ error: "invalid_request", message: "New password must be at least 8 characters." }, 400);
    }

    try {
      const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
      const auth = getAuthInstance();
      await (auth.api as unknown as {
        changePassword(opts: { body: { currentPassword: string; newPassword: string }; headers: Headers }): Promise<unknown>;
      }).changePassword({
        body: { currentPassword, newPassword },
        headers: req.headers,
      });

      // Clear the flag
      if (hasInternalDB()) {
        await internalQuery(
          `UPDATE "user" SET password_change_required = false WHERE id = $1`,
          [user.id],
        );
      }

      log.info({ requestId, userId: user.id }, "Password changed and flag cleared");
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Password change failed";
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Password change failed");
      // Better Auth throws if current password is wrong
      if (message.includes("password") || message.includes("incorrect") || message.includes("invalid")) {
        return c.json({ error: "invalid_request", message: "Current password is incorrect." }, 400);
      }
      return c.json({ error: "internal_error", message: "Failed to change password." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// Session management routes (requires managed auth mode + internal DB)
// ---------------------------------------------------------------------------

// GET /sessions — list all active sessions with user info
admin.get("/sessions", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
    const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const search = c.req.query("search");

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (search) {
        conditions.push(`(u.email ILIKE $${paramIdx} OR s."ipAddress" ILIKE $${paramIdx})`);
        params.push(`%${escapeIlike(search)}%`);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const [rows, countResult] = await Promise.all([
        internalQuery<{
          id: string;
          userId: string;
          userEmail: string | null;
          createdAt: string;
          updatedAt: string;
          expiresAt: string;
          ipAddress: string | null;
          userAgent: string | null;
        }>(
          `SELECT s.id, s."userId" AS "userId", u.email AS "userEmail",
                  s."createdAt" AS "createdAt", s."updatedAt" AS "updatedAt",
                  s."expiresAt" AS "expiresAt",
                  s."ipAddress" AS "ipAddress", s."userAgent" AS "userAgent"
           FROM session s
           LEFT JOIN "user" u ON s."userId" = u.id
           ${where}
           ORDER BY s."updatedAt" DESC
           LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
          [...params, limit, offset],
        ),
        internalQuery<{ count: string }>(
          `SELECT COUNT(*) AS count FROM session s LEFT JOIN "user" u ON s."userId" = u.id ${where}`,
          params,
        ),
      ]);

      return c.json({
        sessions: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          userEmail: r.userEmail,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          expiresAt: r.expiresAt,
          ipAddress: r.ipAddress,
          userAgent: r.userAgent,
        })),
        total: parseInt(String(countResult[0]?.count ?? "0"), 10),
        limit,
        offset,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to list sessions");
      return c.json({ error: "internal_error", message: "Failed to list sessions." }, 500);
    }
  });
});

// GET /sessions/stats — session counts
admin.get("/sessions/stats", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const [totalResult, activeResult, uniqueUsersResult] = await Promise.all([
        internalQuery<{ count: string }>(`SELECT COUNT(*) AS count FROM session`),
        internalQuery<{ count: string }>(`SELECT COUNT(*) AS count FROM session WHERE "expiresAt" > NOW()`),
        internalQuery<{ count: string }>(`SELECT COUNT(DISTINCT "userId") AS count FROM session WHERE "expiresAt" > NOW()`),
      ]);

      return c.json({
        total: parseInt(String(totalResult[0]?.count ?? "0"), 10),
        active: parseInt(String(activeResult[0]?.count ?? "0"), 10),
        uniqueUsers: parseInt(String(uniqueUsersResult[0]?.count ?? "0"), 10),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to get session stats");
      return c.json({ error: "internal_error", message: "Failed to get session stats." }, 500);
    }
  });
});

// DELETE /sessions/:id — revoke a single session by ID
admin.delete("/sessions/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const sessionId = c.req.param("id");

    try {
      const deleted = await internalQuery<{ id: string }>(
        `DELETE FROM session WHERE id = $1 RETURNING id`,
        [sessionId],
      );
      if (deleted.length === 0) {
        return c.json({ error: "not_found", message: "Session not found." }, 404);
      }

      log.info({ requestId, sessionId, actorId: authResult.user?.id }, "Session revoked");
      return c.json({ success: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), sessionId }, "Failed to revoke session");
      return c.json({ error: "internal_error", message: "Failed to revoke session." }, 500);
    }
  });
});

// DELETE /sessions/user/:userId — revoke all sessions for a user
admin.delete("/sessions/user/:userId", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const userId = c.req.param("userId");

    try {
      const deleted = await internalQuery<{ id: string }>(
        `DELETE FROM session WHERE "userId" = $1 RETURNING id`,
        [userId],
      );
      if (deleted.length === 0) {
        return c.json({ error: "not_found", message: "No sessions found for this user." }, 404);
      }

      const count = deleted.length;
      log.info({ requestId, targetUserId: userId, count, actorId: authResult.user?.id }, "All user sessions revoked");
      return c.json({ success: true, count });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to revoke user sessions");
      return c.json({ error: "internal_error", message: "Failed to revoke user sessions." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// User management routes (requires managed auth mode + Better Auth admin plugin)
// ---------------------------------------------------------------------------

/**
 * Server-side admin API methods from Better Auth's admin plugin.
 * The base Auth type doesn't expose plugin-specific methods (see server.ts
 * for why), but they exist at runtime. This interface types the subset we use.
 */
interface AdminApi {
  listUsers(opts: { query: Record<string, unknown>; headers: Headers }): Promise<{
    users: Array<Record<string, unknown>>;
    total: number;
  }>;
  setRole(opts: { body: { userId: string; role: string }; headers: Headers }): Promise<unknown>;
  banUser(opts: { body: Record<string, unknown>; headers: Headers }): Promise<unknown>;
  unbanUser(opts: { body: { userId: string }; headers: Headers }): Promise<unknown>;
  removeUser(opts: { body: { userId: string }; headers: Headers }): Promise<unknown>;
  revokeSessions(opts: { body: { userId: string }; headers: Headers }): Promise<unknown>;
}

/**
 * Get the Better Auth instance's admin API, or null if managed auth is not active.
 * Lazy-imports to avoid pulling in Better Auth when not needed.
 */
async function getAdminApi(): Promise<AdminApi | null> {
  if (detectAuthMode() !== "managed") return null;
  const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
  // Cast: admin plugin methods exist at runtime but aren't in the base Auth type
  return getAuthInstance().api as unknown as AdminApi;
}

/** Validate that a role string is a valid Atlas role. */
function isValidRole(role: unknown): role is AtlasRole {
  return typeof role === "string" && (ATLAS_ROLES as readonly string[]).includes(role);
}

// GET /users — list users (paginated, filterable)
admin.get("/users", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
    const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const search = c.req.query("search");
    const role = c.req.query("role");

    try {
      const result = await adminApi.listUsers({
        query: {
          limit,
          offset,
          ...(search ? { searchField: "email", searchValue: search, searchOperator: "contains" } : {}),
          ...(role && isValidRole(role) ? { filterField: "role", filterValue: role, filterOperator: "eq" } : {}),
          sortBy: "createdAt",
          sortDirection: "desc",
        },
        headers: req.headers,
      });

      return c.json({
        users: result.users.map((u: Record<string, unknown>) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role ?? "member",
          banned: u.banned ?? false,
          banReason: u.banReason ?? null,
          banExpires: u.banExpires ?? null,
          createdAt: u.createdAt,
        })),
        total: result.total,
        limit,
        offset,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to list users");
      return c.json({ error: "internal_error", message: "Failed to list users." }, 500);
    }
  });
});

// GET /users/stats — aggregate user stats
admin.get("/users/stats", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const totalResult = await internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM "user"`,
      );
      const roleResult = await internalQuery<{ role: string; count: string }>(
        `SELECT COALESCE(role, 'member') as role, COUNT(*) as count FROM "user" GROUP BY COALESCE(role, 'member')`,
      );
      const bannedResult = await internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM "user" WHERE banned = true`,
      );

      const total = parseInt(String(totalResult[0]?.count ?? "0"), 10);
      const banned = parseInt(String(bannedResult[0]?.count ?? "0"), 10);
      const byRole: Record<string, number> = {};
      for (const r of roleResult) {
        byRole[r.role] = parseInt(String(r.count), 10);
      }

      return c.json({ total, banned, byRole });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "User stats query failed");
      return c.json({ error: "internal_error", message: "Failed to query user stats." }, 500);
    }
  });
});

// PATCH /users/:id/role — change user role
admin.patch("/users/:id/role", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const userId = c.req.param("id");
    const body = await c.req.json().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in role change request");
      return null;
    });
    const newRole = body?.role;

    if (!isValidRole(newRole)) {
      return c.json({ error: "invalid_request", message: `Invalid role. Must be one of: ${ATLAS_ROLES.join(", ")}` }, 400);
    }

    // Self-protection: cannot change own role
    if (authResult.user?.id === userId) {
      return c.json({ error: "forbidden", message: "Cannot change your own role." }, 403);
    }

    // Last admin guard: if demoting an admin, ensure at least one admin remains
    if (newRole !== "admin" && hasInternalDB()) {
      try {
        const currentUser = await internalQuery<{ role: string }>(
          `SELECT role FROM "user" WHERE id = $1`,
          [userId],
        );
        if (currentUser[0]?.role === "admin") {
          const adminCount = await internalQuery<{ count: string }>(
            `SELECT COUNT(*) as count FROM "user" WHERE role = 'admin'`,
          );
          if (parseInt(String(adminCount[0]?.count ?? "0"), 10) <= 1) {
            return c.json({ error: "forbidden", message: "Cannot demote the last admin." }, 403);
          }
        }
      } catch (err) {
        log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Last admin guard check failed");
        return c.json({ error: "internal_error", message: "Failed to verify admin count." }, 500);
      }
    }

    try {
      await adminApi.setRole({
        body: { userId, role: newRole },
        headers: req.headers,
      });
      log.info({ requestId, targetUserId: userId, newRole, actorId: authResult.user?.id }, "User role changed");
      return c.json({ success: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to set user role");
      return c.json({ error: "internal_error", message: "Failed to update user role." }, 500);
    }
  });
});

// POST /users/:id/ban — ban a user
admin.post("/users/:id/ban", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const userId = c.req.param("id");

    if (authResult.user?.id === userId) {
      return c.json({ error: "forbidden", message: "Cannot ban yourself." }, 403);
    }

    const body = await c.req.json().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in ban user request");
      return {};
    });

    try {
      await adminApi.banUser({
        body: {
          userId,
          ...(body.reason ? { banReason: body.reason } : {}),
          ...(body.expiresIn ? { banExpiresIn: body.expiresIn } : {}),
        },
        headers: req.headers,
      });
      log.info({ requestId, targetUserId: userId, reason: body.reason, actorId: authResult.user?.id }, "User banned");
      return c.json({ success: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to ban user");
      return c.json({ error: "internal_error", message: "Failed to ban user." }, 500);
    }
  });
});

// POST /users/:id/unban — unban a user
admin.post("/users/:id/unban", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const userId = c.req.param("id");

    try {
      await adminApi.unbanUser({
        body: { userId },
        headers: req.headers,
      });
      log.info({ requestId, targetUserId: userId, actorId: authResult.user?.id }, "User unbanned");
      return c.json({ success: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to unban user");
      return c.json({ error: "internal_error", message: "Failed to unban user." }, 500);
    }
  });
});

// DELETE /users/:id — delete a user
admin.delete("/users/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const userId = c.req.param("id");

    if (authResult.user?.id === userId) {
      return c.json({ error: "forbidden", message: "Cannot delete yourself." }, 403);
    }

    // Last admin guard
    if (hasInternalDB()) {
      try {
        const currentUser = await internalQuery<{ role: string }>(
          `SELECT role FROM "user" WHERE id = $1`,
          [userId],
        );
        if (currentUser[0]?.role === "admin") {
          const adminCount = await internalQuery<{ count: string }>(
            `SELECT COUNT(*) as count FROM "user" WHERE role = 'admin'`,
          );
          if (parseInt(String(adminCount[0]?.count ?? "0"), 10) <= 1) {
            return c.json({ error: "forbidden", message: "Cannot delete the last admin." }, 403);
          }
        }
      } catch (err) {
        log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Last admin guard check failed");
        return c.json({ error: "internal_error", message: "Failed to verify admin count." }, 500);
      }
    }

    try {
      await adminApi.removeUser({
        body: { userId },
        headers: req.headers,
      });
      log.info({ requestId, targetUserId: userId, actorId: authResult.user?.id }, "User deleted");
      return c.json({ success: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to delete user");
      return c.json({ error: "internal_error", message: "Failed to delete user." }, 500);
    }
  });
});

// POST /users/:id/revoke — revoke all sessions (force logout)
admin.post("/users/:id/revoke", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const userId = c.req.param("id");

    try {
      await adminApi.revokeSessions({
        body: { userId },
        headers: req.headers,
      });
      log.info({ requestId, targetUserId: userId, actorId: authResult.user?.id }, "User sessions revoked");
      return c.json({ success: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to revoke sessions");
      return c.json({ error: "internal_error", message: "Failed to revoke sessions." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// User Invitations
// ---------------------------------------------------------------------------

const INVITE_EXPIRY_DAYS = 7;

/** Basic email format validation (not exhaustive — just enough to catch obvious mistakes). */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Resolve the frontend base URL for invite links. Priority:
 *  1. Request Origin header (browser sends the frontend origin)
 *  2. ATLAS_CORS_ORIGIN (frontend origin in cross-origin deployments)
 *  3. Fallback: http://localhost:3000 (local development)
 *
 * Deliberately avoids BETTER_AUTH_URL and NEXT_PUBLIC_ATLAS_API_URL
 * because those point to the API server, not the frontend.
 */
function resolveBaseUrl(req: Request): string {
  return (
    req.headers.get("origin") ??
    process.env.ATLAS_CORS_ORIGIN ??
    "http://localhost:3000"
  );
}

// POST /users/invite — create an invitation
admin.post("/users/invite", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "User invitations require managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const body = await c.req.json().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in invite request");
      return null;
    });

    const email = typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";
    const role = body?.role;

    if (!email || !isValidEmail(email)) {
      return c.json({ error: "invalid_request", message: "A valid email address is required." }, 400);
    }

    if (!isValidRole(role)) {
      return c.json({ error: "invalid_request", message: `Invalid role. Must be one of: ${ATLAS_ROLES.join(", ")}` }, 400);
    }

    // Check for existing user and pending invitation in parallel
    let existing: { id: string }[];
    let pending: { id: string }[];
    try {
      [existing, pending] = await Promise.all([
        internalQuery<{ id: string }>(
          `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
          [email],
        ),
        internalQuery<{ id: string }>(
          `SELECT id FROM invitations WHERE email = $1 AND status = 'pending' AND expires_at > now() LIMIT 1`,
          [email],
        ),
      ]);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to check existing user/invitation");
      return c.json({ error: "internal_error", message: "Failed to validate invitation." }, 500);
    }

    if (existing.length > 0) {
      return c.json({ error: "conflict", message: "A user with this email already exists." }, 409);
    }
    if (pending.length > 0) {
      return c.json({ error: "conflict", message: "A pending invitation for this email already exists." }, 409);
    }

    // Create invitation
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    try {
      const rows = await internalQuery<{ id: string; created_at: string }>(
        `INSERT INTO invitations (email, role, token, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [email, role, token, authResult.user?.id ?? null, expiresAt.toISOString()],
      );

      const invitation = rows[0];
      if (!invitation) {
        log.error({ email, role, requestId }, "INSERT RETURNING returned no rows");
        return c.json({ error: "internal_error", message: "Failed to create invitation." }, 500);
      }
      const baseUrl = resolveBaseUrl(req);
      const inviteUrl = `${baseUrl}/?invite=${token}`;

      // Attempt email delivery via Resend if configured
      let emailSent = false;
      let emailError: string | undefined;
      const resendKey = process.env.RESEND_API_KEY;
      if (resendKey) {
        try {
          const fromAddr = process.env.ATLAS_EMAIL_FROM ?? "Atlas <noreply@useatlas.dev>";
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: fromAddr,
              to: [email],
              subject: "You've been invited to Atlas",
              html: `<p>You've been invited to join Atlas as <strong>${role}</strong>.</p>
<p><a href="${inviteUrl}">Accept invitation</a></p>
<p>This invitation expires on ${expiresAt.toLocaleDateString()}.</p>
<p>If you didn't expect this invitation, you can safely ignore this email.</p>`,
            }),
          });
          emailSent = res.ok;
          if (!res.ok) {
            const errorBody = await res.text().catch(() => ""); // fallback: already in error path, body is best-effort for logging
            emailError = `Delivery failed (HTTP ${res.status})`;
            log.error({ status: res.status, email, responseBody: errorBody }, "Failed to send invite email via Resend");
          }
        } catch (err) {
          emailError = err instanceof Error ? err.message : "Network error";
          log.error({ err: err instanceof Error ? err.message : String(err), email }, "Resend email delivery failed");
        }
      }

      log.info({
        requestId,
        invitationId: invitation.id,
        email,
        role,
        emailSent,
        actorId: authResult.user?.id,
      }, "User invited");

      return c.json({
        id: invitation.id,
        email,
        role,
        token,
        inviteUrl,
        emailSent,
        ...(emailError ? { emailError } : {}),
        expiresAt: expiresAt.toISOString(),
        createdAt: invitation.created_at,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to create invitation");
      return c.json({ error: "internal_error", message: "Failed to create invitation." }, 500);
    }
  });
});

// GET /users/invitations — list invitations
admin.get("/users/invitations", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "User invitations require managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const status = c.req.query("status");
    const validStatuses = ["pending", "accepted", "revoked", "expired"];

    try {
      let sql = `SELECT i.id, i.email, i.role, i.status, i.invited_by, u.email AS invited_by_email, i.expires_at, i.accepted_at, i.created_at
                 FROM invitations i
                 LEFT JOIN "user" u ON i.invited_by = u.id`;
      const params: unknown[] = [];

      if (status && validStatuses.includes(status)) {
        if (status === "expired") {
          // "expired" is a virtual status — pending invitations past their expiry
          sql += ` WHERE i.status = 'pending' AND i.expires_at <= now()`;
        } else {
          sql += ` WHERE i.status = $1`;
          params.push(status);
        }
      }

      sql += ` ORDER BY i.created_at DESC LIMIT 100`;

      const rows = await internalQuery<{
        id: string;
        email: string;
        role: string;
        status: string;
        invited_by: string | null;
        invited_by_email: string | null;
        expires_at: string;
        accepted_at: string | null;
        created_at: string;
      }>(sql, params);

      // Mark expired invitations as expired in the response
      const now = new Date();
      const invitations = rows.map((inv) => ({
        ...inv,
        status: inv.status === "pending" && new Date(inv.expires_at) < now ? "expired" : inv.status,
      }));

      return c.json({ invitations });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to list invitations");
      return c.json({ error: "internal_error", message: "Failed to list invitations." }, 500);
    }
  });
});

// DELETE /users/invitations/:id — revoke a pending invitation
admin.delete("/users/invitations/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "User invitations require managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const invitationId = c.req.param("id");

    try {
      const result = await internalQuery<{ id: string }>(
        `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND status = 'pending' RETURNING id`,
        [invitationId],
      );

      if (result.length === 0) {
        return c.json({ error: "not_found", message: "Invitation not found or already resolved." }, 404);
      }

      log.info({ requestId, invitationId, actorId: authResult.user?.id }, "Invitation revoked");
      return c.json({ success: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), invitationId }, "Failed to revoke invitation");
      return c.json({ error: "internal_error", message: "Failed to revoke invitation." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// Token usage analytics
// ---------------------------------------------------------------------------

/** Parse and validate ISO date strings for token usage queries. */
function parseDateRange(from?: string, to?: string): { fromDate: string; toDate: string } | { error: string } {
  if (from && isNaN(Date.parse(from))) {
    return { error: `Invalid 'from' date format: "${from}". Use ISO 8601 (e.g. 2026-01-01).` };
  }
  if (to && isNaN(Date.parse(to))) {
    return { error: `Invalid 'to' date format: "${to}". Use ISO 8601 (e.g. 2026-01-01).` };
  }
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDate = from || defaultFrom.toISOString();
  const toDate = to || now.toISOString();
  return { fromDate, toDate };
}

// GET /tokens/summary — total tokens by period with prompt/completion breakdown
admin.get("/tokens/summary", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Token usage tracking requires an internal database (DATABASE_URL)." }, 404);
  }

  const range = parseDateRange(
    c.req.query("from"),
    c.req.query("to"),
  );
  if ("error" in range) {
    return c.json({ error: "invalid_request", message: range.error }, 400);
  }
  const { fromDate, toDate } = range;

  try {
    const rows = await internalQuery<{
      total_prompt: string;
      total_completion: string;
      total_requests: string;
    }>(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
         COALESCE(SUM(completion_tokens), 0) AS total_completion,
         COUNT(*) AS total_requests
       FROM token_usage
       WHERE created_at >= $1 AND created_at <= $2`,
      [fromDate, toDate],
    );

    const row = rows[0];
    return c.json({
      totalPromptTokens: parseInt(row?.total_prompt ?? "0", 10),
      totalCompletionTokens: parseInt(row?.total_completion ?? "0", 10),
      totalTokens: parseInt(row?.total_prompt ?? "0", 10) + parseInt(row?.total_completion ?? "0", 10),
      totalRequests: parseInt(row?.total_requests ?? "0", 10),
      from: fromDate,
      to: toDate,
    });
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to fetch token summary");
    return c.json({ error: "internal_error", message: "Failed to fetch token usage summary." }, 500);
  }
});

// GET /tokens/by-user — top N users by token consumption
admin.get("/tokens/by-user", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Token usage tracking requires an internal database (DATABASE_URL)." }, 404);
  }

  const range = parseDateRange(
    c.req.query("from"),
    c.req.query("to"),
  );
  if ("error" in range) {
    return c.json({ error: "invalid_request", message: range.error }, 400);
  }
  const { fromDate, toDate } = range;
  const parsedLimit = parseInt(c.req.query("limit") ?? "20", 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 20;

  try {
    const rows = await internalQuery<{
      user_id: string;
      user_email: string | null;
      total_prompt: string;
      total_completion: string;
      total_tokens: string;
      request_count: string;
    }>(
      `SELECT
         COALESCE(t.user_id, 'anonymous') AS user_id,
         u.email AS user_email,
         SUM(t.prompt_tokens) AS total_prompt,
         SUM(t.completion_tokens) AS total_completion,
         SUM(t.prompt_tokens + t.completion_tokens) AS total_tokens,
         COUNT(*) AS request_count
       FROM token_usage t
       LEFT JOIN "user" u ON t.user_id = u.id
       WHERE t.created_at >= $1 AND t.created_at <= $2
       GROUP BY t.user_id, u.email
       ORDER BY total_tokens DESC
       LIMIT $3`,
      [fromDate, toDate, limit],
    );

    return c.json({
      users: rows.map((r) => ({
        userId: r.user_id,
        userEmail: r.user_email,
        promptTokens: parseInt(r.total_prompt, 10),
        completionTokens: parseInt(r.total_completion, 10),
        totalTokens: parseInt(r.total_tokens, 10),
        requestCount: parseInt(r.request_count, 10),
      })),
      from: fromDate,
      to: toDate,
    });
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to fetch token usage by user");
    return c.json({ error: "internal_error", message: "Failed to fetch token usage by user." }, 500);
  }
});

// GET /tokens/trends — time-series data for charting
admin.get("/tokens/trends", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Token usage tracking requires an internal database (DATABASE_URL)." }, 404);
  }

  const range = parseDateRange(
    c.req.query("from"),
    c.req.query("to"),
  );
  if ("error" in range) {
    return c.json({ error: "invalid_request", message: range.error }, 400);
  }
  const { fromDate, toDate } = range;

  try {
    const rows = await internalQuery<{
      day: string;
      prompt_tokens: string;
      completion_tokens: string;
      request_count: string;
    }>(
      `SELECT
         DATE(created_at) AS day,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         COUNT(*) AS request_count
       FROM token_usage
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [fromDate, toDate],
    );

    return c.json({
      trends: rows.map((r) => ({
        day: r.day,
        promptTokens: parseInt(r.prompt_tokens, 10),
        completionTokens: parseInt(r.completion_tokens, 10),
        totalTokens: parseInt(r.prompt_tokens, 10) + parseInt(r.completion_tokens, 10),
        requestCount: parseInt(r.request_count, 10),
      })),
      from: fromDate,
      to: toDate,
    });
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to fetch token trends");
    return c.json({ error: "internal_error", message: "Failed to fetch token usage trends." }, 500);
  }
});

// ---------------------------------------------------------------------------
// Settings routes
// ---------------------------------------------------------------------------

// GET /settings — all known settings with current values and sources
admin.get("/settings", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const settings = getSettingsForAdmin();
    const manageable = hasInternalDB();
    return c.json({ settings, manageable });
  });
});

// PUT /settings/:key — set or update a settings override
admin.put("/settings/:key", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json(
      { error: "not_available", message: "Settings overrides require an internal database (DATABASE_URL)." },
      404,
    );
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const key = c.req.param("key");

    // Validate that the key is in the registry
    const registry = getSettingsRegistry();
    const def = registry.find((s) => s.key === key);
    if (!def) {
      return c.json({ error: "invalid_request", message: `Unknown setting: "${key}".` }, 400);
    }

    // Secret settings are read-only
    if (def.secret) {
      return c.json({ error: "forbidden", message: "Secret settings cannot be modified from the UI." }, 403);
    }

    let body: { value?: unknown };
    try {
      body = (await c.req.json()) as { value?: unknown };
    } catch {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }

    if (body.value === undefined || body.value === null) {
      return c.json({ error: "invalid_request", message: "Missing 'value' in request body." }, 400);
    }

    const value = String(body.value);

    // Type-specific validation
    if (def.type === "number") {
      if (value === "") {
        return c.json({ error: "invalid_request", message: `"${key}" cannot be empty. Use DELETE to revert to default.` }, 400);
      }
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) {
        return c.json({ error: "invalid_request", message: `"${key}" must be a non-negative number.` }, 400);
      }
    }
    if (def.type === "boolean") {
      if (!["true", "false"].includes(value)) {
        return c.json({ error: "invalid_request", message: `"${key}" must be "true" or "false".` }, 400);
      }
    }
    if (def.type === "select" && def.options) {
      if (value !== "" && !def.options.includes(value)) {
        return c.json({ error: "invalid_request", message: `"${key}" must be one of: ${def.options.join(", ")}.` }, 400);
      }
    }

    try {
      await setSetting(key, value, authResult.user?.id);
      log.info({ requestId, key, actorId: authResult.user?.id }, "Setting override saved via admin API");
      return c.json({ success: true, key, value });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), key }, "Failed to save setting");
      return c.json({ error: "internal_error", message: "Failed to save setting." }, 500);
    }
  });
});

// DELETE /settings/:key — remove override, revert to env var / default
admin.delete("/settings/:key", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json(
      { error: "not_available", message: "Settings overrides require an internal database (DATABASE_URL)." },
      404,
    );
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const key = c.req.param("key");

    // Validate that the key is in the registry
    const registry = getSettingsRegistry();
    const def = registry.find((s) => s.key === key);
    if (!def) {
      return c.json({ error: "invalid_request", message: `Unknown setting: "${key}".` }, 400);
    }

    if (def.secret) {
      return c.json({ error: "forbidden", message: "Secret settings cannot be modified from the UI." }, 403);
    }

    try {
      await deleteSetting(key, authResult.user?.id);
      log.info({ requestId, key, actorId: authResult.user?.id }, "Setting override removed via admin API");
      return c.json({ success: true, key });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), key }, "Failed to delete setting");
      return c.json({ error: "internal_error", message: "Failed to delete setting." }, 500);
    }
  });
});

export { admin };
