/**
 * Admin workspace model configuration routes.
 *
 * Mounted under /api/v1/admin/model-config. All routes require admin role AND
 * enterprise license (enforced within the model-routing service layer).
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import {
  getWorkspaceModelConfig,
  setWorkspaceModelConfig,
  deleteWorkspaceModelConfig,
  testModelConfig,
  ModelConfigError,
} from "@atlas/ee/platform/model-routing";
import { WorkspaceModelConfigSchema as ModelConfigSchema } from "@useatlas/schemas";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requirePermission } from "./admin-router";

const modelConfigDomainError = domainError(ModelConfigError, { validation: 400, not_found: 404, test_failed: 422 });

// `ModelConfigSchema` is re-exported under its prior local alias from
// `@useatlas/schemas`. The request-body schemas below keep the strict
// provider enum (`anthropic | openai | azure-openai | custom`) since that
// enum is for input validation — the response-side is typed via
// `@useatlas/types`'s `WorkspaceModelConfig.provider: string` (provider
// list is not a canonical tuple in `@useatlas/types`).

const SetModelConfigBodySchema = z.object({
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom"]).openapi({
    description: "LLM provider. Use 'custom' for any OpenAI-compatible endpoint.",
    example: "anthropic",
  }),
  model: z.string().min(1).openapi({
    description: "Model identifier (e.g. claude-opus-4-6, gpt-4o).",
    example: "claude-opus-4-6",
  }),
  apiKey: z.string().min(1).optional().openapi({
    description: "Provider API key. Will be stored encrypted. Omit to keep existing key on update.",
    example: "sk-ant-...",
  }),
  baseUrl: z.string().optional().openapi({
    description: "Base URL for Azure OpenAI or custom endpoints. Required for azure-openai and custom providers.",
    example: "https://my-deployment.openai.azure.com/openai/deployments/gpt-4o/",
  }),
});

const TestModelConfigBodySchema = z.object({
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom"]),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
});

const TestResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  modelName: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getConfigRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Model Config"],
  summary: "Get workspace model configuration",
  description:
    "Returns the workspace's custom LLM provider configuration, or null if using platform defaults.",
  responses: {
    200: { description: "Workspace model configuration (null if using platform default)", content: { "application/json": { schema: z.object({ config: ModelConfigSchema.nullable() }) } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const setConfigRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Admin — Model Config"],
  summary: "Set workspace model configuration",
  description:
    "Configures a custom LLM provider for the workspace. Overrides the platform default. API key is encrypted at rest.",
  request: { body: { required: true, content: { "application/json": { schema: SetModelConfigBodySchema } } } },
  responses: {
    200: { description: "Model configuration saved", content: { "application/json": { schema: z.object({ config: ModelConfigSchema }) } } },
    400: { description: "Invalid configuration or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteConfigRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Admin — Model Config"],
  summary: "Reset workspace model configuration",
  description:
    "Removes the workspace's custom model configuration. The workspace reverts to using the platform default.",
  responses: {
    200: { description: "Configuration reset to platform default", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No custom configuration found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const testConfigRoute = createRoute({
  method: "post",
  path: "/test",
  tags: ["Admin — Model Config"],
  summary: "Test model configuration",
  description:
    "Tests a model configuration by making a minimal API call to the provider. Does not save the configuration.",
  request: { body: { required: true, content: { "application/json": { schema: TestModelConfigBodySchema } } } },
  responses: {
    200: { description: "Test result", content: { "application/json": { schema: TestResultSchema } } },
    400: { description: "Invalid configuration or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminModelConfig = createAdminRouter();
// F-53 — BYOT model config (provider, key, model) is a settings cluster surface.
adminModelConfig.use(requirePermission("admin:settings"));

// GET / — get workspace model configuration
adminModelConfig.openapi(getConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured.", requestId }, 404);
    }

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
    }

    const config = yield* getWorkspaceModelConfig(orgId);
    return c.json({ config }, 200);
  }), { label: "get workspace model config", domainErrors: [modelConfigDomainError] });
});

// PUT / — set workspace model configuration
adminModelConfig.openapi(setConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured.", requestId }, 404);
    }

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
    }

    const body = c.req.valid("json");

    // If apiKey is omitted, require an existing config to preserve the key
    if (!body.apiKey) {
      const existing = yield* getWorkspaceModelConfig(orgId);
      if (!existing) {
        return c.json({ error: "validation", message: "API key is required when no existing configuration exists." }, 400);
      }
    }

    // Audit metadata NEVER includes apiKey / baseUrl values — `hasSecret`
    // distinguishes a rotation from a metadata-only edit. Keeping the raw
    // key out of admin_action_log is the whole point of the `model_config.*`
    // catalog entries; do not relax this without a security review.
    const auditBase = {
      provider: body.provider,
      model: body.model,
      hasSecret: body.apiKey !== undefined,
    };
    const config = yield* setWorkspaceModelConfig(orgId, {
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          logAdminAction({
            actionType: ADMIN_ACTIONS.model_config.update,
            targetType: "model_config",
            targetId: orgId,
            status: "failure",
            metadata: {
              ...auditBase,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      ),
    );

    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.update,
      targetType: "model_config",
      targetId: orgId,
      metadata: auditBase,
    });

    return c.json({ config }, 200);
  }), { label: "set workspace model config", domainErrors: [modelConfigDomainError] });
});

// DELETE / — reset workspace model configuration
adminModelConfig.openapi(deleteConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured.", requestId }, 404);
    }

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
    }

    const deleted = yield* deleteWorkspaceModelConfig(orgId).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          logAdminAction({
            actionType: ADMIN_ACTIONS.model_config.delete,
            targetType: "model_config",
            targetId: orgId,
            status: "failure",
            metadata: { error: err instanceof Error ? err.message : String(err) },
          }),
        ),
      ),
    );
    if (!deleted) {
      // No-op delete: no state change → no audit row (matches the
      // pre-handler-rejection pattern used on unknown-target writes).
      return c.json({ error: "not_found", message: "No custom model configuration found." }, 404);
    }

    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.delete,
      targetType: "model_config",
      targetId: orgId,
    });

    return c.json({ message: "Model configuration reset to platform default." }, 200);
  }), { label: "delete workspace model config", domainErrors: [modelConfigDomainError] });
});

// POST /test — test model configuration (no hasInternalDB — tests external APIs only)
adminModelConfig.openapi(testConfigRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
    }

    const body = c.req.valid("json");

    // Every /test is audited. Without an audit row an attacker with admin
    // credentials can replay stolen apiKeys here and read pass/fail from
    // the response body with zero forensic trail — the credential-oracle
    // threat. Metadata excludes apiKey / baseUrl values by construction.
    const auditBase = { provider: body.provider, model: body.model };
    const result = yield* testModelConfig({
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() =>
          logAdminAction({
            actionType: ADMIN_ACTIONS.model_config.test,
            targetType: "model_config",
            targetId: orgId,
            status: "failure",
            metadata: {
              ...auditBase,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      ),
    );

    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.test,
      targetType: "model_config",
      targetId: orgId,
      status: result.success ? "success" : "failure",
      metadata: {
        ...auditBase,
        success: result.success,
        ...(result.success ? {} : { error: result.message }),
      },
    });

    return c.json(result, 200);
  }), { label: "test model config", domainErrors: [modelConfigDomainError] });
});

export { adminModelConfig };
