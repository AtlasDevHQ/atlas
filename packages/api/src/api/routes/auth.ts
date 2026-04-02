/**
 * Better Auth catch-all route.
 *
 * Uses Better Auth's fetch-native handler (Request/Response, no framework adapter).
 * Dynamic imports ensure better-auth is never loaded when not in managed mode.
 * Returns 404 for all auth routes when managed mode is not active.
 */

import { Hono } from "hono";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth-route");

const auth = new Hono();

auth.all("/*", async (c) => {
  if (detectAuthMode() !== "managed") {
    return c.json(
      { error: "not_found", message: "Auth routes are not enabled" },
      404,
    );
  }

  try {
    const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
    const authInstance = getAuthInstance();
    const response = await authInstance.handler(c.req.raw);

    // Better Auth returns a raw Response, bypassing Hono's response
    // pipeline. Copy CORS headers set by the upstream middleware so
    // cross-origin requests (app.useatlas.dev → api.useatlas.dev) work.
    const corsOrigin = c.res.headers.get("Access-Control-Allow-Origin");
    if (corsOrigin) {
      response.headers.set("Access-Control-Allow-Origin", corsOrigin);
      const corsCreds = c.res.headers.get("Access-Control-Allow-Credentials");
      if (corsCreds) response.headers.set("Access-Control-Allow-Credentials", corsCreds);
      const corsExpose = c.res.headers.get("Access-Control-Expose-Headers");
      if (corsExpose) response.headers.set("Access-Control-Expose-Headers", corsExpose);
    }

    return response;
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        url: c.req.url,
      },
      "Auth route handler failed",
    );
    return c.json(
      {
        error: "auth_service_error",
        message: "Authentication service unavailable",
      },
      503,
    );
  }
});

export { auth };
