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
  ResidencyResolver,
} from "@atlas/api/lib/effect/services";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { connections, detectDBType, resolveDatasourceUrl } from "@atlas/api/lib/db/connection";
import { isAuthEmailDeliveryConfigured } from "@atlas/api/lib/email/delivery";
import { hasInternalDB, internalQuery, queryEffect, encryptSecret, withDemoSeedLock } from "@atlas/api/lib/db/internal";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { importFromDisk } from "@atlas/api/lib/semantic/sync";
import { setSetting } from "@atlas/api/lib/settings";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";
import {
  DEMO_CONNECTION_ID,
  DEMO_INDUSTRY,
  DEMO_LABEL,
  getDemoSemanticDir,
} from "./onboarding-helpers";

const log = createLogger("onboarding");

// Atlas ships a single canonical demo seed since 1.4.0 (#2021). Earlier
// releases supported a `demoType` picker covering `demo` (SaaS CRM, 3 tables),
// `cybersec` (Sentinel Security, 62 tables), and `ecommerce` (NovaMart, 52
// tables). The body field is gone; the route always provisions ecommerce.
//
// Pre-#2169 we also copied the global builtin prompt_collections rows into
// the calling org's namespace here. That copy was redundant — the
// `org-with-demo` listing query in `lib/prompts/scoping.ts` already
// surfaces global builtins matching the demo industry — and produced the
// duplicate "E-commerce KPIs" library reported in #2169 (one global
// row + one per-org copy, both visible to /admin/prompts).

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

const PasswordResetStatusResponseSchema = z.object({
  enabled: z.boolean(),
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

const passwordResetStatusRoute = createRoute({
  method: "get",
  path: "/password-reset-status",
  tags: ["Onboarding"],
  summary: "Whether password reset emails can be sent",
  description:
    "Returns whether the deployment has an email provider wired so the /login page can decide whether to render the 'Forgot password?' link. The Better Auth password-reset endpoints are always enabled (email send is fire-and-forget); this flag is purely a UI hint to avoid showing a recovery affordance that goes nowhere on a deployment with no SMTP configured. Public endpoint — no authentication required.",
  responses: {
    200: {
      description: "Password reset configuration status",
      content: { "application/json": { schema: PasswordResetStatusResponseSchema } },
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
  /**
   * Names of post-commit decoration steps that failed. Today the only
   * decoration is `demo_industry_setting`; #2169 dropped the redundant
   * per-org prompt-collection seed (the `org-with-demo` listing query
   * already returns the global builtins). Always present as an array —
   * empty when the full install succeeded — so consumers can call
   * `.includes()` or `.length` without optional-chaining gymnastics.
   */
  partialFailures: z.array(z.enum(["demo_industry_setting"])),
});

// Strict-but-empty: validation parses to {} and silently strips unknown keys
// (Zod's default `.strip()` semantic). The legacy `demoType` field is read
// directly from the raw body before validation — see the route handler.
// `.passthrough()` would overstate intent ("we keep unknowns") since nothing
// downstream consumes them. `.strict()` would 400 every legacy client.
const UseDemoBodySchema = z.object({}).strip();

const useDemoRoute = createRoute({
  method: "post",
  path: "/use-demo",
  tags: ["Onboarding"],
  summary: "Set up workspace with demo data",
  description:
    "Connects the workspace to the platform's default datasource (ATLAS_DATASOURCE_URL) and imports " +
    "the canonical demo semantic layer (NovaMart e-commerce — 13 entities, 52 tables, ~480K rows). " +
    "Atlas ships a single canonical demo seed since 1.4.0 (#2021); the previous " +
    "`demoType` picker covering `demo`/`cybersec`/`ecommerce` was removed.",
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
// GET /password-reset-status — UI hint for whether to render the
// "Forgot password?" link on /login. The Better Auth password-reset
// endpoints are always live; this just flags whether emails can be sent.
// (public — no auth middleware)
// ---------------------------------------------------------------------------

onboarding.openapi(passwordResetStatusRoute, (c) => {
  return c.json({ enabled: isAuthEmailDeliveryConfigured() }, 200);
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

      // Encrypt and persist to internal DB as a workspace_plugins
      // datasource install (post-0096 cutover, #2744 / ADR-0007). The
      // group concept collapses into the JSONB `config.group_id` — no
      // separate `connection_groups` row is created here. The two
      // encryption modules produce identical ciphertext, so the legacy
      // `encryptSecret(url)` round-trips through `decryptSecret(config->>'url')`
      // verbatim — only the surrounding catalog-schema awareness changes.
      const catalogRows = yield* Effect.tryPromise({
        try: () => internalQuery<{ id: string }>(
          `SELECT id FROM plugin_catalog WHERE slug = $1 AND pillar = 'datasource' LIMIT 1`,
          [dbType],
        ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.catchAll((err) => {
        log.error({ err: err.message, requestId, dbType }, "Failed to look up datasource catalog row");
        return Effect.succeed([] as Array<{ id: string }>);
      }));
      if (catalogRows.length === 0) {
        log.error({ requestId, dbType }, "No built-in datasource catalog row for dbType — onboarding cannot proceed");
        return c.json({
          error: "internal_error",
          message: `No catalog row for datasource type '${dbType}'.`,
          requestId,
        }, 500);
      }
      const catalogId = catalogRows[0].id;

      let encryptedUrl: string;
      try {
        encryptedUrl = encryptSecret(url);
      } catch (err) {
        log.error({ err: errorMessage(err), requestId }, "Failed to encrypt connection URL during onboarding");
        return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL.", requestId }, 500);
      }
      const configJson = JSON.stringify({
        url: encryptedUrl,
        description: `${dbType} datasource`,
        db_type: dbType,
      });

      // Pre-delete any existing datasource install with the same
      // (workspace_id, install_id) regardless of catalog so re-running
      // onboarding with the same `connectionId` but a different dbType
      // updates the logical connection in place instead of leaving a
      // ghost row under the prior catalog (codex P2, #2784). The composite
      // PK on workspace_plugins is `(workspace_id, catalog_id, install_id)`,
      // so a plain ON CONFLICT can't span catalogs — delete-then-insert
      // is the right shape. install_id is the user-facing unique key in
      // every read path; this preserves that invariant on write.
      yield* Effect.tryPromise({
        try: () => internalQuery(
          `DELETE FROM workspace_plugins
            WHERE workspace_id = $1 AND pillar = 'datasource' AND install_id = $2`,
          [orgId, id],
        ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.catchAll((err) => {
        log.error({ err: err.message, requestId }, "Failed to clear prior datasource install during onboarding");
        return Effect.succeed(null);
      }));

      const upsertResult = yield* Effect.tryPromise({
        try: () => internalQuery<{ id: string }>(
          `INSERT INTO workspace_plugins
             (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at, status)
           VALUES ($1, $2, $3, $4, 'datasource', $5::jsonb, true, NOW(), 'published')
           RETURNING install_id AS id`,
          [`cn_${orgId}_${id}`, orgId, catalogId, id, configJson],
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

/**
 * Sentinel for a /use-demo seed step that must abort the locked transaction
 * (rolling it back) AND map to a specific HTTP error envelope. Thrown inside the
 * {@link withDemoSeedLock} callback so the failure rolls back phases 2+3
 * together; caught once outside, where `code` + `httpMessage` select the 500
 * response shape. Keeps the rollback trigger and the response shape in one place
 * (#3683).
 */
class DemoSeedFailure extends Error {
  constructor(
    readonly code: string,
    readonly httpMessage: string,
  ) {
    super(httpMessage);
    this.name = "DemoSeedFailure";
  }
}

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

      // Legacy `demoType: simple|cybersec|ecommerce` clients (#1188) still
      // call this endpoint after #2021 collapsed the picker. The body schema
      // strips unknown keys; we peek the raw body for telemetry so operators
      // can see when a stale client is in the wild. The route always
      // provisions ecommerce regardless. We also surface a custom
      // `Deprecation` header (a non-standard hint, NOT RFC 9745 — that RFC
      // requires a Structured Field date value) whose format is intentionally
      // human-readable for DevTools / API-explorer inspection; clients are
      // not expected to parse it. Hono caches the raw request body, so this
      // telemetry peek doesn't consume the stream the validated body
      // downstream relies on.
      // Telemetry-only peek; failures stay silent because the validated
      // body downstream is the load-bearing read.
      const rawBody = (yield* Effect.promise(() =>
        c.req.json().catch(() => null) as Promise<unknown>,
      )) as unknown;
      if (
        rawBody &&
        typeof rawBody === "object" &&
        !Array.isArray(rawBody) &&
        "demoType" in rawBody &&
        typeof (rawBody as Record<string, unknown>).demoType === "string" &&
        (rawBody as Record<string, string>).demoType !== "ecommerce"
      ) {
        const legacyDemoType = (rawBody as Record<string, string>).demoType;
        log.warn(
          { requestId, legacyDemoType },
          "Legacy demoType body field ignored — every demo workspace gets ecommerce since 1.4.0 (#2021)",
        );
        c.header(
          "Deprecation",
          'true; field="demoType"; reason="Atlas ships a single canonical demo since 1.4.0 (#2021); body field ignored"',
        );
      }

      // ---------------------------------------------------------------
      // Phase 1 — fail-fast pre-validation. Resolve and check everything
      // we'll need before touching the DB so a misconfigured deploy 500s
      // without leaving a half-installed workspace behind. The previous
      // ordering committed the connection row before attempting the
      // entity import; if the import then failed (or the bundled YAML
      // wasn't on disk), the user ended up with a `__demo__` connection
      // and zero `semantic_entities` — the semantic page and the agent
      // both saw a broken setup.
      // ---------------------------------------------------------------
      const url = resolveDatasourceUrl();
      if (!url) {
        return c.json({ error: "no_demo_datasource", message: "No demo datasource configured. Set ATLAS_DATASOURCE_URL." }, 400);
      }

      const id = DEMO_CONNECTION_ID;
      const industry = DEMO_INDUSTRY;
      let dbType: string;
      try {
        dbType = detectDBType(url);
      } catch (err) {
        log.error({ err: errorMessage(err), requestId }, "Demo datasource URL has unsupported scheme");
        return c.json({ error: "invalid_datasource", message: "Demo datasource URL has an unsupported scheme.", requestId }, 500);
      }

      let semanticDir: string;
      try {
        const resolved = getDemoSemanticDir();
        semanticDir = resolved.dir;
        if (resolved.source === "bundled-seed") {
          log.info(
            { requestId, semanticDir },
            "Demo semantic layer resolved via bundled-seed dev fallback (semantic/ not initialized at the configured root)",
          );
        }
      } catch (err) {
        log.error({ err: errorMessage(err), requestId }, "Canonical demo semantic layer not found");
        return c.json({
          error: "demo_not_available",
          message: "The canonical demo semantic layer is not installed on this server. Contact the platform administrator.",
          requestId,
        }, 500);
      }

      let encryptedUrl: string;
      try {
        encryptedUrl = encryptSecret(url);
      } catch (err) {
        log.error({ err: errorMessage(err), requestId }, "Failed to encrypt demo connection URL");
        return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL.", requestId }, 500);
      }

      // Resolve the demo catalog row up front (a read, kept off the locked
      // transaction). Post-0096 cutover (#2744 / ADR-0007) every workspace owns
      // its own `__demo__` install row (auto-created at boot via
      // `loadSavedConnections` / 0096 step 3); onboarding upserts that row's
      // config + status for THIS workspace.
      const demoLabel = DEMO_LABEL;
      const demoCatalogRows = yield* Effect.tryPromise({
        try: () => internalQuery<{ id: string }>(
          `SELECT id FROM plugin_catalog WHERE slug = 'demo-postgres' AND pillar = 'datasource' LIMIT 1`,
        ),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.catchAll((err) => {
        log.error({ err: err.message, requestId }, "Failed to look up demo-postgres catalog row");
        return Effect.succeed([] as Array<{ id: string }>);
      }));
      if (demoCatalogRows.length === 0) {
        log.error({ requestId }, "demo-postgres catalog row missing — onboarding cannot commit");
        return c.json({ error: "internal_error", message: "Demo catalog not seeded.", requestId }, 500);
      }
      const demoConfigJson = JSON.stringify({
        url: encryptedUrl,
        description: `${demoLabel} — demo ${dbType} datasource`,
        db_type: dbType,
      });

      // ---------------------------------------------------------------
      // Phases 2+3 — atomic, mutually-exclusive seed (#3683).
      //
      // `withDemoSeedLock` opens ONE transaction holding a per-workspace
      // advisory lock and hands a `tx.query` runner. Both the semantic-entity
      // import (phase 2) and the `workspace_plugins` published flip (phase 3)
      // run on that single connection, so:
      //   • Atomicity — a blip / pool exhaustion / process kill between the two
      //     phases rolls the whole seed back; draft `semantic_entities` are
      //     never committed without the published install that makes them
      //     visible (the orphaned-partial-demo state this fixes).
      //   • Mutual exclusion — concurrent same-`orgId` POSTs serialize on the
      //     advisory lock instead of interleaving `ON CONFLICT DO UPDATE`
      //     upserts on the same rows, which deadlock → intermittent 500s.
      //
      // Post-0096 the per-workspace demo install typically has no
      // `config.group_id`, so entities import with `connection_group_id = NULL`
      // and the visibility join's `IS NULL` branch keeps them visible. A
      // `DemoSeedFailure` thrown inside the callback rolls back and selects the
      // HTTP envelope; any other throw (raw DB error, deadlock) rolls back too
      // and maps to a generic `import_failed`.
      // ---------------------------------------------------------------
      const seedOutcome = yield* Effect.tryPromise({
        try: () => withDemoSeedLock(orgId, async (tx) => {
          // Phase 2 — import demo semantic entities on the transaction
          // connection so they commit (or roll back) with phase 3.
          //
          // Seed as `published`, not the import default `draft` (#3932). A fresh
          // signup runs in `published` atlas-mode by default (no developer
          // cookie), and the published-mode entity read requires the ENTITY's
          // own `status='published'` — a published install alone does NOT surface
          // draft entities. Left as drafts, the curated demo layer is invisible
          // to BOTH the chat data-setup gate (`/semantic/entities` → 0 →
          // composer hidden) AND the agent's published-mode whitelist (empty →
          // "I have no tables"), dead-ending the user at the activation moment.
          //
          // CONTENT-MODE CARVE-OUT: this is the one place demo entities go live
          // outside the atomic publish endpoint. Justified because the demo layer
          // is system-curated and read-only (`use-demo-readonly`) with no
          // human-review step — it is published-at-seed by design, the same way
          // on-disk YAML entities are always treated as published. The published
          // upsert's `ON CONFLICT ... WHERE status='published'` keeps the re-seed
          // idempotent. See docs/development/content-mode.md.
          const importResult = await importFromDisk(orgId, {
            sourceDir: semanticDir,
            connectionId: DEMO_CONNECTION_ID,
            exec: tx.query,
            status: "published",
          });

          if (importResult.total === 0) {
            // Scan returned zero candidates — the bundled YAML isn't on the API
            // container even though `getDemoSemanticDir()` resolved a path. A
            // deploy-time misconfiguration, not user error. Fail loudly so the
            // install stays all-or-nothing.
            throw new DemoSeedFailure(
              "demo_not_available",
              "The canonical demo semantic layer is missing on this server. Contact the platform administrator.",
            );
          }
          if (importResult.imported === 0) {
            // Defensive: unreachable on the transactional path — a first-row
            // upsert failure re-throws out of `bulkUpsertEntities` (rolling the
            // batch back), so `importFromDisk` never returns `imported: 0` with
            // `total > 0` here; that case is caught by the generic rollback
            // branch below. Kept because a connection without entities is the
            // exact partial state we're preventing, so if the executor contract
            // ever changes to return a 0 count instead of throwing, this still
            // fails the seed (#3683).
            throw new DemoSeedFailure(
              "import_failed",
              "Failed to import the demo semantic layer. Retry in a moment.",
            );
          }
          if (importResult.dbFailures > 0) {
            // Defensive: on the transactional path `bulkUpsertEntities` throws
            // on the first failure (so `dbFailures` is 0 here), but if a future
            // change re-enables partial tolerance this stops a partial seed from
            // 201'ing as a clean success (#3683).
            throw new DemoSeedFailure(
              "import_failed",
              "Failed to import the full demo semantic layer. Retry in a moment.",
            );
          }

          // Phase 3 — commit point: flip THIS workspace's `__demo__` install to
          // `status='published'`, making the phase-2 entities visible. Already
          // onboarded workspaces hit ON CONFLICT and the row updates in place.
          const upsertRows = await tx.query<{ id: string }>(
            `INSERT INTO workspace_plugins
               (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at, status)
             VALUES ($1, $2, $3, $4, 'datasource', $5::jsonb, true, NOW(), 'published')
             ON CONFLICT (workspace_id, catalog_id, install_id)
               DO UPDATE SET config = EXCLUDED.config, status = 'published', updated_at = NOW()
             RETURNING install_id AS id`,
            [`cn_${orgId}_${id}`, orgId, demoCatalogRows[0].id, id, demoConfigJson],
          );
          if (upsertRows.length === 0) {
            throw new DemoSeedFailure(
              "internal_error",
              "Demo connection write did not confirm. Retry the request — the operation is idempotent.",
            );
          }

          return {
            ok: true as const,
            entitiesImported: importResult.imported,
            skipped: importResult.skipped,
          };
        }),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.catchAll((err) => {
        if (err instanceof DemoSeedFailure) {
          log.error({ code: err.code, requestId, orgId }, "Demo seed aborted — transaction rolled back");
          return Effect.succeed({
            ok: false as const,
            failure: { code: err.code, message: err.httpMessage } as const,
          });
        }
        // Any other throw — a raw DB error from the import or the published flip,
        // a deadlock, pool exhaustion. The transaction has already rolled back,
        // so no partial phase-2/phase-3 state is committed.
        log.error({ err: err.message, requestId, orgId, semanticDir }, "Demo seed transaction failed — rolled back");
        return Effect.succeed({
          ok: false as const,
          failure: {
            code: "import_failed",
            message: "Failed to import the demo semantic layer. No queryable demo state was committed — retry in a moment.",
          } as const,
        });
      }));

      if (!seedOutcome.ok) {
        return c.json({ error: seedOutcome.failure.code, message: seedOutcome.failure.message, requestId }, 500);
      }

      const entitiesImported = seedOutcome.entitiesImported;
      log.info(
        { orgId, imported: seedOutcome.entitiesImported, skipped: seedOutcome.skipped, requestId },
        "Imported demo semantic layer",
      );

      // Skip re-registration if the in-memory pool already has this id —
      // concurrent onboarders would otherwise needlessly drain and recreate
      // the pool. The DB-level race is resolved by the per-workspace advisory
      // lock + the `(workspace_id, catalog_id, install_id)` unique index backing
      // the `ON CONFLICT DO UPDATE` above — last write wins on the same demo
      // config, so no duplicate rows result.
      try {
        if (!connections.has(id)) {
          connections.register(id, { url, description: `${demoLabel} — demo ${dbType} datasource` });
        }
      } catch (err) {
        log.warn({ err: errorMessage(err), requestId }, "Demo connection saved but runtime registration failed");
      }

      // Write demo_industry setting. Independent post-commit decoration —
      // failure leaves the workspace queryable but with no demoIndustry-aware
      // banners. Surfaced through a `partialFailures` array on the 201
      // response so the frontend can show a degraded-state notice instead
      // of pretending everything worked. The `org-with-demo` listing query
      // (lib/prompts/scoping.ts) keys off this setting, so the demo
      // industry's global builtin prompt collections show up automatically
      // — there's no per-org prompt seed to do here (#2169).
      const settingResult = yield* Effect.tryPromise({
        try: () => setSetting("ATLAS_DEMO_INDUSTRY", industry, user?.id, orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(
        Effect.map(() => ({ ok: true as const, step: "demo_industry_setting" as const })),
        Effect.catchAll((err) => {
          log.warn({ err: err.message, requestId, orgId, industry }, "Failed to write demo_industry setting — non-fatal");
          return Effect.succeed({ ok: false as const, step: "demo_industry_setting" as const });
        }),
      );

      const partialFailures = settingResult.ok ? [] : [settingResult.step];

      _resetWhitelists();

      log.info(
        { requestId, orgId, dbType, userId: user?.id, entitiesImported, industry, partialFailures },
        "Demo onboarding complete",
      );

      return c.json({
        connectionId: id,
        dbType,
        maskedUrl: maskConnectionUrl(url),
        entitiesImported,
        partialFailures,
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

import { residencyDomainError } from "./shared-residency";
import { ResidencyError } from "@atlas/api/lib/residency/errors";
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
    "This must be called before connecting a database. Region can be migrated later " +
    "via the admin Data Residency surface — pick the region that matches where your " +
    "team operates to keep cross-region migrations rare.",
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

    const mod = yield* ResidencyResolver;
    if (!mod.available) {
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
      if (err instanceof ResidencyError && err.code === "not_configured") {
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

      const mod = yield* ResidencyResolver;
      if (!mod.available) {
        return c.json({ error: "not_available", message: "Data residency is not available in this deployment.", requestId }, 404);
      }

      const result = yield* mod.assignWorkspaceRegion(orgId, region);
      log.info({ orgId, region, requestId }, "Workspace region assigned during signup");
      return c.json(result, 200);
    }), { label: "assign region during signup", domainErrors: [residencyDomainError] });
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
