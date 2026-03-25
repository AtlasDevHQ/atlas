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
 */
export function eeOnError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
}
