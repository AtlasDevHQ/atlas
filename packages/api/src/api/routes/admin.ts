/**
 * Admin console API routes.
 *
 * Mounted at /api/v1/admin. All routes require admin role.
 * Browsing endpoints are read-only; health-check routes (POST) trigger
 * live probes and update cached health status.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { connections } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { plugins } from "@atlas/api/lib/plugins/registry";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { ATLAS_ROLES } from "@atlas/api/lib/auth/types";

const log = createLogger("admin-routes");

const admin = new Hono();

// ---------------------------------------------------------------------------
// Semantic layer root — resolves the semantic/ directory at cwd.
// ---------------------------------------------------------------------------

/**
 * @internal Exported for testing only. ATLAS_SEMANTIC_ROOT is a test-only
 * env var; in production the semantic root is always resolved from cwd.
 */
export function getSemanticRoot(): string {
  return process.env.ATLAS_SEMANTIC_ROOT ?? path.resolve(process.cwd(), "semantic");
}

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
    return { error: { error: "auth_error", message: authResult.error }, status: authResult.status as 401 | 403 | 500 };
  }

  // Enforce admin role — when auth mode is "none" (no auth configured, e.g.
  // local dev), treat the request as an implicit admin since there is no
  // identity boundary to enforce.
  if (authResult.mode !== "none" && (!authResult.user || authResult.user.role !== "admin")) {
    return { error: { error: "forbidden", message: "Admin role required." }, status: 403 as const };
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

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

/** Reject entity names that could escape the semantic root. */
function isValidEntityName(name: string): boolean {
  return !!(
    name &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..") &&
    !name.includes("\0")
  );
}

// ---------------------------------------------------------------------------
// YAML reading helpers
// ---------------------------------------------------------------------------

interface EntitySummary {
  table: string;
  description: string;
  columnCount: number;
  joinCount: number;
  measureCount: number;
  connection: string | null;
  type: string | null;
  source: string;
}

function readYamlFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");
  return yaml.load(content);
}

/**
 * Discover all entity YAML files from semantic/entities/ and
 * semantic/{source}/entities/. Entities in the top-level entities/
 * directory are tagged with source "default"; those under
 * semantic/{name}/entities/ use the subdirectory name as source.
 */
function discoverEntities(root: string): EntitySummary[] {
  const entities: EntitySummary[] = [];

  const defaultDir = path.join(root, "entities");
  if (fs.existsSync(defaultDir)) {
    loadEntitiesFromDir(defaultDir, "default", entities);
  }

  // Per-source subdirectories
  const RESERVED_DIRS = new Set(["entities", "metrics"]);
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subEntities = path.join(root, entry.name, "entities");
        if (fs.existsSync(subEntities)) {
          loadEntitiesFromDir(subEntities, entry.name, entities);
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to scan semantic root for per-source directories");
    }
  }

  return entities;
}

function loadEntitiesFromDir(dir: string, source: string, out: EntitySummary[]): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err : new Error(String(err)), dir, source }, "Failed to read entities directory");
    return;
  }

  for (const file of files) {
    try {
      const raw = readYamlFile(path.join(dir, file)) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || !raw.table) continue;

      const dimensions = raw.dimensions && typeof raw.dimensions === "object"
        ? Object.keys(raw.dimensions)
        : [];
      const joins = Array.isArray(raw.joins) ? raw.joins : (raw.joins && typeof raw.joins === "object" ? Object.keys(raw.joins) : []);
      const measures = Array.isArray(raw.measures) ? raw.measures : (raw.measures && typeof raw.measures === "object" ? Object.keys(raw.measures) : []);

      out.push({
        table: String(raw.table),
        description: typeof raw.description === "string" ? raw.description : "",
        columnCount: dimensions.length,
        joinCount: Array.isArray(joins) ? joins.length : 0,
        measureCount: Array.isArray(measures) ? measures.length : 0,
        connection: typeof raw.connection === "string" ? raw.connection : null,
        type: typeof raw.type === "string" ? raw.type : null,
        source,
      });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), file, dir, source }, "Failed to parse entity YAML file");
    }
  }
}

/**
 * Find a specific entity YAML file by table name. Searches all entity
 * directories. Caller must validate `name` with isValidEntityName() first.
 */
function findEntityFile(root: string, name: string): string | null {
  const defaultDir = path.join(root, "entities");
  const defaultFile = path.join(defaultDir, `${name}.yml`);
  if (fs.existsSync(defaultFile)) return defaultFile;

  // Search per-source subdirectories
  const RESERVED_DIRS = new Set(["entities", "metrics"]);
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subFile = path.join(root, entry.name, "entities", `${name}.yml`);
        if (fs.existsSync(subFile)) return subFile;
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root, name }, "Failed to scan subdirectories for entity file");
    }
  }

  return null;
}

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
    const entities = discoverEntities(root);
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

    return c.json({
      connections: connList.length,
      entities: entities.length,
      metrics: metrics.length,
      glossaryTerms: glossaryTermCount,
      plugins: pluginList.length,
      pluginHealth: pluginList.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        status: p.status,
      })),
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
    const entities = discoverEntities(root);
    return c.json({ entities });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serveRawYaml(c: any, requestId: string, filePath: string) {
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
    const entities = discoverEntities(root);

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
    });
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

// ---------------------------------------------------------------------------
// Audit routes
// ---------------------------------------------------------------------------

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
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    const user = c.req.query("user");
    if (user) {
      conditions.push(`user_id = $${paramIdx++}`);
      params.push(user);
    }

    const success = c.req.query("success");
    if (success === "true" || success === "false") {
      conditions.push(`success = $${paramIdx++}`);
      params.push(success === "true");
    }

    const from = c.req.query("from");
    if (from) {
      if (isNaN(Date.parse(from))) {
        return c.json({ error: "invalid_request", message: `Invalid 'from' date format: "${from}". Use ISO 8601 (e.g. 2026-01-01).` }, 400);
      }
      conditions.push(`timestamp >= $${paramIdx++}`);
      params.push(from);
    }

    const to = c.req.query("to");
    if (to) {
      if (isNaN(Date.parse(to))) {
        return c.json({ error: "invalid_request", message: `Invalid 'to' date format: "${to}". Use ISO 8601 (e.g. 2026-03-03).` }, 400);
      }
      conditions.push(`timestamp <= $${paramIdx++}`);
      params.push(to);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
      const countResult = await internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM audit_log ${whereClause}`,
        params,
      );
      const total = parseInt(String(countResult[0]?.count ?? "0"), 10);

      const rows = await internalQuery(
        `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      );

      return c.json({ rows, total, limit, offset });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Audit query failed");
      return c.json({ error: "internal_error", message: "Failed to query audit log." }, 500);
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
      const errorRate = total > 0 ? errors / total : 0;

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
    return c.json({ plugins: pluginList });
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
    return c.json({ error: "auth_error", message: authResult.error }, authResult.status);
  }
  if (authResult.mode !== "managed" || !authResult.user) {
    return c.json({ passwordChangeRequired: false });
  }

  if (!hasInternalDB()) return c.json({ passwordChangeRequired: false });

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const rows = await internalQuery<{ password_change_required: boolean }>(
        `SELECT password_change_required FROM "user" WHERE id = $1`,
        [authResult.user!.id],
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
    return c.json({ error: "auth_error", message: authResult.error }, authResult.status);
  }
  if (authResult.mode !== "managed" || !authResult.user) {
    return c.json({ error: "not_available", message: "Password change requires managed auth mode." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const body = await c.req.json().catch(() => null);
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
          [authResult.user!.id],
        );
      }

      log.info({ requestId, userId: authResult.user!.id }, "Password changed and flag cleared");
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
          role: u.role ?? "viewer",
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
        `SELECT COALESCE(role, 'viewer') as role, COUNT(*) as count FROM "user" GROUP BY COALESCE(role, 'viewer')`,
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
    const body = await c.req.json().catch(() => null);
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

    const body = await c.req.json().catch(() => ({}));

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

export { admin };
