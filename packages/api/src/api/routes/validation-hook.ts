/**
 * Shared defaultHook for @hono/zod-openapi routers.
 *
 * Uses the `target` field from the validation result to generate
 * context-appropriate error messages instead of a blanket
 * "Invalid JSON body" for all validation failures.
 *
 * Must be passed as `defaultHook` to each OpenAPIHono instance —
 * Hono does NOT cascade defaultHook to sub-routers.
 */

import type { Context, Env } from "hono";
import type { ZodError } from "zod";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("validation");

/** Maps validation target keys to human-readable descriptions. */
const targetLabels: Record<string, string> = {
  json: "Invalid request body",
  form: "Invalid form data",
  query: "Invalid query parameters",
  param: "Invalid path parameters",
  header: "Invalid request headers",
  cookie: "Invalid cookie values",
};

type HookResult =
  | { target: string; success: true; data: unknown }
  | { target: string; success: false; error: ZodError };

/**
 * Shared defaultHook that returns 422 with an accurate message
 * describing which part of the request failed validation.
 *
 * Drop-in replacement for per-route defaultHook closures.
 *
 * @example
 * ```ts
 * const app = new OpenAPIHono({ defaultHook: validationHook });
 * ```
 */
export function validationHook<E extends Env = Env>(
  result: HookResult,
  c: Context<E, string>,
): Response | undefined {
  if (result.success) return undefined;

  const message =
    targetLabels[result.target] ?? `Validation error (${result.target})`;

  log.debug({ target: result.target, issues: result.error.issues.length }, "Request validation failed: %s", message);

  return c.json(
    {
      error: "validation_error",
      message,
      details: result.error.issues,
    },
    422,
  );
}
