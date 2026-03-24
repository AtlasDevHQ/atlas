/**
 * Admin workspace model configuration routes.
 *
 * Mounted under /api/v1/admin/model-config. All routes require admin role AND
 * enterprise license (enforced within the model-routing service layer).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "@atlas/api/lib/logger";
import { EnterpriseError } from "@atlas/ee/index";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  getWorkspaceModelConfig,
  setWorkspaceModelConfig,
  deleteWorkspaceModelConfig,
  testModelConfig,
  ModelConfigError,
} from "@atlas/ee/platform/model-routing";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("admin-model-config");

const MODEL_CONFIG_ERROR_STATUS = { validation: 400, not_found: 404, test_failed: 422 } as const;

/**
 * Throw HTTPException for known model config errors. Enterprise license
 * errors → 403; ModelConfigError → 400/404/422. Unknown errors fall through.
 */
function throwIfModelConfigError(err: unknown): void {
  if (err instanceof EnterpriseError) {
    throw new HTTPException(403, {
      res: Response.json({ error: "enterprise_required", message: err.message }, { status: 403 }),
    });
  }
  if (err instanceof ModelConfigError) {
    const status = MODEL_CONFIG_ERROR_STATUS[err.code];
    throw new HTTPException(status, {
      res: Response.json({ error: err.code, message: err.message }, { status }),
    });
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ModelConfigSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom"]),
  model: z.string(),
  baseUrl: z.string().nullable(),
  apiKeyMasked: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

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
    200: {
      description: "Workspace model configuration (null if using platform default)",
      content: {
        "application/json": {
          schema: z.object({
            config: ModelConfigSchema.nullable(),
          }),
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const setConfigRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Admin — Model Config"],
  summary: "Set workspace model configuration",
  description:
    "Configures a custom LLM provider for the workspace. Overrides the platform default. API key is encrypted at rest.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: SetModelConfigBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Model configuration saved",
      content: {
        "application/json": {
          schema: z.object({ config: ModelConfigSchema }),
        },
      },
    },
    400: {
      description: "Invalid configuration or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
    200: {
      description: "Configuration reset to platform default",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "No custom configuration found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const testConfigRoute = createRoute({
  method: "post",
  path: "/test",
  tags: ["Admin — Model Config"],
  summary: "Test model configuration",
  description:
    "Tests a model configuration by making a minimal API call to the provider. Does not save the configuration.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: TestModelConfigBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Test result",
      content: {
        "application/json": {
          schema: TestResultSchema,
        },
      },
    },
    400: {
      description: "Invalid configuration or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminModelConfig = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

adminModelConfig.use(adminAuth);
adminModelConfig.use(requestContext);

adminModelConfig.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Our thrown HTTPExceptions carry a JSON Response
    if (err.res) return err.res;
    // Framework 400 for malformed JSON
    if (err.status === 400) {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

// GET / — get workspace model configuration
adminModelConfig.openapi(getConfigRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  try {
    const config = await getWorkspaceModelConfig(orgId);
    return c.json({ config }, 200);
  } catch (err) {
    throwIfModelConfigError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to get workspace model config");
    return c.json({ error: "internal_error", message: "Failed to get workspace model configuration.", requestId }, 500);
  }
});

// PUT / — set workspace model configuration
adminModelConfig.openapi(setConfigRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  const body = c.req.valid("json");

  // If apiKey is omitted, require an existing config to preserve the key
  if (!body.apiKey) {
    const existing = await getWorkspaceModelConfig(orgId);
    if (!existing) {
      return c.json({ error: "validation", message: "API key is required when no existing configuration exists." }, 400);
    }
  }

  try {
    const config = await setWorkspaceModelConfig(orgId, {
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    });
    return c.json({ config }, 200);
  } catch (err) {
    throwIfModelConfigError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to set workspace model config");
    return c.json({ error: "internal_error", message: "Failed to save workspace model configuration.", requestId }, 500);
  }
});

// DELETE / — reset workspace model configuration
adminModelConfig.openapi(deleteConfigRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  try {
    const deleted = await deleteWorkspaceModelConfig(orgId);
    if (!deleted) {
      return c.json({ error: "not_found", message: "No custom model configuration found." }, 404);
    }
    return c.json({ message: "Model configuration reset to platform default." }, 200);
  } catch (err) {
    throwIfModelConfigError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to delete workspace model config");
    return c.json({ error: "internal_error", message: "Failed to reset workspace model configuration.", requestId }, 500);
  }
});

// POST /test — test model configuration
adminModelConfig.openapi(testConfigRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  const body = c.req.valid("json");

  try {
    const result = await testModelConfig({
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    });
    return c.json(result, 200);
  } catch (err) {
    throwIfModelConfigError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to test model config");
    return c.json({ error: "internal_error", message: "Failed to test model configuration.", requestId }, 500);
  }
});

export { adminModelConfig };
