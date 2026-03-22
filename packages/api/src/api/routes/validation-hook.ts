/**
 * Shared defaultHook for @hono/zod-openapi routers.
 *
 * Uses the `target` field from the validation result to generate
 * context-appropriate error messages instead of a blanket
 * "Invalid JSON body" for all validation failures.
 */

import type { Context, Env } from "hono";
import type { ZodError } from "zod";

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
 * Shared defaultHook that returns 400 with an accurate message
 * describing which part of the request failed validation.
 *
 * Drop-in replacement for per-route defaultHook closures.
 *
 * @example
 * ```ts
 * const app = new OpenAPIHono({ defaultHook: validationHook });
 * ```
 */
export function validationHook(
  result: HookResult,
  c: Context<Env, string>,
): Response | undefined {
  if (result.success) return undefined;

  const message =
    targetLabels[result.target] ?? "Validation error";

  return c.json(
    {
      error: "validation_error",
      message,
      issues: result.error.issues,
    },
    400,
  );
}
