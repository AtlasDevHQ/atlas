/**
 * Atlas API — OpenAPIHono application.
 *
 * Mounts chat, health, auth, v1 query, conversations, public shared
 * conversations, semantic, OpenAPI, admin, and widget routes with CORS
 * middleware. Actions, scheduled tasks, and Slack routes are conditionally
 * loaded based on env vars.
 * Can be served standalone (./server.ts). The Next.js frontend
 * connects via same-origin rewrites (default) or cross-origin
 * fetch (when NEXT_PUBLIC_ATLAS_API_URL is set).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import {
  trace,
  SpanStatusCode,
  context as otelContext,
} from "@opentelemetry/api";
import { createLogger } from "@atlas/api/lib/logger";
import { validationHook } from "./routes/validation-hook";
import { chat } from "./routes/chat";
import { health } from "./routes/health";
import { auth } from "./routes/auth";
import { query } from "./routes/query";
import { staticPaths, staticTags, securitySchemes } from "./routes/openapi";
import { conversations, publicConversations } from "./routes/conversations";
import { dashboards, publicDashboards } from "./routes/dashboards";
import { semantic } from "./routes/semantic";
import { tables } from "./routes/tables";
import { validateSqlRoute } from "./routes/validate-sql";
import { prompts } from "./routes/prompts";
import { widget } from "./routes/widget";
import { widgetLoader, widgetTypesLoader } from "./routes/widget-loader";
import { publicBranding } from "./routes/public-branding";
import { onboardingEmails } from "./routes/onboarding-emails";
import { mode } from "./routes/mode";
import { starterPrompts } from "./routes/starter-prompts";
import { subProcessorSubscriptions } from "./routes/sub-processor-subscriptions";
import { wellKnown } from "./routes/well-known";

const log = createLogger("api");
const tracer = trace.getTracer("atlas");
const app = new OpenAPIHono({ defaultHook: validationHook });

// Security headers (issue #1984). Must run BEFORE the CORS middleware
// because CORS short-circuits OPTIONS preflights via `c.body(null, 204)`
// and we want those hardened too.
//
// Widget routes opt out of X-Frame-Options and the strict CSP so they can
// be iframe-embedded from any origin — the widget HTML route sets its own
// `frame-ancestors *`. The match is precise (covers /widget, /widget/...,
// /widget.js, /widget.d.ts) — a bare `startsWith("/widget")` would also
// match a future /widgetfoo route and silently make it framable.
//
// `style-src 'unsafe-inline'` is required by the email unsubscribe pages
// in routes/onboarding-emails.ts, which use inline `style="..."` for
// styling. The rest of the policy stays at `default-src 'none'` so JSON
// endpoints can't be turned into resource loaders by an XSS in a rendered
// field. The set of paths that emit this CSP is the union of every
// `c.html(...)` call across the api package — keep that list small.
function isWidgetPath(path: string): boolean {
  return (
    path === "/widget" ||
    path.startsWith("/widget/") ||
    path.startsWith("/widget.")
  );
}

const API_SECURITY_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

app.use("*", async (c, next) => {
  c.header(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  if (!isWidgetPath(c.req.path)) {
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", API_SECURITY_CSP);
  }

  await next();
});

// OTel tracing — root span per HTTP request. No-op when SDK is not initialized.
// Must be the first middleware so all downstream operations are children.
app.use("/api/*", async (c, next) => {
  const span = tracer.startSpan("http.request", {
    attributes: {
      "http.method": c.req.method,
      "http.target": c.req.path,
    },
  });
  const ctx = trace.setSpan(otelContext.active(), span);
  try {
    await otelContext.with(ctx, () => next());
    span.setAttributes({ "http.status_code": c.res.status });
    span.setStatus({
      code: c.res.status < 400 ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
  } catch (err) {
    try {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(
        err instanceof Error ? err : new Error(String(err)),
      );
    } catch {
      // OTel span operations must never replace the original error.
    }
    throw err;
  } finally {
    try { span.end(); } catch { /* span lifecycle must not crash the request */ }
  }
});

// CORS — configurable origin for cross-origin frontend deployments.
// Default "*" is fine for API key / BYOT auth (header-based).
// Managed auth (cookies) needs explicit origin + credentials — see docs/hono-extraction-design.md.
//
// The origin is read per-request from the settings cache (via the
// corsResponseHeaders helper) so admin changes take effect without a server
// restart. The same helper is reused by streaming-response paths (demo chat,
// main chat) that bypass this middleware via `throw HTTPException` — see
// `packages/api/src/lib/cors.ts`.
import { corsResponseHeaders } from "@atlas/api/lib/cors";

app.use("/api/*", async (c, next) => {
  const requestOrigin = c.req.header("Origin") ?? "";
  for (const [name, value] of Object.entries(corsResponseHeaders(requestOrigin))) {
    c.header(name, value);
  }

  // Handle preflight
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, DELETE, PATCH");
    return c.body(null, 204);
  }

  await next();
});

// Plugin hook middleware — dispatches onRequest/onResponse to plugin hooks.
// Dynamic import avoids circular deps; dispatchHook is a no-op when no plugins.
app.use("/api/*", async (c, next) => {
  const { dispatchHook } = await import("@atlas/api/lib/plugins/hooks");
  await dispatchHook("onRequest", {
    path: c.req.path,
    method: c.req.method,
    headers: Object.fromEntries(c.req.raw.headers.entries()),
  });
  await next();
  await dispatchHook("onResponse", {
    path: c.req.path,
    method: c.req.method,
    status: c.res.status,
  });
});

app.route("/api/v1/chat", chat);
app.route("/api/health", health);
app.route("/api/auth", auth);
app.route("/api/v1/query", query);
// OpenAPI spec served below via merged auto + static endpoint
app.route("/api/v1/conversations", conversations);
app.route("/api/public/conversations", publicConversations);
app.route("/api/v1/dashboards", dashboards);
app.route("/api/public/dashboards", publicDashboards);
app.route("/api/v1/semantic", semantic);
app.route("/api/v1/tables", tables);
app.route("/api/v1/validate-sql", validateSqlRoute);
app.route("/api/v1/prompts", prompts);
app.route("/widget", widget);
app.route("/widget.js", widgetLoader);
app.route("/widget.d.ts", widgetTypesLoader);
app.route("/api/v1/branding", publicBranding);
app.route("/api/v1/onboarding-emails", onboardingEmails);
app.route("/api/v1/mode", mode);
app.route("/api/v1/starter-prompts", starterPrompts);
app.route("/api/v1/sub-processor-subscriptions", subProcessorSubscriptions);

// .well-known metadata endpoints — RFC 8414 OAuth authorization-server
// metadata, OIDC discovery, RFC 9728 protected-resource metadata for the
// hosted MCP endpoint. Public, CORS-permissive — these are discovery
// documents that any client must be able to fetch unauthenticated.
app.route("/.well-known", wellKnown);

// Onboarding routes — self-serve signup flow (test-connection, complete setup).
try {
  const { onboarding } = await import("./routes/onboarding");
  app.route("/api/v1/onboarding", onboarding);
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load onboarding routes",
  );
}

// Wizard routes — guided semantic layer setup (admin-gated).
try {
  const { wizard } = await import("./routes/wizard");
  app.route("/api/v1/wizard", wizard);
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load wizard routes",
  );
}

// Suggestions routes — user-facing query suggestions.
try {
  const { suggestions } = await import("./routes/suggestions");
  app.route("/api/v1/suggestions", suggestions);
  // Also register trailing-slash variant so ?table=orders and GET / both match.
  app.route("/api/v1/suggestions/", suggestions);
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load suggestions routes",
  );
}

// Demo mode routes — email-gated public demo with lead capture.
if (process.env.ATLAS_DEMO_ENABLED === "true") {
  try {
    const { demo } = await import("./routes/demo");
    app.route("/api/v1/demo", demo);
    log.info("Demo mode enabled");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load demo routes",
    );
  }
} else {
  log.debug("Demo mode disabled (ATLAS_DEMO_ENABLED not set)");
}

// Action routes — lazy import, only loaded if ATLAS_ACTIONS_ENABLED is set.
if (process.env.ATLAS_ACTIONS_ENABLED === "true") {
  const { actions } = await import("./routes/actions");
  app.route("/api/v1/actions", actions);
  log.info("Action framework enabled");
} else {
  log.debug("Action framework disabled (ATLAS_ACTIONS_ENABLED not set)");
}

// Scheduled tasks routes — lazy import, only loaded if ATLAS_SCHEDULER_ENABLED is set.
if (process.env.ATLAS_SCHEDULER_ENABLED === "true") {
  const { scheduledTasks } = await import("./routes/scheduled-tasks");
  app.route("/api/v1/scheduled-tasks", scheduledTasks);
  log.info("Scheduled tasks enabled");
} else {
  log.debug("Scheduled tasks disabled (ATLAS_SCHEDULER_ENABLED not set)");
}

// User session self-service routes — requires managed auth + internal DB.
try {
  const { sessions } = await import("./routes/sessions");
  app.route("/api/v1/sessions", sessions);
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load session routes — user session self-service will be unavailable",
  );
}

// Per-user OAuth-clients management (#2065). Workspace users (non-admin)
// list and self-revoke clients THEY personally registered through the
// hosted MCP install path. Admin variant lives under /api/v1/admin/oauth-clients.
try {
  const { meOauthClients } = await import("./routes/me-oauth-clients");
  app.route("/api/v1/me/oauth-clients", meOauthClients);
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load me-oauth-clients routes — Settings → AI Agents will be unavailable",
  );
}

// Admin routes — always available (auth-gated to admin role).
// Wrapped in try/catch so a missing dependency (e.g. js-yaml) doesn't crash the entire server.
try {
  const { admin } = await import("./routes/admin");
  app.route("/api/v1/admin", admin);
  log.info("Admin routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load admin routes — admin console will be unavailable",
  );
}

// Internal cross-region migration import — service-to-service auth via ATLAS_INTERNAL_SECRET.
try {
  const { internalMigrate } = await import("./routes/admin-migrate");
  app.route("/api/v1/internal/migrate", internalMigrate);
  log.info("Internal migration routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load internal migration routes",
  );
}

// Platform admin routes — cross-tenant management (gated to platform_admin role).
try {
  const { platformAdmin } = await import("./routes/platform-admin");
  app.route("/api/v1/platform", platformAdmin);
  log.info("Platform admin routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load platform admin routes — platform console will be unavailable",
  );
}

// Platform admin action log routes — cross-tenant action audit.
try {
  const { platformActions } = await import("./routes/platform-actions");
  app.route("/api/v1/platform/actions", platformActions);
  log.info("Platform action log routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load platform action log routes",
  );
}

// Platform security adoption telemetry — cross-tenant MFA + passkey + trust-device counts.
try {
  const { platformSecurityMetrics } = await import("./routes/platform-security-metrics");
  app.route("/api/v1/platform/admin/security", platformSecurityMetrics);
  log.info("Platform security metrics routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load platform security metrics routes — adoption dashboard will be unavailable",
  );
}

// Platform SLA monitoring routes — enterprise-gated, platform_admin role.
try {
  const { platformSLA } = await import("./routes/platform-sla");
  app.route("/api/v1/platform/sla", platformSLA);
  log.info("Platform SLA monitoring routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load platform SLA routes — SLA monitoring will be unavailable",
  );
}

// Platform backups routes — enterprise-gated, platform_admin role.
try {
  const { platformBackups } = await import("./routes/platform-backups");
  app.route("/api/v1/platform/backups", platformBackups);
  log.info("Platform backup routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load platform backup routes — backup management will be unavailable",
  );
}

// Platform data residency routes — enterprise-gated, platform_admin role.
try {
  const { platformResidency } = await import("./routes/platform-residency");
  app.route("/api/v1/platform/residency", platformResidency);
  log.info("Platform residency routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load platform residency routes — data residency will be unavailable",
  );
}

// Platform custom domain routes — enterprise-gated, platform_admin role.
try {
  const { platformDomains } = await import("./routes/platform-domains");
  app.route("/api/v1/platform/domains", platformDomains);
  log.info("Platform custom domain routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load platform domain routes — custom domains will be unavailable",
  );
}

// Platform plugin catalog routes — platform_admin role.
try {
  const { platformCatalog } = await import("./routes/admin-marketplace");
  app.route("/api/v1/platform/plugins/catalog", platformCatalog);
  log.info("Platform plugin catalog routes enabled");
} catch (err) {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Failed to load platform plugin catalog routes — marketplace catalog will be unavailable",
  );
}

// Billing routes — lazy import, only loaded if STRIPE_SECRET_KEY is set (SaaS mode).
if (process.env.STRIPE_SECRET_KEY) {
  try {
    const { billing } = await import("./routes/billing");
    app.route("/api/v1/billing", billing);
    log.info("Stripe billing routes enabled");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load billing routes — billing endpoints will be unavailable",
    );
  }
} else {
  log.debug("Billing routes disabled (STRIPE_SECRET_KEY not set)");
}

// Slack routes — lazy import, only loaded if SLACK_SIGNING_SECRET is set.
// Dynamic import avoids pulling slack dependencies into the module graph
// when Slack is disabled, and prevents mock.module leaks in test suites.
if (process.env.SLACK_SIGNING_SECRET) {
  const { slack } = await import("./routes/slack");
  app.route("/api/v1/slack", slack);
  log.info("Slack integration enabled");
} else {
  log.debug("Slack integration disabled (SLACK_SIGNING_SECRET not set)");
}

// Teams routes — lazy import, only loaded if TEAMS_APP_ID is set.
// Dynamic import avoids pulling teams dependencies into the module graph
// when Teams is disabled, and prevents mock.module leaks in test suites.
if (process.env.TEAMS_APP_ID) {
  const { teams } = await import("./routes/teams");
  app.route("/api/v1/teams", teams);
  log.info("Teams integration enabled");
} else {
  log.debug("Teams integration disabled (TEAMS_APP_ID not set)");
}

// Discord routes — lazy import, only loaded if DISCORD_CLIENT_ID is set.
if (process.env.DISCORD_CLIENT_ID) {
  const { discord } = await import("./routes/discord");
  app.route("/api/v1/discord", discord);
  log.info("Discord integration enabled");
} else {
  log.debug("Discord integration disabled (DISCORD_CLIENT_ID not set)");
}

// Hosted MCP endpoint — mounts the MCP server as a Hono route under
// /mcp/{workspace_id}/sse so the same per-region API instance that
// serves the data also serves the agent. Keeps residency guarantees —
// workspace data never crosses regions even via the agent path.
//
// `turbopackIgnore: true` tells Next.js / Turbopack not to trace this
// dynamic import into the bundle. The standalone Vercel template
// (examples/nextjs-standalone) doesn't ship hosted MCP — it's a
// single-tenant deploy where stdio MCP is the right shape — and
// dragging the heavy @atlas/mcp graph (sandbox runtime, plugin
// lifecycle, semantic-tools) into the function bundle would inflate
// cold starts. The Hono API server (which Bun runs natively, no
// bundler) resolves the import at runtime via the workspace dep.
try {
  const { createHostedMcpRouter } = await import(
    /* turbopackIgnore: true */ "@atlas/mcp/hosted"
  );
  app.route("/mcp", createHostedMcpRouter());
  log.info("Hosted MCP endpoint mounted at /mcp/{workspace_id}/sse");
} catch (err) {
  log.debug(
    { err: err instanceof Error ? err.message : String(err) },
    "Hosted MCP endpoint not available in this build — agent connections via mcp.useatlas.dev will be unavailable",
  );
}

app.onError((err, c) => {
  // Framework HTTP exceptions (e.g., malformed JSON from @hono/zod-openapi) carry
  // their own status code and response — forward them instead of converting to 500.
  // CORS + security headers must be copied from the middleware context because the
  // raw Response from HTTPException(200, { res }) bypasses Hono's header pipeline.
  if (err instanceof HTTPException) {
    const res = err.getResponse();
    const patched = new Response(res.body, res);
    for (const h of [
      "Access-Control-Allow-Origin",
      "Access-Control-Allow-Credentials",
      "Access-Control-Allow-Headers",
      "Access-Control-Expose-Headers",
      "Strict-Transport-Security",
      "Content-Security-Policy",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
    ]) {
      if (patched.headers.has(h)) continue;
      const v = c.res.headers.get(h);
      if (v) patched.headers.set(h, v);
    }
    return patched;
  }
  const requestId = crypto.randomUUID();
  log.error({ err, path: c.req.path, requestId }, "Unhandled error");
  return c.json(
    {
      error: "internal_error",
      message: `An unexpected server error occurred (ref: ${requestId.slice(0, 8)}). Please try again.`,
      requestId,
    },
    500,
  );
});

// ---------------------------------------------------------------------------
// OpenAPI spec — merged auto-generated + static entries
// ---------------------------------------------------------------------------
// Auto-generated routes come from OpenAPIHono createRoute() definitions.
// Static entries (auth proxy, widget assets) are defined in openapi.ts.

let cachedSpec: Record<string, unknown> | null = null;

app.get("/api/v1/openapi.json", (c) => {
  if (!cachedSpec) {
    const auto = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: {
        title: "Atlas API",
        version: "1.0.0",
        description:
          "Text-to-SQL data analyst agent. Ask natural-language questions about your data and receive structured answers.",
      },
      servers: [
        { url: "http://localhost:3001", description: "Standalone API (development)" },
        { url: "http://localhost:3000", description: "Same-origin via Next.js rewrites" },
      ],
    });

    // Merge static paths (auth, widget) into the auto-generated spec
    const autoPaths = (auto.paths ?? {}) as Record<string, unknown>;
    const mergedPaths = { ...autoPaths, ...staticPaths };

    // Merge static tags
    const autoTags = (auto.tags ?? []) as Array<{ name: string; description?: string }>;
    const autoTagNames = new Set(autoTags.map((t) => t.name));
    const mergedTags = [...autoTags, ...staticTags.filter((t) => !autoTagNames.has(t.name))];

    // Add security schemes
    const autoComponents = (auto.components ?? {}) as Record<string, unknown>;
    const mergedComponents = {
      ...autoComponents,
      securitySchemes: { ...((autoComponents.securitySchemes as Record<string, unknown>) ?? {}), ...securitySchemes },
    };

    cachedSpec = { ...auto, paths: mergedPaths, tags: mergedTags, components: mergedComponents };
  }
  return c.json(cachedSpec);
});

export { app };
export type AppType = typeof app;
