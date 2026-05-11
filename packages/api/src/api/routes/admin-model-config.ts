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
  getWorkspaceModelConfigRaw,
  setWorkspaceModelConfig,
  deleteWorkspaceModelConfig,
  testModelConfig,
  ModelConfigError,
} from "@atlas/ee/platform/model-routing";
import { WorkspaceModelConfigSchema as ModelConfigSchema } from "@useatlas/schemas";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { getGatewayCatalog } from "@atlas/api/lib/gateway-catalog";
import {
  AnthropicCatalogRateLimited,
  AnthropicCatalogUnauthorized,
  AnthropicCatalogUnavailable,
  getAnthropicCatalog,
} from "@atlas/api/lib/anthropic-catalog";
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
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom", "gateway"]).openapi({
    description:
      "LLM provider. Use 'custom' for any OpenAI-compatible endpoint. 'gateway' routes through Vercel AI Gateway — omit apiKey to use platform credits, or supply one for BYOT gateway billing.",
    example: "anthropic",
  }),
  model: z.string().min(1).openapi({
    description: "Model identifier (e.g. claude-opus-4-6, gpt-4o, anthropic/claude-opus-4.6 for gateway).",
    example: "claude-opus-4-6",
  }),
  apiKey: z.string().min(1).optional().openapi({
    description:
      "Provider API key. Stored encrypted. Omit to keep the existing key on update. For 'gateway', omit entirely to ride on platform credits.",
    example: "sk-ant-...",
  }),
  baseUrl: z.string().optional().openapi({
    description: "Base URL for Azure OpenAI or custom endpoints. Required for azure-openai and custom providers.",
    example: "https://my-deployment.openai.azure.com/openai/deployments/gpt-4o/",
  }),
});

const TestModelConfigBodySchema = z.object({
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom", "gateway"]),
  model: z.string().min(1),
  // Optional for `gateway` on platform credits; required for every other case.
  // Cross-field validation lives in the handler (see PUT) and in EE testModelConfig.
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().optional(),
});

const TestResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  modelName: z.string().optional(),
});

const GatewayCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  type: z.string(),
  contextWindow: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  inputPrice: z.string().nullable(),
  outputPrice: z.string().nullable(),
  recommended: z.boolean(),
});

const GatewayCatalogResponseSchema = z.object({
  models: z.array(GatewayCatalogModelSchema),
  fetchedAt: z.string(),
  fallback: z.boolean(),
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

const CatalogQuerySchema = z.object({
  provider: z.enum(["gateway", "anthropic"]).optional().openapi({
    description:
      "Provider catalog to return. Defaults to 'gateway' (Vercel AI Gateway, anonymous). 'anthropic' returns the workspace's catalog from api.anthropic.com/v1/models using the saved BYOT key — requires a saved Anthropic configuration.",
    example: "anthropic",
  }),
  refresh: z.enum(["1", "true"]).optional().openapi({
    description: "Bypass the catalog cache and force a fresh upstream fetch.",
  }),
});

const catalogRoute = createRoute({
  method: "get",
  path: "/catalog",
  tags: ["Admin — Model Config"],
  summary: "BYOT model catalog",
  description:
    "Returns a model catalog for the requested provider. With no `?provider` (or `?provider=gateway`), returns the Vercel AI Gateway catalog (server-cached; `fallback: true` when the live fetch failed and a bundled subset was returned). With `?provider=anthropic`, returns Anthropic /v1/models for the workspace using its saved BYOT key — requires a saved Anthropic provider configuration.",
  request: { query: CatalogQuerySchema },
  responses: {
    200: { description: "Provider catalog", content: { "application/json": { schema: GatewayCatalogResponseSchema } } },
    400: { description: "Missing BYOT key for the requested provider", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required — or upstream rejected the BYOT key", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    422: { description: "Stored BYOT key cannot be decrypted (likely key-rotation drift)", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limited — by Atlas or by upstream provider", content: { "application/json": { schema: AuthErrorSchema } } },
    503: { description: "Upstream provider unavailable", content: { "application/json": { schema: ErrorSchema } } },
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

    // For BYOT providers (anthropic/openai/azure-openai/custom): omitting
    // apiKey is only valid when an existing healthy key can be preserved.
    // For provider='gateway' it's always valid: no key = ride on platform
    // AI_GATEWAY_API_KEY. A gateway-on-platform-credits row CANNOT serve as
    // the "existing key" for a BYOT-provider transition — there's no key
    // to preserve.
    if (!body.apiKey && body.provider !== "gateway") {
      const existing = yield* getWorkspaceModelConfig(orgId);
      if (!existing || existing.apiKeyStatus !== "masked") {
        return c.json(
          {
            error: "validation",
            message: `API key is required for the "${body.provider}" provider.`,
          },
          400,
        );
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

// GET /catalog — BYOT model catalog (server-cached). Defaults to gateway
// (anonymous); `?provider=anthropic` returns the workspace's Anthropic
// /v1/models catalog using the stored BYOT key.
adminModelConfig.openapi(catalogRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { provider: requestedProvider, refresh: refreshRaw } = c.req.valid("query");
    const provider = requestedProvider ?? "gateway";
    const refresh = refreshRaw === "1" || refreshRaw === "true";

    if (provider === "gateway") {
      const catalog = yield* Effect.tryPromise({
        try: () => getGatewayCatalog(),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      return c.json(catalog, 200);
    }

    // Anthropic BYOT catalog — requires a saved anthropic configuration.
    if (!orgId) {
      return c.json(
        { error: "bad_request", message: "No active organization. Set an active org first.", requestId },
        400,
      );
    }

    // Decrypt errors surface as 422 with a clear "re-enter the key" message
    // rather than as a generic 500. Catch inline so the response shape is
    // colocated with the rest of this route's envelopes.
    const rawConfigOrDecryptError = yield* getWorkspaceModelConfigRaw(orgId).pipe(
      Effect.map((cfg) => ({ ok: true as const, cfg })),
      Effect.catchTag("ModelConfigDecryptError", (err) =>
        Effect.succeed({ ok: false as const, err }),
      ),
    );

    if (!rawConfigOrDecryptError.ok) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.model_config.catalogRefresh,
        targetType: "model_config",
        targetId: orgId,
        status: "failure",
        metadata: { provider: "anthropic", error: "decrypt_failed" },
      });
      return c.json(
        {
          error: "decrypt_failed",
          message:
            "The stored API key could not be decrypted (likely a key-rotation drift). Re-enter the key on the AI Provider page.",
          requestId,
        },
        422,
      );
    }
    const rawConfig = rawConfigOrDecryptError.cfg;

    if (!rawConfig || rawConfig.provider !== "anthropic" || !rawConfig.apiKey) {
      return c.json(
        {
          error: "missing_byot_key",
          message:
            "Save an Anthropic API key on this workspace before refreshing the catalog.",
          requestId,
        },
        400,
      );
    }

    // Discovery fetches against an external provider are credentialed
    // operations: same audit threat model as `model_config.test`. Log the
    // fetch outcome (never the apiKey). The provider-specific exceptions
    // are caught inside the promise so the Effect channel carries a clean
    // discriminated result rather than tunneling through `Effect.tryPromise`'s
    // generic catch (which becomes "unmapped tagged error" at the bridge).
    type CatalogResult =
      | { kind: "ok"; models: typeof rawConfig extends never ? never : Awaited<ReturnType<typeof getAnthropicCatalog>>["models"]; fetchedAt: string; source: "cache" | "fresh" }
      | { kind: "byot_key_invalid"; message: string }
      | { kind: "byot_provider_rate_limited"; message: string; retryAfter: number | null }
      | { kind: "byot_provider_unavailable"; message: string };

    const catalogResult = yield* Effect.tryPromise({
      try: async (): Promise<CatalogResult> => {
        try {
          const cat = await getAnthropicCatalog(orgId, rawConfig.apiKey ?? "", {
            refresh,
          });
          return {
            kind: "ok",
            models: cat.models,
            fetchedAt: cat.fetchedAt,
            source: cat.source,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof AnthropicCatalogUnauthorized) {
            return { kind: "byot_key_invalid", message };
          }
          if (err instanceof AnthropicCatalogRateLimited) {
            return {
              kind: "byot_provider_rate_limited",
              message,
              retryAfter: err.retryAfterSeconds,
            };
          }
          if (err instanceof AnthropicCatalogUnavailable) {
            return { kind: "byot_provider_unavailable", message };
          }
          throw err;
        }
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    if (catalogResult.kind === "ok") {
      logAdminAction({
        actionType: ADMIN_ACTIONS.model_config.catalogRefresh,
        targetType: "model_config",
        targetId: orgId,
        metadata: {
          provider: "anthropic",
          modelCount: catalogResult.models.length,
          source: catalogResult.source,
        },
      });

      return c.json(
        {
          models: catalogResult.models,
          fetchedAt: catalogResult.fetchedAt,
          // Anthropic discovery has no curated fallback — upstream failures
          // surface as the matching HTTP envelope above. `fallback` stays
          // false for shape parity with the gateway response.
          fallback: false,
        },
        200,
      );
    }

    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.catalogRefresh,
      targetType: "model_config",
      targetId: orgId,
      status: "failure",
      metadata: {
        provider: "anthropic",
        error: catalogResult.kind,
        detail: catalogResult.message,
      },
    });

    if (catalogResult.kind === "byot_key_invalid") {
      return c.json({ error: "byot_key_invalid", message: catalogResult.message, requestId }, 401);
    }
    if (catalogResult.kind === "byot_provider_rate_limited") {
      if (catalogResult.retryAfter !== null) {
        c.header("Retry-After", String(catalogResult.retryAfter));
      }
      return c.json(
        { error: "byot_provider_rate_limited", message: catalogResult.message, requestId },
        429,
      );
    }
    return c.json(
      { error: "byot_provider_unavailable", message: catalogResult.message, requestId },
      503,
    );
  }), { label: "get model catalog", domainErrors: [modelConfigDomainError] });
});

export { adminModelConfig };
