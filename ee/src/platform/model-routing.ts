/**
 * Enterprise workspace-level model routing.
 *
 * CRUD for per-organization LLM provider/model configuration. Every CRUD
 * function calls `requireEnterpriseEffect("model-routing")` — unlicensed
 * deployments get a clear error. API keys are stored encrypted using the
 * same AES-256-GCM pattern as connection URLs.
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 */

import { Data, Effect } from "effect";
import { requireEnterpriseEffect, EnterpriseError } from "../index";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
  encryptSecret,
  decryptSecret,
  getEncryptionKey,
} from "@atlas/api/lib/db/internal";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { getGatewayCatalog } from "@atlas/api/lib/gateway-catalog";
import { invalidateAnthropicCatalog } from "@atlas/api/lib/anthropic-catalog";
import { invalidateOpenAICatalog } from "@atlas/api/lib/openai-catalog";
import {
  invalidateBedrockCatalog,
  getBedrockCatalog,
  type BedrockDiscoveryCredentials,
} from "@atlas/api/lib/bedrock-catalog";
import { suggestModelReplacement } from "@atlas/api/lib/byot-deprecation";
import type { BedrockRegion, GatewayCatalogModel } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  ApiKeyStatus,
  WorkspaceModelConfig,
  ModelConfigProvider,
  SetWorkspaceModelConfigRequest,
  TestModelConfigRequest,
} from "@useatlas/types";
import { MODEL_CONFIG_PROVIDERS } from "@useatlas/types";

const log = createLogger("ee:model-routing");

// ── Typed errors ────────────────────────────────────────────────────

export type ModelConfigErrorCode = "validation" | "not_found" | "test_failed";

export class ModelConfigError extends Data.TaggedError("ModelConfigError")<{
  message: string;
  code: ModelConfigErrorCode;
}> {}

/**
 * Raised by `getWorkspaceModelConfigRaw` when an encrypted API key cannot be
 * decrypted (typically a key-rotation drift between `ATLAS_ENCRYPTION_KEYS`
 * and the row's `api_key_key_version`). The agent loop must surface this to
 * the user — silently falling back to the platform default would bill the
 * platform without consent.
 */
export class ModelConfigDecryptError extends Data.TaggedError("ModelConfigDecryptError")<{
  configId: string;
  cause: string;
}> {}

// ── Internal row shape ──────────────────────────────────────────────

interface ModelConfigRow {
  id: string;
  org_id: string;
  provider: string;
  model: string;
  /**
   * Nullable for provider='gateway' on platform credits. For
   * provider='bedrock' this holds an encrypted JSON blob shaped as
   * `BedrockCredentialBundle` (see `parseBedrockCredentialBundle`).
   */
  api_key_encrypted: string | null;
  base_url: string | null;
  bedrock_region: string | null;
  /** Default `'healthy'` enforced by `chk_model_status`; `null` only on pre-0059 rows. */
  model_status: "healthy" | "deprecated" | null;
  model_suggested_replacement: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Parse a string-encoded Bedrock credential bundle. The bundle ships on
 * the wire as JSON; we round-trip it through the URL encryption helper
 * the same way every other secret column does (the helper is a thin
 * AES-GCM wrapper that's content-agnostic). Returns null on malformed
 * input so the caller can surface a clean validation error.
 */
/**
 * Parse a string-encoded Bedrock credential bundle. The route layer
 * calls this directly to keep its malformed-bundle path consistent with
 * the EE row mapper's `decrypt_failed` surfacing.
 */
export function parseBedrockCredentialBundle(
  raw: string,
): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.accessKeyId !== "string" || obj.accessKeyId.length === 0) return null;
  if (typeof obj.secretAccessKey !== "string" || obj.secretAccessKey.length === 0) return null;
  const sessionToken =
    typeof obj.sessionToken === "string" && obj.sessionToken.length > 0
      ? obj.sessionToken
      : undefined;
  return {
    accessKeyId: obj.accessKeyId,
    secretAccessKey: obj.secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}


// ── Helpers ─────────────────────────────────────────────────────────

function isValidProvider(provider: string): provider is ModelConfigProvider {
  return (MODEL_CONFIG_PROVIDERS as readonly string[]).includes(provider);
}

/** Mask an API key to show only the last 4 characters. */
export function maskApiKey(key: string): string {
  if (key.length <= 4) return "****";
  return "*".repeat(key.length - 4) + key.slice(-4);
}

function rowToConfig(row: ModelConfigRow): WorkspaceModelConfig {
  if (!isValidProvider(row.provider)) {
    throw new Error(
      `Workspace model config ${row.id} has invalid provider "${row.provider}" in database`,
    );
  }

  let apiKeyMasked: string | null;
  let apiKeyStatus: ApiKeyStatus;
  if (row.api_key_encrypted === null) {
    // Per the chk_model_provider_key DB constraint, only `gateway` rows can
    // legally have a NULL ciphertext — surface as platform_credits.
    apiKeyMasked = null;
    apiKeyStatus = "platform_credits";
  } else {
    try {
      const decrypted = decryptSecret(row.api_key_encrypted);
      if (row.provider === "bedrock") {
        // For bedrock, the decrypted blob is JSON. Show the accessKeyId
        // tail as the mask — the secretAccessKey half NEVER appears on
        // the wire, not even masked. A bundle that decrypts but fails
        // to parse is functionally unusable (the AI Layer will reject
        // it on next chat); surface it as `decrypt_failed` so the admin
        // UI prompts re-entry and monitoring sees the same signal as a
        // true crypto failure.
        const bundle = parseBedrockCredentialBundle(decrypted);
        if (bundle) {
          apiKeyMasked = maskApiKey(bundle.accessKeyId);
          apiKeyStatus = "masked";
        } else {
          log.error(
            { configId: row.id },
            "Decrypted bedrock bundle is malformed — surfacing decrypt_failed to UI",
          );
          apiKeyMasked = null;
          apiKeyStatus = "decrypt_failed";
        }
      } else {
        apiKeyMasked = maskApiKey(decrypted);
        apiKeyStatus = "masked";
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), configId: row.id },
        "Failed to decrypt workspace API key — surfacing decrypt_failed to UI",
      );
      apiKeyMasked = null;
      apiKeyStatus = "decrypt_failed";
    }
  }

  // bedrockRegion narrows on the row.provider invariant — only bedrock
  // rows are allowed to have a non-null region per the DB CHECK
  // (chk_model_provider_region). For every other provider it must be null.
  const bedrockRegion =
    row.provider === "bedrock" && row.bedrock_region
      ? (row.bedrock_region as WorkspaceModelConfig["bedrockRegion"])
      : null;

  // Normalize model_status. Existing rows pre-migration 0059 may have NULL
  // until the next refresh writes through; surface those as 'healthy'.
  const modelStatus: "healthy" | "deprecated" =
    row.model_status === "deprecated" ? "deprecated" : "healthy";
  const modelSuggestedReplacement =
    modelStatus === "deprecated" && typeof row.model_suggested_replacement === "string"
      ? row.model_suggested_replacement
      : null;

  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    bedrockRegion,
    apiKeyMasked,
    apiKeyStatus,
    modelStatus,
    modelSuggestedReplacement,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ── Validation ──────────────────────────────────────────────────────

function validateConfig(
  config: SetWorkspaceModelConfigRequest,
): Effect.Effect<void, ModelConfigError> {
  if (!isValidProvider(config.provider)) {
    return Effect.fail(
      new ModelConfigError({
        message: `Invalid provider "${config.provider}". Supported: ${MODEL_CONFIG_PROVIDERS.join(", ")}`,
        code: "validation",
      }),
    );
  }

  if (!config.model || config.model.trim().length === 0) {
    return Effect.fail(
      new ModelConfigError({ message: "Model name is required.", code: "validation" }),
    );
  }

  // apiKey is optional on update (preserves existing key when omitted)
  if (config.apiKey !== undefined && config.apiKey.trim().length === 0) {
    return Effect.fail(
      new ModelConfigError({
        message: "API key cannot be empty. Omit the field to keep the existing key.",
        code: "validation",
      }),
    );
  }

  // Azure OpenAI and custom providers require a base URL
  if ((config.provider === "azure-openai" || config.provider === "custom") && !config.baseUrl) {
    return Effect.fail(
      new ModelConfigError({
        message: `Base URL is required for the "${config.provider}" provider.`,
        code: "validation",
      }),
    );
  }

  // Bedrock requires a region and a parseable IAM cred bundle. The
  // bundle is stringified JSON on the wire; we don't try to validate the
  // IAM creds themselves here (that's what testModelConfig is for) — just
  // that the shape is right so we don't store a row the AI Layer can't use.
  if (config.provider === "bedrock") {
    if (!config.bedrockRegion) {
      return Effect.fail(
        new ModelConfigError({
          message: 'AWS region is required for the "bedrock" provider.',
          code: "validation",
        }),
      );
    }
    if (config.apiKey !== undefined) {
      const parsed = parseBedrockCredentialBundle(config.apiKey);
      if (!parsed) {
        return Effect.fail(
          new ModelConfigError({
            message:
              'Bedrock credentials must be a JSON object with `accessKeyId` and `secretAccessKey`.',
            code: "validation",
          }),
        );
      }
    }
  }

  // Validate base URL format when provided
  if (config.baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(config.baseUrl);
    } catch {
      return Effect.fail(
        new ModelConfigError({
          message: `Invalid base URL: "${config.baseUrl}". Must be a valid URL (e.g. https://api.example.com/v1).`,
          code: "validation",
        }),
      );
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return Effect.fail(
        new ModelConfigError({
          message: `Base URL must use http:// or https:// (got "${parsed.protocol}").`,
          code: "validation",
        }),
      );
    }
  }

  return Effect.void;
}

const promiseError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

// ── CRUD ─────────────────────────────────────────────────────────────

/**
 * Get the workspace model configuration for an organization.
 * Returns null if no workspace config is set (falls back to platform default).
 */
export const getWorkspaceModelConfig = (
  orgId: string,
): Effect.Effect<WorkspaceModelConfig | null, EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("model-routing");
    if (!hasInternalDB()) return null;

    const rows = yield* Effect.tryPromise({
      try: () =>
        internalQuery<ModelConfigRow>(
          `SELECT id, org_id, provider, model, api_key_encrypted, base_url, bedrock_region, model_status, model_suggested_replacement, created_at, updated_at
           FROM workspace_model_config
           WHERE org_id = $1
           LIMIT 1`,
          [orgId],
        ),
      catch: promiseError,
    });

    if (rows.length === 0) return null;
    return rowToConfig(rows[0]);
  });

/**
 * Get the raw (decrypted) workspace model configuration for provider resolution.
 * Returns null if no workspace config is set or its provider failed validation.
 * Fails with `ModelConfigDecryptError` when an encrypted key cannot be
 * decrypted — the agent loop converts that into a user-visible message
 * rather than silently falling back to the platform default (which would
 * bill the platform without consent).
 *
 * WARNING: The returned API key is in plaintext. Never expose it to clients.
 */
export const getWorkspaceModelConfigRaw = (
  orgId: string,
): Effect.Effect<
  {
    provider: ModelConfigProvider;
    model: string;
    apiKey: string | null;
    baseUrl: string | null;
    bedrockRegion: string | null;
  } | null,
  ModelConfigDecryptError | Error
> =>
  Effect.gen(function* () {
    // Skip enterprise check for provider resolution — the enterprise gate
    // is enforced at the admin route level. If a config exists, we use it.
    if (!hasInternalDB()) return null;

    const rows = yield* Effect.tryPromise({
      try: () =>
        internalQuery<ModelConfigRow>(
          `SELECT id, org_id, provider, model, api_key_encrypted, base_url, bedrock_region, model_status, model_suggested_replacement, created_at, updated_at
           FROM workspace_model_config
           WHERE org_id = $1
           LIMIT 1`,
          [orgId],
        ),
      catch: promiseError,
    });

    if (rows.length === 0) return null;
    const row = rows[0];

    if (!isValidProvider(row.provider)) {
      log.error(
        { configId: row.id, provider: row.provider },
        "Invalid provider in workspace model config — ignoring",
      );
      return null;
    }

    let apiKey: string | null = null;
    if (row.api_key_encrypted !== null) {
      try {
        apiKey = decryptSecret(row.api_key_encrypted);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        log.error(
          { err: cause, configId: row.id },
          "Failed to decrypt workspace API key — surfacing tagged error",
        );
        return yield* Effect.fail(new ModelConfigDecryptError({ configId: row.id, cause }));
      }
    }

    return {
      provider: row.provider,
      model: row.model,
      apiKey,
      baseUrl: row.base_url,
      // Mirror `rowToConfig`: only bedrock rows are allowed to surface
      // a region. A stray region from a pre-migration row or a future
      // bug elsewhere doesn't leak into the AI Layer.
      bedrockRegion: row.provider === "bedrock" ? row.bedrock_region : null,
    };
  });

/**
 * Set (upsert) the workspace model configuration for an organization.
 * Validates provider, encrypts the API key, and stores the config.
 */
export const setWorkspaceModelConfig = (
  orgId: string,
  config: SetWorkspaceModelConfigRequest,
): Effect.Effect<WorkspaceModelConfig, ModelConfigError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("model-routing");
    yield* requireInternalDBEffect("workspace model configuration");
    yield* validateConfig(config);

    // Provider-transition guard: switching from gateway-on-platform-credits
    // (no stored key) to a BYOT provider without supplying a key would land
    // a NULL key on a non-gateway row, which the DB CHECK rejects with an
    // opaque 23514. Translate to a clean validation error here.
    if (!config.apiKey && config.provider !== "gateway") {
      const existing = yield* getWorkspaceModelConfig(orgId).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (!existing || existing.apiKeyStatus !== "masked") {
        return yield* Effect.fail(
          new ModelConfigError({
            message: `API key is required for the "${config.provider}" provider.`,
            code: "validation",
          }),
        );
      }
    }

    let encryptedKey: string | null = null;
    if (config.apiKey) {
      if (!getEncryptionKey()) {
        return yield* Effect.die(
          new Error(
            "Encryption key required for API key storage. Set ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET.",
          ),
        );
      }
      encryptedKey = encryptSecret(config.apiKey);
    }

    // When apiKey is omitted, preserve the existing encrypted key AND its
    // key version via COALESCE — swapping one without the other would
    // break decryption after the active version advances.
    const keyVersion = encryptedKey !== null ? activeKeyVersion() : null;
    // Bedrock region is required on the row when provider='bedrock' (see
    // chk_model_provider_region in migration 0057). Forcing NULL on every
    // other provider keeps the constraint clean and prevents a left-over
    // region from a previous bedrock row leaking into a switched provider.
    const bedrockRegion = config.provider === "bedrock" ? config.bedrockRegion ?? null : null;
    const rows = yield* Effect.tryPromise({
      try: () =>
        internalQuery<ModelConfigRow>(
          `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted, api_key_key_version, base_url, bedrock_region, model_status, model_suggested_replacement)
           VALUES (
             $1, $2, $3,
             COALESCE($4, (SELECT api_key_encrypted FROM workspace_model_config WHERE org_id = $1)),
             COALESCE($6, (SELECT api_key_key_version FROM workspace_model_config WHERE org_id = $1), 1),
             $5, $7,
             'healthy', NULL
           )
           ON CONFLICT (org_id) DO UPDATE SET
             provider = EXCLUDED.provider,
             model = EXCLUDED.model,
             api_key_encrypted = COALESCE($4, workspace_model_config.api_key_encrypted),
             api_key_key_version = COALESCE($6, workspace_model_config.api_key_key_version),
             base_url = EXCLUDED.base_url,
             bedrock_region = EXCLUDED.bedrock_region,
             -- Every successful save resets the deprecation marker. The
             -- admin picked a model — that's an explicit assertion the
             -- new choice is healthy until the next discovery refresh
             -- says otherwise.
             model_status = 'healthy',
             model_suggested_replacement = NULL,
             updated_at = now()
           RETURNING id, org_id, provider, model, api_key_encrypted, base_url, bedrock_region, model_status, model_suggested_replacement, created_at, updated_at`,
          [
            orgId,
            config.provider,
            config.model.trim(),
            encryptedKey,
            config.baseUrl ?? null,
            keyVersion,
            bedrockRegion,
          ],
        ),
      catch: promiseError,
    });

    if (!rows[0])
      return yield* Effect.die(
        new Error("Failed to save workspace model config — no row returned."),
      );

    log.info(
      { orgId, provider: config.provider, model: config.model },
      "Workspace model config saved",
    );

    // BYOT discovery caches are keyed per (org, provider) and outlast a
    // single save — flush the matching cache entry so a key rotation or
    // provider switch doesn't serve a stale catalog from the previous
    // shape. Each provider owns its own invalidator; gateway has no
    // per-org cache so it gets no hook.
    if (config.provider === "anthropic") {
      invalidateAnthropicCatalog(orgId);
    } else if (config.provider === "openai") {
      invalidateOpenAICatalog(orgId);
    } else if (config.provider === "bedrock") {
      invalidateBedrockCatalog(orgId);
    }

    return rowToConfig(rows[0]);
  });

/**
 * Delete the workspace model configuration for an organization.
 * After deletion, the workspace falls back to the platform default.
 */
export const deleteWorkspaceModelConfig = (
  orgId: string,
): Effect.Effect<boolean, EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("model-routing");
    if (!hasInternalDB()) return false;

    const pool = getInternalDB();
    const result = yield* Effect.tryPromise({
      try: () =>
        pool.query(`DELETE FROM workspace_model_config WHERE org_id = $1 RETURNING id`, [orgId]),
      catch: promiseError,
    });

    const deleted = result.rows.length > 0;
    if (deleted) {
      log.info({ orgId }, "Workspace model config deleted — reverting to platform default");
    }
    return deleted;
  });

/**
 * After a BYOT discovery refresh, compare the workspace's saved model
 * against the fresh catalog. If the model is missing, flip
 * `model_status` to `deprecated` and store the suggestion (if the
 * algorithm finds an acceptable match). If the model is present, flip
 * back to `healthy` and clear any prior suggestion.
 *
 * Best-effort: failures are logged but don't break the catalog
 * response. Returns the resulting `{ status, suggestion }` so the route
 * can echo it back if the caller wants it. Each UPDATE scopes by
 * `(org_id, model)` — a concurrent `setWorkspaceModelConfig` that
 * changed `model` mid-fetch is safe, because the WHERE doesn't match
 * the new row and the next refresh reconciles against the new model.
 */
export const reconcileModelDeprecation = (
  orgId: string,
  savedModelId: string,
  savedProvider: string,
  freshCatalog: GatewayCatalogModel[],
): Effect.Effect<
  { status: "healthy" | "deprecated"; suggestion: string | null },
  Error
> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) {
      return { status: "healthy" as const, suggestion: null };
    }
    const ids = new Set(freshCatalog.map((m) => m.id));
    // Race window: a concurrent `setWorkspaceModelConfig` may have already
    // changed `model` since the catalog fetch started. Both UPDATEs scope
    // by `(org_id, model)` so a stale reconcile can never clobber a
    // freshly-saved row — if the WHERE doesn't match, nothing changes and
    // the next refresh will reconcile against the new model.
    if (ids.has(savedModelId)) {
      yield* Effect.tryPromise({
        try: () =>
          internalQuery(
            `UPDATE workspace_model_config
             SET model_status = 'healthy', model_suggested_replacement = NULL, updated_at = now()
             WHERE org_id = $1 AND model = $2 AND model_status = 'deprecated'`,
            [orgId, savedModelId],
          ),
        catch: promiseError,
      });
      return { status: "healthy" as const, suggestion: null };
    }

    const suggestion = suggestModelReplacement(
      savedModelId,
      savedProvider,
      freshCatalog.map((m) => ({ id: m.id, provider: m.provider })),
    );
    yield* Effect.tryPromise({
      try: () =>
        internalQuery(
          `UPDATE workspace_model_config
           SET model_status = 'deprecated',
               model_suggested_replacement = $3,
               updated_at = now()
           WHERE org_id = $1 AND model = $2`,
          [orgId, savedModelId, suggestion],
        ),
      catch: promiseError,
    });
    log.info(
      { orgId, savedModelId, suggestion, candidates: freshCatalog.length },
      "Workspace model deprecated against fresh catalog",
    );
    return { status: "deprecated" as const, suggestion };
  });

/**
 * Test a model configuration by making a minimal API call.
 * Uses a simple chat completion request with minimal tokens.
 */
export const testModelConfig = (
  config: TestModelConfigRequest,
): Effect.Effect<
  {
    success: boolean;
    message: string;
    modelName?: string;
  },
  ModelConfigError | Error
> =>
  Effect.gen(function* () {
    yield* validateConfig(config);

    // BYOT providers require an apiKey for the test call. `gateway` is the
    // only provider that's allowed to test without one (platform credits via
    // catalog-membership check).
    if (!config.apiKey && config.provider !== "gateway") {
      return yield* Effect.fail(
        new ModelConfigError({
          message: `API key is required to test the "${config.provider}" provider.`,
          code: "validation",
        }),
      );
    }
    const apiKey = config.apiKey ?? "";

    return yield* Effect.tryPromise({
      try: async () => {
        try {
          switch (config.provider) {
            case "anthropic": {
              const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                  "x-api-key": apiKey,
                  "anthropic-version": "2023-06-01",
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  model: config.model,
                  max_tokens: 1,
                  messages: [{ role: "user", content: "Hi" }],
                }),
              });

              if (!response.ok) {
                const body = (await response
                  .json()
                  .catch(() => ({ error: { message: `HTTP ${response.status}` } }))) as {
                  error?: { message?: string };
                };
                const msg = body?.error?.message ?? `HTTP ${response.status}`;
                throw new Error(msg);
              }
              return { success: true, message: "Connection successful.", modelName: config.model };
            }

            case "openai": {
              const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: config.model,
                  max_tokens: 1,
                  messages: [{ role: "user", content: "Hi" }],
                }),
              });

              if (!response.ok) {
                const body = (await response
                  .json()
                  .catch(() => ({ error: { message: `HTTP ${response.status}` } }))) as {
                  error?: { message?: string };
                };
                const msg = body?.error?.message ?? `HTTP ${response.status}`;
                throw new Error(msg);
              }
              return { success: true, message: "Connection successful.", modelName: config.model };
            }

            case "azure-openai":
            case "custom": {
              if (!config.baseUrl) {
                throw new Error("Base URL is required.");
              }
              const url = config.baseUrl.replace(/\/$/, "") + "/chat/completions";
              const response = await fetch(url, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                  ...(config.provider === "azure-openai" ? { "api-key": apiKey } : {}),
                },
                body: JSON.stringify({
                  model: config.model,
                  max_tokens: 1,
                  messages: [{ role: "user", content: "Hi" }],
                }),
              });

              if (!response.ok) {
                const body = (await response
                  .json()
                  .catch(() => ({ error: { message: `HTTP ${response.status}` } }))) as {
                  error?: { message?: string };
                };
                const msg = body?.error?.message ?? `HTTP ${response.status}`;
                throw new Error(msg);
              }
              return { success: true, message: "Connection successful.", modelName: config.model };
            }

            case "gateway": {
              // Re-use the cached catalog rather than hitting upstream on every
              // test — keeps the test cheap and consistent with what the picker
              // is showing the admin.
              const catalog = await getGatewayCatalog();
              const ids = new Set(catalog.models.map((m) => m.id));
              if (!ids.has(config.model)) {
                throw new Error(
                  `Model "${config.model}" is not in the gateway catalog. Pick one from https://ai-gateway.vercel.sh/v1/models.`,
                );
              }
              if (config.apiKey) {
                // BYOT key — verify it authenticates by hitting the gateway's
                // OpenAI-compatible chat completions endpoint with 1 token.
                const authedRes = await fetch(
                  "https://ai-gateway.vercel.sh/v1/chat/completions",
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${config.apiKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      model: config.model,
                      max_tokens: 1,
                      messages: [{ role: "user", content: "Hi" }],
                    }),
                  },
                );
                if (!authedRes.ok) {
                  const body = (await authedRes
                    .json()
                    .catch(() => ({ error: { message: `HTTP ${authedRes.status}` } }))) as {
                    error?: { message?: string };
                  };
                  throw new Error(body?.error?.message ?? `HTTP ${authedRes.status}`);
                }
              }
              return { success: true, message: "Connection successful.", modelName: config.model };
            }

            case "bedrock": {
              if (!config.bedrockRegion) {
                throw new Error("AWS region is required for the bedrock provider.");
              }
              const bundle = parseBedrockCredentialBundle(apiKey);
              if (!bundle) {
                throw new Error(
                  "Bedrock credentials must be a JSON object with `accessKeyId` and `secretAccessKey`.",
                );
              }
              // Validate by hitting ListFoundationModels — it's a cheap
              // read-only call that exercises both the cred bundle and the
              // region without burning an inference token. The Converse
              // path is verified at agent-loop time once the catalog
              // selection is saved.
              try {
                const catalog = await getBedrockCatalog(
                  // Synthetic orgId keeps the in-memory cache scoped
                  // away from real workspaces; `persist: false` keeps the
                  // L2 store (workspace_model_catalog) from accumulating
                  // throwaway rows keyed by accessKeyId.
                  `__test:${bundle.accessKeyId}`,
                  config.bedrockRegion as BedrockRegion,
                  bundle as BedrockDiscoveryCredentials,
                  { refresh: true, persist: false },
                );
                const ids = new Set(catalog.models.map((m) => m.id));
                if (!ids.has(config.model)) {
                  throw new Error(
                    `Model "${config.model}" is not available in region ${config.bedrockRegion}. Pick one from the catalog.`,
                  );
                }
              } catch (err) {
                throw err instanceof Error ? err : new Error(String(err));
              }
              return { success: true, message: "Connection successful.", modelName: config.model };
            }

            default: {
              const _exhaustive: never = config.provider;
              throw new Error(`Unknown provider: ${_exhaustive}`);
            }
          }
        } catch (err) {
          const rawMessage = err instanceof Error ? err.message : String(err);
          log.warn(
            { provider: config.provider, model: config.model, err: rawMessage },
            "Model config test failed",
          );
          // Truncate provider error messages to avoid leaking sensitive info
          const sanitized = rawMessage.length > 200 ? rawMessage.slice(0, 200) + "..." : rawMessage;
          return { success: false, message: `Connection test failed: ${sanitized}` };
        }
      },
      catch: promiseError,
    });
  });
