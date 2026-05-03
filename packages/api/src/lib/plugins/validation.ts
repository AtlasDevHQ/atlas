/**
 * Stored plugin config validation (#1988 C8).
 *
 * Runs at boot — for each row in `workspace_plugins`, parse the stored
 * `config` JSONB and validate it against the plugin's current
 * `getConfigSchema()`. The result is a flat list of issues; the caller
 * (`PluginConfigGuardLive`) decides warn-only vs fail-fast based on
 * `ATLAS_STRICT_PLUGIN_SECRETS=true`.
 *
 * Why this lives outside `wiring.ts`:
 *   - Wiring is the one-time imperative pass that actually mounts
 *     datasource / action / context / interaction surfaces. It runs
 *     even when there are no stored configs at all (a fresh region).
 *   - Validation is per-stored-row; it can produce N issues per plugin
 *     and runs in addition to wiring. Splitting keeps wiring's logs
 *     focused on success/failure and lets validation deal with shape
 *     drift independently.
 *
 * What counts as "stale":
 *   - A `required: true` schema field is missing from the stored config.
 *   - A stored value's runtime type does not match the field's declared
 *     `type` (string / number / boolean). `select` is treated as string
 *     because the admin UI persists the chosen option as a string.
 *   - The plugin still exists in the registry but its catalog row's
 *     stored config has a key the schema no longer declares — this is
 *     surfaced as a warning, not an error, because we cannot tell
 *     whether the field was renamed or removed (and removing it would
 *     lose data on round-trip writes).
 *
 * Out of scope:
 *   - Strict-mode F-42 secret-residue checks — those are
 *     `lib/plugins/secrets.ts:checkStrictPluginSecrets()` and run on
 *     every admin write.
 *   - Catalog-level `pluginCatalog.config_schema` drift detection —
 *     this function reads the *live* plugin's `getConfigSchema()`. If
 *     the live plugin and the catalog row diverge (e.g. plugin code
 *     updated without re-registering the catalog row), this path
 *     won't catch it. That's a separate concern handled at plugin
 *     registration / migration time.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { internalQuery, hasInternalDB } from "@atlas/api/lib/db/internal";
import type { ConfigSchemaField, PluginLike } from "./registry";

const log = createLogger("plugins:validation");

interface PluginRegistryLike {
  getAll(): readonly PluginLike[];
  get(id: string): PluginLike | undefined;
}

export interface PluginConfigIssue {
  readonly catalogId: string;
  readonly installationId: string;
  readonly workspaceId: string;
  readonly reason: string;
}

type StoredPluginRow = Record<string, unknown> & {
  id: string;
  workspace_id: string;
  catalog_id: string;
  config: unknown;
};

/**
 * Coerce a JSONB row value to a plain `Record<string, unknown>`. JSONB
 * legitimately holds primitives, arrays, or `null` — using `in` /
 * `Object.keys` on any of those throws at runtime. Treat anything that
 * isn't a non-array object as "empty config" so the loop downgrades to
 * a single structured issue instead of crashing the boot guard.
 */
function coerceConfigObject(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * Read every `workspace_plugins` row, look up the matching plugin in
 * the registry, and validate the stored config blob against the
 * current `getConfigSchema()`. No-ops when there's no internal DB
 * (returns an empty issue list; the caller's strict-mode check
 * decides whether that should fail boot — currently it doesn't,
 * because `InternalDbGuardLive` already handles missing-DB in SaaS).
 *
 * Every issue is logged at `warn` level here so an operator running
 * without `ATLAS_STRICT_PLUGIN_SECRETS=true` still sees the drift in
 * the boot log. SaaS regions ALSO get a single `log.error` summary so
 * a partial opt-in (warn-only mode) still surfaces in error tracking
 * — review-flagged silent failure (#1988 PR review).
 *
 * Strict mode collects the same issues into a tagged error
 * (`PluginConfigStaleError`) for the boot Layer to fail with.
 */
export async function validateStoredPluginConfigs(deps: {
  pluginRegistry: PluginRegistryLike;
}): Promise<readonly PluginConfigIssue[]> {
  if (!hasInternalDB()) return [];

  let rows: StoredPluginRow[];
  try {
    rows = await internalQuery<StoredPluginRow>(
      "SELECT id, workspace_id, catalog_id, config FROM workspace_plugins",
    );
  } catch (err) {
    // Match by SQLSTATE only — the English `"does not exist"` string
    // also appears in role/schema/extension/function errors and is
    // localized via `lc_messages`, so a string check would silently
    // route permission errors to the "first boot" path. The C9 boot
    // guard catches "table missing post-migration" via the migration
    // path; we don't second-guess it here.
    const code = (err as { code?: string } | null)?.code;
    if (code === "42P01") {
      log.debug({ err: errorMessage(err) }, "workspace_plugins table not present yet — skipping validation");
      return [];
    }
    log.warn(
      { err: errorMessage(err) },
      "Failed to read workspace_plugins for boot validation — proceeding without stale-config checks",
    );
    return [];
  }

  const issues: PluginConfigIssue[] = [];

  for (const row of rows) {
    const plugin = deps.pluginRegistry.get(row.catalog_id);
    if (!plugin) {
      // The plugin was uninstalled (or renamed) between boots while
      // workspace rows still reference its catalog id. The admin UI
      // surfaces this elsewhere — not our concern here.
      continue;
    }
    if (typeof plugin.getConfigSchema !== "function") continue;

    const schema = plugin.getConfigSchema();
    if (!Array.isArray(schema) || schema.length === 0) continue;

    const config = coerceConfigObject(row.config);
    if (config === null) {
      // Surface as a structured issue rather than silently treating
      // a malformed JSONB row as empty. Only fires when a row has
      // been corrupted (manual ops edit, schemaless drift) AND has a
      // schema that requires fields — the empty case below is a no-op.
      const hasRequired = schema.some((f) => f.required === true);
      if (hasRequired) {
        issues.push({
          catalogId: row.catalog_id,
          installationId: row.id,
          workspaceId: row.workspace_id,
          reason: "stored config is not a JSON object (corrupt JSONB or schema-shape drift)",
        });
      }
      continue;
    }

    const declaredKeys = new Set(schema.map((f) => f.key));

    for (const field of schema) {
      const issue = validateField(field, config, row);
      if (issue) issues.push(issue);
    }

    for (const storedKey of Object.keys(config)) {
      if (!declaredKeys.has(storedKey)) {
        issues.push({
          catalogId: row.catalog_id,
          installationId: row.id,
          workspaceId: row.workspace_id,
          reason: `stored key "${storedKey}" is not declared by the current plugin schema (renamed or removed?)`,
        });
      }
    }
  }

  for (const issue of issues) {
    log.warn(
      {
        catalogId: issue.catalogId,
        installationId: issue.installationId,
        workspaceId: issue.workspaceId,
      },
      `Stored plugin config drift: ${issue.reason}`,
    );
  }

  // SaaS-only: emit a single `error`-level summary so a region running
  // in warn-only mode still surfaces this in error tracking (Sentry,
  // pino → ES, etc). Without this, an unattended SaaS pod could carry
  // stale plugin configs for weeks before anyone reads the boot log.
  if (issues.length > 0 && process.env.ATLAS_DEPLOY_MODE === "saas") {
    log.error(
      {
        issueCount: issues.length,
        affectedCatalogIds: Array.from(new Set(issues.map((i) => i.catalogId))),
      },
      "SaaS region has stale plugin configs — surfacing for error tracking. Set ATLAS_STRICT_PLUGIN_SECRETS=true to fail boot instead.",
    );
  }

  return issues;
}

/**
 * Per-field check. Returns `null` when the field is fine. Order of
 * checks matters: required-but-missing is a stricter failure than a
 * type mismatch on a present value, so we surface only the first one
 * per field to keep the issue list focused.
 */
function validateField(
  field: ConfigSchemaField,
  config: Record<string, unknown>,
  row: StoredPluginRow,
): PluginConfigIssue | null {
  const present = field.key in config;
  const value = config[field.key];

  if (field.required) {
    if (!present || value === null || value === undefined || value === "") {
      return {
        catalogId: row.catalog_id,
        installationId: row.id,
        workspaceId: row.workspace_id,
        reason: `required field "${field.key}" is missing from stored config`,
      };
    }
  }

  if (!present || value === null || value === undefined) return null;

  const expected = field.type;
  const actual = typeof value;
  // `select` is persisted as the chosen option string by the admin UI.
  const expectedRuntime: string =
    expected === "select" ? "string" : expected;
  if (actual !== expectedRuntime) {
    return {
      catalogId: row.catalog_id,
      installationId: row.id,
      workspaceId: row.workspace_id,
      reason: `field "${field.key}" expected ${expectedRuntime}, got ${actual}`,
    };
  }

  return null;
}
