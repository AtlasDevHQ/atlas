/**
 * Public semantic layer API routes.
 *
 * Mounted at /api/v1/semantic. Available to all authenticated users (not admin-gated).
 * Provides read-only access to entity metadata, enabling the schema explorer UI.
 *
 * These mirror a subset of the admin semantic endpoints but with standard auth.
 * Only entities present in the semantic layer (respecting the table whitelist) are returned.
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

const log = createLogger("semantic-routes");

export const semantic = new Hono();

// ---------------------------------------------------------------------------
// Semantic layer root — resolves the semantic/ directory at cwd.
// ---------------------------------------------------------------------------

/** @internal Exported for testing only. */
export function getSemanticRoot(): string {
  return process.env.ATLAS_SEMANTIC_ROOT ?? path.resolve(process.cwd(), "semantic");
}

// ---------------------------------------------------------------------------
// Auth preamble — standard auth (no admin role required).
// ---------------------------------------------------------------------------

async function authPreamble(req: Request, requestId: string) {
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
  type: string | null;
}

function readYamlFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");
  return yaml.load(content);
}

function discoverEntities(root: string): EntitySummary[] {
  const entities: EntitySummary[] = [];

  const defaultDir = path.join(root, "entities");
  if (fs.existsSync(defaultDir)) {
    loadEntitiesFromDir(defaultDir, entities);
  }

  const RESERVED_DIRS = new Set(["entities", "metrics"]);
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subEntities = path.join(root, entry.name, "entities");
        if (fs.existsSync(subEntities)) {
          loadEntitiesFromDir(subEntities, entities);
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to scan semantic root");
    }
  }

  return entities;
}

function loadEntitiesFromDir(dir: string, out: EntitySummary[]): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err : new Error(String(err)), dir }, "Failed to read entities directory");
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

      out.push({
        table: String(raw.table),
        description: typeof raw.description === "string" ? raw.description : "",
        columnCount: dimensions.length,
        joinCount: Array.isArray(joins) ? joins.length : 0,
        type: typeof raw.type === "string" ? raw.type : null,
      });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), file, dir }, "Failed to parse entity YAML");
    }
  }
}

function findEntityFile(root: string, name: string): string | null {
  const defaultDir = path.join(root, "entities");
  const defaultFile = path.join(defaultDir, `${name}.yml`);
  if (fs.existsSync(defaultFile)) return defaultFile;

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
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root, name }, "Failed to scan subdirectories");
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /entities — list all entities
semantic.get("/entities", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
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

// GET /entities/:name — full entity detail
semantic.get("/entities/:name", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const name = c.req.param("name");

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
