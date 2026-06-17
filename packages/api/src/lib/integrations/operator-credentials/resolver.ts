/**
 * Operator-tier credential resolution (#3704) — the single place precedence
 * is decided: DB row (set via Admin) → operator env var → unset.
 *
 * Consumers:
 *   - The chat plugin's adapter build, via `resolveOperatorAdapterEnv()`
 *     wired as `ChatPluginConfig.resolveAdapterEnv` in `deploy/api/atlas.config.ts`.
 *     The returned overlay is merged onto `process.env` (DB wins) so the
 *     existing env-reading adapter builders pick up Admin-set credentials
 *     with no per-builder change.
 *   - The boot guard `ChatAdapterEnvGuardLive`, via `resolveOperatorFieldValue()`
 *     / `getOperatorPlatformStatus()` — converts the env-only presence check
 *     into a "DB-row-OR-env" presence check.
 *   - The Admin route, via `getOperatorPlatformStatus()` for the masked
 *     status read.
 *
 * Self-host is unchanged: with no internal DB (or no row), every field falls
 * through to env exactly as before. This resolver NEVER reads any workspace-
 * tier store, and the workspace-tier resolver never reads this one — the
 * operator/workspace isolation is structural and pinned by
 * `__tests__/operator-credential-isolation.test.ts`.
 */

import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { readOperatorCredentials } from "./store";
import {
  OPERATOR_PLATFORMS,
  getOperatorPlatform,
  getOperatorPlatformByCatalogSlug,
  type OperatorCredentialField,
  type OperatorPlatformSpec,
} from "./platforms";

const log = createLogger("integrations.operator-credentials.resolver");

/** Where a resolved operator credential field's value came from. */
export type OperatorCredentialSource = "db" | "env" | "unset";

/** Per-field resolution status (no secret values — only presence + source). */
export interface OperatorFieldStatus {
  readonly envVar: string;
  readonly label: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly present: boolean;
  readonly source: OperatorCredentialSource;
}

/** Per-platform status for the Admin UI + boot diagnostics. */
export interface OperatorPlatformStatus {
  readonly platform: string;
  readonly label: string;
  /** True when every `required` field resolved to a non-empty value. */
  readonly configured: boolean;
  /** True when at least one field resolved from the DB (Admin-set). */
  readonly hasDbOverride: boolean;
  readonly fields: readonly OperatorFieldStatus[];
}

/**
 * Resolve a single operator field's effective value with full precedence.
 * Returns the value (DB row → env) or `undefined` when neither source has it.
 *
 * `bundle` is the already-read DB bundle for the platform (or `null`); passing
 * it in lets callers resolve a whole platform with one DB read.
 */
export function resolveOperatorFieldValue(
  field: OperatorCredentialField,
  bundle: Record<string, string> | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const dbVal = bundle?.[field.envVar];
  if (typeof dbVal === "string" && dbVal.length > 0) return dbVal;
  const envVal = env[field.envVar];
  if (typeof envVal === "string" && envVal.length > 0) return envVal;
  return undefined;
}

/**
 * Build the env overlay for the chat adapter builders: for every managed
 * platform field present in the DB, its decrypted value. This overlay is
 * intentionally DB-only — the caller merges it as `{ ...process.env,
 * ...overlay }`, so DB wins over env while unset keys fall through to env. It
 * therefore takes no `env` argument: env passthrough is the merge's job, not
 * this function's.
 *
 * Reads the DB once per platform. When no internal DB is configured
 * (self-host stateless), returns `{}` immediately — env passes through
 * untouched.
 */
export async function resolveOperatorAdapterEnv(
  platforms: readonly OperatorPlatformSpec[] = OPERATOR_PLATFORMS,
): Promise<Record<string, string>> {
  const overlay: Record<string, string> = {};
  if (!hasInternalDB()) return overlay;

  for (const spec of platforms) {
    let bundle: Record<string, string> | null;
    try {
      bundle = (await readOperatorCredentials(spec.platform)) as Record<string, string> | null;
    } catch (err) {
      // #3741 — a not-yet-migrated table (first boot before migration 0140
      // applies) is benign: there are no operator rows to read yet, so fall
      // through to the env fallback exactly as an empty table would. This stays
      // NARROW — only Postgres `undefined_table` (SQLSTATE 42P01). The boot
      // entry point now runs `runBootMigrations()` before plugin init so this
      // should not trigger in practice; it is graceful-degradation defense so a
      // future boot-ordering regression degrades to env-only rather than taking
      // the adapter down.
      if (isUndefinedTableError(err)) {
        log.warn(
          { platform: spec.platform },
          "operator_integration_credentials not yet migrated — using env fallback for this platform (expected only on a first boot before migration 0140 applies)",
        );
        continue;
      }
      // A decrypt/corruption failure must not silently drop the platform to
      // env-only (that would mask a broken rotation). Log loudly and rethrow
      // so the refresh/boot path surfaces it rather than booting degraded.
      log.error(
        { platform: spec.platform, err: err instanceof Error ? err.message : String(err) },
        "Failed to read operator credentials while building adapter env overlay",
      );
      throw err;
    }
    if (!bundle) continue;
    for (const field of spec.fields) {
      const dbVal = bundle[field.envVar];
      if (typeof dbVal === "string" && dbVal.length > 0) overlay[field.envVar] = dbVal;
    }
  }
  return overlay;
}

/**
 * True when `err` is Postgres `undefined_table` (SQLSTATE 42P01) — the
 * `operator_integration_credentials` table does not exist yet. Distinguishes
 * the benign first-boot "migration 0140 hasn't applied" race (#3741) from a
 * real read failure (decrypt/corruption), which must still propagate. Matches
 * on the driver-stable SQLSTATE code, with a message fallback for any wrapper
 * that drops `.code`.
 */
function isUndefinedTableError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    if ((err as { code?: unknown }).code === "42P01") return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /relation .* does not exist/i.test(msg);
}

/**
 * Compute the masked status of one operator platform: per-field presence +
 * source, whether every required field resolves, and whether any field came
 * from the DB. Used by the Admin GET route and the boot guard. Never returns
 * secret values.
 */
export async function getOperatorPlatformStatus(
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorPlatformStatus | null> {
  const spec = getOperatorPlatform(platform);
  if (!spec) return null;

  const bundle = hasInternalDB()
    ? ((await readOperatorCredentials(platform)) as Record<string, string> | null)
    : null;

  const fields = spec.fields.map<OperatorFieldStatus>((field) => {
    const dbVal = bundle?.[field.envVar];
    if (typeof dbVal === "string" && dbVal.length > 0) {
      return fieldStatus(field, true, "db");
    }
    const envVal = env[field.envVar];
    if (typeof envVal === "string" && envVal.length > 0) {
      return fieldStatus(field, true, "env");
    }
    return fieldStatus(field, false, "unset");
  });

  const configured = fields.every((f) => !f.required || f.present);
  const hasDbOverride = fields.some((f) => f.source === "db");
  return { platform: spec.platform, label: spec.label, configured, hasDbOverride, fields };
}

/**
 * Boot-guard helper: given a chat-catalog slug and the adapter builder's
 * `requiredEnv` set (the single source of truth, passed in by the guard from
 * `@useatlas/chat`), return the subset of keys absent from BOTH the operator
 * credential DB row AND env. An empty result means "configured" (env, DB, or a
 * mix). The guard fails boot only when this is non-empty.
 *
 * `requiredKeys` stays the source of truth so a future adapter adding a key
 * is checked without touching this module. The operator DB row is consulted
 * only when the slug maps to a managed operator platform and an internal DB
 * exists; otherwise this collapses to the original env-only check.
 */
export async function getMissingOperatorEnvForCatalogSlug(
  catalogSlug: string,
  requiredKeys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  let bundle: Record<string, string> | null = null;
  const spec = getOperatorPlatformByCatalogSlug(catalogSlug);
  if (spec && hasInternalDB()) {
    bundle = (await readOperatorCredentials(spec.platform)) as Record<string, string> | null;
  }
  return requiredKeys.filter((key) => {
    const dbVal = bundle?.[key];
    if (typeof dbVal === "string" && dbVal.length > 0) return false;
    const envVal = env[key];
    if (typeof envVal === "string" && envVal.length > 0) return false;
    return true;
  });
}

function fieldStatus(
  field: OperatorCredentialField,
  present: boolean,
  source: OperatorCredentialSource,
): OperatorFieldStatus {
  return {
    envVar: field.envVar,
    label: field.label,
    secret: field.secret,
    required: field.required,
    present,
    source,
  };
}
