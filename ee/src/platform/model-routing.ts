/**
 * Enterprise workspace-level model routing.
 *
 * CRUD for per-organization LLM provider/model configuration. Every CRUD
 * function calls `requireEnterprise("model-routing")` — unlicensed deployments
 * get a clear error. API keys are stored encrypted using the same AES-256-GCM
 * pattern as connection URLs.
 */

import { requireEnterprise } from "../index";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
  encryptUrl,
  decryptUrl,
  getEncryptionKey,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  WorkspaceModelConfig,
  ModelConfigProvider,
  SetWorkspaceModelConfigRequest,
  TestModelConfigRequest,
} from "@useatlas/types";
import { MODEL_CONFIG_PROVIDERS } from "@useatlas/types";

const log = createLogger("ee:model-routing");

// ── Typed errors ────────────────────────────────────────────────────

export type ModelConfigErrorCode = "validation" | "not_found" | "test_failed";

export class ModelConfigError extends Error {
  constructor(message: string, public readonly code: ModelConfigErrorCode) {
    super(message);
    this.name = "ModelConfigError";
  }
}

// ── Internal row shape ──────────────────────────────────────────────

interface ModelConfigRow {
  id: string;
  org_id: string;
  provider: string;
  model: string;
  api_key_encrypted: string;
  base_url: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
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
    throw new Error(`Workspace model config ${row.id} has invalid provider "${row.provider}" in database`);
  }

  // Decrypt the API key, then mask it for the response
  let apiKeyMasked: string;
  try {
    const decrypted = decryptUrl(row.api_key_encrypted);
    apiKeyMasked = maskApiKey(decrypted);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), configId: row.id },
      "Failed to decrypt workspace API key — masking as redacted",
    );
    apiKeyMasked = "[REDACTED]";
  }

  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    apiKeyMasked,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ── Validation ──────────────────────────────────────────────────────

function validateConfig(config: SetWorkspaceModelConfigRequest): void {
  if (!isValidProvider(config.provider)) {
    throw new ModelConfigError(
      `Invalid provider "${config.provider}". Supported: ${MODEL_CONFIG_PROVIDERS.join(", ")}`,
      "validation",
    );
  }

  if (!config.model || config.model.trim().length === 0) {
    throw new ModelConfigError("Model name is required.", "validation");
  }

  // apiKey is optional on update (preserves existing key when omitted)
  if (config.apiKey !== undefined && config.apiKey.trim().length === 0) {
    throw new ModelConfigError("API key cannot be empty. Omit the field to keep the existing key.", "validation");
  }

  // Azure OpenAI and custom providers require a base URL
  if ((config.provider === "azure-openai" || config.provider === "custom") && !config.baseUrl) {
    throw new ModelConfigError(
      `Base URL is required for the "${config.provider}" provider.`,
      "validation",
    );
  }

  // Validate base URL format when provided
  if (config.baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(config.baseUrl);
    } catch {
      throw new ModelConfigError(
        `Invalid base URL: "${config.baseUrl}". Must be a valid URL (e.g. https://api.example.com/v1).`,
        "validation",
      );
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ModelConfigError(
        `Base URL must use http:// or https:// (got "${parsed.protocol}").`,
        "validation",
      );
    }
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────

/**
 * Get the workspace model configuration for an organization.
 * Returns null if no workspace config is set (falls back to platform default).
 */
export async function getWorkspaceModelConfig(orgId: string): Promise<WorkspaceModelConfig | null> {
  requireEnterprise("model-routing");
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<ModelConfigRow>(
    `SELECT id, org_id, provider, model, api_key_encrypted, base_url, created_at, updated_at
     FROM workspace_model_config
     WHERE org_id = $1
     LIMIT 1`,
    [orgId],
  );

  if (rows.length === 0) return null;
  return rowToConfig(rows[0]);
}

/**
 * Get the raw (decrypted) workspace model configuration for provider resolution.
 * Returns null if no workspace config is set.
 *
 * WARNING: The returned API key is in plaintext. Never expose it to clients.
 * This is only for internal use in the provider resolution path.
 */
export async function getWorkspaceModelConfigRaw(orgId: string): Promise<{
  provider: ModelConfigProvider;
  model: string;
  apiKey: string;
  baseUrl: string | null;
} | null> {
  // Skip enterprise check for provider resolution — the enterprise gate
  // is enforced at the admin route level. If a config exists, we use it.
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<ModelConfigRow>(
    `SELECT id, org_id, provider, model, api_key_encrypted, base_url, created_at, updated_at
     FROM workspace_model_config
     WHERE org_id = $1
     LIMIT 1`,
    [orgId],
  );

  if (rows.length === 0) return null;
  const row = rows[0];

  if (!isValidProvider(row.provider)) {
    log.error({ configId: row.id, provider: row.provider }, "Invalid provider in workspace model config — ignoring");
    return null;
  }

  let apiKey: string;
  try {
    apiKey = decryptUrl(row.api_key_encrypted);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), configId: row.id },
      "Failed to decrypt workspace API key — falling back to platform default",
    );
    return null;
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey,
    baseUrl: row.base_url,
  };
}

/**
 * Set (upsert) the workspace model configuration for an organization.
 * Validates provider, encrypts the API key, and stores the config.
 */
export async function setWorkspaceModelConfig(
  orgId: string,
  config: SetWorkspaceModelConfigRequest,
): Promise<WorkspaceModelConfig> {
  requireEnterprise("model-routing");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for workspace model configuration.");
  }

  validateConfig(config);

  let encryptedKey: string | null = null;
  if (config.apiKey) {
    if (!getEncryptionKey()) {
      throw new Error("Encryption key required for API key storage. Set ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET.");
    }
    encryptedKey = encryptUrl(config.apiKey);
  }

  // When apiKey is omitted, preserve the existing encrypted key via COALESCE
  const rows = await internalQuery<ModelConfigRow>(
    `INSERT INTO workspace_model_config (org_id, provider, model, api_key_encrypted, base_url)
     VALUES ($1, $2, $3, COALESCE($4, (SELECT api_key_encrypted FROM workspace_model_config WHERE org_id = $1)), $5)
     ON CONFLICT (org_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       api_key_encrypted = COALESCE($4, workspace_model_config.api_key_encrypted),
       base_url = EXCLUDED.base_url,
       updated_at = now()
     RETURNING id, org_id, provider, model, api_key_encrypted, base_url, created_at, updated_at`,
    [orgId, config.provider, config.model.trim(), encryptedKey, config.baseUrl ?? null],
  );

  if (!rows[0]) throw new Error("Failed to save workspace model config — no row returned.");

  log.info({ orgId, provider: config.provider, model: config.model }, "Workspace model config saved");
  return rowToConfig(rows[0]);
}

/**
 * Delete the workspace model configuration for an organization.
 * After deletion, the workspace falls back to the platform default.
 */
export async function deleteWorkspaceModelConfig(orgId: string): Promise<boolean> {
  requireEnterprise("model-routing");
  if (!hasInternalDB()) return false;

  const pool = getInternalDB();
  const result = await pool.query(
    `DELETE FROM workspace_model_config WHERE org_id = $1 RETURNING id`,
    [orgId],
  );

  const deleted = result.rows.length > 0;
  if (deleted) {
    log.info({ orgId }, "Workspace model config deleted — reverting to platform default");
  }
  return deleted;
}

/**
 * Test a model configuration by making a minimal API call.
 * Uses a simple chat completion request with minimal tokens.
 */
export async function testModelConfig(config: TestModelConfigRequest): Promise<{
  success: boolean;
  message: string;
  modelName?: string;
}> {
  validateConfig(config);

  try {
    switch (config.provider) {
      case "anthropic": {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": config.apiKey,
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
          const body = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } })) as { error?: { message?: string } };
          const msg = body?.error?.message ?? `HTTP ${response.status}`;
          throw new Error(msg);
        }
        return { success: true, message: "Connection successful.", modelName: config.model };
      }

      case "openai": {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 1,
            messages: [{ role: "user", content: "Hi" }],
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } })) as { error?: { message?: string } };
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
        // Use the OpenAI-compatible chat completions endpoint
        const url = config.baseUrl.replace(/\/$/, "") + "/chat/completions";
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            // Azure OpenAI also accepts api-key header
            ...(config.provider === "azure-openai" ? { "api-key": config.apiKey } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 1,
            messages: [{ role: "user", content: "Hi" }],
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } })) as { error?: { message?: string } };
          const msg = body?.error?.message ?? `HTTP ${response.status}`;
          throw new Error(msg);
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
    log.warn({ provider: config.provider, model: config.model, err: rawMessage }, "Model config test failed");
    // Truncate provider error messages to avoid leaking sensitive info
    const sanitized = rawMessage.length > 200 ? rawMessage.slice(0, 200) + "..." : rawMessage;
    return { success: false, message: `Connection test failed: ${sanitized}` };
  }
}
