/**
 * Onboarding API routes for self-serve signup flow.
 *
 * Mounted at /api/v1/onboarding. Requires managed auth (session-based).
 * These routes power the post-signup wizard: test a database connection
 * and finalize workspace setup (persist connection scoped to the user's org).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  AuthContext,
} from "@atlas/api/lib/effect/services";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { connections, detectDBType, resolveDatasourceUrl } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, queryEffect, encryptUrl } from "@atlas/api/lib/db/internal";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { importFromDisk } from "@atlas/api/lib/semantic/sync";
import { getSemanticRoot } from "@atlas/api/lib/semantic/files";
import { setSetting } from "@atlas/api/lib/settings";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";
import path from "path";
import { existsSync } from "fs";

const log = createLogger("onboarding");

// ---------------------------------------------------------------------------
// Demo dataset types — each maps to a semantic layer directory on disk
// ---------------------------------------------------------------------------

type DemoType = "demo" | "cybersec" | "ecommerce";

const DEMO_LABELS: Record<DemoType, string> = {
  demo: "SaaS CRM",
  cybersec: "Sentinel Security (Cybersecurity SaaS)",
  ecommerce: "NovaMart (E-commerce)",
};

/** Maps demo type to the canonical industry string used in prompt_collections and settings. */
const DEMO_INDUSTRIES: Record<DemoType, string> = {
  demo: "saas",
  cybersec: "cybersecurity",
  ecommerce: "ecommerce",
};

/** Reserved connection ID for demo workspaces. */
const DEMO_CONNECTION_ID = "__demo__";

/**
 * Resolve the semantic layer source directory for a demo type.
 *
 * In Docker: demo → /app/semantic, cybersec → /app/data/cybersec-semantic, ecommerce → /app/data/ecommerce-semantic
 * In dev:    demo → {cwd}/semantic, cybersec → {cwd}/packages/cli/data/seeds/cybersec/semantic, etc.
 */
function getDemoSemanticDir(demoType: DemoType): string {
  if (demoType === "demo") return getSemanticRoot();

  // Docker image has these at /app/data/{type}-semantic (backward-compat symlinks)
  const dockerPath = path.resolve(process.cwd(), "data", `${demoType}-semantic`);
  // New canonical path: packages/cli/data/seeds/{type}/semantic
  const seedsPath = path.resolve(process.cwd(), "packages", "cli", "data", "seeds", demoType, "semantic");
  // Legacy dev fallback: packages/cli/data/{type}-semantic (symlink)
  const devPath = path.resolve(process.cwd(), "packages", "cli", "data", `${demoType}-semantic`);

  // Check Docker path first (production), then seeds path, then legacy dev path
  if (existsSync(path.join(dockerPath, "entities"))) return dockerPath;
  if (existsSync(path.join(seedsPath, "entities"))) return seedsPath;
  if (existsSync(path.join(devPath, "entities"))) return devPath;

  throw new Error(
    `Semantic layer not found for demo type "${demoType}". ` +
    `Each semantic directory must contain an entities/ subdirectory. ` +
    `Checked: ${dockerPath}/entities, ${seedsPath}/entities, ${devPath}/entities`,
  );
}

/**
 * Seed org-scoped prompt collections matching the demo industry.
 * Copies the global builtins for that industry into the org's namespace
 * so they appear in the prompt library immediately after demo setup.
 */
async function seedDemoPromptCollections(orgId: string, industry: string): Promise<void> {
  // Find global builtin collections for this industry
  const builtins = await internalQuery<{ id: string; name: string; description: string; sort_order: number }>(
    `SELECT id, name, description, sort_order FROM prompt_collections
     WHERE is_builtin = true AND industry = $1 AND org_id IS NULL`,
    [industry],
  );

  for (const builtin of builtins) {
    try {
      // Skip if org already has a collection with this name
      const existing = await internalQuery<{ id: string }>(
        `SELECT id FROM prompt_collections WHERE name = $1 AND org_id = $2`,
        [builtin.name, orgId],
      );
      if (existing.length > 0) continue;

      // Create org-scoped copy
      const inserted = await internalQuery<{ id: string }>(
        `INSERT INTO prompt_collections (name, industry, description, is_builtin, sort_order, org_id, status)
         VALUES ($1, $2, $3, true, $4, $5, 'published')
         RETURNING id`,
        [builtin.name, industry, builtin.description, builtin.sort_order, orgId],
      );
      if (!inserted[0]?.id) {
        log.warn({ collection: builtin.name, orgId }, "Failed to seed demo prompt collection — INSERT returned no rows");
        continue;
      }

      // Copy prompt items from the global collection (independent inserts — parallelize)
      const items = await internalQuery<{ question: string; description: string; category: string; sort_order: number }>(
        `SELECT question, description, category, sort_order FROM prompt_items
         WHERE collection_id = $1 ORDER BY sort_order ASC`,
        [builtin.id],
      );
      const collectionId = inserted[0].id;
      await Promise.all(items.map((item) =>
        internalQuery(
          `INSERT INTO prompt_items (collection_id, question, description, category, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [collectionId, item.question, item.description, item.category, item.sort_order],
        ),
      ));
    } catch (err) {
      log.warn(
        { err: errorMessage(err), collection: builtin.name, orgId },
        "Failed to seed demo prompt collection — skipping to next",
      );
    }
  }
}

/** Valid connection ID: lowercase alphanumeric, hyphens, underscores, 1-64 chars. Must not start with underscore (reserved for internal IDs). */
const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9_-]{0,62}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------


const TestConnectionRequestSchema = z.object({
  url: z.string().min(1, "Database URL is required."),
});

const TestConnectionResponseSchema = z.object({
  status: z.string(),
  latencyMs: z.number(),
  dbType: z.string(),
  maskedUrl: z.string(),
});

const CompleteOnboardingRequestSchema = z.object({
  url: z.string().min(1, "Database URL is required."),
  connectionId: z.string().optional(),
});

const CompleteOnboardingResponseSchema = z.object({
  connectionId: z.string(),
  dbType: z.string(),
  maskedUrl: z.string(),
});

const SocialProvidersResponseSchema = z.object({
  providers: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const socialProvidersRoute = createRoute({
  method: "get",
  path: "/social-providers",
  tags: ["Onboarding"],
  summary: "List enabled social login providers",
  description:
    "Returns which OAuth providers (Google, GitHub, Microsoft) are configured so the signup page can render the correct buttons. Public endpoint — no authentication required.",
  responses: {
    200: {
      description: "List of enabled social providers",
      content: { "application/json": { schema: SocialProvidersResponseSchema } },
    },
  },
});

const testConnectionRoute = createRoute({
  method: "post",
  path: "/test-connection",
  tags: ["Onboarding"],
  summary: "Test a database connection",
  description:
    "Validates the URL scheme, creates a temporary connection, runs a health check, and returns the result. " +
    "The connection is not persisted. Requires managed auth mode and an authenticated session.",
  request: {
    body: {
      content: { "application/json": { schema: TestConnectionRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Connection test result",
      content: { "application/json": { schema: TestConnectionResponseSchema } },
    },
    400: {
      description: "Invalid URL scheme or connection test failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Onboarding requires managed auth mode",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error (invalid request body)",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const completeOnboardingRoute = createRoute({
  method: "post",
  path: "/complete",
  tags: ["Onboarding"],
  summary: "Complete workspace setup",
  description:
    "Finalizes onboarding by testing the connection, encrypting the URL, and persisting it to the internal database " +
    "scoped to the user's active organization. Resets the semantic layer whitelist cache so new tables become queryable immediately.",
  request: {
    body: {
      content: { "application/json": { schema: CompleteOnboardingRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Connection saved and workspace setup complete",
      content: { "application/json": { schema: CompleteOnboardingResponseSchema } },
    },
    400: {
      description: "Invalid URL, connection test failed, or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Onboarding requires managed auth mode and DATABASE_URL",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error (invalid request body)",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Failed to encrypt or save connection",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const UseDemoResponseSchema = z.object({
  connectionId: z.string(),
  dbType: z.string(),
  maskedUrl: z.string(),
  entitiesImported: z.number(),
});

const UseDemoBodySchema = z.object({
  demoType: z.enum(["demo", "cybersec", "ecommerce"]).optional().default("demo"),
});

const useDemoRoute = createRoute({
  method: "post",
  path: "/use-demo",
  tags: ["Onboarding"],
  summary: "Set up workspace with demo data",
  description:
    "Connects the workspace to the platform's default datasource (ATLAS_DATASOURCE_URL) and imports " +
    "the semantic layer for the chosen demo dataset. Three datasets are available: " +
    "'demo' (SaaS CRM, 3 tables), 'cybersec' (Sentinel Security, 62 tables), " +
    "'ecommerce' (NovaMart, 52 tables). Defaults to 'demo' if not specified.",
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: UseDemoBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Demo connection saved, semantic layer imported",
      content: { "application/json": { schema: UseDemoResponseSchema } },
    },
    400: {
      description: "No active organization or demo datasource not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Onboarding requires managed auth mode and DATABASE_URL",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Failed to set up demo connection",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const onboarding = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

// Normalize JSON parse errors. Only catch SyntaxError (malformed JSON); let
// other 400s (e.g. Zod query/path param validation) propagate with their message.
onboarding.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      if (err.cause instanceof SyntaxError) {
        log.warn("Malformed JSON body in request");
        return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
      }
      return c.json({ error: "invalid_request", message: err.message || "Bad request." }, 400);
    }
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET /social-providers — returns which social login providers are enabled
// (public — no auth middleware)
// ---------------------------------------------------------------------------

onboarding.openapi(socialProvidersRoute, (c) => {
  const providers: string[] = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) providers.push("google");
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) providers.push("github");
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) providers.push("microsoft");
  return c.json({ providers }, 200);
});

// ---------------------------------------------------------------------------
// Apply auth middleware to all routes registered after this point
// ---------------------------------------------------------------------------

onboarding.use("/test-connection", standardAuth);
onboarding.use("/test-connection", requestContext);
onboarding.use("/complete", standardAuth);
onboarding.use("/complete", requestContext);
onboarding.use("/use-demo", standardAuth);
onboarding.use("/use-demo", requestContext);
onboarding.use("/tour-status", standardAuth);
onboarding.use("/tour-status", requestContext);
onboarding.use("/tour-complete", standardAuth);
onboarding.use("/tour-complete", requestContext);
onboarding.use("/tour-reset", standardAuth);
onboarding.use("/tour-reset", requestContext);

// ---------------------------------------------------------------------------
// POST /test-connection — test a datasource URL without persisting
// ---------------------------------------------------------------------------

onboarding.openapi(
  testConnectionRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;

      if (detectAuthMode() !== "managed") {
        return c.json({ error: "not_available", message: "Onboarding requires managed auth mode.", requestId }, 404);
      }

      const { url } = c.req.valid("json");

      // Validate URL scheme
      let dbType: string;
      try {
        dbType = detectDBType(url);
      } catch (err) {
        log.warn({ err: errorMessage(err), requestId }, "Invalid database URL scheme");
        return c.json({
          error: "invalid_url",
          message: "Unsupported database URL scheme. Use postgresql:// or mysql://.",
        }, 400);
      }

      // Register a temporary connection, test it, then always clean up
      const tempId = `_onboard_${Date.now()}`;
      return yield* Effect.tryPromise({
        try: async () => {
          connections.register(tempId, { url });
          const result = await connections.healthCheck(tempId);
          return c.json({
            status: result.status,
            latencyMs: result.latencyMs,
            dbType,
            maskedUrl: maskConnectionUrl(url),
          }, 200);
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.catchAll((err) => {
          log.warn({ err: err.message, requestId }, "Connection test failed");
          return Effect.succeed(c.json({
            error: "connection_failed",
            message: "Connection test failed. Check the URL, credentials, and that the database is reachable.",
          }, 400));
        }),
        Effect.ensuring(Effect.sync(() => {
          if (connections.has(tempId)) {
            connections.unregister(tempId);
          }
        })),
      );
    }), { label: "test connection" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /complete — finalize workspace setup
// ---------------------------------------------------------------------------

onboarding.openapi(
  completeOnboardingRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { user, orgId } = yield* AuthContext;

      if (detectAuthMode() !== "managed") {
        return c.json({ error: "not_available", message: "Onboarding requires managed auth mode.", requestId }, 404);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Onboarding requires an internal database (DATABASE_URL).", requestId }, 404);
      }

      if (!orgId) {
        return c.json({ error: "no_organization", message: "No active organization. Create a workspace first." }, 400);
      }

      const { url, connectionId: rawConnectionId } = c.req.valid("json");

      const id = typeof rawConnectionId === "string" && rawConnectionId.trim()
        ? rawConnectionId.trim()
        : "default";

      // Validate connectionId format (skip for default)
      if (id !== "default" && !CONNECTION_ID_PATTERN.test(id)) {
        return c.json({
          error: "invalid_request",
          message: "Connection ID must be 2-64 lowercase alphanumeric characters, hyphens, or underscores.",
        }, 400);
      }

      // Validate URL scheme
      let dbType: string;
      try {
        dbType = detectDBType(url);
      } catch (err) {
        log.warn({ err: errorMessage(err), requestId }, "Invalid database URL scheme");
        return c.json({
          error: "invalid_url",
          message: "Unsupported database URL scheme. Use postgresql:// or mysql://.",
        }, 400);
      }

      // Test the connection before persisting
      const tempId = `_onboard_complete_${Date.now()}`;
      const testResult = yield* Effect.tryPromise({
        try: async () => {
          connections.register(tempId, { url });
          await connections.healthCheck(tempId);
          return { ok: true as const };
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.catchAll((err) => {
          log.warn({ err: err.message, requestId }, "Connection test failed during onboarding");
          return Effect.succeed({ ok: false as const, response: c.json({
            error: "connection_failed",
            message: "Connection test failed. Check the URL, credentials, and that the database is reachable.",
          }, 400) });
        }),
        Effect.ensuring(Effect.sync(() => {
          if (connections.has(tempId)) connections.unregister(tempId);
        })),
      );
      if (!testResult.ok) {
        return testResult.response;
      }

      // Encrypt and persist to internal DB
      let encryptedUrl: string;
      try {
        encryptedUrl = encryptUrl(url);
      } catch (err) {
        log.error({ err: errorMessage(err), requestId }, "Failed to encrypt connection URL during onboarding");
        return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL.", requestId }, 500);
      }

      const urlKeyVersion = activeKeyVersion();
      // Org-scoped upsert: composite PK (id, org_id) ensures each org has its own namespace
      const upsertResult = yield* Effect.tryPromise({
        try: () => internalQuery<{ id: string }>(
          `INSERT INTO connections (id, url, url_key_version, type, description, org_id)
           VALUES ($1, $2, $6, $3, $4, $5)
           ON CONFLICT (id, org_id) DO UPDATE SET url = $2, url_key_version = $6, type = $3, updated_at = NOW()
           RETURNING id`,
          [id, encryptedUrl, dbType, `${dbType} datasource`, orgId, urlKeyVersion],
        ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.catchAll((err) => {
        log.error({ err: err.message, requestId }, "Failed to persist onboarding connection");
        return Effect.succeed(null);
      }));

      if (upsertResult === null) {
        return c.json({ error: "internal_error", message: "Failed to save connection.", requestId }, 500);
      }
      if (upsertResult.length === 0) {
        log.error({ connectionId: id, orgId, requestId }, "Connection upsert returned 0 rows — data may not have been persisted");
        return c.json({ error: "internal_error", message: "Failed to save connection — database did not confirm the write.", requestId }, 500);
      }

      // Register the connection in the runtime registry
      try {
        if (connections.has(id)) connections.unregister(id);
        connections.register(id, { url, description: `${dbType} datasource` });
      } catch (err) {
        log.warn({ err: errorMessage(err), requestId }, "Connection saved but runtime registration failed — will load on next restart");
      }

      _resetWhitelists();

      log.info({ requestId, connectionId: id, orgId, dbType, userId: user?.id }, "Onboarding complete — connection saved");

      // Trigger onboarding milestone: database connected (fire-and-forget)
      // AtlasUser.label is the user's email in managed auth mode.
      if (user?.id && user.label?.includes("@")) {
        yield* Effect.tryPromise({
          try: async () => {
            const { onDatabaseConnected } = await import("@atlas/api/lib/email/hooks");
            onDatabaseConnected({
              userId: user.id,
              email: user.label!,
              orgId,
            });
          },
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        }).pipe(Effect.catchAll((err) => {
          log.debug({ err: err.message }, "Onboarding email hook not available");
          return Effect.void;
        }));
      }

      return c.json({
        connectionId: id,
        dbType,
        maskedUrl: maskConnectionUrl(url),
      }, 201);
    }), { label: "complete onboarding" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /use-demo — connect workspace to the default datasource + import semantic layer
// ---------------------------------------------------------------------------

onboarding.openapi(
  useDemoRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { user, orgId } = yield* AuthContext;

      if (detectAuthMode() !== "managed") {
        return c.json({ error: "not_available", message: "Onboarding requires managed auth mode.", requestId }, 404);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Onboarding requires an internal database (DATABASE_URL).", requestId }, 404);
      }

      if (!orgId) {
        return c.json({ error: "no_organization", message: "No active organization. Create a workspace first." }, 400);
      }

      const { demoType } = c.req.valid("json");

      const url = resolveDatasourceUrl();
      if (!url) {
        return c.json({ error: "no_demo_datasource", message: "No demo datasource configured. Set ATLAS_DATASOURCE_URL." }, 400);
      }

      const id = DEMO_CONNECTION_ID;
      const industry = DEMO_INDUSTRIES[demoType];
      let dbType: string;
      try {
        dbType = detectDBType(url);
      } catch (err) {
        log.error({ err: errorMessage(err), requestId }, "Demo datasource URL has unsupported scheme");
        return c.json({ error: "invalid_datasource", message: "Demo datasource URL has an unsupported scheme." }, 500);
      }

      // Encrypt and persist with status='published'
      let encryptedUrl: string;
      try {
        encryptedUrl = encryptUrl(url);
      } catch (err) {
        log.error({ err: errorMessage(err), requestId }, "Failed to encrypt demo connection URL");
        return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL.", requestId }, 500);
      }

      const demoLabel = DEMO_LABELS[demoType];
      const urlKeyVersion = activeKeyVersion();
      const upsertResult = yield* Effect.tryPromise({
        try: () => internalQuery<{ id: string }>(
          `INSERT INTO connections (id, url, url_key_version, type, description, org_id, status)
           VALUES ($1, $2, $6, $3, $4, $5, 'published')
           ON CONFLICT (id, org_id) DO UPDATE SET url = $2, url_key_version = $6, type = $3, description = $4, status = 'published', updated_at = NOW()
           RETURNING id`,
          [id, encryptedUrl, dbType, `${demoLabel} — demo ${dbType} datasource`, orgId, urlKeyVersion],
        ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.catchAll((err) => {
        log.error({ err: err.message, requestId }, "Failed to persist demo connection");
        return Effect.succeed(null);
      }));

      if (upsertResult === null) {
        return c.json({ error: "internal_error", message: "Failed to save connection.", requestId }, 500);
      }
      if (upsertResult.length === 0) {
        log.error({ connectionId: id, orgId, requestId }, "Demo connection upsert returned 0 rows — data may not have been persisted");
        return c.json({ error: "internal_error", message: "Failed to save connection — database did not confirm the write.", requestId }, 500);
      }

      // Register in runtime
      try {
        if (connections.has(id)) connections.unregister(id);
        connections.register(id, { url, description: `${demoLabel} — demo ${dbType} datasource` });
      } catch (err) {
        log.warn({ err: errorMessage(err), requestId }, "Demo connection saved but runtime registration failed");
      }

      // Resolve and import the semantic layer for the chosen demo dataset
      let semanticDir: string;
      try {
        semanticDir = getDemoSemanticDir(demoType);
      } catch (err) {
        log.error({ err: errorMessage(err), requestId, demoType }, "Semantic layer not found for demo type");
        return c.json({
          error: "demo_not_available",
          message: `Demo dataset "${demoType}" is not installed on this server. Contact the platform administrator.`,
          requestId,
        }, 500);
      }

      const importResult = yield* Effect.tryPromise({
        try: () => importFromDisk(orgId, { sourceDir: semanticDir, connectionId: DEMO_CONNECTION_ID }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.catchAll((err) => {
        log.error({ err: err.message, requestId, demoType, semanticDir }, "Semantic layer import failed");
        return Effect.succeed(null);
      }));

      if (importResult === null) {
        return c.json({
          error: "import_failed",
          message: `Failed to import semantic layer for "${demoType}" dataset. The connection was saved but the workspace needs manual setup.`,
          requestId,
        }, 500);
      }

      const entitiesImported = importResult.imported;
      if (entitiesImported > 0) {
        log.info({ orgId, demoType, imported: importResult.imported, skipped: importResult.skipped, requestId }, "Imported semantic layer for demo workspace");
      }

      // Write demo_industry setting + seed prompt collections concurrently (independent, non-fatal)
      yield* Effect.all([
        Effect.tryPromise({
          try: () => setSetting("ATLAS_DEMO_INDUSTRY", industry, user?.id, orgId),
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        }).pipe(Effect.catchAll((err) => {
          log.warn({ err: err.message, requestId, orgId, industry }, "Failed to write demo_industry setting — non-fatal");
          return Effect.void;
        })),
        Effect.tryPromise({
          try: () => seedDemoPromptCollections(orgId, industry),
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        }).pipe(Effect.catchAll((err) => {
          log.warn({ err: err.message, requestId, orgId, industry }, "Failed to seed demo prompt collections — non-fatal");
          return Effect.void;
        })),
      ], { concurrency: "unbounded" });

      _resetWhitelists();

      log.info({ requestId, orgId, demoType, dbType, userId: user?.id, entitiesImported, industry }, "Demo onboarding complete");

      return c.json({
        connectionId: id,
        dbType,
        maskedUrl: maskConnectionUrl(url),
        entitiesImported,
      }, 201);
    }), { label: "use demo data" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Region selection during signup
// ---------------------------------------------------------------------------

import { loadResidency, getResidencyDomainError } from "./shared-residency";
import { RegionPickerItemSchema } from "@useatlas/schemas";

// OnboardingRegionSchema previously duplicated this shape inline; the signup
// page already imports RegionPickerItemSchema from @useatlas/schemas, so
// route + web consumer describe the same shape from one source.
const OnboardingRegionsResponseSchema = z.object({
  configured: z.boolean(),
  defaultRegion: z.string(),
  availableRegions: z.array(RegionPickerItemSchema),
});

const AssignRegionBodySchema = z.object({
  region: z.string().min(1),
});

const AssignRegionResponseSchema = z.object({
  workspaceId: z.string(),
  region: z.string(),
  assignedAt: z.string(),
});

const getRegionsRoute = createRoute({
  method: "get",
  path: "/regions",
  tags: ["Onboarding"],
  summary: "List available data residency regions",
  description:
    "Returns available data residency regions for the signup flow. " +
    "If residency is not configured (self-hosted or EE not available), " +
    "returns configured=false so the frontend can skip the region step.",
  responses: {
    200: {
      description: "Available regions",
      content: { "application/json": { schema: OnboardingRegionsResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Onboarding requires managed auth mode",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const assignRegionRoute = createRoute({
  method: "post",
  path: "/assign-region",
  tags: ["Onboarding"],
  summary: "Assign data residency region during signup",
  description:
    "Assigns a data residency region to the user's workspace during the signup flow. " +
    "This must be called before connecting a database. The region cannot be changed " +
    "after assignment.",
  request: {
    body: {
      content: { "application/json": { schema: AssignRegionBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Region assigned",
      content: { "application/json": { schema: AssignRegionResponseSchema } },
    },
    400: {
      description: "Invalid region or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Onboarding requires managed auth mode or residency not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Region already assigned (immutable)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    503: {
      description: "Service unavailable (no internal database)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

onboarding.use("/regions", standardAuth);
onboarding.use("/regions", requestContext);
onboarding.use("/assign-region", standardAuth);
onboarding.use("/assign-region", requestContext);

// GET /regions — available data residency regions for signup

onboarding.openapi(getRegionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Onboarding requires managed auth mode.", requestId }, 404);
    }

    const mod = yield* Effect.promise(() => loadResidency());
    if (!mod) {
      return c.json({ configured: false, defaultRegion: "none", availableRegions: [] }, 200);
    }

    try {
      const defaultRegion = mod.getDefaultRegion();
      const regions = mod.getConfiguredRegions();
      const availableRegions = Object.entries(regions).map(([id, cfg]) => ({
        id,
        label: cfg.label,
        isDefault: id === defaultRegion,
      }));
      return c.json({ configured: true, defaultRegion, availableRegions }, 200);
    } catch (err) {
      if (err instanceof mod.ResidencyError && err.code === "not_configured") {
        return c.json({ configured: false, defaultRegion: "none", availableRegions: [] }, 200);
      }
      throw err;
    }
  }), { label: "get onboarding regions" });
});

// POST /assign-region — assign region during signup

onboarding.openapi(
  assignRegionRoute,
  async (c) => {
    const mod = await loadResidency();
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;

      if (detectAuthMode() !== "managed") {
        return c.json({ error: "not_available", message: "Onboarding requires managed auth mode.", requestId }, 404);
      }

      if (!orgId) {
        return c.json({ error: "no_organization", message: "No active organization. Create a workspace first.", requestId }, 400);
      }

      const { region } = c.req.valid("json");

      if (!mod) {
        return c.json({ error: "not_available", message: "Data residency is not available in this deployment.", requestId }, 404);
      }

      const result = yield* mod.assignWorkspaceRegion(orgId, region);
      log.info({ orgId, region, requestId }, "Workspace region assigned during signup");
      return c.json(result, 200);
    }), { label: "assign region during signup", domainErrors: mod ? [getResidencyDomainError(mod)] : undefined });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Tour status & completion
// ---------------------------------------------------------------------------

const TourStatusResponseSchema = z.object({
  tourCompleted: z.boolean(),
  tourCompletedAt: z.string().nullable(),
});

const tourStatusRoute = createRoute({
  method: "get",
  path: "/tour-status",
  tags: ["Onboarding"],
  summary: "Get guided tour completion status",
  description:
    "Returns whether the authenticated user has completed the guided tour. " +
    "Used on app load to decide whether to auto-start the tour.",
  responses: {
    200: {
      description: "Tour completion status",
      content: { "application/json": { schema: TourStatusResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Requires managed auth mode and internal database",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const tourCompleteRoute = createRoute({
  method: "post",
  path: "/tour-complete",
  tags: ["Onboarding"],
  summary: "Mark guided tour as completed",
  description:
    "Records that the authenticated user has completed (or dismissed) the guided tour. " +
    "Idempotent — calling multiple times is safe.",
  responses: {
    200: {
      description: "Tour marked as completed",
      content: { "application/json": { schema: TourStatusResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Requires managed auth mode and internal database",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const tourResetRoute = createRoute({
  method: "post",
  path: "/tour-reset",
  tags: ["Onboarding"],
  summary: "Reset guided tour so it can be replayed",
  description:
    "Clears the tour completion timestamp for the authenticated user, allowing " +
    "the guided tour to be triggered again.",
  responses: {
    200: {
      description: "Tour reset successfully",
      content: { "application/json": { schema: TourStatusResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Requires managed auth mode and internal database",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET /tour-status
// ---------------------------------------------------------------------------

onboarding.openapi(tourStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Tour tracking requires managed auth mode.", requestId }, 404);
    }
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Tour tracking requires an internal database (DATABASE_URL).", requestId }, 404);
    }

    const userId = user?.id;
    if (!userId) {
      return c.json({ error: "auth_error", message: "No user ID in session.", requestId }, 401);
    }

    const rows = yield* queryEffect<{ tour_completed_at: string | null }>(
      `SELECT tour_completed_at FROM user_onboarding WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    return c.json({
      tourCompleted: !!row?.tour_completed_at,
      tourCompletedAt: row?.tour_completed_at ?? null,
    }, 200);
  }), { label: "fetch tour status" });
});

// ---------------------------------------------------------------------------
// POST /tour-complete
// ---------------------------------------------------------------------------

onboarding.openapi(tourCompleteRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Tour tracking requires managed auth mode.", requestId }, 404);
    }
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Tour tracking requires an internal database (DATABASE_URL).", requestId }, 404);
    }

    const userId = user?.id;
    if (!userId) {
      return c.json({ error: "auth_error", message: "No user ID in session.", requestId }, 401);
    }

    const now = new Date().toISOString();
    yield* queryEffect(
      `INSERT INTO user_onboarding (user_id, tour_completed_at)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET tour_completed_at = $2`,
      [userId, now],
    );
    log.info({ requestId, userId }, "Tour marked as completed");
    return c.json({ tourCompleted: true, tourCompletedAt: now }, 200);
  }), { label: "save tour completion" });
});

// ---------------------------------------------------------------------------
// POST /tour-reset
// ---------------------------------------------------------------------------

onboarding.openapi(tourResetRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Tour tracking requires managed auth mode.", requestId }, 404);
    }
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Tour tracking requires an internal database (DATABASE_URL).", requestId }, 404);
    }

    const userId = user?.id;
    if (!userId) {
      return c.json({ error: "auth_error", message: "No user ID in session.", requestId }, 401);
    }

    yield* queryEffect(
      `UPDATE user_onboarding SET tour_completed_at = NULL WHERE user_id = $1`,
      [userId],
    );
    log.info({ requestId, userId }, "Tour reset for replay");
    return c.json({ tourCompleted: false, tourCompletedAt: null }, 200);
  }), { label: "reset tour" });
});

export { onboarding };
