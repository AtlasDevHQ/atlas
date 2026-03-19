/**
 * Atlas API — Hono application.
 *
 * Mounts chat, health, auth, v1 query, conversations, public shared
 * conversations, semantic, OpenAPI, admin, and widget routes with CORS
 * middleware. Actions, scheduled tasks, and Slack routes are conditionally
 * loaded based on env vars.
 * Can be served standalone (./server.ts). The Next.js frontend
 * connects via same-origin rewrites (default) or cross-origin
 * fetch (when NEXT_PUBLIC_ATLAS_API_URL is set).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  trace,
  SpanStatusCode,
  context as otelContext,
} from "@opentelemetry/api";
import { createLogger } from "@atlas/api/lib/logger";
import { chat } from "./routes/chat";
import { health } from "./routes/health";
import { auth } from "./routes/auth";
import { query } from "./routes/query";
import { openapi } from "./routes/openapi";
import { conversations, publicConversations } from "./routes/conversations";
import { semantic } from "./routes/semantic";
import { tables } from "./routes/tables";
import { validateSqlRoute } from "./routes/validate-sql";
import { prompts } from "./routes/prompts";
import { widget } from "./routes/widget";
import { widgetLoader, widgetTypesLoader } from "./routes/widget-loader";

const log = createLogger("api");
const tracer = trace.getTracer("atlas");
const app = new Hono();

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
const corsOrigin = process.env.ATLAS_CORS_ORIGIN;
app.use(
  "/api/*",
  cors({
    origin: corsOrigin ?? "*",
    credentials: !!corsOrigin, // only send credentials header when origin is explicit
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Retry-After", "x-conversation-id"],
  }),
);

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
app.route("/api/v1/openapi.json", openapi);
app.route("/api/v1/conversations", conversations);
app.route("/api/public/conversations", publicConversations);
app.route("/api/v1/semantic", semantic);
app.route("/api/v1/tables", tables);
app.route("/api/v1/validate-sql", validateSqlRoute);
app.route("/api/v1/prompts", prompts);
app.route("/widget", widget);
app.route("/widget.js", widgetLoader);
app.route("/widget.d.ts", widgetTypesLoader);

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

app.onError((err, c) => {
  const requestId = crypto.randomUUID();
  log.error({ err, path: c.req.path, requestId }, "Unhandled error");
  return c.json(
    {
      error: "internal_error",
      message: `An unexpected server error occurred (ref: ${requestId.slice(0, 8)}). Please try again.`,
    },
    500,
  );
});

export { app };
export type AppType = typeof app;
