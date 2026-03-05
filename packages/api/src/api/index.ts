/**
 * Atlas API — Hono application.
 *
 * Mounts chat, health, auth, v1 query, conversations, OpenAPI, and admin routes
 * with CORS middleware. Actions, scheduled tasks, and Slack routes are
 * conditionally loaded based on env vars.
 * Can be served standalone (./server.ts). The Next.js frontend
 * connects via same-origin rewrites (default) or cross-origin
 * fetch (when NEXT_PUBLIC_ATLAS_API_URL is set).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createLogger } from "@atlas/api/lib/logger";
import { chat } from "./routes/chat";
import { health } from "./routes/health";
import { auth } from "./routes/auth";
import { query } from "./routes/query";
import { openapi } from "./routes/openapi";
import { conversations } from "./routes/conversations";

const log = createLogger("api");
const app = new Hono();

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

app.route("/api/chat", chat);
app.route("/api/health", health);
app.route("/api/auth", auth);
app.route("/api/v1/query", query);
app.route("/api/v1/openapi.json", openapi);
app.route("/api/v1/conversations", conversations);

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

// Slack routes — lazy import, only loaded if SLACK_SIGNING_SECRET is set.
// Dynamic import avoids pulling slack dependencies into the module graph
// when Slack is disabled, and prevents mock.module leaks in test suites.
if (process.env.SLACK_SIGNING_SECRET) {
  const { slack } = await import("./routes/slack");
  app.route("/api/slack", slack);
  log.info("Slack integration enabled");
} else {
  log.debug("Slack integration disabled (SLACK_SIGNING_SECRET not set)");
}

app.onError((err, c) => {
  log.error({ err, path: c.req.path }, "Unhandled error");
  return c.json(
    {
      error: "internal_error",
      message: "An unexpected server error occurred. Please try again.",
    },
    500,
  );
});

export { app };
export type AppType = typeof app;
