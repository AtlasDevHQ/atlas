/**
 * The one seam through which a settings write reaches `admin_action_log`
 * (#5270, #5262).
 *
 * ⚠️ **THREE DEFECTS SHARED ONE CALL SITE**, and each is only half-closed by
 * fixing the others, which is why they land together:
 *
 * 1. **The value was recorded verbatim.** `PUT /admin/settings/{key}` passed
 *    `metadata: { key, value, tier }` with the raw string, so writing any of
 *    the seven `secret: true` registry keys — `RESEND_API_KEY`,
 *    `ANTHROPIC_API_KEY`, `DATABASE_URL`, `ATLAS_DATASOURCE_URL`, … — put the
 *    plaintext credential in a DB row. Two of the three surfaces that show a
 *    settings value already withhold it: the read path masks
 *    (`getSettingsForAdmin` → `maskSecret`), and #5180 redacted the
 *    `security_setting.changed` log line. This one, the DURABLE surface, did
 *    neither. `redactPaths` does not cover it either: pino redacts on FIELD
 *    NAME (`apiKey`, `clientSecret`, `serverToken`, …) and this field is
 *    called `value`, nested under `metadata`, so the pino line leaked too.
 *
 * 2. **The row was stamped `scope: "workspace"`.** `resolveEntry` defaults
 *    scope to `"workspace"` for any non-`systemActor` write, and neither
 *    settings call site passed one — unlike `admin-abuse.ts`,
 *    `admin-connections.ts`, `admin-marketplace.ts` and
 *    `admin-operator-integrations.ts`, which all pass `scope: "platform"`
 *    explicitly. All seven secret keys are `scope: "platform"` in the
 *    registry, so a platform-tier write was filed as a workspace action —
 *    and `GET /admin/admin-actions` selects
 *    `WHERE org_id = $1 AND scope = 'workspace'` and returns `metadata`
 *    verbatim, with a CSV export beside it. That router is
 *    `createAdminRouter()`, i.e. `adminAuth` only, while the write required
 *    `admin:settings`. An admin who could not write the setting could read
 *    back what another admin wrote. Redacting (1) without fixing this leaves
 *    platform actions on the workspace read API; fixing this without (1)
 *    leaves plaintext in the table and the log stream.
 *
 * 3. **The audit row was fire-and-forget.** `logAdminAction` drops the row
 *    with a `log.warn` when the internal-DB circuit breaker is open — and
 *    `ATLAS_LOG_LEVEL` is runtime-mutable, hot-reloading through
 *    `SETTING_SIDE_EFFECTS`, so an operator who raised it to `error` also
 *    silences that warn. `logAdminActionAwait` exists for exactly this shape;
 *    its own docstring names the audit-retention surface, "where a
 *    fire-and-forget gap during a circuit-breaker open would let an attacker
 *    shrink retention with no record". A settings write is the same surface.
 *
 * ⚠️ **WHY THE WHOLE ENTRY IS BUILT HERE rather than at the route.** The
 * redaction is not something a call site can be trusted to remember: #5180
 * measured that re-inlining `log.warn({ ...line, value })` passed all 154
 * tests, because no sensitive key is `secret: true` today and redacted equals
 * raw on every currently-reachable input. The brand is the guard — and a brand
 * only bites where something is EXPECTED to carry it. `AdminActionEntry`'s
 * `metadata` is `Record<string, unknown>`, so a route that builds its own
 * object gets no help at all. Hence: the route hands over the definition and
 * the raw value, and never touches `metadata`. There is no spelling of the
 * call site that reintroduces (1) without deleting this module.
 *
 * ⚠️ **WHAT THIS DOES NOT CLOSE**, stated because the fence invites the wrong
 * confidence: a caller that goes back to `logAdminAction` directly with a
 * hand-built metadata object bypasses everything here, and no type can see
 * that. `__tests__/settings-write.test.ts` flips a registry definition to
 * `secret: true` to make redacted and raw differ on a reachable input, which
 * is what catches the seam-REMOVING edit; the brand catches the
 * seam-preserving one. Neither is redundant.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { logAdminActionAwait } from "@atlas/api/lib/audit/admin";
import { ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";
import {
  redactAuditValue,
  type AuditedValue,
  type AuditMaskReason,
  type SettingDefinition,
} from "@atlas/api/lib/settings";

const log = createLogger("audit.settings-write");

/**
 * Which verb produced the row. `reset_to_default` is the DELETE path, which
 * clears an override rather than writing one — it carries no value, and must
 * not acquire one: "the value it reverted to" is the env/default, which is
 * exactly as secret as the override was.
 */
export type SettingsWriteAction = "update" | "reset_to_default";

/**
 * The metadata shape that reaches `admin_action_log.metadata`.
 *
 * ⚠️ `value` is {@link AuditedValue}, not `string`. That is the compile-time
 * half of defect (1) above: the only way to obtain one is
 * {@link redactAuditValue}, so `value: rawValue` here is a type error on the
 * day it is harmless and on the day it is a breach.
 */
type SettingsAuditMetadata = {
  readonly key: string;
  readonly tier: "workspace" | "platform";
  readonly action?: "reset_to_default";
  readonly value?: AuditedValue;
  /** Present whenever a value is; `true` means the characters were withheld. */
  readonly valueMasked?: boolean;
  /** Present only when `valueMasked` is true. */
  readonly maskReason?: AuditMaskReason;
};

export interface SettingsAuditWrite {
  readonly key: string;
  /**
   * The registry definition, or `undefined` when the key has no entry.
   * Passed rather than looked up here so the fail-closed arm of
   * {@link redactAuditValue} — "we could not tell, so withhold" — stays
   * reachable and testable from the call site.
   */
  readonly definition: SettingDefinition | undefined;
  /** The raw written value; `undefined` on the `reset_to_default` path. */
  readonly value: string | undefined;
  readonly action: SettingsWriteAction;
  /**
   * True when the write targeted the GLOBAL row rather than a workspace's.
   * The route computes this as `effectiveOrgId === undefined`, which is the
   * same condition it already annotates as `tier` in the metadata — one fact,
   * now driving both the metadata field and the row's `scope` column.
   */
  readonly platformTier: boolean;
  readonly ipAddress: string | null;
}

/**
 * Record a settings write in `admin_action_log`, awaiting the row.
 *
 * ⚠️ **IT REJECTS WHEN THE ROW CANNOT BE COMMITTED, and the caller must not
 * swallow that.** This is a deliberate availability trade: a settings write
 * whose audit row is lost is an unrecorded change to runtime configuration,
 * which is the thing the log exists to prevent. The caller surfaces it as an
 * explicit 500 saying the setting DID change but was not recorded — a generic
 * "something failed" would be worse than silence, because it implies the write
 * did not land.
 *
 * ⚠️ Applied to EVERY settings write, not only the security-sensitive keys.
 * A conditional await would need a second classification of "which keys
 * matter", and a second classification is a second thing that drifts from the
 * first — the exact failure mode `SECURITY_SENSITIVE_KEYS` vs
 * `SAAS_IMMUTABLE_KEYS` vs `secret: true` already presents three times over.
 */
export async function auditSettingsWrite(entry: SettingsAuditWrite): Promise<void> {
  const redacted = redactAuditValue(entry.definition, entry.value);
  const tier = entry.platformTier ? "platform" : "workspace";

  const metadata: SettingsAuditMetadata = {
    key: entry.key,
    tier,
    ...(entry.action === "reset_to_default" ? { action: "reset_to_default" as const } : {}),
    ...(redacted.value !== undefined
      ? {
          value: redacted.value,
          valueMasked: redacted.masked,
          ...(redacted.maskReason !== undefined ? { maskReason: redacted.maskReason } : {}),
        }
      : {}),
  };

  await logAdminActionAwait({
    actionType: ADMIN_ACTIONS.settings.update,
    targetType: "settings",
    targetId: entry.key,
    // ⚠️ EXPLICIT, because the default is wrong here. `resolveEntry` defaults
    // to "workspace" for any non-systemActor write, which put platform-tier
    // settings rows on the org-scoped `/admin/admin-actions` read API.
    scope: tier,
    metadata,
    ipAddress: entry.ipAddress,
  });

  log.debug({ key: entry.key, tier, action: entry.action }, "Settings write audited");
}
