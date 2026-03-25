import { z } from "@hono/zod-openapi";
import type { Context } from "hono";

/**
 * Standard error response schema used across all API routes.
 * Includes optional requestId for log correlation on server errors.
 */
export const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

/**
 * Auth error schema for Better Auth responses.
 * Better Auth returns dynamic shapes, so we use a permissive record type.
 */
export const AuthErrorSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Permissive Zod schema for OpenAPI route declarations.
 * Accepts the widest bounds any route allows; individual routes enforce
 * stricter limits at runtime via {@link parsePagination}.
 */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
});

/**
 * Parse limit/offset from query params with clamped bounds.
 * Values <= 0 or non-numeric fall back to the default limit.
 * Values above maxLimit are clamped. Offset below 0 defaults to 0.
 * Defaults: limit=50, maxLimit=200, offset=0.
 */
export function parsePagination(
  c: Context,
  defaults?: { limit?: number; maxLimit?: number },
): { limit: number; offset: number } {
  const maxLimit = defaults?.maxLimit ?? 200;
  const defaultLimit = defaults?.limit ?? 50;
  const rawLimit = parseInt(c.req.query("limit") ?? "", 10);
  const rawOffset = parseInt(c.req.query("offset") ?? "", 10);
  return {
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit,
    offset: Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
  };
}

// ---------------------------------------------------------------------------
// ID validation
// ---------------------------------------------------------------------------

/** Max length for path-param IDs (roles, SSO providers, SCIM connections, etc.). */
export const MAX_ID_LENGTH = 128;

/** Type guard: checks that id is a non-empty string within MAX_ID_LENGTH characters. */
export function isValidId(id: string | undefined): id is string {
  return !!id && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

// ---------------------------------------------------------------------------
// OpenAPI schema factories
// ---------------------------------------------------------------------------

/**
 * Create a path parameter schema for an entity ID.
 * Enforces min(1), max(MAX_ID_LENGTH), and includes `.openapi()` metadata.
 */
export function createIdParamSchema(example?: string) {
  return z.object({
    id: z.string().min(1).max(MAX_ID_LENGTH).openapi({
      param: { name: "id", in: "path" },
      example: example ?? "abc123",
    }),
  });
}

/**
 * Create a path parameter schema for a named parameter (e.g. "userId", "collectionId").
 * Same validation as {@link createIdParamSchema} but with a custom param name.
 */
export function createParamSchema<K extends string>(name: K, example?: string) {
  return z.object({
    [name]: z.string().min(1).max(MAX_ID_LENGTH).openapi({
      param: { name, in: "path" },
      example: example ?? "abc123",
    }),
  }) as z.ZodObject<Record<K, z.ZodString>>;
}

/**
 * Create a list response schema with `{ [fieldName]: T[], total: number }`.
 * Covers the common admin listing pattern. Pass `extra` for additional fields
 * (e.g. limit, offset, callerIP).
 */
export function createListResponseSchema<T extends z.ZodTypeAny>(
  fieldName: string,
  itemSchema: T,
  extra?: z.ZodRawShape,
) {
  return z.object({
    [fieldName]: z.array(itemSchema),
    total: z.number().openapi({ description: "Total count" }),
    ...extra,
  });
}

/**
 * Create a success response schema with a boolean field.
 * Defaults to `{ success: boolean, message?: string }`.
 */
export function createSuccessResponseSchema() {
  return z.object({
    success: z.boolean(),
    message: z.string().optional(),
  });
}

/** Standard `{ deleted: boolean }` response schema. */
export const DeletedResponseSchema = z.object({
  deleted: z.boolean(),
});

/**
 * Create a standard error response schema.
 * Equivalent to {@link ErrorSchema} but as a factory for symmetry.
 */
export function createErrorResponseSchema() {
  return z.object({
    error: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  });
}
