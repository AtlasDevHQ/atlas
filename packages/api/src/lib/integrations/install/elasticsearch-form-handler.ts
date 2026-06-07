/**
 * `ElasticsearchFormInstallHandler` — Admin → Integrations install/edit for the
 * `@useatlas/elasticsearch` datasource (#3270). Lets a workspace admin connect an
 * Elasticsearch / OpenSearch cluster from the UI instead of editing
 * `atlas.config.ts`. Modeled on the openapi-generic datasource form handler
 * precedent: validate → encrypt schema-marked secrets → upsert a
 * `pillar='datasource'` `workspace_plugins` row.
 *
 * **Schema-driven, not field-hardcoded.** The catalog row's `config_schema` is
 * read live from `plugin_catalog` (it mirrors the plugin's `getConfigSchema()`),
 * so the encryption walker, the masked-secret restore, and the required-field
 * check all key off the catalog schema. When the Basic / CloudID / SigV4 auth
 * slices (#3263–#3265) extend `getConfigSchema()` (+ the catalog row), this
 * handler picks the new fields up with NO code change here — the only field
 * names it knows are the ones the schema declares as `secret: true`.
 *
 * **Mask-on-read / restore-on-save (the #3270 invariant).** Admin reads mask
 * `secret: true` fields to the masked sentinel (`••••••••`) (see
 * `integrations-catalog` / marketplace `/available`). On save, a field still carrying it — or
 * omitted entirely — MUST NOT clear the stored credential: {@link
 * restoreMaskedSecrets} swaps the bullets back to the persisted value before
 * re-encryption. An explicit new value is trusted and replaces it. Decryption of
 * the existing row surfaces as an error (never a silent plaintext fallback).
 *
 * **SaaS keyset gate.** Mirrors the Email / OpenAPI posture: refuse the install
 * when `ATLAS_DEPLOY_MODE=saas` and no encryption keyset is configured, so a
 * misconfigured SaaS deploy fails closed at the credential boundary rather than
 * persisting `apiKey` in plaintext.
 *
 * **Single-instance per workspace.** One ES install per workspace (a fixed
 * `install_id`); re-submitting the form edits the same row. Connection
 * queryability for admin-installed plugin datasources is tracked separately
 * (#3295) — this slice owns install/edit/persist only, matching how every other
 * plugin-backed datasource admin-install behaves today.
 *
 * @see ./types.ts — {@link FormBasedInstallHandler}
 * @see ./openapi-generic-form-handler.ts — datasource form-handler precedent
 * @see ../../plugins/secrets.ts — encrypt / mask / restore walkers
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import { isPlaintextCredentialRisk } from "@atlas/api/lib/db/secret-encryption";
import {
  encryptSecretFields,
  decryptSecretFields,
  restoreMaskedSecrets,
  parseConfigSchema,
  type ConfigSchema,
} from "@atlas/api/lib/plugins/secrets";
import type { WorkspaceId } from "@useatlas/types";
import { FormInstallValidationError } from "./email-form-handler";
import type { CatalogId, FormBasedInstallHandler, InstallRecord } from "./types";

const log = createLogger("integrations.install.elasticsearch");

/** Catalog slug — the dispatch key in `registerFormHandler`. */
export const ELASTICSEARCH_SLUG: CatalogId = "elasticsearch";
/** Catalog FK — the canonical `catalog:<slug>` id seeded in `plugin_catalog`. */
export const ELASTICSEARCH_CATALOG_ID = "catalog:elasticsearch";
/**
 * Stable per-workspace install id — ES is single-instance for this slice, so a
 * fixed id makes re-submits edit-in-place (and the restore-on-save lookup
 * unambiguous). Multi-instance support rides along with the query-wiring slice
 * (#3295).
 */
export const ELASTICSEARCH_INSTALL_ID = "elasticsearch";

/** Test-only injection of the install id generator. */
export interface ElasticsearchFormInstallHandlerOptions {
  readonly idGenerator?: () => string;
}

interface CatalogSchemaRow extends Record<string, unknown> {
  readonly id: string;
  readonly config_schema: unknown;
}

interface ExistingInstallRow extends Record<string, unknown> {
  readonly config: Record<string, unknown> | null;
}

export class ElasticsearchFormInstallHandler implements FormBasedInstallHandler {
  readonly kind = "form" as const;

  private readonly newId: () => string;

  constructor(options: ElasticsearchFormInstallHandlerOptions = {}) {
    this.newId = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async validateConfig(
    workspaceId: WorkspaceId,
    formData: unknown,
  ): Promise<{
    readonly installRecord: InstallRecord;
    readonly credentialWritten: boolean;
  }> {
    // ── 1. Shape guard ──────────────────────────────────────────────
    if (formData === null || typeof formData !== "object" || Array.isArray(formData)) {
      throw new FormInstallValidationError({
        fieldErrors: {},
        formErrors: ["Request body must be a JSON object of config fields."],
      });
    }
    const incoming = formData as Record<string, unknown>;

    // ── 2. Load the catalog row (id + live config_schema) ───────────
    // The schema is the source of truth for which fields are secret / required
    // — read it from the catalog so future auth fields propagate automatically.
    const catalogRows = await internalQuery<CatalogSchemaRow>(
      `SELECT id, config_schema
         FROM plugin_catalog
        WHERE slug = $1 AND enabled = true
        LIMIT 1`,
      [ELASTICSEARCH_SLUG],
    );
    if (catalogRows.length === 0) {
      // The route pre-checks the catalog row, so reaching here is a seed/boot
      // misconfig (row missing or disabled) — surface as a 500, not a 400.
      log.error({ workspaceId }, "Elasticsearch catalog row missing or disabled — cannot install");
      throw new Error(
        `Catalog row "${ELASTICSEARCH_SLUG}" not found or disabled — the built-in datasource catalog seed has not run.`,
      );
    }
    const catalogId = catalogRows[0].id;
    const schema = parseConfigSchema(catalogRows[0].config_schema);

    // ── 3. Corrupt-schema guard (fail closed) ───────────────────────
    // The catalog `config_schema` is operator-controlled, not user input, and
    // the built-in datasource row is seeded ON CONFLICT DO NOTHING (no
    // self-heal of a drifted schema). A corrupt schema makes
    // `restoreMaskedSecrets` / `encryptSecretFields` fall back to "act on every
    // string" — which on a fresh install would encrypt-and-persist the masked
    // sentinel itself as the credential while `validateAgainstSchema` skips the
    // required check. Refuse loudly (operator must fix the row) instead of
    // silently storing junk.
    if (schema.state === "corrupt") {
      log.error(
        { workspaceId, reason: schema.reason },
        "Elasticsearch catalog config_schema is corrupt — refusing install rather than persisting the mask sentinel as a credential",
      );
      throw new Error(
        `Catalog "${ELASTICSEARCH_SLUG}" config_schema is corrupt (${schema.reason}) — fix the catalog row before installing.`,
      );
    }

    // ── 4. SaaS keyset gate ─────────────────────────────────────────
    // `encryptSecret` falls back to plaintext when no key is configured (dev
    // convenience). In SaaS that would leak the credential — refuse the install
    // so a misconfigured deploy fails closed at the credential boundary. Checked
    // BEFORE the existing-row read so a re-save under misconfigured SaaS surfaces
    // this actionable message rather than an opaque decrypt failure.
    if (process.env.ATLAS_DEPLOY_MODE === "saas" && !getEncryptionKeyset()) {
      log.error(
        { workspaceId },
        "Refusing Elasticsearch install: SaaS mode + no encryption keyset (would persist a plaintext credential)",
      );
      throw new Error(
        "Encryption keyset unavailable in SaaS mode — refusing to persist plaintext credentials. " +
          "Set ATLAS_ENCRYPTION_KEYS and retry.",
      );
    }

    // ── 5. Restore masked secrets against the existing install ──────
    // Read the current row (if any) so an unchanged masked secret round-trips
    // back to its stored value instead of persisting the bullet sentinel.
    const existingDecrypted = await this.loadExistingDecryptedConfig(
      workspaceId,
      catalogId,
      schema,
    );
    const restored = restoreMaskedSecrets(incoming, existingDecrypted, schema);

    // ── 6. Catalog-schema required + type validation ────────────────
    // Runs on the RESTORED config so a masked-but-preserved secret satisfies
    // its `required` rule. The schema is guaranteed `absent` or `parsed` here
    // (corrupt was rejected in step 3).
    const fieldErrors = validateAgainstSchema(restored, schema);
    if (Object.keys(fieldErrors).length > 0) {
      throw new FormInstallValidationError({ fieldErrors, formErrors: [] });
    }

    // ── 7. Self-hosted plaintext-credential warning (non-fatal) ─────
    const secretKeys = schema.state === "parsed" ? secretFieldKeys(schema) : [];
    const credentialWritten = secretKeys.some(
      (k) => typeof restored[k] === "string" && (restored[k] as string).length > 0,
    );
    if (credentialWritten && isPlaintextCredentialRisk()) {
      log.warn(
        { workspaceId },
        "Persisting an Elasticsearch credential with no encryption keyset configured in a " +
          "prod-like environment — the credential will be stored in plaintext. Set ATLAS_ENCRYPTION_KEYS " +
          "(or ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET) to encrypt integration credentials at rest.",
      );
    }

    // ── 8. Encrypt secret fields + upsert the datasource install ────
    // `encryptSecretFields` is idempotent against already-`enc:v1:` ciphertext.
    const encryptedConfig = encryptSecretFields(restored, schema);

    const candidateId = this.newId();
    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(
        `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, status, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'datasource', $5::jsonb, true, 'draft', NOW(), NOW())
         ON CONFLICT (workspace_id, catalog_id, install_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true,
               updated_at = NOW()
         RETURNING id`,
        [candidateId, workspaceId, catalogId, ELASTICSEARCH_INSTALL_ID, JSON.stringify(encryptedConfig)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        // INSERT ... ON CONFLICT ... DO UPDATE RETURNING emits exactly one row
        // on both paths; an empty result is a driver/RLS/query-rewrite anomaly.
        // Falling back to candidateId would return a WRONG id on the conflict
        // path (the row keeps its existing id). Fail loud with a 500.
        log.error(
          { workspaceId, candidateId },
          "workspace_plugins upsert returned no id — Postgres invariant violation",
        );
        throw new Error(
          "workspace_plugins upsert returned no id from RETURNING — likely a driver/RLS/query-rewrite anomaly",
        );
      }
      persistedId = returned;
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist Elasticsearch install record — aborting install",
      );
      throw err;
    }

    log.info(
      { workspaceId, installId: persistedId, credentialWritten },
      "Elasticsearch datasource install completed",
    );
    return {
      installRecord: { id: persistedId, workspaceId, catalogId: ELASTICSEARCH_SLUG },
      credentialWritten,
    };
  }

  /**
   * Read + decrypt the existing install's config so masked secrets can be
   * restored. Returns `{}` when no row exists (fresh install). A decryption
   * failure throws — a silently-empty config would let a re-save clear a live
   * credential, turning a key-rotation glitch into a failed-open install.
   */
  private async loadExistingDecryptedConfig(
    workspaceId: WorkspaceId,
    catalogId: string,
    schema: ConfigSchema,
  ): Promise<Record<string, unknown>> {
    const rows = await internalQuery<ExistingInstallRow>(
      `SELECT config
         FROM workspace_plugins
        WHERE workspace_id = $1 AND catalog_id = $2 AND install_id = $3
        LIMIT 1`,
      [workspaceId, catalogId, ELASTICSEARCH_INSTALL_ID],
    );
    if (rows.length === 0) return {};
    return decryptSecretFields(rows[0].config ?? {}, schema);
  }
}

/** Keys of every `secret: true` field in a parsed schema. */
function secretFieldKeys(schema: Extract<ConfigSchema, { state: "parsed" }>): string[] {
  return schema.fields.filter((f) => f.secret === true).map((f) => f.key);
}

/**
 * Validate a (restored) config against the catalog `config_schema`: required
 * fields must be present + non-empty, and declared types must match. Returns a
 * field→messages map (empty = valid). Mirrors the installer's
 * `validateAgainstConfigSchema` shape so the admin UI gets a consistent
 * `fieldErrors` envelope. A corrupt / absent schema yields no errors — the
 * encrypt walker still fail-closes on a corrupt schema.
 */
function validateAgainstSchema(
  config: Record<string, unknown>,
  schema: ConfigSchema,
): Record<string, string[]> {
  if (schema.state !== "parsed" || schema.fields.length === 0) return {};
  const fieldErrors: Record<string, string[]> = {};
  for (const field of schema.fields) {
    const value = config[field.key];
    const present = value !== undefined && value !== null && value !== "";
    if (field.required === true && !present) {
      (fieldErrors[field.key] ??= []).push(`${field.label ?? field.key} is required`);
      continue;
    }
    if (!present) continue;
    switch (field.type) {
      case "string":
      case "select":
        if (typeof value !== "string") {
          (fieldErrors[field.key] ??= []).push(`${field.key} must be a string`);
        }
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) {
          (fieldErrors[field.key] ??= []).push(`${field.key} must be a number`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          (fieldErrors[field.key] ??= []).push(`${field.key} must be a boolean`);
        }
        break;
      default:
        // Unknown catalog type — skip (treat as pass), matching the installer.
        break;
    }
  }
  return fieldErrors;
}
