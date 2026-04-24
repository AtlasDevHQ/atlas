/**
 * Secret-masking helpers for plugin config blobs.
 *
 * Admin endpoints that return a plugin's stored config must not leak values
 * whose schema field is marked `secret: true`. The placeholder is echoed back
 * by the admin UI on save when a field wasn't edited, so the write path swaps
 * it for the original value before persisting.
 *
 * Schema parsing is three-state on purpose: `absent` (no schema configured —
 * nothing to mask, pass through) vs `parsed` (a real array — mask fields
 * explicitly marked `secret: true`) vs `corrupt` (schema column held something
 * we can't interpret — fail closed by masking every string value, since we'd
 * rather blank the UI than leak a credential through a migration typo).
 */

import type { ConfigSchemaField } from "./registry";

/** Placeholder returned in place of secret values in admin config responses. */
export const MASKED_PLACEHOLDER = "••••••••";

/**
 * Three-state parse result. Callers branch on `state` to decide mask/restore
 * behavior — keeping the three cases distinct prevents the fail-open that
 * would happen if `corrupt` silently collapsed to `absent`.
 */
export type ConfigSchema =
  | { state: "absent" }
  | { state: "parsed"; fields: ConfigSchemaField[] }
  | { state: "corrupt"; reason: string };

/**
 * Parse a `plugin_catalog.config_schema` JSONB blob. `null`/`undefined` →
 * `absent` (legitimate — not every plugin defines a schema). Anything else
 * that isn't an array → `corrupt` (DB drift, SDK version skew, manual ops
 * edit) — mask-all fail-closed at the call site. Within an array, entries
 * missing a string `key` are silently dropped; `secret` is coerced to a
 * strict `true` check elsewhere so `secret: "true"` (string) never passes.
 */
export function parseConfigSchema(raw: unknown): ConfigSchema {
  if (raw == null) return { state: "absent" };
  if (!Array.isArray(raw)) return { state: "corrupt", reason: `expected array, got ${typeof raw}` };
  const fields: ConfigSchemaField[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
      fields.push(entry as ConfigSchemaField);
    }
  }
  return { state: "parsed", fields };
}

/** True iff `entry` has a strict boolean `secret: true` — guards against `"true"` string drift in JSONB. */
function isSecretField(entry: ConfigSchemaField): boolean {
  return entry.secret === true;
}

/**
 * Return a copy of `config` where every key whose schema field has
 * `secret: true` is replaced by `MASKED_PLACEHOLDER`. Only non-empty string
 * values are masked — null/empty/absent values pass through so the UI can
 * distinguish "set but hidden" from "never configured".
 *
 * - `config === null` → returns `null` (propagates "not installed").
 * - `config` is not a plain object → returns `{}` (defensive: the DB shouldn't
 *   produce this but don't crash if a JSONB column drifts).
 * - `schema.state === "corrupt"` → fail closed by masking every non-empty
 *   string value, not just the schema-declared secrets. A malformed schema
 *   that silently passed config through would defeat the purpose of the
 *   mask entirely.
 */
export function maskSecretFields(
  config: unknown,
  schema: ConfigSchema,
): Record<string, unknown> | null {
  if (config == null) return null;
  if (typeof config !== "object" || Array.isArray(config)) return {};
  const source = config as Record<string, unknown>;

  if (schema.state === "corrupt") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      out[key] = typeof value === "string" && value.length > 0 ? MASKED_PLACEHOLDER : value;
    }
    return out;
  }

  if (schema.state === "absent" || schema.fields.length === 0) return { ...source };

  const secretKeys = new Set(schema.fields.filter(isSecretField).map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = secretKeys.has(key) && typeof value === "string" && value.length > 0
      ? MASKED_PLACEHOLDER
      : value;
  }
  return out;
}

/**
 * Restore secret placeholders to their prior persisted value. Returns a new
 * object — does not mutate `incoming`.
 *
 * For each `secret: true` field the write-path rules are:
 * - `incoming[key] === MASKED_PLACEHOLDER` → swap in `originals[key]` (drop
 *   the key if no original exists, so the bullet string never persists).
 * - `key` absent from `incoming` → preserve `originals[key]` if set. A UI
 *   that saves only dirty fields will omit the secret entirely; without this
 *   guard the UPDATE would silently wipe the live credential.
 * - `incoming[key]` has any other value (including `""` or `null`) → trust
 *   the caller; they explicitly submitted a rotation or a clear.
 *
 * On `corrupt` schema the same rules apply to **every** key in `originals`
 * — we don't know which are secret so we can't selectively trust omission.
 */
export function restoreMaskedSecrets(
  incoming: Record<string, unknown>,
  originals: Record<string, unknown>,
  schema: ConfigSchema,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };

  if (schema.state === "corrupt") {
    for (const [key, original] of Object.entries(originals)) {
      if (out[key] === MASKED_PLACEHOLDER) out[key] = original;
      else if (!(key in incoming)) out[key] = original;
    }
    return out;
  }

  if (schema.state === "absent") return out;

  for (const field of schema.fields) {
    if (!isSecretField(field)) continue;
    if (out[field.key] === MASKED_PLACEHOLDER) {
      if (originals[field.key] !== undefined) out[field.key] = originals[field.key];
      else delete out[field.key];
      continue;
    }
    if (!(field.key in incoming) && originals[field.key] !== undefined) {
      out[field.key] = originals[field.key];
    }
  }
  return out;
}
