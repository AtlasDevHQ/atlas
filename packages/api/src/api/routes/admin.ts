/**
 * Admin console API routes.
 *
 * Mounted at /api/v1/admin. All routes require admin role.
 * Overview, semantic layer, user management, password, and settings handlers
 * live here. Connections, plugins, cache, invitations, and other domains are
 * in dedicated sub-routers (admin-connections.ts, admin-plugins.ts, etc.).
 */

import * as fs from "fs";
import * as path from "path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createLogger, withRequestContext, getRequestContext } from "@atlas/api/lib/logger";
import { withRequestId, resolveMode, parseModeFromCookie } from "./middleware";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { authenticateRequest } from "@atlas/api/lib/auth/middleware";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { connections } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, getWorkspaceRegion } from "@atlas/api/lib/db/internal";
import { plugins } from "@atlas/api/lib/plugins/registry";
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
import { adminAudit } from "./admin-audit";
import { adminLearnedPatterns } from "./admin-learned-patterns";
import { adminSessions } from "./admin-sessions";
import { adminPrompts } from "./admin-prompts";
import { adminSuggestions } from "./admin-suggestions";
import { adminStarterPrompts } from "./admin-starter-prompts";
import { adminSso } from "./admin-sso";
import { adminScim } from "./admin-scim";
import { adminIPAllowlist } from "./admin-ip-allowlist";
import { adminRoles } from "./admin-roles";
import { adminModelConfig } from "./admin-model-config";
import { adminEmailProvider } from "./admin-email-provider";
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
import { adminMigrate } from "./admin-migrate";
import { adminTokens } from "./admin-tokens";
import { adminConnections } from "./admin-connections";
import { adminPlugins } from "./admin-plugins";
import { adminCache } from "./admin-cache";
import { adminActions } from "./admin-actions";
import { adminPublish } from "./admin-publish";
import { adminArchive, adminRestore } from "./admin-archive";
import { registerSemanticEditorRoutes } from "./admin-semantic";
import { ErrorSchema, AuthErrorSchema, parsePagination, OrgRoleSchema, ORG_ROLE_ERROR_MESSAGE } from "./shared-schemas";
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

/** Read atlasMode from middleware context. Defaults to "published" when not set. */
const getAtlasMode = (c: { get(key: string): unknown }): import("@useatlas/types/auth").AtlasMode =>
  (c.get("atlasMode") as import("@useatlas/types/auth").AtlasMode | undefined) ?? "published";

/**
 * Run admin auth preamble and bind user identity into AsyncLocalStorage.
 * Returns { authResult, requestId } for the handler to use.
 * Throws HTTPException on auth failure.
 *
 * Also resolves the effective atlas mode and stores it on the Hono context
 * (`c.set("atlasMode", ...)`). admin.ts uses the `withRequestId` middleware
 * — not `adminAuth` — so the mode is resolved lazily here once the auth
 * result is known.
 */
async function adminAuthAndContext(
  c: { req: { raw: Request }; get(key: string): unknown; set?: (key: string, value: unknown) => void },
): Promise<{ authResult: AuthResult & { authenticated: true }; requestId: string }> {
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

  // Resolve and publish atlas mode for downstream handlers. getAtlasMode(c)
  // reads from c.get("atlasMode") — populate it once per request and log any
  // developer-mode request we downgraded due to insufficient role (matches
  // the security signal emitted by `resolveModeForRequest` on the
  // adminAuth/standardAuth middleware paths).
  //
  // Note: the downgrade branch is defensive — `requireAdminAuth` above
  // already 403's non-admin users before this point, so in practice the
  // downgrade never fires for admin routes. It stays for parity with the
  // other auth preambles in case admin gating is ever relaxed.
  if (typeof c.set === "function") {
    const cookieHeader = c.req.raw.headers.get("cookie");
    const xAtlasModeHeader = c.req.raw.headers.get("x-atlas-mode");
    const mode = resolveMode(cookieHeader, xAtlasModeHeader, authResult);
    const requestedDeveloper =
      parseModeFromCookie(cookieHeader) === "developer" ||
      xAtlasModeHeader === "developer";
    if (requestedDeveloper && mode === "published") {
      log.warn(
        { requestId, userId: authResult.user?.id, role: authResult.user?.role },
        "Developer mode request downgraded to published — insufficient role",
      );
    }
    c.set("atlasMode", mode);
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
admin.route("/sessions", adminSessions);
admin.route("/sessions/", adminSessions);
admin.route("/audit", adminAudit);
admin.route("/audit/", adminAudit);
admin.route("/prompts", adminPrompts);
admin.route("/prompts/", adminPrompts);
admin.route("/suggestions", adminSuggestions);
admin.route("/suggestions/", adminSuggestions);
admin.route("/starter-prompts", adminStarterPrompts);
admin.route("/starter-prompts/", adminStarterPrompts);
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
admin.route("/email-provider", adminEmailProvider);
admin.route("/email-provider/", adminEmailProvider);
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
admin.route("/migrate", adminMigrate);
admin.route("/migrate/", adminMigrate);
admin.route("/tokens", adminTokens);
admin.route("/tokens/", adminTokens);
// Invitations — registered directly to avoid sub-router middleware leaking to other /users/* routes
import { registerInvitationRoutes } from "./admin-invitations";
registerInvitationRoutes(admin, adminAuthAndContext);
admin.route("/connections", adminConnections);
admin.route("/connections/", adminConnections);
admin.route("/publish", adminPublish);
admin.route("/publish/", adminPublish);
admin.route("/archive-connection", adminArchive);
admin.route("/archive-connection/", adminArchive);
admin.route("/restore-connection", adminRestore);
admin.route("/restore-connection/", adminRestore);
admin.route("/plugins", adminPlugins);
admin.route("/plugins/", adminPlugins);
admin.route("/cache", adminCache);
admin.route("/cache/", adminCache);
admin.route("/admin-actions", adminActions);
admin.route("/admin-actions/", adminActions);
// Plugin marketplace — dynamic import defers loading the marketplace module
// (and its dependency graph) until admin routes register. Import failure is a
// build/test bug, not a runtime-recoverable condition: log then re-throw so it
// fails loudly instead of serving silent 404s on marketplace endpoints.
try {
  const { workspaceMarketplace } = await import("./admin-marketplace");
  admin.route("/plugins/marketplace", workspaceMarketplace);
  admin.route("/plugins/marketplace/", workspaceMarketplace);
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load marketplace routes",
  );
  throw err;
}

// Semantic improve routes — dynamic import defers loading the expert agent tool
// graph until admin routes register. Import failure fails loud for the same
// reason as the marketplace import above.
try {
  const { adminSemanticImprove } = await import("./admin-semantic-improve");
  admin.route("/semantic-improve", adminSemanticImprove);
  admin.route("/semantic-improve/", adminSemanticImprove);
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load semantic improve routes",
  );
  throw err;
}

// Semantic entity editor routes — registered directly (not subrouter) to avoid
// middleware conflicts with existing /semantic/* GET routes above.
registerSemanticEditorRoutes(admin, adminAuthAndContext);

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

const VALID_ENTITY_TYPES = new Set(["entity", "metric", "glossary", "catalog"]);

type SemanticEntityType = "entity" | "metric" | "glossary" | "catalog";

function validateEntityType(raw: string | undefined, defaultType: string = "entity"): SemanticEntityType | null {
  const value = raw ?? defaultType;
  return VALID_ENTITY_TYPES.has(value) ? value as SemanticEntityType : null;
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

/**
 * Type guard for *any* AtlasRole — includes `platform_admin`.
 *
 * DANGER: Do NOT use this for authorization decisions about roles that are
 * being assigned from request bodies. A workspace admin accepting
 * `platform_admin` here would re-introduce F-10. Parse body role fields
 * through `OrgRoleSchema` in `shared-schemas.ts` instead.
 *
 * Use cases this is appropriate for: read-only filter params on list endpoints
 * (e.g. `GET /users?role=platform_admin` — listing platform admins is safe),
 * and validating session-user role strings that already come from the auth
 * layer (not untrusted input).
 */
function isAtlasRole(role: unknown): role is AtlasRole {
  return typeof role === "string" && (ATLAS_ROLES as readonly string[]).includes(role);
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
  summary: "Ban user (platform admins only)",
  description:
    "Globally bans a user across every workspace they belong to. Requires " +
    "`platform_admin` role — workspace admins cannot perform a cross-tenant " +
    "ban because the effect propagates past their workspace boundary. Workspace " +
    "admins should use `DELETE /users/{id}/membership` to remove a member from " +
    "their own workspace only (F-14, 1.2.3 phase 2).",
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
    403: { description: "Forbidden — platform_admin role required", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const removeMembershipRoute = createRoute({
  method: "delete",
  path: "/users/{id}/membership",
  tags: ["Admin — Users"],
  summary: "Remove user from workspace",
  description:
    "Removes the target user from the caller's active workspace only. Other " +
    "workspaces the user belongs to are unaffected. This is the workspace-admin " +
    "analogue of `POST /users/{id}/ban` — see F-14 in security audit 1.2.3 for " +
    "why cross-tenant ban is restricted to platform admins.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "user_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "User removed from workspace",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: "No active workspace", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required / cannot self-remove", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "User is not a member of this workspace", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const unbanUserRoute = createRoute({
  method: "post",
  path: "/users/{id}/unban",
  tags: ["Admin — Users"],
  summary: "Unban user (platform admins only)",
  description:
    "Removes a global ban from a user. Symmetric with `POST /users/{id}/ban` " +
    "— requires `platform_admin` role. Workspace admins re-onboard users via " +
    "the invite flow rather than unbanning (F-14, 1.2.3 phase 2).",
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
    403: { description: "Forbidden — platform_admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
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
        regionApiUrl: z.string().url().optional().describe("Regional API endpoint for the workspace's assigned region"),
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
  const { authResult, requestId } = await adminAuthAndContext(c);
  const connectionId = c.req.query("connection") ?? "default";

  // Validate connection exists
  const registered = connections.list();
  if (!registered.includes(connectionId)) {
    return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
  }

  // Scope the diff to the caller's org + mode so demo orgs sharing a DB don't
  // see phantom tables from other tenants. `adminAuthAndContext` has already
  // resolved the mode and bound the user onto the request context.
  const orgId = authResult.user?.activeOrganizationId;
  const atlasMode = getAtlasMode(c);

  try {
    const result = await runDiff(connectionId, { orgId, atlasMode });
    return c.json(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), connectionId, orgId, atlasMode, requestId },
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
  const atlasMode = getAtlasMode(c);
  const statusFilter = atlasMode === "published" ? "published" as const : undefined;
  const rows = await listEntities(orgId, entityType, statusFilter);
  return c.json({
    entities: rows.map((r) => ({
      name: r.name,
      entityType: r.entity_type,
      connectionId: r.connection_id,
      status: r.status,
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

  const semanticAction = entityType === "metric"
    ? ADMIN_ACTIONS.semantic.updateMetric
    : entityType === "glossary"
      ? ADMIN_ACTIONS.semantic.updateGlossary
      : ADMIN_ACTIONS.semantic.updateEntity;

  logAdminAction({
    actionType: semanticAction,
    targetType: "semantic",
    targetId: name,
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    metadata: { name, entityType },
  });

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

  logAdminAction({
    actionType: ADMIN_ACTIONS.semantic.deleteEntity,
    targetType: "semantic",
    targetId: name,
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    metadata: { name, entityType },
  });

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
    if (role && isAtlasRole(role)) {
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
      ...(role && isAtlasRole(role) ? { filterField: "role", filterValue: role, filterOperator: "eq" } : {}),
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

  // Reject platform_admin and any off-tuple value. Granting cross-org privilege
  // must go through a platform-admin-gated endpoint, not this per-workspace
  // role change. See F-10 in .claude/research/security-audit-1-2-3.md.
  const roleParse = OrgRoleSchema.safeParse(body?.role);
  if (!roleParse.success) {
    return c.json({ error: "invalid_request", message: ORG_ROLE_ERROR_MESSAGE, requestId }, 400);
  }
  const newRole = roleParse.data;

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
    // Capture previous role for audit metadata (best-effort — may be undefined for non-DB auth)
    let previousRole: string | undefined;
    if (hasInternalDB()) {
      try {
        const roleRow = await internalQuery<{ role: string }>(
          `SELECT role FROM "user" WHERE id = $1`,
          [userId],
        );
        previousRole = roleRow[0]?.role;
      } catch {
        // intentionally ignored: previous role is metadata only, not critical
      }
    }

    await adminApi.setRole({
      body: { userId, role: newRole },
      headers: c.req.raw.headers,
    });
    log.info({ requestId, targetUserId: userId, newRole, actorId: authResult.user?.id }, "User role changed");

    logAdminAction({
      actionType: ADMIN_ACTIONS.user.changeRole,
      targetType: "user",
      targetId: userId,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { previousRole, newRole },
    });

    return c.json({ success: true }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to set user role");
    return c.json({ error: "internal_error", message: "Failed to update user role." , requestId}, 500);
  }
});

admin.openapi(banUserRoute, async (c) => runHandler(c, "ban user", async () => {

  const { id: userId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  // Ban is a global state change — user.banned = true across every workspace
  // the target belongs to. Workspace admins must not be able to degrade
  // service for orgs they're not members of. See F-14 in security audit
  // 1.2.3. Workspace admins should use DELETE /users/:id/membership instead.
  if (authResult.user?.role !== "platform_admin") {
    return c.json(
      {
        error: "forbidden",
        message: "Banning a user is a global action restricted to platform admins. To remove a user from your workspace only, use DELETE /api/v1/admin/users/{id}/membership.",
        requestId,
      },
      403,
    );
  }

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
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

  logAdminAction({
    actionType: ADMIN_ACTIONS.user.ban,
    targetType: "user",
    targetId: userId,
    metadata: { reason: body.reason, expiresIn: body.expiresIn },
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
  });

  return c.json({ success: true }, 200);
}));

admin.openapi(unbanUserRoute, async (c) => runHandler(c, "unban user", async () => {

  const { id: userId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);

  // Symmetric with banUserRoute — unban is a global state change, platform-only.
  if (authResult.user?.role !== "platform_admin") {
    return c.json(
      {
        error: "forbidden",
        message: "Unbanning a user is a global action restricted to platform admins.",
        requestId,
      },
      403,
    );
  }

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  await adminApi.unbanUser({
    body: { userId },
    headers: c.req.raw.headers,
  });
  log.info({ requestId, targetUserId: userId, actorId: authResult.user?.id }, "User unbanned");

  logAdminAction({
    actionType: ADMIN_ACTIONS.user.unban,
    targetType: "user",
    targetId: userId,
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
  });

  return c.json({ success: true }, 200);
}));

admin.openapi(removeMembershipRoute, async (c) => runHandler(c, "remove user from workspace", async () => {
  const { id: userId } = c.req.valid("param");

  const { authResult, requestId } = await adminAuthAndContext(c);
  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active workspace. Set an active org first.", requestId }, 400);
  }

  // Self-protection
  if (authResult.user?.id === userId) {
    return c.json({ error: "forbidden", message: "Cannot remove yourself from the workspace.", requestId }, 403);
  }

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Workspace membership requires an internal database.", requestId }, 404);
  }

  // Last-admin guard: if the target is an admin/owner of this workspace,
  // removing them must leave at least one admin/owner behind. Without this,
  // a workspace admin could strand the workspace with no remaining admins
  // (either by removing their co-admin and getting stuck, or via a two-admin
  // race where each removes the other). The role-change and delete-user paths
  // have analogous guards; this mirrors them at the workspace scope.
  const targetMembership = await internalQuery<{ role: string }>(
    `SELECT role FROM member WHERE "userId" = $1 AND "organizationId" = $2`,
    [userId, orgId],
  );
  const targetRole = targetMembership[0]?.role;
  if (targetRole === "admin" || targetRole === "owner") {
    const remainingAdmins = await internalQuery<{ count: string }>(
      `SELECT COUNT(*) as count FROM member
       WHERE "organizationId" = $1 AND role IN ('admin', 'owner') AND "userId" != $2`,
      [orgId, userId],
    );
    if (parseInt(String(remainingAdmins[0]?.count ?? "0"), 10) === 0) {
      return c.json(
        {
          error: "forbidden",
          message: "Cannot remove the last admin of this workspace. Promote another member first.",
          requestId,
        },
        403,
      );
    }
  }

  // Scope the DELETE to the caller's active workspace — the `organizationId`
  // filter is what makes this workspace-admin-safe (no cross-tenant state change).
  const deleted = await internalQuery<{ id: string }>(
    `DELETE FROM member WHERE "userId" = $1 AND "organizationId" = $2 RETURNING id`,
    [userId, orgId],
  );
  if (deleted.length === 0) {
    return c.json({ error: "not_found", message: "User is not a member of this workspace.", requestId }, 404);
  }

  log.info({ requestId, targetUserId: userId, orgId, actorId: authResult.user?.id }, "User removed from workspace");

  logAdminAction({
    actionType: ADMIN_ACTIONS.user.removeFromWorkspace,
    targetType: "user",
    targetId: userId,
    metadata: { orgId, previousRole: targetRole },
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
  });

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

    logAdminAction({
      actionType: ADMIN_ACTIONS.user.remove,
      targetType: "user",
      targetId: userId,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({ success: true }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), userId }, "Failed to delete user");
    return c.json({ error: "internal_error", message: "Failed to delete user." , requestId}, 500);
  }
});

admin.openapi(revokeUserSessionsRoute, async (c) => runHandler(c, "revoke sessions", async () => {

  const { id: userId } = c.req.valid("param");
  const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;

  const { authResult, requestId } = await adminAuthAndContext(c);

  const adminApi = await getAdminApi();
  if (!adminApi) {
    return c.json({ error: "not_available", message: "User management requires managed auth mode." }, 404);
  }

  // Org-scoping: workspace admins can only revoke sessions for users in their own org
  if (!(await verifyOrgMembership(authResult, userId))) {
    return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
  }

  // Pre-count live sessions so the audit row carries `count` — better-auth's
  // `revokeSessions` doesn't return how many it invalidated. Best-effort:
  // concurrent logins, a parallel admin, or TTL expiry can shift the true
  // number in the window between this read and the revoke. If the internal
  // DB is absent or the read fails, `count` stays null and
  // `countLookupFailed: true` is stamped into the audit row so a reviewer
  // can distinguish "zero sessions" from "pre-count errored".
  let count: number | null = null;
  let countLookupFailed = false;
  if (hasInternalDB()) {
    try {
      const rows = await internalQuery<{ count: string }>(
        `SELECT COUNT(*) AS count FROM session WHERE "userId" = $1`,
        [userId],
      );
      const parsed = parseInt(String(rows[0]?.count ?? "0"), 10);
      count = Number.isFinite(parsed) ? parsed : null;
      if (count === null) countLookupFailed = true;
    } catch (err: unknown) {
      countLookupFailed = true;
      log.warn(
        { err: err instanceof Error ? err.message : String(err), requestId, userId },
        "Session pre-count failed; audit row will record countLookupFailed",
      );
    }
  } else {
    countLookupFailed = true;
  }

  // Cap the upstream revoke so better-auth hanging (pool exhaustion, network
  // stall) can't leave the route waiting until the proxy times the client
  // out with zero audit trail. 30s is generous enough for a bulk revoke
  // against a managed auth provider and short enough that a genuine hang
  // becomes a `status: "failure"` audit row within one human-observable window.
  const REVOKE_TIMEOUT_MS = 30_000;
  async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`revokeSessions timed out after ${ms}ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  try {
    await withTimeout(
      adminApi.revokeSessions({
        body: { userId },
        headers: c.req.raw.headers,
      }),
      REVOKE_TIMEOUT_MS,
    );
    log.info({ requestId, targetUserId: userId, actorId: authResult.user?.id }, "User sessions revoked");
    logAdminAction({
      actionType: ADMIN_ACTIONS.user.sessionRevokeAll,
      targetType: "user",
      targetId: userId,
      ipAddress,
      metadata: {
        targetUserId: userId,
        ...(count !== null && { count }),
        ...(countLookupFailed && { countLookupFailed: true }),
      },
    });
    return c.json({ success: true }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, userId }, "Failed to revoke user sessions");
    logAdminAction({
      actionType: ADMIN_ACTIONS.user.sessionRevokeAll,
      targetType: "user",
      targetId: userId,
      status: "failure",
      ipAddress,
      metadata: {
        targetUserId: userId,
        error: errorMessage(err),
        ...(countLookupFailed && { countLookupFailed: true }),
      },
    });
    return c.json({ error: "internal_error", message: "Failed to revoke sessions.", requestId }, 500);
  }
}));

// -- Settings ---------------------------------------------------------------

admin.openapi(getSettingsRoute, async (c) => runHandler(c, "list settings", async () => {
  const { authResult } = await adminAuthAndContext(c);
  const orgId = authResult.user?.activeOrganizationId;
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const allSettings = getSettingsForAdmin(orgId, isPlatformAdmin || !orgId);
  const manageable = hasInternalDB();
  const config = getConfig();
  const deployMode = config?.deployMode ?? "self-hosted";

  // In SaaS mode, workspace admins only see settings they can control.
  // Platform admins and self-hosted mode see everything.
  const filtered = (deployMode === "saas" && !isPlatformAdmin)
    ? allSettings.filter((s) => s.saasVisible !== false)
    : allSettings;

  // Strip internal-only saasVisible field from response
  const settings = filtered.map(({ saasVisible: _, ...rest }) => rest);

  // Resolve regional API URL for the workspace (if residency is configured).
  // Wrapped in try-catch so a transient DB error doesn't break the entire settings response.
  let regionApiUrl: string | undefined;
  if (orgId && config?.residency) {
    try {
      const region = await getWorkspaceRegion(orgId);
      if (region) {
        regionApiUrl = config.residency.regions[region]?.apiUrl ?? undefined;
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), orgId },
        "Failed to resolve workspace region for settings response — omitting regionApiUrl",
      );
    }
  }

  return c.json({ settings, manageable, deployMode, regionApiUrl }, 200);
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

  logAdminAction({
    actionType: ADMIN_ACTIONS.settings.update,
    targetType: "settings",
    targetId: key,
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    metadata: { key, value },
  });

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

  logAdminAction({
    actionType: ADMIN_ACTIONS.settings.update,
    targetType: "settings",
    targetId: key,
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    metadata: { key, action: "reset_to_default" },
  });

  return c.json({ success: true, key }, 200);
}));

export { admin };
