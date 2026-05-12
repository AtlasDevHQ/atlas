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
  reconcileModelDeprecation,
  parseBedrockCredentialBundle,
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
import {
  OpenAICatalogRateLimited,
  OpenAICatalogUnauthorized,
  OpenAICatalogUnavailable,
  getOpenAICatalog,
} from "@atlas/api/lib/openai-catalog";
import {
  BedrockCatalogRateLimited,
  BedrockCatalogUnauthorized,
  BedrockCatalogUnavailable,
  getBedrockCatalog,
} from "@atlas/api/lib/bedrock-catalog";
import { BEDROCK_REGIONS, type BedrockRegion, type GatewayCatalogModel } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requirePermission } from "./admin-router";

const log = createLogger("admin-model-config");

const modelConfigDomainError = domainError(ModelConfigError, { validation: 400, not_found: 404, test_failed: 422 });

// `ModelConfigSchema` is re-exported under its prior local alias from
// `@useatlas/schemas`. The request-body schemas below keep the strict
// provider enum (`anthropic | openai | azure-openai | custom`) since that
// enum is for input validation — the response-side is typed via
// `@useatlas/types`'s `WorkspaceModelConfig.provider: string` (provider
// list is not a canonical tuple in `@useatlas/types`).

const SetModelConfigBodySchema = z.object({
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom", "gateway", "bedrock"]).openapi({
    description:
      "LLM provider. Use 'custom' for any OpenAI-compatible endpoint. 'gateway' routes through Vercel AI Gateway — omit apiKey to use platform credits, or supply one for BYOT gateway billing. 'bedrock' calls AWS Bedrock using IAM creds (apiKey is the JSON-encoded `{ accessKeyId, secretAccessKey, sessionToken? }` bundle) plus `bedrockRegion`.",
    example: "anthropic",
  }),
  model: z.string().min(1).openapi({
    description: "Model identifier (e.g. claude-opus-4-7, gpt-4o, anthropic/claude-opus-4.7 for gateway, anthropic.claude-opus-4-7 for bedrock).",
    example: "claude-opus-4-6",
  }),
  apiKey: z.string().min(1).optional().openapi({
    description:
      "Provider API key. Stored encrypted. Omit to keep the existing key on update. For 'gateway', omit entirely to ride on platform credits. For 'bedrock', supply the JSON-stringified IAM cred bundle.",
    example: "sk-ant-...",
  }),
  baseUrl: z.string().optional().openapi({
    description: "Base URL for Azure OpenAI or custom endpoints. Required for azure-openai and custom providers.",
    example: "https://my-deployment.openai.azure.com/openai/deployments/gpt-4o/",
  }),
  bedrockRegion: z.enum(BEDROCK_REGIONS).optional().openapi({
    description: "AWS region for the 'bedrock' provider. Required when provider='bedrock'; ignored otherwise.",
    example: "us-east-1",
  }),
});

const TestModelConfigBodySchema = z.object({
  provider: z.enum(["anthropic", "openai", "azure-openai", "custom", "gateway", "bedrock"]),
  model: z.string().min(1),
  // Optional for `gateway` on platform credits; required for every other case.
  // Cross-field validation lives in the handler (see PUT) and in EE testModelConfig.
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().optional(),
  bedrockRegion: z.enum(BEDROCK_REGIONS).optional(),
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
  provider: z.enum(["gateway", "anthropic", "openai", "bedrock"]).optional().openapi({
    description:
      "Provider catalog to return. Defaults to 'gateway' (Vercel AI Gateway, anonymous). 'anthropic' / 'openai' / 'bedrock' return BYOT catalogs fetched with the workspace's saved key — bedrock additionally requires a saved region. Every BYOT variant requires a matching saved configuration.",
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
    // `bedrockRegion` is non-secret and useful for triage so it lands in
    // metadata; the IAM cred bundle (inside `apiKey`) does not.
    const auditBase = {
      provider: body.provider,
      model: body.model,
      hasSecret: body.apiKey !== undefined,
      ...(body.bedrockRegion ? { bedrockRegion: body.bedrockRegion } : {}),
    };
    const config = yield* setWorkspaceModelConfig(orgId, {
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      bedrockRegion: body.bedrockRegion,
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
    const auditBase = {
      provider: body.provider,
      model: body.model,
      ...(body.bedrockRegion ? { bedrockRegion: body.bedrockRegion } : {}),
    };
    const result = yield* testModelConfig({
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      bedrockRegion: body.bedrockRegion,
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

    // BYOT direct-provider catalogs (anthropic, openai) share a flow:
    //   1. The workspace must have a saved config matching the requested
    //      provider and a healthy (decryptable) key.
    //   2. The catalog fetch is credentialed — audit the outcome (never
    //      the key).
    //   3. Provider-specific exceptions map to a small set of HTTP
    //      envelopes: 401 / 429 / 503.
    //
    // The dispatch table below keeps the per-provider knobs (fetcher,
    // error classes, friendly provider name) in one place. Bedrock
    // forks into a parallel inline flow because its cred shape is
    // `(region, bundle)` instead of `(apiKey)`.
    if (!orgId) {
      return c.json(
        { error: "bad_request", message: "No active organization. Set an active org first.", requestId },
        400,
      );
    }

    // Decrypt errors surface as 422 with a clear "re-enter the key" message
    // rather than as a generic 500. Shared across every BYOT direct-provider
    // path below.
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
        metadata: { provider, error: "decrypt_failed" },
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

    if (provider === "bedrock") {
      // Bedrock has a divergent shape: creds are a JSON bundle, region is
      // a separate workspace_model_config column. Surface a clear envelope
      // for each missing precondition before the dispatch tries to fetch.
      if (
        !rawConfig ||
        rawConfig.provider !== "bedrock" ||
        !rawConfig.apiKey ||
        !rawConfig.bedrockRegion
      ) {
        // Audit the missing-key envelope to match the success path —
        // forensic queries scanning catalog_refresh attempts shouldn't
        // see silent 400s for misconfigured workspaces.
        logAdminAction({
          actionType: ADMIN_ACTIONS.model_config.catalogRefresh,
          targetType: "model_config",
          targetId: orgId,
          status: "failure",
          metadata: { provider: "bedrock", error: "missing_byot_key" },
        });
        return c.json(
          {
            error: "missing_byot_key",
            message:
              "Save AWS Bedrock IAM credentials + region on this workspace before refreshing the catalog.",
            requestId,
          },
          400,
        );
      }
      // Reuse the shared parser so the route and EE row mapper stay
      // in lockstep. `null` is the malformed-bundle signal — distinct
      // from a true decrypt failure (`decryptSecret` throwing), which
      // would have already surfaced via `rowToConfig`'s
      // `apiKeyStatus = "decrypt_failed"` path.
      const bundle = parseBedrockCredentialBundle(rawConfig.apiKey);
      if (!bundle) {
        log.warn(
          { orgId },
          "Stored bedrock bundle decrypted but parsed as null — surfacing malformed_bedrock_bundle 422",
        );
        logAdminAction({
          actionType: ADMIN_ACTIONS.model_config.catalogRefresh,
          targetType: "model_config",
          targetId: orgId,
          status: "failure",
          metadata: { provider: "bedrock", error: "malformed_bedrock_bundle" },
        });
        return c.json(
          {
            error: "malformed_bedrock_bundle",
            message:
              "Stored bedrock credentials are malformed. Re-enter the access key + secret on the AI Provider page.",
            requestId,
          },
          422,
        );
      }

      const bedrockResult = yield* Effect.tryPromise({
        try: async (): Promise<ByotCatalogResult> => {
          try {
            const cat = await getBedrockCatalog(
              orgId,
              rawConfig.bedrockRegion as BedrockRegion,
              bundle,
              { refresh },
            );
            return {
              kind: "ok",
              models: cat.models,
              fetchedAt: cat.fetchedAt,
              source: cat.source,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err instanceof BedrockCatalogUnauthorized) {
              return { kind: "byot_key_invalid", message };
            }
            if (err instanceof BedrockCatalogRateLimited) {
              return {
                kind: "byot_provider_rate_limited",
                message,
                retryAfter: err.retryAfterSeconds,
              };
            }
            if (err instanceof BedrockCatalogUnavailable) {
              return { kind: "byot_provider_unavailable", message };
            }
            // Unmapped error class — the three instanceof arms above
            // cover every error the bedrock fetcher is documented to
            // throw, but a future addition that forgets to add an arm
            // would land here and bubble up as a generic 500 with the
            // `_tag` lost. Log loudly so the gap is visible in prod
            // before users hit it.
            log.error(
              {
                err: err instanceof Error ? err.message : String(err),
                errName: err instanceof Error ? err.name : "Unknown",
                provider: "bedrock",
              },
              "Unmapped bedrock catalog error class — add an instanceof arm",
            );
            throw err;
          }
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      if (bedrockResult.kind === "ok") {
        yield* reconcileModelDeprecation(
          orgId,
          rawConfig.model,
          "bedrock",
          bedrockResult.models,
        ).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              const message = err instanceof Error ? err.message : String(err);
              log.warn(
                { orgId, provider: "bedrock", err: message },
                "reconcileModelDeprecation failed — modelStatus may be stale until next refresh",
              );
              return null;
            }),
          ),
        );
      }

      return finalizeByotCatalog(c, bedrockResult, {
        orgId,
        requestId,
        provider: "bedrock",
      });
    }

    const adapter = byotAdapter(provider);

    if (!rawConfig || rawConfig.provider !== adapter.providerKey || !rawConfig.apiKey) {
      return c.json(
        {
          error: "missing_byot_key",
          message: `Save a ${adapter.displayName} API key on this workspace before refreshing the catalog.`,
          requestId,
        },
        400,
      );
    }

    const catalogResult = yield* Effect.tryPromise({
      try: async (): Promise<ByotCatalogResult> => {
        try {
          const cat = await adapter.fetch(orgId, rawConfig.apiKey ?? "", { refresh });
          return {
            kind: "ok",
            models: cat.models,
            fetchedAt: cat.fetchedAt,
            source: cat.source,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof adapter.errors.Unauthorized) {
            return { kind: "byot_key_invalid", message };
          }
          if (err instanceof adapter.errors.RateLimited) {
            // The `RateLimited` discriminator types its instance with
            // `retryAfterSeconds`, so this access type-narrows without
            // a cast.
            return {
              kind: "byot_provider_rate_limited",
              message,
              retryAfter: err.retryAfterSeconds,
            };
          }
          if (err instanceof adapter.errors.Unavailable) {
            return { kind: "byot_provider_unavailable", message };
          }
          // Unmapped error class — see the parallel comment in the
          // bedrock branch. Log so production sees the missing arm
          // before the user-facing 500.
          log.error(
            {
              err: err instanceof Error ? err.message : String(err),
              errName: err instanceof Error ? err.name : "Unknown",
              provider: adapter.providerKey,
            },
            "Unmapped catalog error class — add an instanceof arm",
          );
          throw err;
        }
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    if (catalogResult.kind === "ok") {
      // Best-effort reconciliation: a DB hiccup here leaves
      // `model_status` stale until the next refresh. We log the failure
      // explicitly so prod dashboards can spot a degraded reconcile
      // pattern instead of silently divergent state.
      yield* reconcileModelDeprecation(
        orgId,
        rawConfig.model,
        adapter.providerKey,
        catalogResult.models,
      ).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(
              { orgId, provider: adapter.providerKey, err: message },
              "reconcileModelDeprecation failed — modelStatus may be stale until next refresh",
            );
            return null;
          }),
        ),
      );
    }

    return finalizeByotCatalog(c, catalogResult, {
      orgId,
      requestId,
      provider: adapter.providerKey,
    });
  }), { label: "get model catalog", domainErrors: [modelConfigDomainError] });
});

// ---------------------------------------------------------------------------
// BYOT direct-provider catalog adapter
//
// Anthropic + OpenAI share an identical flow (config gate → fetch →
// classified-error envelope). The adapter is the smallest surface that
// captures the per-provider knobs without abstracting away the per-route
// audit + envelope logic. A direct provider whose cred shape matches
// `(orgId, apiKey)` plugs in by adding a single entry to `byotAdapter`;
// providers with a different cred shape (Bedrock takes a region + a
// bundle) get a parallel inline flow.
// ---------------------------------------------------------------------------

interface ByotErrorClasses {
  // `abstract new (...args: never)` is the honest type for these — the
  // adapter never constructs them, it only uses them as `instanceof`
  // discriminators. `abstract` blocks `new adapter.errors.X(...)` calls
  // (which would be wrong here) while keeping `instanceof` lawful, and
  // typing `RateLimited`'s instance with `retryAfterSeconds` removes the
  // `(err as unknown as …)` cast at the read site below.
  readonly Unauthorized: abstract new (...args: never) => Error;
  readonly RateLimited: abstract new (...args: never) => Error & {
    readonly retryAfterSeconds: number | null;
  };
  readonly Unavailable: abstract new (...args: never) => Error;
}

// Wire-shape entry — kept structurally identical to `GatewayCatalogModel`
// so deprecation reconciliation hands it directly to
// `suggestModelReplacement` without an adapter step. Stays mutable
// because Hono's typed-response narrowing rejects ReadonlyArray here.
type ByotCatalogEntry = GatewayCatalogModel;

interface ByotProviderAdapter {
  readonly providerKey: "anthropic" | "openai";
  readonly displayName: string;
  readonly fetch: (
    orgId: string,
    apiKey: string,
    opts: { refresh?: boolean },
  ) => Promise<{
    models: ByotCatalogEntry[];
    fetchedAt: string;
    source: "cache" | "fresh";
  }>;
  readonly errors: ByotErrorClasses;
}

type ByotCatalogResult =
  | { kind: "ok"; models: ByotCatalogEntry[]; fetchedAt: string; source: "cache" | "fresh" }
  | { kind: "byot_key_invalid"; message: string }
  | { kind: "byot_provider_rate_limited"; message: string; retryAfter: number | null }
  | { kind: "byot_provider_unavailable"; message: string };

function byotAdapter(provider: "anthropic" | "openai"): ByotProviderAdapter {
  if (provider === "anthropic") {
    return {
      providerKey: "anthropic",
      displayName: "Anthropic",
      fetch: getAnthropicCatalog,
      errors: {
        Unauthorized: AnthropicCatalogUnauthorized,
        RateLimited: AnthropicCatalogRateLimited,
        Unavailable: AnthropicCatalogUnavailable,
      },
    };
  }
  return {
    providerKey: "openai",
    displayName: "OpenAI",
    fetch: getOpenAICatalog,
    errors: {
      Unauthorized: OpenAICatalogUnauthorized,
      RateLimited: OpenAICatalogRateLimited,
      Unavailable: OpenAICatalogUnavailable,
    },
  };
}

/**
 * Map a `ByotCatalogResult` to the matching HTTP response + audit row.
 * Shared by every BYOT direct-provider path so the envelope stays in
 * lockstep regardless of the per-provider fetcher shape.
 */
function finalizeByotCatalog(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono's context type carries the runtime request var bag; we only call its narrow `json` + `header` here, no need to thread the full Env type through.
  c: any,
  result: ByotCatalogResult,
  meta: { orgId: string; requestId: string; provider: "anthropic" | "openai" | "bedrock" },
) {
  if (result.kind === "ok") {
    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.catalogRefresh,
      targetType: "model_config",
      targetId: meta.orgId,
      metadata: {
        provider: meta.provider,
        modelCount: result.models.length,
        source: result.source,
      },
    });
    return c.json(
      {
        models: result.models,
        fetchedAt: result.fetchedAt,
        // BYOT direct providers have no curated fallback — upstream
        // failures surface as the matching HTTP envelope below.
        // `fallback` stays false for shape parity with the gateway
        // response.
        fallback: false,
      },
      200,
    );
  }

  logAdminAction({
    actionType: ADMIN_ACTIONS.model_config.catalogRefresh,
    targetType: "model_config",
    targetId: meta.orgId,
    status: "failure",
    metadata: {
      provider: meta.provider,
      error: result.kind,
      detail: result.message,
    },
  });

  if (result.kind === "byot_key_invalid") {
    return c.json(
      { error: "byot_key_invalid", message: result.message, requestId: meta.requestId },
      401,
    );
  }
  if (result.kind === "byot_provider_rate_limited") {
    if (result.retryAfter !== null) {
      c.header("Retry-After", String(result.retryAfter));
    }
    return c.json(
      { error: "byot_provider_rate_limited", message: result.message, requestId: meta.requestId },
      429,
    );
  }
  return c.json(
    { error: "byot_provider_unavailable", message: result.message, requestId: meta.requestId },
    503,
  );
}

export { adminModelConfig };
