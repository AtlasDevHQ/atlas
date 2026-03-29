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
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createLogger, withRequestContext, getRequestContext } from "@atlas/api/lib/logger";
import { withRequestId } from "./middleware";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { authenticateRequest } from "@atlas/api/lib/auth/middleware";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, encryptUrl, decryptUrl } from "@atlas/api/lib/db/internal";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { plugins } from "@atlas/api/lib/plugins/registry";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import { savePluginEnabled, savePluginConfig, getPluginConfig } from "@atlas/api/lib/plugins/settings";
import {
  getSettingsForAdmin,
  getSettingDefinition,
  setSetting,
  deleteSetting,
} from "@atlas/api/lib/settings";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { getConfig } from "@atlas/api/lib/config";
import type { AtlasRole } from "@atlas/api/lib/auth/types";
import { ATLAS_ROLES } from "@atlas/api/lib/auth/types";
import {
  getSemanticRoot,
  isValidEntityName,
  readYamlFile,
  discoverEntities,
  findEntityFile,
} from "@atlas/api/lib/semantic/files";
import { runDiff } from "@atlas/api/lib/semantic/diff";
import { adminOrgs } from "./admin-orgs";
import { adminLearnedPatterns } from "./admin-learned-patterns";
import { adminPrompts } from "./admin-prompts";
import { adminSuggestions } from "./admin-suggestions";
import { adminSso } from "./admin-sso";
import { adminScim } from "./admin-scim";
import { adminIPAllowlist } from "./admin-ip-allowlist";
import { adminRoles } from "./admin-roles";
import { adminModelConfig } from "./admin-model-config";
import { adminAuthPreamble, authErrorCode, requireAdminAuth } from "./admin-auth";
import { adminUsage } from "./admin-usage";
import { adminAuditRetention } from "./admin-audit-retention";
import { adminApproval } from "./admin-approval";
import { adminCompliance } from "./admin-compliance";
import { adminBranding } from "./admin-branding";
import { adminDomains } from "./admin-domains";
import { adminOnboardingEmails } from "./admin-onboarding-emails";
import { adminAbuse } from "./admin-abuse";
import { adminIntegrations } from "./admin-integrations";
import { adminSandbox } from "./admin-sandbox";
import { adminResidency } from "./admin-residency";
import { ErrorSchema, AuthErrorSchema, parsePagination } from "./shared-schemas";
import { runHandler } from "@atlas/api/lib/effect/hono";

const log = createLogger("admin-routes");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Note: admin.ts does NOT use AuthEnv to avoid @hono/zod-openapi type
// inference issues with custom Env on z.record() response schemas.
// Middleware sets requestId via withRequestId; handlers read it with reqId().
const admin = new OpenAPIHono({ defaultHook: validationHook });

/** Read requestId from middleware context. */
const reqId = (c: { get(key: string): unknown }): string => c.get("requestId") as string;

/**
 * Run admin auth preamble and bind user identity into AsyncLocalStorage.
 * Returns { authResult, requestId } for the handler to use.
 * Throws HTTPException on auth failure.
 */
async function adminAuthAndContext(c: { req: { raw: Request }; get(key: string): unknown }): Promise<{ authResult: AuthResult & { authenticated: true }; requestId: string }> {
  const requestId = reqId(c);
  const preamble = await adminAuthPreamble(c.req.raw, requestId);
  requireAdminAuth(preamble);
  const { authResult } = preamble;
  // Bind user identity into the existing AsyncLocalStorage context so
  // downstream log lines include userId. The context was created by
  // withRequestId middleware with { requestId } only — mutating is safe
  // because each request has its own context object.
  const ctx = getRequestContext();
  if (ctx) {
    (ctx as unknown as Record<string, unknown>).user = authResult.user;
  }
  return { authResult, requestId };
}

/**
 * Verify that target user is a member of the caller's active org.
 * Platform admins and self-hosted (no org context) bypass the check.
 * Returns true if the action may proceed, false if the target user is not
 * in the caller's org (caller should return 404 to avoid revealing existence).
 */
async function verifyOrgMembership(
  authResult: AuthResult & { authenticated: true },
  targetUserId: string,
): Promise<boolean> {
  const orgId = authResult.user?.activeOrganizationId;
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  // Platform admins — always allowed
  if (!orgId || isPlatformAdmin) return true;
  // No internal DB — can't verify membership. Log if org context is present
  // since this may indicate a misconfigured SaaS deployment.
  if (!hasInternalDB()) {
    log.warn({ orgId, targetUserId }, "Org membership check skipped — no internal DB available despite org context");
    return true;
  }
  try {
    const rows = await internalQuery<{ userId: string }>(
      `SELECT "userId" FROM member WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
      [targetUserId, orgId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), targetUserId, orgId }, "Org membership check failed");
    throw err;
  }
}

admin.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
  }
  throw err;
});

admin.use(withRequestId);

// Mount organization management sub-router
admin.route("/organizations", adminOrgs);
admin.route("/learned-patterns", adminLearnedPatterns);
admin.route("/learned-patterns/", adminLearnedPatterns);
admin.route("/prompts", adminPrompts);
admin.route("/prompts/", adminPrompts);
admin.route("/suggestions", adminSuggestions);
admin.route("/suggestions/", adminSuggestions);
admin.route("/usage", adminUsage);
admin.route("/usage/", adminUsage);
admin.route("/sso", adminSso);
admin.route("/sso/", adminSso);
admin.route("/scim", adminScim);
admin.route("/scim/", adminScim);
admin.route("/ip-allowlist", adminIPAllowlist);
admin.route("/ip-allowlist/", adminIPAllowlist);
admin.route("/roles", adminRoles);
admin.route("/roles/", adminRoles);
admin.route("/audit/retention", adminAuditRetention);
admin.route("/audit/retention/", adminAuditRetention);
admin.route("/model-config", adminModelConfig);
admin.route("/model-config/", adminModelConfig);
admin.route("/approval", adminApproval);
admin.route("/approval/", adminApproval);
admin.route("/compliance", adminCompliance);
admin.route("/compliance/", adminCompliance);
admin.route("/branding", adminBranding);
admin.route("/branding/", adminBranding);
admin.route("/domain", adminDomains);
admin.route("/domain/", adminDomains);
admin.route("/onboarding-emails", adminOnboardingEmails);
admin.route("/onboarding-emails/", adminOnboardingEmails);
admin.route("/abuse", adminAbuse);
admin.route("/abuse/", adminAbuse);
admin.route("/integrations", adminIntegrations);
admin.route("/integrations/", adminIntegrations);
admin.route("/sandbox", adminSandbox);
admin.route("/sandbox/", adminSandbox);
admin.route("/residency", adminResidency);
admin.route("/residency/", adminResidency);

// Path traversal guard, YAML helpers, entity discovery, and file finding
// are all imported from @atlas/api/lib/semantic/files above.

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

function serveRawYaml(_c: Context, requestId: string, filePath: string): never {
  // All paths throw HTTPException to bypass OpenAPI typed-return constraints.
  // The route definitions declare text/plain 200 and JSON error codes, but c.text()
  // returns a plain Response that doesn't satisfy the typed response contract.

  // Validate: no traversal, must be .yml
  if (filePath.includes("..") || filePath.includes("\0") || filePath.includes("\\") || !filePath.endsWith(".yml")) {
    throw new HTTPException(400, {
      res: Response.json({ error: "invalid_request", message: "Invalid file path." }, { status: 400 }),
    });
  }

  const allowedPattern = /^(catalog|glossary)\.yml$|^(entities|metrics)\/[a-zA-Z0-9_-]+\.yml$/;
  if (!allowedPattern.test(filePath)) {
    throw new HTTPException(400, {
      res: Response.json({ error: "invalid_request", message: "File path not allowed." }, { status: 400 }),
    });
  }

  const root = getSemanticRoot();
  const resolved = path.resolve(root, filePath);
  if (!resolved.startsWith(path.resolve(root))) {
    log.error({ requestId, filePath, resolved, root }, "Raw YAML path escaped semantic root");
    throw new HTTPException(403, {
      res: Response.json({ error: "forbidden", message: "Access denied.", requestId }, { status: 403 }),
    });
  }

  if (!fs.existsSync(resolved)) {
    throw new HTTPException(404, {
      res: Response.json({ error: "not_found", message: `File "${filePath}" not found.` }, { status: 404 }),
    });
  }

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    throw new HTTPException(200, {
      res: new Response(content, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    });
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    log.error({ err: err instanceof Error ? err : new Error(String(err)), filePath }, "Failed to read raw YAML file");
    throw new HTTPException(500, {
      res: Response.json({ error: "internal_error", message: "Failed to read file.", requestId }, { status: 500 }),
    });
  }
}

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
  // Always exclude soft-deleted entries from normal audit views
  const conditions: string[] = ["a.deleted_at IS NULL"];
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

/** Build WHERE clause from optional `from` and `to` query params. */
function analyticsDateRange(c: { req: { query(name: string): string | undefined } }) {
  // Always exclude soft-deleted entries from analytics
  const conditions: string[] = ["deleted_at IS NULL"];
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

const VALID_ENTITY_TYPES = new Set(["entity", "metric", "glossary", "catalog"]);

type SemanticEntityType = "entity" | "metric" | "glossary" | "catalog";

function validateEntityType(raw: string | undefined, defaultType: string = "entity"): SemanticEntityType | null {
  const value = raw ?? defaultType;
  return VALID_ENTITY_TYPES.has(value) ? value as SemanticEntityType : null;
}

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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

// -- Overview ---------------------------------------------------------------

const overviewRoute = createRoute({
  method: "get",
  path: "/overview",
  tags: ["Admin — Overview"],
  summary: "Dashboard overview",
  description: "Returns aggregate counts for connections, entities, metrics, glossary terms, plugins, and health warnings.",
  responses: {
    200: {
      description: "Dashboard overview data",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Semantic Layer ---------------------------------------------------------

const listEntitiesRoute = createRoute({
  method: "get",
  path: "/semantic/entities",
  tags: ["Admin — Semantic"],
  summary: "List semantic entities",
  description: "Returns all discovered semantic layer entities from YAML files.",
  responses: {
    200: {
      description: "Entity list with optional warnings",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getEntityRoute = createRoute({
  method: "get",
  path: "/semantic/entities/{name}",
  tags: ["Admin — Semantic"],
  summary: "Get entity detail",
  description: "Returns the full parsed YAML for a single semantic entity.",
  request: {
    params: z.object({
      name: z.string().min(1).openapi({ param: { name: "name", in: "path" }, example: "users" }),
    }),
  },
  responses: {
    200: {
      description: "Entity detail",
      content: { "application/json": { schema: z.object({ entity: z.unknown() }) } },
    },
    400: { description: "Invalid entity name", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Entity not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listMetricsRoute = createRoute({
  method: "get",
  path: "/semantic/metrics",
  tags: ["Admin — Semantic"],
  summary: "List semantic metrics",
  description: "Returns all discovered semantic metrics from YAML files.",
  responses: {
    200: {
      description: "Metrics list",
      content: { "application/json": { schema: z.object({ metrics: z.array(z.unknown()) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getGlossaryRoute = createRoute({
  method: "get",
  path: "/semantic/glossary",
  tags: ["Admin — Semantic"],
  summary: "Get glossary",
  description: "Returns all glossary terms from semantic/glossary.yml and per-source glossaries.",
  responses: {
    200: {
      description: "Glossary data",
      content: { "application/json": { schema: z.object({ glossary: z.array(z.unknown()) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getCatalogRoute = createRoute({
  method: "get",
  path: "/semantic/catalog",
  tags: ["Admin — Semantic"],
  summary: "Get catalog",
  description: "Returns the semantic layer catalog (catalog.yml) if it exists.",
  responses: {
    200: {
      description: "Catalog data",
      content: { "application/json": { schema: z.object({ catalog: z.unknown() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRawYamlDirFileRoute = createRoute({
  method: "get",
  path: "/semantic/raw/{dir}/{file}",
  tags: ["Admin — Semantic"],
  summary: "Get raw YAML (subdirectory)",
  description: "Serves raw YAML content for a file in a subdirectory (e.g. entities/users.yml).",
  request: {
    params: z.object({
      dir: z.string().min(1).openapi({ param: { name: "dir", in: "path" }, example: "entities" }),
      file: z.string().min(1).openapi({ param: { name: "file", in: "path" }, example: "users.yml" }),
    }),
  },
  responses: {
    200: { description: "Raw YAML content", content: { "text/plain": { schema: z.string() } } },
    400: { description: "Invalid file path", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "File not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRawYamlFileRoute = createRoute({
  method: "get",
  path: "/semantic/raw/{file}",
  tags: ["Admin — Semantic"],
  summary: "Get raw YAML (top-level)",
  description: "Serves raw YAML content for a top-level file (catalog.yml, glossary.yml).",
  request: {
    params: z.object({
      file: z.string().min(1).openapi({ param: { name: "file", in: "path" }, example: "glossary.yml" }),
    }),
  },
  responses: {
    200: { description: "Raw YAML content", content: { "text/plain": { schema: z.string() } } },
    400: { description: "Invalid file path", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "File not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getSemanticStatsRoute = createRoute({
  method: "get",
  path: "/semantic/stats",
  tags: ["Admin — Semantic"],
  summary: "Semantic layer stats",
  description: "Returns aggregate stats: entity count, column count, join count, measure count, coverage gaps.",
  responses: {
    200: {
      description: "Semantic layer statistics",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getSemanticDiffRoute = createRoute({
  method: "get",
  path: "/semantic/diff",
  tags: ["Admin — Semantic"],
  summary: "Schema diff",
  description: "Compares the live database schema against YAML entity definitions. Optionally specify a connection via ?connection=id.",
  responses: {
    200: {
      description: "Schema diff result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Org-scoped semantic CRUD -----------------------------------------------

const listOrgEntitiesRoute = createRoute({
  method: "get",
  path: "/semantic/org/entities",
  tags: ["Admin — Semantic"],
  summary: "List org semantic entities",
  description: "Lists DB-backed semantic entities for the active organization.",
  responses: {
    200: {
      description: "Org entity list",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "No active organization or invalid type", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    501: { description: "Internal database not available", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getOrgEntityRoute = createRoute({
  method: "get",
  path: "/semantic/org/entities/{name}",
  tags: ["Admin — Semantic"],
  summary: "Get org semantic entity",
  description: "Returns a single DB-backed semantic entity for the active organization.",
  request: {
    params: z.object({
      name: z.string().min(1).openapi({ param: { name: "name", in: "path" }, example: "users" }),
    }),
  },
  responses: {
    200: {
      description: "Org entity detail",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "No active organization or invalid type", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Entity not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    501: { description: "Internal database not available", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const putOrgEntityRoute = createRoute({
  method: "put",
  path: "/semantic/org/entities/{name}",
  tags: ["Admin — Semantic"],
  summary: "Create or update org semantic entity",
  description: "Upserts a DB-backed semantic entity for the active organization.",
  request: {
    params: z.object({
      name: z.string().min(1).openapi({ param: { name: "name", in: "path" }, example: "users" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            yamlContent: z.string(),
            entityType: z.string().optional(),
            connectionId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Entity upserted",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), name: z.string(), entityType: z.string() }) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    501: { description: "Internal database not available", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteOrgEntityRoute = createRoute({
  method: "delete",
  path: "/semantic/org/entities/{name}",
  tags: ["Admin — Semantic"],
  summary: "Delete org semantic entity",
  description: "Deletes a DB-backed semantic entity for the active organization.",
  request: {
    params: z.object({
      name: z.string().min(1).openapi({ param: { name: "name", in: "path" }, example: "users" }),
    }),
  },
  responses: {
    200: {
      description: "Entity deleted",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), name: z.string(), entityType: z.string() }) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Entity not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    501: { description: "Internal database not available", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const importOrgEntitiesRoute = createRoute({
  method: "post",
  path: "/semantic/org/import",
  tags: ["Admin — Semantic"],
  summary: "Bulk import org entities from disk",
  description: "Imports semantic entities from the org's disk directory into the database.",
  responses: {
    200: {
      description: "Import result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    501: { description: "Internal database not available", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Connections -------------------------------------------------------------

const listConnectionsRoute = createRoute({
  method: "get",
  path: "/connections",
  tags: ["Admin — Connections"],
  summary: "List connections",
  description: "Returns all registered database connections.",
  responses: {
    200: {
      description: "Connection list",
      content: { "application/json": { schema: z.object({ connections: z.array(z.unknown()) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getPoolMetricsRoute = createRoute({
  method: "get",
  path: "/connections/pool",
  tags: ["Admin — Connections"],
  summary: "Pool metrics",
  description: "Returns connection pool metrics for all connections.",
  responses: {
    200: {
      description: "Pool metrics",
      content: { "application/json": { schema: z.object({ metrics: z.unknown() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getOrgPoolMetricsRoute = createRoute({
  method: "get",
  path: "/connections/pool/orgs",
  tags: ["Admin — Connections"],
  summary: "Org-scoped pool metrics",
  description: "Returns connection pool metrics scoped by organization.",
  responses: {
    200: {
      description: "Org pool metrics",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const drainOrgPoolRoute = createRoute({
  method: "post",
  path: "/connections/pool/orgs/{orgId}/drain",
  tags: ["Admin — Connections"],
  summary: "Drain org pools",
  description: "Drains all connection pools for a specific organization.",
  request: {
    params: z.object({
      orgId: z.string().min(1).openapi({ param: { name: "orgId", in: "path" }, example: "org_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Drain result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const drainConnectionPoolRoute = createRoute({
  method: "post",
  path: "/connections/{id}/drain",
  tags: ["Admin — Connections"],
  summary: "Drain connection pool",
  description: "Drains and recreates the pool for a specific connection.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Pool drained",
      content: { "application/json": { schema: z.object({ drained: z.boolean(), message: z.string() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Pool drain conflict", content: { "application/json": { schema: z.object({ drained: z.boolean(), message: z.string() }) } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getCacheStatsRoute = createRoute({
  method: "get",
  path: "/cache/stats",
  tags: ["Admin — Connections"],
  summary: "Cache statistics",
  description: "Returns cache hit/miss statistics.",
  responses: {
    200: {
      description: "Cache stats",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const flushCacheRoute = createRoute({
  method: "post",
  path: "/cache/flush",
  tags: ["Admin — Connections"],
  summary: "Flush cache",
  description: "Flushes all cache entries.",
  responses: {
    200: {
      description: "Cache flushed",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), flushed: z.number(), message: z.string() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const testConnectionRoute = createRoute({
  method: "post",
  path: "/connections/test",
  tags: ["Admin — Connections"],
  summary: "Test connection URL",
  description: "Tests a database connection URL without persisting it.",
  responses: {
    200: {
      description: "Connection test result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid request or connection failed", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const testExistingConnectionRoute = createRoute({
  method: "post",
  path: "/connections/{id}/test",
  tags: ["Admin — Connections"],
  summary: "Health check connection",
  description: "Runs a health check on an existing connection.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Health check result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createConnectionRoute = createRoute({
  method: "post",
  path: "/connections",
  tags: ["Admin — Connections"],
  summary: "Create connection",
  description: "Creates a new database connection. Tests it before saving.",
  responses: {
    201: {
      description: "Connection created",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid request or connection failed", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Connection already exists", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateConnectionRoute = createRoute({
  method: "put",
  path: "/connections/{id}",
  tags: ["Admin — Connections"],
  summary: "Update connection",
  description: "Updates an existing connection's URL, description, or schema.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Connection updated",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid request or connection failed", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteConnectionRoute = createRoute({
  method: "delete",
  path: "/connections/{id}",
  tags: ["Admin — Connections"],
  summary: "Delete connection",
  description: "Removes a connection from the registry and internal database.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Connection deleted",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Connection has references", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getConnectionRoute = createRoute({
  method: "get",
  path: "/connections/{id}",
  tags: ["Admin — Connections"],
  summary: "Get connection detail",
  description: "Returns connection detail including masked URL and schema.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Connection detail",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Audit ------------------------------------------------------------------

const listAuditRoute = createRoute({
  method: "get",
  path: "/audit",
  tags: ["Admin — Audit"],
  summary: "Query audit log",
  description: "Returns paginated audit log entries with optional filters for user, success, date range, connection, table, column, and search.",
  responses: {
    200: {
      description: "Audit log entries",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid filter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const exportAuditRoute = createRoute({
  method: "get",
  path: "/audit/export",
  tags: ["Admin — Audit"],
  summary: "Export audit log as CSV",
  description: "Exports audit log entries as a CSV file (up to 10,000 rows). Respects current filters.",
  responses: {
    200: { description: "CSV file", content: { "text/csv": { schema: z.string() } } },
    400: { description: "Invalid filter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getAuditStatsRoute = createRoute({
  method: "get",
  path: "/audit/stats",
  tags: ["Admin — Audit"],
  summary: "Audit statistics",
  description: "Returns aggregate audit stats: total queries, error count, error rate, and queries per day for the last 7 days.",
  responses: {
    200: {
      description: "Audit statistics",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getAuditFacetsRoute = createRoute({
  method: "get",
  path: "/audit/facets",
  tags: ["Admin — Audit"],
  summary: "Audit filter facets",
  description: "Returns distinct tables and columns from the audit log for filter dropdowns.",
  responses: {
    200: {
      description: "Facet values",
      content: { "application/json": { schema: z.object({ tables: z.array(z.string()), columns: z.array(z.string()) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Audit Analytics --------------------------------------------------------

const auditVolumeRoute = createRoute({
  method: "get",
  path: "/audit/analytics/volume",
  tags: ["Admin — Audit Analytics"],
  summary: "Query volume over time",
  description: "Returns queries per day over an optional date range.",
  responses: {
    200: {
      description: "Volume data",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const auditSlowRoute = createRoute({
  method: "get",
  path: "/audit/analytics/slow",
  tags: ["Admin — Audit Analytics"],
  summary: "Slowest queries",
  description: "Returns top 20 queries by average duration.",
  responses: {
    200: {
      description: "Slow query data",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const auditFrequentRoute = createRoute({
  method: "get",
  path: "/audit/analytics/frequent",
  tags: ["Admin — Audit Analytics"],
  summary: "Most frequent queries",
  description: "Returns top 20 queries by execution count.",
  responses: {
    200: {
      description: "Frequent query data",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const auditErrorsRoute = createRoute({
  method: "get",
  path: "/audit/analytics/errors",
  tags: ["Admin — Audit Analytics"],
  summary: "Error distribution",
  description: "Returns error count grouped by error message pattern.",
  responses: {
    200: {
      description: "Error analytics data",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const auditUsersRoute = createRoute({
  method: "get",
  path: "/audit/analytics/users",
  tags: ["Admin — Audit Analytics"],
  summary: "Per-user stats",
  description: "Returns per-user query stats: count, average duration, error count, error rate.",
  responses: {
    200: {
      description: "User analytics data",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Plugins ----------------------------------------------------------------

const listPluginsRoute = createRoute({
  method: "get",
  path: "/plugins",
  tags: ["Admin — Plugins"],
  summary: "List plugins",
  description: "Returns all installed plugins with their status.",
  responses: {
    200: {
      description: "Plugin list",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const PluginHealthResponseSchema = z.object({
  healthy: z.boolean(),
  message: z.string().nullable().optional(),
  latencyMs: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
  error: z.string().optional(),
});

const pluginHealthRoute = createRoute({
  method: "post",
  path: "/plugins/{id}/health",
  tags: ["Admin — Plugins"],
  summary: "Plugin health check",
  description: "Triggers a health check for a specific plugin.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Health check result",
      content: { "application/json": { schema: PluginHealthResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const PluginToggleResponseSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  status: z.string().nullable(),
  persisted: z.boolean(),
  warning: z.string().optional(),
});

const enablePluginRoute = createRoute({
  method: "post",
  path: "/plugins/{id}/enable",
  tags: ["Admin — Plugins"],
  summary: "Enable plugin",
  description: "Enables a plugin. Persists to DB if available.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Plugin enabled",
      content: { "application/json": { schema: PluginToggleResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const disablePluginRoute = createRoute({
  method: "post",
  path: "/plugins/{id}/disable",
  tags: ["Admin — Plugins"],
  summary: "Disable plugin",
  description: "Disables a plugin. Persists to DB if available.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Plugin disabled",
      content: { "application/json": { schema: PluginToggleResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getPluginSchemaRoute = createRoute({
  method: "get",
  path: "/plugins/{id}/schema",
  tags: ["Admin — Plugins"],
  summary: "Plugin config schema",
  description: "Returns the configuration schema and current values for a plugin.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Plugin schema and values",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updatePluginConfigRoute = createRoute({
  method: "put",
  path: "/plugins/{id}/config",
  tags: ["Admin — Plugins"],
  summary: "Update plugin config",
  description: "Updates the configuration for a plugin. Validates against the schema if available.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "bigquery" }),
    }),
  },
  responses: {
    200: {
      description: "Config saved",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Validation error", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Plugin not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Password ---------------------------------------------------------------

const getPasswordStatusRoute = createRoute({
  method: "get",
  path: "/me/password-status",
  tags: ["Admin — Password"],
  summary: "Check password status",
  description: "Checks if the current user must change their password. Requires authentication but not admin role.",
  responses: {
    200: {
      description: "Password status",
      content: { "application/json": { schema: z.object({ passwordChangeRequired: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — SSO enforcement active", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const changePasswordRoute = createRoute({
  method: "post",
  path: "/me/password",
  tags: ["Admin — Password"],
  summary: "Change password",
  description: "Changes the current user's password and clears the password_change_required flag. Requires managed auth mode.",
  responses: {
    200: {
      description: "Password changed",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — SSO enforcement active", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Sessions ---------------------------------------------------------------

const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Admin — Sessions"],
  summary: "List sessions",
  description: "Returns paginated active sessions with user info. Supports search by email or IP.",
  responses: {
    200: {
      description: "Session list",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getSessionStatsRoute = createRoute({
  method: "get",
  path: "/sessions/stats",
  tags: ["Admin — Sessions"],
  summary: "Session statistics",
  description: "Returns total, active, and unique user session counts.",
  responses: {
    200: {
      description: "Session stats",
      content: { "application/json": { schema: z.object({ total: z.number(), active: z.number(), uniqueUsers: z.number() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/sessions/{id}",
  tags: ["Admin — Sessions"],
  summary: "Revoke session",
  description: "Revokes a single session by ID.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "sess_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Session revoked",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Session not found or not available", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteUserSessionsRoute = createRoute({
  method: "delete",
  path: "/sessions/user/{userId}",
  tags: ["Admin — Sessions"],
  summary: "Revoke all user sessions",
  description: "Revokes all sessions for a specific user.",
  request: {
    params: z.object({
      userId: z.string().min(1).openapi({ param: { name: "userId", in: "path" }, example: "user_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Sessions revoked",
      content: { "application/json": { schema: z.object({ success: z.boolean(), count: z.number() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No sessions found or not available", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Users ------------------------------------------------------------------

const listUsersRoute = createRoute({
  method: "get",
  path: "/users",
  tags: ["Admin — Users"],
  summary: "List users",
  description: "Returns paginated users with optional search and role filtering.",
  responses: {
    200: {
      description: "User list",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getUserStatsRoute = createRoute({
  method: "get",
  path: "/users/stats",
  tags: ["Admin — Users"],
  summary: "User statistics",
  description: "Returns aggregate user stats: total, banned, and breakdown by role.",
  responses: {
    200: {
      description: "User stats",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const changeUserRoleRoute = createRoute({
  method: "patch",
  path: "/users/{id}/role",
  tags: ["Admin — Users"],
  summary: "Change user role",
  description: "Changes a user's role. Cannot change own role or demote the last admin.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "user_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Role changed",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: "Invalid role", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const banUserRoute = createRoute({
  method: "post",
  path: "/users/{id}/ban",
  tags: ["Admin — Users"],
  summary: "Ban user",
  description: "Bans a user with optional reason and expiry.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "user_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "User banned",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const unbanUserRoute = createRoute({
  method: "post",
  path: "/users/{id}/unban",
  tags: ["Admin — Users"],
  summary: "Unban user",
  description: "Removes a ban from a user.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "user_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "User unbanned",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteUserRoute = createRoute({
  method: "delete",
  path: "/users/{id}",
  tags: ["Admin — Users"],
  summary: "Delete user",
  description: "Permanently deletes a user. Cannot delete yourself or the last admin.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "user_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "User deleted",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeUserSessionsRoute = createRoute({
  method: "post",
  path: "/users/{id}/revoke",
  tags: ["Admin — Users"],
  summary: "Revoke user sessions",
  description: "Revokes all sessions for a user (force logout).",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "user_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Sessions revoked",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Invitations ------------------------------------------------------------

const inviteUserRoute = createRoute({
  method: "post",
  path: "/users/invite",
  tags: ["Admin — Invitations"],
  summary: "Create invitation",
  description: "Creates an invitation for a new user. Optionally sends an email via Resend.",
  responses: {
    200: {
      description: "Invitation created",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "User or invitation already exists", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/users/invitations",
  tags: ["Admin — Invitations"],
  summary: "List invitations",
  description: "Returns invitations with optional status filter (pending, accepted, revoked, expired).",
  responses: {
    200: {
      description: "Invitation list",
      content: { "application/json": { schema: z.object({ invitations: z.array(z.unknown()) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeInvitationRoute = createRoute({
  method: "delete",
  path: "/users/invitations/{id}",
  tags: ["Admin — Invitations"],
  summary: "Revoke invitation",
  description: "Revokes a pending invitation.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "inv_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Invitation revoked",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Invitation not found or not available", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Tokens -----------------------------------------------------------------

const getTokenSummaryRoute = createRoute({
  method: "get",
  path: "/tokens/summary",
  tags: ["Admin — Tokens"],
  summary: "Token usage summary",
  description: "Returns total token consumption with prompt/completion breakdown over a date range.",
  responses: {
    200: {
      description: "Token summary",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getTokensByUserRoute = createRoute({
  method: "get",
  path: "/tokens/by-user",
  tags: ["Admin — Tokens"],
  summary: "Token usage by user",
  description: "Returns top N users by token consumption over a date range.",
  responses: {
    200: {
      description: "Token usage by user",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getTokenTrendsRoute = createRoute({
  method: "get",
  path: "/tokens/trends",
  tags: ["Admin — Tokens"],
  summary: "Token usage trends",
  description: "Returns time-series token usage data for charting.",
  responses: {
    200: {
      description: "Token trends",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// -- Settings ---------------------------------------------------------------

const getSettingsRoute = createRoute({
  method: "get",
  path: "/settings",
  tags: ["Admin — Settings"],
  summary: "Get all settings",
  description: "Returns all known settings with current values and sources.",
  responses: {
    200: {
      description: "Settings list",
      content: { "application/json": { schema: z.object({
        settings: z.array(z.object({
          key: z.string(),
          section: z.string(),
          label: z.string(),
          description: z.string(),
          type: z.enum(["string", "number", "boolean", "select"]),
          options: z.array(z.string()).optional(),
          default: z.string().optional(),
          secret: z.boolean().optional(),
          envVar: z.string(),
          requiresRestart: z.boolean().optional(),
          scope: z.enum(["platform", "workspace"]),
          currentValue: z.string().optional(),
          source: z.enum(["env", "override", "workspace-override", "default"]),
        })),
        manageable: z.boolean().describe("Whether settings can be persisted (internal DB is available)"),
        deployMode: z.enum(["self-hosted", "saas"]).describe("Current deploy mode"),
      }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateSettingRoute = createRoute({
  method: "put",
  path: "/settings/{key}",
  tags: ["Admin — Settings"],
  summary: "Update setting",
  description: "Sets or updates a settings override. Requires internal database.",
  request: {
    params: z.object({
      key: z.string().min(1).openapi({ param: { name: "key", in: "path" }, example: "ATLAS_ROW_LIMIT" }),
    }),
  },
  responses: {
    200: {
      description: "Setting saved",
      content: { "application/json": { schema: z.object({ success: z.boolean(), key: z.string(), value: z.string() }) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteSettingRoute = createRoute({
  method: "delete",
  path: "/settings/{key}",
  tags: ["Admin — Settings"],
  summary: "Delete setting override",
  description: "Removes a settings override, reverting to env var or default value.",
  request: {
    params: z.object({
      key: z.string().min(1).openapi({ param: { name: "key", in: "path" }, example: "ATLAS_ROW_LIMIT" }),
    }),
  },
  responses: {
    200: {
      description: "Setting deleted",
      content: { "application/json": { schema: z.object({ success: z.boolean(), key: z.string() }) } },
    },
    400: { description: "Unknown setting key", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// -- Overview ---------------------------------------------------------------

admin.openapi(overviewRoute, async (c) => {
  await adminAuthAndContext(c);
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
  }, 200);
});

// -- Semantic Layer ---------------------------------------------------------

admin.openapi(listEntitiesRoute, async (c) => {
  await adminAuthAndContext(c);
  const root = getSemanticRoot();
  const result = discoverEntities(root);
  return c.json({
    entities: result.entities,
    ...(result.warnings.length > 0 && { warnings: result.warnings }),
  }, 200);
});

admin.openapi(getEntityRoute, async (c) => {

  const { name } = c.req.valid("param");

  const { requestId } = await adminAuthAndContext(c);
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
    return c.json({ error: "forbidden", message: "Access denied." , requestId}, 403);
  }

  try {
    const raw = readYamlFile(filePath);
    return c.json({ entity: raw }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), filePath, entityName: name }, "Failed to parse entity YAML file");
    return c.json({ error: "internal_error", message: `Failed to parse entity file for "${name}".` , requestId}, 500);
  }
});

admin.openapi(listMetricsRoute, async (c) => {
  await adminAuthAndContext(c);
  const root = getSemanticRoot();
  const metrics = discoverMetrics(root);
  return c.json({ metrics }, 200);
});

admin.openapi(getGlossaryRoute, async (c) => {
  await adminAuthAndContext(c);
  const root = getSemanticRoot();
  const glossary = loadGlossary(root);
  return c.json({ glossary }, 200);
});

admin.openapi(getCatalogRoute, async (c) => {
  const { requestId } = await adminAuthAndContext(c);
  const root = getSemanticRoot();
  const catalogFile = path.join(root, "catalog.yml");
  if (!fs.existsSync(catalogFile)) {
    return c.json({ catalog: null }, 200);
  }
  try {
    const raw = readYamlFile(catalogFile);
    return c.json({ catalog: raw }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), file: catalogFile }, "Failed to parse catalog YAML");
    return c.json({ error: "internal_error", message: "Failed to parse catalog file." , requestId}, 500);
  }
});

admin.openapi(getRawYamlDirFileRoute, async (c) => {

  const { dir, file } = c.req.valid("param");
  const { requestId } = await adminAuthAndContext(c);
  serveRawYaml(c, requestId, `${dir}/${file}`);
});

admin.openapi(getRawYamlFileRoute, async (c) => {

  const { file } = c.req.valid("param");
  const { requestId } = await adminAuthAndContext(c);
  serveRawYaml(c, requestId, file);
});

admin.openapi(getSemanticStatsRoute, async (c) => {
  await adminAuthAndContext(c);
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
  }, 200);
});

admin.openapi(getSemanticDiffRoute, async (c) => {
  const { requestId } = await adminAuthAndContext(c);
  const connectionId = c.req.query("connection") ?? "default";

  // Validate connection exists
  const registered = connections.list();
  if (!registered.includes(connectionId)) {
    return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
  }

  try {
    const result = await runDiff(connectionId);
    return c.json(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), connectionId, requestId },
      "Schema diff failed",
    );
    return c.json({ error: "internal_error", message: `Schema diff failed: ${message}` , requestId}, 500);
  }
});

// -- Org-scoped semantic CRUD -----------------------------------------------

admin.openapi(listOrgEntitiesRoute, async (c) => runHandler(c, "list org semantic entities", async () => {
  const { authResult } = await adminAuthAndContext(c);

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
  }

  if (!hasInternalDB()) {
    const requestId = reqId(c);
    return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." , requestId}, 501);
  }

  const { listEntities } = await import("@atlas/api/lib/semantic/entities");
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
  }, 200);
}));

admin.openapi(getOrgEntityRoute, async (c) => runHandler(c, "get org semantic entity", async () => {

  const { name } = c.req.valid("param");
  const { authResult } = await adminAuthAndContext(c);

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
  }

  if (!hasInternalDB()) {
    const requestId = reqId(c);
    return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." , requestId}, 501);
  }

  const entityType = validateEntityType(c.req.query("type"));
  if (!entityType) {
    return c.json({ error: "bad_request", message: `Invalid type. Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}` }, 400);
  }
  const { getEntity } = await import("@atlas/api/lib/semantic/entities");
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
  }, 200);
}));

admin.openapi(putOrgEntityRoute, async (c) => runHandler(c, "save org semantic entity", async () => {

  const { name } = c.req.valid("param");
  const { authResult, requestId } = await adminAuthAndContext(c);

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
  }

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." , requestId}, 501);
  }

  let body: { yamlContent: string; entityType?: string; connectionId?: string };
  try {
    body = await c.req.json();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in YAML upload request");
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

  const { upsertEntity } = await import("@atlas/api/lib/semantic/entities");
  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
  const { syncEntityToDisk } = await import("@atlas/api/lib/semantic/sync");
  await upsertEntity(orgId, entityType, name, body.yamlContent, body.connectionId);
  invalidateOrgWhitelist(orgId);
  await syncEntityToDisk(orgId, name, entityType, body.yamlContent);

  log.info({ requestId, orgId, name, entityType }, "Org semantic entity upserted");
  return c.json({ ok: true, name, entityType }, 200);
}));

admin.openapi(deleteOrgEntityRoute, async (c) => runHandler(c, "delete org semantic entity", async () => {

  const { name } = c.req.valid("param");
  const { authResult, requestId } = await adminAuthAndContext(c);

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
  }

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." , requestId}, 501);
  }

  const entityType = validateEntityType(c.req.query("type"));
  if (!entityType) {
    return c.json({ error: "bad_request", message: `Invalid type. Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}` }, 400);
  }
  const { deleteEntity } = await import("@atlas/api/lib/semantic/entities");
  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
  const { syncEntityDeleteFromDisk } = await import("@atlas/api/lib/semantic/sync");
  const deleted = await deleteEntity(orgId, entityType, name);
  if (!deleted) {
    return c.json({ error: "not_found", message: `Entity "${name}" not found.` }, 404);
  }
  invalidateOrgWhitelist(orgId);
  await syncEntityDeleteFromDisk(orgId, name, entityType);

  log.info({ requestId, orgId, name, entityType }, "Org semantic entity deleted");
  return c.json({ ok: true, name, entityType }, 200);
}));

admin.openapi(importOrgEntitiesRoute, async (c) => runHandler(c, "import org semantic entities", async () => {
  const { authResult, requestId } = await adminAuthAndContext(c);

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
  }

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Org-scoped semantic entities require an internal database (DATABASE_URL)." , requestId}, 501);
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

  const { importFromDisk } = await import("@atlas/api/lib/semantic/sync");
  const result = await importFromDisk(orgId, {
    connectionId: body.connectionId,
  });

  log.info(
    { requestId, orgId, imported: result.imported, skipped: result.skipped, total: result.total },
    "Org semantic import completed",
  );
  return c.json(result, 200);
}));

// -- Connections ------------------------------------------------------------

admin.openapi(listConnectionsRoute, async (c) => {
  await adminAuthAndContext(c);
  const connList = connections.describe();
  return c.json({ connections: connList }, 200);
});

admin.openapi(getPoolMetricsRoute, async (c) => {
  await adminAuthAndContext(c);
  const metrics = connections.getAllPoolMetrics();
  return c.json({ metrics }, 200);
});

admin.openapi(getOrgPoolMetricsRoute, async (c) => {
  const { requestId } = await adminAuthAndContext(c);
  try {
    const orgId = c.req.query("orgId");
    const metrics = connections.getOrgPoolMetrics(orgId || undefined);
    const config = connections.getOrgPoolConfig();
    return c.json({ metrics, config, orgCount: connections.listOrgs().length }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to retrieve org pool metrics");
    return c.json({ error: "metrics_failed", message: err instanceof Error ? err.message : "Failed to retrieve metrics" , requestId}, 500);
  }
});

admin.openapi(drainOrgPoolRoute, async (c) => {

  const { orgId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  try {
    const result = await connections.drainOrg(orgId);
    log.info({ orgId, drained: result.drained, requestId, userId: authResult.user?.id }, "Org pools drained via admin API");
    return c.json(result, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), orgId, requestId }, "Org pool drain failed");
    return c.json({ error: "drain_failed", message: err instanceof Error ? err.message : "Org drain failed" , requestId}, 500);
  }
});

admin.openapi(drainConnectionPoolRoute, async (c) => {

  const { id } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!connections.has(id)) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found` }, 404);
  }
  try {
    const result = await connections.drain(id);
    if (!result.drained) {
      return c.json({ drained: false, message: result.message }, 409);
    }
    log.info({ connectionId: id, requestId, userId: authResult.user?.id }, "Pool drained via admin API");
    return c.json({ drained: true, message: result.message }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id, requestId }, "Pool drain failed");
    return c.json({ error: "drain_failed", message: err instanceof Error ? err.message : "Drain failed" , requestId}, 500);
  }
});

admin.openapi(getCacheStatsRoute, async (c) => runHandler(c, "retrieve cache statistics", async () => {
  await adminAuthAndContext(c);
  const { getCache, cacheEnabled } = await import("@atlas/api/lib/cache/index");
  if (!cacheEnabled()) {
    return c.json({ enabled: false, hits: 0, misses: 0, hitRate: 0, missRate: 0, entryCount: 0, maxSize: 0, ttl: 0 }, 200);
  }
  const stats = getCache().stats();
  const total = stats.hits + stats.misses;
  const hitRate = total > 0 ? stats.hits / total : 0;
  const missRate = total > 0 ? stats.misses / total : 0;
  return c.json({ enabled: true, ...stats, hitRate, missRate }, 200);
}));

admin.openapi(flushCacheRoute, async (c) => runHandler(c, "flush cache", async () => {
  const { authResult, requestId } = await adminAuthAndContext(c);

  const { getCache, flushCache, cacheEnabled } = await import("@atlas/api/lib/cache/index");
  if (!cacheEnabled()) {
    return c.json({ ok: false, flushed: 0, message: "Cache is disabled" }, 200);
  }
  const count = getCache().stats().entryCount;
  flushCache();
  log.info({ requestId, userId: authResult.user?.id, flushed: count }, "Cache flushed via admin API");
  return c.json({ ok: true, flushed: count, message: "Cache flushed" }, 200);
}));

admin.openapi(testConnectionRoute, async (c) => {
  const { requestId } = await adminAuthAndContext(c);
  const body = await c.req.json().catch((err: unknown) => {
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
    return c.json({ status: result.status, latencyMs: result.latencyMs, dbType }, 200);
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

admin.openapi(testExistingConnectionRoute, async (c) => runHandler(c, "health check connection", async () => {

  const { id } = c.req.valid("param");

  await adminAuthAndContext(c);
  const registered = connections.list();
  if (!registered.includes(id)) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found.` }, 404);
  }
  const result = await connections.healthCheck(id);
  return c.json(result, 200);
}));

admin.openapi(createConnectionRoute, async (c) => {
  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL)." }, 404);
  }

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
    return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET." , requestId}, 500);
  }

  try {
    await internalQuery(
      `INSERT INTO connections (id, url, type, description, schema_name) VALUES ($1, $2, $3, $4, $5)`,
      [id, encryptedUrl, dbType, typeof description === "string" ? description : null, typeof schema === "string" ? schema : null],
    );
  } catch (err) {
    connections.unregister(id as string);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id }, "Failed to persist connection");
    return c.json({ error: "internal_error", message: "Failed to save connection." , requestId}, 500);
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

admin.openapi(updateConnectionRoute, async (c) => {

  const { id } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL)." }, 404);
  }

  if (id === "default") {
    return c.json({ error: "forbidden", message: "Cannot modify the default connection. Update ATLAS_DATASOURCE_URL instead." , requestId}, 403);
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
    return c.json({ error: "decryption_failed", message: "Stored connection URL could not be decrypted. The encryption key may have changed." , requestId}, 500);
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
      return c.json({ error: "internal_error", message: "Failed to update connection." , requestId}, 500);
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
    return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET." , requestId}, 500);
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
    return c.json({ error: "internal_error", message: "Failed to update connection." , requestId}, 500);
  }

  _resetWhitelists();

  log.info({ requestId, connectionId: id, urlChanged, actorId: authResult.user?.id }, "Connection updated");
  return c.json({
    id,
    dbType,
    description: newDescription,
    maskedUrl: maskConnectionUrl(newUrl),
  }, 200);
});

admin.openapi(deleteConnectionRoute, async (c) => {

  const { id } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL)." }, 404);
  }

  if (id === "default") {
    return c.json({ error: "forbidden", message: "Cannot delete the default connection." , requestId}, 403);
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
    return c.json({ error: "internal_error", message: "Failed to delete connection." , requestId}, 500);
  }

  connections.unregister(id);

  log.info({ requestId, connectionId: id, actorId: authResult.user?.id }, "Connection deleted");
  return c.json({ success: true }, 200);
});

admin.openapi(getConnectionRoute, async (c) => {

  const { id } = c.req.valid("param");

  await adminAuthAndContext(c);
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
  }, 200);
});

// -- Audit ------------------------------------------------------------------

admin.openapi(listAuditRoute, async (c) => runHandler(c, "query audit log", async () => {

  // Auth before feature-availability check to avoid info disclosure
  await adminAuthAndContext(c);
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  const { limit, offset } = parsePagination(c);

  // Queries the internal DB directly (not the analytics datasource),
  // so no validateSQL pipeline needed. Parameterized queries prevent injection.
  const filters = buildAuditFilters((k) => c.req.query(k));
  if (!filters.ok) {
    return c.json({ error: filters.error, message: filters.message }, filters.status);
  }
  const { conditions, params, paramIdx } = filters;

  // The JOIN is always needed because the search filter references u.email
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

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
     ${whereClause} ORDER BY a.timestamp DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, limit, offset],
  );

  return c.json({ rows, total, limit, offset }, 200);
}));

admin.openapi(exportAuditRoute, async (c) => runHandler(c, "export audit log", async () => {
  await adminAuthAndContext(c);
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  const filters = buildAuditFilters((k) => c.req.query(k));
  if (!filters.ok) {
    return c.json({ error: filters.error, message: filters.message }, filters.status);
  }
  const { conditions, params, paramIdx } = filters;

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const exportLimit = 10000;

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
     ${whereClause} ORDER BY a.timestamp DESC LIMIT $${paramIdx}`,
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
}));

admin.openapi(getAuditStatsRoute, async (c) => runHandler(c, "query audit stats", async () => {

  // Auth before feature-availability check to avoid info disclosure
  await adminAuthAndContext(c);
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  const totalResult = await internalQuery<{ total: string; errors: string }>(
    `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE NOT success) as errors FROM audit_log WHERE deleted_at IS NULL`,
  );

  const total = parseInt(String(totalResult[0]?.total ?? "0"), 10);
  const errors = parseInt(String(totalResult[0]?.errors ?? "0"), 10);
  const errorRate = total > 0 ? (errors / total) * 100 : 0;

  const dailyResult = await internalQuery<{ day: string; count: string }>(
    `SELECT DATE(timestamp) as day, COUNT(*) as count FROM audit_log WHERE deleted_at IS NULL AND timestamp >= NOW() - INTERVAL '7 days' GROUP BY DATE(timestamp) ORDER BY day DESC`,
  );

  return c.json({
    totalQueries: total,
    totalErrors: errors,
    errorRate,
    queriesPerDay: dailyResult.map((r) => ({
      day: r.day,
      count: parseInt(String(r.count), 10),
    })),
  }, 200);
}));

admin.openapi(getAuditFacetsRoute, async (c) => {
  await adminAuthAndContext(c);
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  // Use allSettled so one failing query doesn't block the other
  const [tableResult, columnResult] = await Promise.allSettled([
    internalQuery<{ val: string }>(
      `SELECT DISTINCT jsonb_array_elements_text(tables_accessed) AS val FROM audit_log WHERE deleted_at IS NULL AND tables_accessed IS NOT NULL AND jsonb_typeof(tables_accessed) = 'array' ORDER BY val LIMIT 200`,
    ),
    internalQuery<{ val: string }>(
      `SELECT DISTINCT jsonb_array_elements_text(columns_accessed) AS val FROM audit_log WHERE deleted_at IS NULL AND columns_accessed IS NOT NULL AND jsonb_typeof(columns_accessed) = 'array' ORDER BY val LIMIT 200`,
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
  }, 200);
});

// -- Audit Analytics --------------------------------------------------------

admin.openapi(auditVolumeRoute, async (c) => runHandler(c, "query volume analytics", async () => {
  await adminAuthAndContext(c);
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  const range = analyticsDateRange(c);
  if ("error" in range) {
    throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error }, { status: 400 }) });
  }

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
  }, 200);
}));

admin.openapi(auditSlowRoute, async (c) => runHandler(c, "query slow analytics", async () => {
  await adminAuthAndContext(c);
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  const range = analyticsDateRange(c);
  if ("error" in range) {
    throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error }, { status: 400 }) });
  }

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
  }, 200);
}));

admin.openapi(auditFrequentRoute, async (c) => runHandler(c, "query frequency analytics", async () => {
  await adminAuthAndContext(c);
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  const range = analyticsDateRange(c);
  if ("error" in range) {
    throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error }, { status: 400 }) });
  }

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
  }, 200);
}));

admin.openapi(auditErrorsRoute, async (c) => runHandler(c, "query error analytics", async () => {
  await adminAuthAndContext(c);
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  const range = analyticsDateRange(c);
  if ("error" in range) {
    throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error }, { status: 400 }) });
  }

  // range.where always includes at least "WHERE deleted_at IS NULL"
  const errorCondition = `${range.where} AND NOT success`;

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
  }, 200);
}));

admin.openapi(auditUsersRoute, async (c) => runHandler(c, "query user analytics", async () => {
  await adminAuthAndContext(c);
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Audit log requires an internal database." }, 404);
  }

  const range = analyticsDateRange(c);
  if ("error" in range) {
    throw new HTTPException(400, { res: Response.json({ error: "invalid_request", message: range.error }, { status: 400 }) });
  }

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
  }, 200);
}));

// -- Plugins ----------------------------------------------------------------

admin.openapi(listPluginsRoute, async (c) => {
  await adminAuthAndContext(c);
  const pluginList = plugins.describe();
  return c.json({ plugins: pluginList, manageable: hasInternalDB() }, 200);
});

admin.openapi(pluginHealthRoute, async (c) => {

  const { id } = c.req.valid("param");

  await adminAuthAndContext(c);
  const plugin = plugins.get(id);
  if (!plugin) {
    return c.json({ error: "not_found", message: `Plugin "${id}" not found.` }, 404);
  }

  if (!plugin.healthCheck) {
    return c.json({
      healthy: true,
      message: "Plugin does not implement healthCheck.",
      status: plugins.getStatus(id) ?? null,
    }, 200);
  }

  try {
    const result = await plugin.healthCheck();
    return c.json({
      healthy: result.healthy,
      message: result.message ?? null,
      latencyMs: result.latencyMs ?? null,
      status: plugins.getStatus(id) ?? null,
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), pluginId: id }, "Plugin health check threw an exception");
    return c.json({
      error: "internal_error",
      healthy: false,
      message: "Plugin health check failed unexpectedly.",
      status: plugins.getStatus(id) ?? null,
    }, 500);
  }
});

admin.openapi(enablePluginRoute, async (c) => {

  const { id } = c.req.valid("param");

  await adminAuthAndContext(c);
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

  return c.json({ id, enabled: true, status: plugins.getStatus(id) ?? null, persisted, warning }, 200);
});

admin.openapi(disablePluginRoute, async (c) => {

  const { id } = c.req.valid("param");

  await adminAuthAndContext(c);
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

  return c.json({ id, enabled: false, status: plugins.getStatus(id) ?? null, persisted, warning }, 200);
});

admin.openapi(getPluginSchemaRoute, async (c) => {

  const { id } = c.req.valid("param");

  await adminAuthAndContext(c);
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
  }, 200);
});

admin.openapi(updatePluginConfigRoute, async (c) => runHandler(c, "save plugin configuration", async () => {

  const { id } = c.req.valid("param");

  const { requestId } = await adminAuthAndContext(c);
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
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in invite request");
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

  await savePluginConfig(id, body);
  log.info({ pluginId: id, requestId }, "Plugin config updated");
  return c.json({
    id,
    message: "Configuration saved. Changes take effect on next restart.",
  }, 200);
}));

// -- Password ---------------------------------------------------------------

admin.openapi(getPasswordStatusRoute, async (c) => {
  const req = c.req.raw;
  const requestId = reqId(c);

  // Light auth: authenticate but don't require admin role
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), requestId }, "Authentication system error in password-status check");
    return c.json({ error: "auth_error", message: "Authentication system error", requestId }, 500);
  }
  if (!authResult.authenticated) {
    const code = authErrorCode(authResult.error);
    return c.json({ error: code, message: authResult.error, requestId }, authResult.status);
  }
  const user = authResult.user;
  if (authResult.mode !== "managed" || !user) {
    return c.json({ passwordChangeRequired: false }, 200);
  }

  if (!hasInternalDB()) return c.json({ passwordChangeRequired: false }, 200);

  return withRequestContext({ requestId, user }, async () => {
    try {
      const rows = await internalQuery<{ password_change_required: boolean }>(
        `SELECT password_change_required FROM "user" WHERE id = $1`,
        [user.id],
      );
      return c.json({ passwordChangeRequired: rows[0]?.password_change_required === true }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), userId: user.id, requestId }, "Failed to check password_change_required — returning 500 to avoid bypassing forced password change");
      return c.json({ error: "internal_error", message: "Unable to verify password status. Please try again." , requestId}, 500);
    }
  });
});

admin.openapi(changePasswordRoute, async (c) => {
  const req = c.req.raw;
  const requestId = reqId(c);

  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), requestId }, "Authentication system error in password change");
    return c.json({ error: "auth_error", message: "Authentication system error", requestId }, 500);
  }
  if (!authResult.authenticated) {
    const code = authErrorCode(authResult.error);
    return c.json({ error: code, message: authResult.error, requestId }, authResult.status);
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
      return c.json({ success: true }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Password change failed";
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Password change failed");
      // Better Auth throws if current password is wrong
      if (message.includes("password") || message.includes("incorrect") || message.includes("invalid")) {
        return c.json({ error: "invalid_request", message: "Current password is incorrect." }, 400);
      }
      return c.json({ error: "internal_error", message: "Failed to change password." , requestId}, 500);
    }
  });
});

// -- Sessions ---------------------------------------------------------------

admin.openapi(listSessionsRoute, async (c) => runHandler(c, "list sessions", async () => {
  await adminAuthAndContext(c);
  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
  }

  const { limit, offset } = parsePagination(c);
  const search = c.req.query("search");

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
  }, 200);
}));

admin.openapi(getSessionStatsRoute, async (c) => runHandler(c, "get session stats", async () => {
  await adminAuthAndContext(c);
  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
  }

  const [totalResult, activeResult, uniqueUsersResult] = await Promise.all([
    internalQuery<{ count: string }>(`SELECT COUNT(*) AS count FROM session`),
    internalQuery<{ count: string }>(`SELECT COUNT(*) AS count FROM session WHERE "expiresAt" > NOW()`),
    internalQuery<{ count: string }>(`SELECT COUNT(DISTINCT "userId") AS count FROM session WHERE "expiresAt" > NOW()`),
  ]);

  return c.json({
    total: parseInt(String(totalResult[0]?.count ?? "0"), 10),
    active: parseInt(String(activeResult[0]?.count ?? "0"), 10),
    uniqueUsers: parseInt(String(uniqueUsersResult[0]?.count ?? "0"), 10),
  }, 200);
}));

admin.openapi(deleteSessionRoute, async (c) => runHandler(c, "revoke session", async () => {

  const { id: sessionId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
  }

  const deleted = await internalQuery<{ id: string }>(
    `DELETE FROM session WHERE id = $1 RETURNING id`,
    [sessionId],
  );
  if (deleted.length === 0) {
    return c.json({ error: "not_found", message: "Session not found." }, 404);
  }

  log.info({ requestId, sessionId, actorId: authResult.user?.id }, "Session revoked");
  return c.json({ success: true }, 200);
}));

admin.openapi(deleteUserSessionsRoute, async (c) => runHandler(c, "revoke user sessions", async () => {

  const { userId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Session management requires managed auth mode." }, 404);
  }

  // Org-scoping: workspace admins can only revoke sessions for users in their own org
  if (!(await verifyOrgMembership(authResult, userId))) {
    return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
  }

  const deleted = await internalQuery<{ id: string }>(
    `DELETE FROM session WHERE "userId" = $1 RETURNING id`,
    [userId],
  );
  if (deleted.length === 0) {
    return c.json({ error: "not_found", message: "No sessions found for this user." }, 404);
  }

  const count = deleted.length;
  log.info({ requestId, targetUserId: userId, count, actorId: authResult.user?.id }, "All user sessions revoked");
  return c.json({ success: true, count }, 200);
}));

// -- Users ------------------------------------------------------------------

admin.openapi(listUsersRoute, async (c) => runHandler(c, "list users", async () => {
  const { authResult } = await adminAuthAndContext(c);
  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  const { limit, offset } = parsePagination(c);
  const search = c.req.query("search");
  const role = c.req.query("role");

  // Org-scoping: non-platform_admin users with an activeOrganizationId see
  // only members of their org. Platform admins and self-hosted (no org) see all.
  const orgId = authResult.user?.activeOrganizationId;
  const isPlatformAdmin = authResult.user?.role === "platform_admin";

  if (orgId && !isPlatformAdmin && hasInternalDB()) {
    // Query users via member table JOIN, scoped to the caller's active org
    const conditions: string[] = [`m."organizationId" = $1`];
    const params: unknown[] = [orgId];
    let paramIndex = 2;

    if (search) {
      conditions.push(`u.email ILIKE $${paramIndex}`);
      params.push(`%${search}%`);
      paramIndex++;
    }
    if (role && isValidRole(role)) {
      // Use org-level role from the member table
      conditions.push(`m.role = $${paramIndex}`);
      params.push(role);
      paramIndex++;
    }

    const whereClause = conditions.join(" AND ");

    const [userRows, countRows] = await Promise.all([
      internalQuery<{
        id: string; email: string; name: string | null; role: string;
        banned: boolean; banReason: string | null; banExpires: string | null;
        createdAt: string;
      }>(
        `SELECT u.id, u.email, u.name, COALESCE(m.role, 'member') as role,
                COALESCE(u.banned, false) as banned, u."banReason", u."banExpires",
                u."createdAt"
         FROM "user" u
         JOIN member m ON m."userId" = u.id
         WHERE ${whereClause}
         ORDER BY u."createdAt" DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset],
      ),
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM "user" u
         JOIN member m ON m."userId" = u.id
         WHERE ${whereClause}`,
        params,
      ),
    ]);

    return c.json({
      users: userRows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        banned: u.banned,
        banReason: u.banReason,
        banExpires: u.banExpires,
        createdAt: u.createdAt,
      })),
      total: parseInt(String(countRows[0]?.count ?? "0"), 10),
      limit,
      offset,
    }, 200);
  }

  // Platform admin or self-hosted: global view via Better Auth admin API
  const result = await adminApi.listUsers({
    query: {
      limit,
      offset,
      ...(search ? { searchField: "email", searchValue: search, searchOperator: "contains" } : {}),
      ...(role && isValidRole(role) ? { filterField: "role", filterValue: role, filterOperator: "eq" } : {}),
      sortBy: "createdAt",
      sortDirection: "desc",
    },
    headers: c.req.raw.headers,
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
  }, 200);
}));

admin.openapi(getUserStatsRoute, async (c) => runHandler(c, "query user stats", async () => {
  const { authResult } = await adminAuthAndContext(c);
  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  // Org-scoping: non-platform_admin users with an activeOrganizationId get
  // stats scoped to their org. Platform admins and self-hosted see global stats.
  const orgId = authResult.user?.activeOrganizationId;
  const isPlatformAdmin = authResult.user?.role === "platform_admin";

  let totalResult: { count: string }[];
  let roleResult: { role: string; count: string }[];
  let bannedResult: { count: string }[];

  if (orgId && !isPlatformAdmin) {
    [totalResult, roleResult, bannedResult] = await Promise.all([
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM "user" u JOIN member m ON m."userId" = u.id WHERE m."organizationId" = $1`,
        [orgId],
      ),
      internalQuery<{ role: string; count: string }>(
        `SELECT COALESCE(m.role, 'member') as role, COUNT(*) as count
         FROM "user" u JOIN member m ON m."userId" = u.id
         WHERE m."organizationId" = $1
         GROUP BY COALESCE(m.role, 'member')`,
        [orgId],
      ),
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM "user" u JOIN member m ON m."userId" = u.id WHERE m."organizationId" = $1 AND u.banned = true`,
        [orgId],
      ),
    ]);
  } else {
    [totalResult, roleResult, bannedResult] = await Promise.all([
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM "user"`,
      ),
      internalQuery<{ role: string; count: string }>(
        `SELECT COALESCE(role, 'member') as role, COUNT(*) as count FROM "user" GROUP BY COALESCE(role, 'member')`,
      ),
      internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM "user" WHERE banned = true`,
      ),
    ]);
  }

  const total = parseInt(String(totalResult[0]?.count ?? "0"), 10);
  const banned = parseInt(String(bannedResult[0]?.count ?? "0"), 10);
  const byRole: Record<string, number> = {};
  for (const r of roleResult) {
    byRole[r.role] = parseInt(String(r.count), 10);
  }

  return c.json({ total, banned, byRole }, 200);
}));

admin.openapi(changeUserRoleRoute, async (c) => {

  const { id: userId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  // Org-scoping: workspace admins can only modify users in their own org
  if (!(await verifyOrgMembership(authResult, userId))) {
    return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
  }

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
    return c.json({ error: "forbidden", message: "Cannot change your own role." , requestId}, 403);
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
          return c.json({ error: "forbidden", message: "Cannot demote the last admin." , requestId}, 403);
        }
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Last admin guard check failed");
      return c.json({ error: "internal_error", message: "Failed to verify admin count." , requestId}, 500);
    }
  }

  try {
    await adminApi.setRole({
      body: { userId, role: newRole },
      headers: c.req.raw.headers,
    });
    log.info({ requestId, targetUserId: userId, newRole, actorId: authResult.user?.id }, "User role changed");
    return c.json({ success: true }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to set user role");
    return c.json({ error: "internal_error", message: "Failed to update user role." , requestId}, 500);
  }
});

admin.openapi(banUserRoute, async (c) => runHandler(c, "ban user", async () => {

  const { id: userId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  // Org-scoping: workspace admins can only ban users in their own org
  if (!(await verifyOrgMembership(authResult, userId))) {
    return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
  }

  if (authResult.user?.id === userId) {
    return c.json({ error: "forbidden", message: "Cannot ban yourself." , requestId}, 403);
  }

  const body = await c.req.json().catch((err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in ban user request");
    return {};
  });

  await adminApi.banUser({
    body: {
      userId,
      ...(body.reason ? { banReason: body.reason } : {}),
      ...(body.expiresIn ? { banExpiresIn: body.expiresIn } : {}),
    },
    headers: c.req.raw.headers,
  });
  log.info({ requestId, targetUserId: userId, reason: body.reason, actorId: authResult.user?.id }, "User banned");
  return c.json({ success: true }, 200);
}));

admin.openapi(unbanUserRoute, async (c) => runHandler(c, "unban user", async () => {

  const { id: userId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  // Org-scoping: workspace admins can only unban users in their own org
  if (!(await verifyOrgMembership(authResult, userId))) {
    return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
  }

  await adminApi.unbanUser({
    body: { userId },
    headers: c.req.raw.headers,
  });
  log.info({ requestId, targetUserId: userId, actorId: authResult.user?.id }, "User unbanned");
  return c.json({ success: true }, 200);
}));

admin.openapi(deleteUserRoute, async (c) => {

  const { id: userId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  // Org-scoping: workspace admins can only delete users in their own org
  if (!(await verifyOrgMembership(authResult, userId))) {
    return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
  }

  if (authResult.user?.id === userId) {
    return c.json({ error: "forbidden", message: "Cannot delete yourself." , requestId}, 403);
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
          return c.json({ error: "forbidden", message: "Cannot delete the last admin." , requestId}, 403);
        }
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Last admin guard check failed");
      return c.json({ error: "internal_error", message: "Failed to verify admin count." , requestId}, 500);
    }
  }

  try {
    await adminApi.removeUser({
      body: { userId },
      headers: c.req.raw.headers,
    });
    log.info({ requestId, targetUserId: userId, actorId: authResult.user?.id }, "User deleted");
    return c.json({ success: true }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to delete user");
    return c.json({ error: "internal_error", message: "Failed to delete user." , requestId}, 500);
  }
});

admin.openapi(revokeUserSessionsRoute, async (c) => runHandler(c, "revoke sessions", async () => {

  const { id: userId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  // Org-scoping: workspace admins can only revoke sessions for users in their own org
  if (!(await verifyOrgMembership(authResult, userId))) {
    return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
  }

  await adminApi.revokeSessions({
    body: { userId },
    headers: c.req.raw.headers,
  });
  log.info({ requestId, targetUserId: userId, actorId: authResult.user?.id }, "User sessions revoked");
  return c.json({ success: true }, 200);
}));

// -- Invitations ------------------------------------------------------------

admin.openapi(inviteUserRoute, async (c) => {
  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "User invitations require managed auth mode." }, 404);
  }

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
    return c.json({ error: "internal_error", message: "Failed to validate invitation." , requestId}, 500);
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
      return c.json({ error: "internal_error", message: "Failed to create invitation." , requestId}, 500);
    }
    const baseUrl = resolveBaseUrl(c.req.raw);
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
          // intentionally ignored: best-effort error body extraction for logging
          const errorBody = await res.text().catch(() => "");
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
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Failed to create invitation");
    return c.json({ error: "internal_error", message: "Failed to create invitation." , requestId}, 500);
  }
});

admin.openapi(listInvitationsRoute, async (c) => runHandler(c, "list invitations", async () => {
  await adminAuthAndContext(c);
  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "User invitations require managed auth mode." }, 404);
  }

  const status = c.req.query("status");
  const validStatuses = ["pending", "accepted", "revoked", "expired"];

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

  return c.json({ invitations }, 200);
}));

admin.openapi(revokeInvitationRoute, async (c) => runHandler(c, "revoke invitation", async () => {

  const { id: invitationId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!hasInternalDB() || detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "User invitations require managed auth mode." }, 404);
  }

  const result = await internalQuery<{ id: string }>(
    `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND status = 'pending' RETURNING id`,
    [invitationId],
  );

  if (result.length === 0) {
    return c.json({ error: "not_found", message: "Invitation not found or already resolved." }, 404);
  }

  log.info({ requestId, invitationId, actorId: authResult.user?.id }, "Invitation revoked");
  return c.json({ success: true }, 200);
}));

// -- Tokens -----------------------------------------------------------------

admin.openapi(getTokenSummaryRoute, async (c) => runHandler(c, "fetch token usage summary", async () => {
  await adminAuthAndContext(c);

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
  }, 200);
}));

admin.openapi(getTokensByUserRoute, async (c) => runHandler(c, "fetch token usage by user", async () => {
  await adminAuthAndContext(c);

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
  const { limit } = parsePagination(c, { limit: 20, maxLimit: 100 });

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
  }, 200);
}));

admin.openapi(getTokenTrendsRoute, async (c) => runHandler(c, "fetch token usage trends", async () => {
  await adminAuthAndContext(c);

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
  }, 200);
}));

// -- Settings ---------------------------------------------------------------

admin.openapi(getSettingsRoute, async (c) => runHandler(c, "list settings", async () => {
  const { authResult } = await adminAuthAndContext(c);
  const orgId = authResult.user?.activeOrganizationId;
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const allSettings = getSettingsForAdmin(orgId, isPlatformAdmin || !orgId);
  const manageable = hasInternalDB();
  const deployMode = getConfig()?.deployMode ?? "self-hosted";

  // In SaaS mode, workspace admins only see settings they can control.
  // Platform admins and self-hosted mode see everything.
  const filtered = (deployMode === "saas" && !isPlatformAdmin)
    ? allSettings.filter((s) => s.saasVisible !== false)
    : allSettings;

  // Strip internal-only saasVisible field from response
  const settings = filtered.map(({ saasVisible: _, ...rest }) => rest);

  return c.json({ settings, manageable, deployMode }, 200);
}));

admin.openapi(updateSettingRoute, async (c) => runHandler(c, "save setting", async () => {

  const { key } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!hasInternalDB()) {
    return c.json(
      { error: "not_available", message: "Settings overrides require an internal database (DATABASE_URL)." },
      404,
    );
  }

  // Validate that the key is in the registry
  const def = getSettingDefinition(key);
  if (!def) {
    return c.json({ error: "invalid_request", message: `Unknown setting: "${key}".` }, 400);
  }

  // Secret settings are read-only
  if (def.secret) {
    return c.json({ error: "forbidden", message: "Secret settings cannot be modified from the UI." , requestId}, 403);
  }

  // Platform-scoped settings require platform_admin (or no org context = self-hosted)
  const orgId = authResult.user?.activeOrganizationId;
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  if (def.scope === "platform" && orgId && !isPlatformAdmin) {
    return c.json({ error: "forbidden", message: `"${key}" is a platform-level setting and cannot be modified by workspace admins.`, requestId }, 403);
  }

  let body: { value?: unknown };
  try {
    body = (await c.req.json()) as { value?: unknown };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in settings update request");
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

  // Pass orgId for workspace-scoped settings
  const effectiveOrgId = def.scope === "workspace" ? orgId : undefined;
  await setSetting(key, value, authResult.user?.id, effectiveOrgId);
  log.info({ requestId, key, orgId: effectiveOrgId, actorId: authResult.user?.id }, "Setting override saved via admin API");
  return c.json({ success: true, key, value }, 200);
}));

admin.openapi(deleteSettingRoute, async (c) => runHandler(c, "delete setting", async () => {

  const { key } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  if (!hasInternalDB()) {
    return c.json(
      { error: "not_available", message: "Settings overrides require an internal database (DATABASE_URL)." },
      404,
    );
  }

  // Validate that the key is in the registry
  const def = getSettingDefinition(key);
  if (!def) {
    return c.json({ error: "invalid_request", message: `Unknown setting: "${key}".` }, 400);
  }

  if (def.secret) {
    return c.json({ error: "forbidden", message: "Secret settings cannot be modified from the UI." , requestId}, 403);
  }

  // Platform-scoped settings require platform_admin (or no org context = self-hosted)
  const orgId = authResult.user?.activeOrganizationId;
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  if (def.scope === "platform" && orgId && !isPlatformAdmin) {
    return c.json({ error: "forbidden", message: `"${key}" is a platform-level setting and cannot be modified by workspace admins.`, requestId }, 403);
  }

  const effectiveOrgId = def.scope === "workspace" ? orgId : undefined;
  await deleteSetting(key, authResult.user?.id, effectiveOrgId);
  log.info({ requestId, key, orgId: effectiveOrgId, actorId: authResult.user?.id }, "Setting override removed via admin API");
  return c.json({ success: true, key }, 200);
}));

export { admin };
