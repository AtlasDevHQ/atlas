import { z } from "@hono/zod-openapi";

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
