/**
 * Secret-masking helpers for plugin config blobs.
 *
 * Admin endpoints that return a plugin's stored config must not leak values
 * whose schema field is marked `secret: true`. The placeholder is echoed back
 * by the admin UI on save when a field wasn't edited, so the write path swaps
 * it for the original value before persisting.
 */

import type { ConfigSchemaField } from "./registry";

/** Placeholder returned in place of secret values in admin config responses. */
export const MASKED_PLACEHOLDER = "••••••••";

/**
 * Narrowly parse a `plugin_catalog.config_schema` JSONB blob into a
 * `ConfigSchemaField[]`. Returns `null` for any shape we don't recognize —
 * callers treat null as "no schema, pass everything through".
 */
export function parseConfigSchema(raw: unknown): ConfigSchemaField[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ConfigSchemaField[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
      out.push(entry as ConfigSchemaField);
    }
  }
  return out;
}

/**
 * Return a copy of `config` where every key whose schema field has
 * `secret: true` is replaced by `MASKED_PLACEHOLDER`. Only non-empty string
 * values are masked — null/empty/absent values pass through so the UI can
 * distinguish "set but hidden" from "never configured".
 *
 * Returns `null` when `config` is `null` (e.g. a never-installed plugin).
 */
export function maskSecretFields(
  config: unknown,
  schema: readonly ConfigSchemaField[] | null | undefined,
): Record<string, unknown> | null {
  if (config == null) return null;
  if (typeof config !== "object" || Array.isArray(config)) return {};
  const source = config as Record<string, unknown>;
  if (!schema || schema.length === 0) return { ...source };
  const secretKeys = new Set(schema.filter((f) => f.secret).map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = secretKeys.has(key) && typeof value === "string" && value.length > 0
      ? MASKED_PLACEHOLDER
      : value;
  }
  return out;
}

/**
 * Restore secret placeholders to their prior persisted value. For each
 * `secret: true` field, if `incoming[key] === MASKED_PLACEHOLDER`, replace
 * with `originals[key]` (dropping the key if no original exists). Returns a
 * new object — does not mutate `incoming`.
 */
export function restoreMaskedSecrets(
  incoming: Record<string, unknown>,
  originals: Record<string, unknown>,
  schema: readonly ConfigSchemaField[] | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  if (!schema) return out;
  for (const field of schema) {
    if (!field.secret) continue;
    if (out[field.key] !== MASKED_PLACEHOLDER) continue;
    if (originals[field.key] !== undefined) {
      out[field.key] = originals[field.key];
    } else {
      delete out[field.key];
    }
  }
  return out;
}
