/**
 * Shared Hono onError handler for admin routes.
 *
 * Surfaces HTTPExceptions (thrown by runEffect/runHandler or framework
 * validation) as JSON responses. Unhandled errors re-throw to Hono's
 * default handler.
 *
 * Enterprise/domain error → HTTP mapping is now centralized in
 * `lib/effect/hono.ts` via `classifyError`. This module only provides
 * the router-level onError glue.
 */

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Shared Hono onError handler for admin routes.
 *
 * Returns the pre-built response for HTTPExceptions (from runEffect or
 * framework validation). Bare 400s without a response body get a generic
 * JSON body for malformed-JSON errors. Everything else re-throws to
 * Hono's default handler.
 *
 * Typed responses (`err.res`) go through `c.newResponse` so the queued
 * middleware headers — CORS, CSP, X-Frame-Options, etc. set by
 * `app.use("/api/*", ...)` upstream — merge into the response. Returning
 * `err.res` directly bypasses Hono's header pipeline, which strips CORS
 * from any cross-origin response built via `throw new HTTPException(status,
 * { res })`. #2037 fixed the same gap for streaming chat; this fix closes
 * it for every admin/platform route that uses the throw-typed-response
 * pattern (e.g. `/admin/semantic/raw/{file}`).
 */
export function eeOnError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    if (err.res) return c.newResponse(err.res.body, err.res);
    if (err.status === 400) {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
}
