/**
 * Teams plugin configuration schema.
 *
 * Validates credential fields via Zod; runtime callbacks are validated
 * with refinements (TypeScript provides compile-time safety via
 * TeamsPluginConfig).
 */

import { z } from "zod";

export const TeamsConfigSchema = z.object({
  appId: z.string().min(1, "appId must not be empty"),
  appPassword: z.string().min(1, "appPassword must not be empty"),
  tenantId: z.string().optional(),
  // Runtime callbacks — z.any() with refinement validates the value is callable.
  executeQuery: z
    .any()
    .refine((v) => typeof v === "function", "executeQuery must be a function"),
  checkRateLimit: z
    .any()
    .refine(
      (v) => v === undefined || typeof v === "function",
      "checkRateLimit must be a function",
    )
    .optional(),
  scrubError: z
    .any()
    .refine(
      (v) => v === undefined || typeof v === "function",
      "scrubError must be a function",
    )
    .optional(),
});
