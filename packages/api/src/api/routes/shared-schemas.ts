import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ORG_ROLES, ATLAS_ROLES } from "@atlas/api/lib/auth/types";

/**
 * Standard error response schema used across all API routes.
 * Includes optional requestId for log correlation on server errors.
 */
export const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Role validation
// ---------------------------------------------------------------------------

/**
 * The canonical schema for any request body field that assigns a workspace-
 * level role. Accepts only `member`, `admin`, `owner` — rejects `platform_admin`
 * because cross-org privilege must only be granted through a platform-admin-
 * gated endpoint, never a workspace admin surface.
 *
 * Every write path that accepts a `role` from untrusted input (body, query,
 * SCIM attribute mapping, etc.) should parse through this schema. See F-10 in
 * .claude/research/security-audit-1-2-3.md for the threat model.
 */
export const OrgRoleSchema = z.enum(ORG_ROLES);

/** Human-readable error phrase used in 400 responses when an off-tuple role is rejected. */
export const ORG_ROLE_ERROR_MESSAGE =
  `Invalid role. Must be one of: ${ORG_ROLES.join(", ")}. ` +
  `platform_admin must be granted through platform-admin endpoints.`;

/**
 * Case-insensitive reserved set of all Atlas built-in role names. Used by the
 * custom-role surface (@atlas/ee/auth/roles) to prevent a tenant admin from
 * creating a custom role that shadows `platform_admin` (or any other built-in)
 * and then assigning it via the looser custom-role assignment path. See F-10.
 */
export const RESERVED_ATLAS_ROLE_NAMES: ReadonlySet<string> = new Set(
  ATLAS_ROLES.map((r) => r.toLowerCase()),
);

/**
 * Auth error schema for Better Auth responses.
 * Better Auth returns dynamic shapes, so we use a permissive record type.
 */
export const AuthErrorSchema = z.record(z.string(), z.unknown());

/**
 * F-57 — 409 response schema returned by user-mutation routes when the
 * target is SCIM-provisioned and the workspace policy is `strict`. Owned
 * by `lib/auth/scim-managed-schema.ts` (a dependency-free module so both
 * the lib helper and this route-layer file can import it without crossing
 * the lib/ → routes/ direction); re-exported here so OpenAPI route
 * declarations have a single conventional import location.
 */
export { SCIMManagedSchema } from "@atlas/api/lib/auth/scim-managed-schema";
import { SCIMManagedSchema } from "@atlas/api/lib/auth/scim-managed-schema";

/** Reusable OpenAPI 409 response entry for SCIM-managed user mutations. */
export const SCIMManagedResponse = {
  description:
    "User is provisioned via SCIM and the workspace policy is `strict`. The IdP owns the user lifecycle; manual mutations would be reverted on the next sync.",
  content: { "application/json": { schema: SCIMManagedSchema } },
} as const;

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

/** Escape ILIKE special characters so they are matched literally. */
export function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}
