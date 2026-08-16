/**
 * The seam through which the `PUT`/`DELETE /admin/settings/{key}` verbs reach
 * `admin_action_log` (#5270, #5262).
 *
 * ⚠️ **NOT "the one seam for settings writes" — three other writers exist and
 * none of them routes through here.** `platform-demo.ts` files its own
 * `settings.update` with the fire-and-forget `logAdminAction` (it does pass
 * `scope: "platform"`, so only defect 3 below applies to it);
 * `onboarding.ts` writes `ATLAS_DEMO_INDUSTRY` and `admin-sandbox.ts` clears
 * `ATLAS_SANDBOX_BACKEND`; neither files an audit row. They are outside
 * this PR, and naming them here is the point — the next reader must not take
 * "the seam" to mean coverage nobody built.
 *
 * ⚠️ **THREE DEFECTS SHARED ONE CALL SITE. ONE WAS LIVE; TWO WERE NOT WHAT
 * THE ISSUES SAID THEY WERE.** Both stated mechanisms were checked and both
 * were wrong — recorded here rather than quietly corrected, because a fix
 * resting on a false rationale is one verification away from being deleted:
 *
 * 1. **The value was recorded verbatim — but a `secret: true` value cannot
 *    reach it.** `metadata: { key, value, tier }` carried the raw string, and
 *    #5270 claimed that put the seven `secret: true` credentials in a DB row.
 *    It does not: both verbs in `api/routes/admin.ts` 403 a `secret: true`
 *    key *before* the write — grep the guard by its copy, `"Secret settings
 *    cannot be modified from the UI."`, which appears once per verb — and
 *    that guard is on `main` already, so there was no window. So
 *    `redactAuditValue`'s `secret` arm and its `undefined`-definition
 *    fail-closed arm are BOTH route-unreachable today, and every production
 *    entry takes the verbatim arm.
 *
 *    ⚠️ Cited by MESSAGE rather than by line, deliberately. The first draft of
 *    this block pinned `admin.ts:3720`/`:3876` and both were stale within the
 *    same round — the line numbers moved when this PR's own helper was added
 *    forty lines above them. A citation that rots is worse than none, because
 *    the next reader checks it, finds unrelated code, and stops trusting the
 *    paragraph that was right.
 *
 *    The redaction is kept as defense in depth, and the honest claim is
 *    narrow: the 403 is the primary control, this is what remains if someone
 *    deletes it or adds a second settings writer. `redactPaths` would not
 *    catch that case — pino redacts on FIELD NAME (`apiKey`, `clientSecret`,
 *    `serverToken`, …) and this field is called `value`, nested under
 *    `metadata` — so there is no backstop underneath.
 *
 * 2. **The row was stamped `scope: "workspace"` — this one was live.**
 *    `resolveEntry` defaults scope to `"workspace"` for any non-`systemActor`
 *    write, and neither settings call site passed one, unlike
 *    `admin-abuse.ts`, `admin-connections.ts`, `admin-marketplace.ts` and
 *    `admin-operator-integrations.ts`. So a PLATFORM-tier write was filed as
 *    a workspace action and landed on `GET /admin/admin-actions`, which
 *    selects `WHERE org_id = $1 AND scope = 'workspace'` and returns
 *    `metadata` verbatim with a CSV export beside it. The values involved are
 *    non-secret registry settings (the secret ones are 403'd per 1), so this
 *    is an audit-correctness bug plus minor disclosure of platform
 *    configuration to workspace admins — not a credential leak.
 *
 * 3. **The audit row was fire-and-forget — and the drop is SILENT, which is
 *    a stronger reason than the one #5262 gave.** #5262 argued a raised
 *    `ATLAS_LOG_LEVEL` silences the drop's `log.warn`. There is no such warn.
 *    Once the internal-DB circuit breaker is open, `internalExecute`
 *    (`db/internal.ts:874-879`) increments `_droppedCount` and returns with
 *    NO log line at any level — the only trace is an anonymous count on a
 *    later recovery line, naming no key, actor or value. Before the breaker
 *    opens, the drop logs at `error` (`:889-898`), which names no key — and
 *    which only `fatal` silences, a level that is itself in
 *    `ATLAS_LOG_LEVEL`'s own option list, so even that trace is
 *    operator-revocable — so #5262's instinct was not baseless; it named the
 *    wrong line and the wrong branch. Either way the settings change is
 *    unrecorded and unattributable, so
 *    `logAdminActionAwait` is the
 *    right instrument — for the reason its own docstring gives about the
 *    audit-retention surface, not for the reason #5262 gave.
 *
 * ⚠️ **WHY THE WHOLE ENTRY IS BUILT HERE rather than at the route.** The
 * redaction is not something a call site can be trusted to remember: #5180
 * measured that re-inlining `log.warn({ ...line, value })` passed the whole
 * suite, because redacted equals raw on every currently-reachable input. The
 * brand is the guard — and a brand only bites where something is EXPECTED to
 * carry it. `AdminActionEntry`'s `metadata` is `Record<string, unknown>`, so a
 * route that builds its own object gets no help at all. Hence: the route hands
 * over the definition and the raw value, and never touches `metadata`.
 *
 * ⚠️ **WHAT THIS DOES NOT CLOSE**, stated because the fence invites the wrong
 * confidence. The spread case below was measured by compiling both spellings;
 * the other two are stated from the type system's rules:
 *
 * - **A caller that goes back to `logAdminAction` with a hand-built metadata
 *   object** bypasses everything here, and no type can see it.
 * - **A property arriving via a SPREAD.** `...(cond ? { previousValue: raw }
 *   : {})` compiles clean against this annotation — excess-property checking
 *   does not apply through a spread — while the direct spelling
 *   `previousValue: raw` is a type error. Verified by compiling both. The
 *   spread form is caught only by `settings-write.test.ts`'s whole-entry
 *   `JSON.stringify` negative assertion, which is why that assertion is on
 *   the serialized entry rather than on `metadata.value`.
 * - **A definition belonging to a DIFFERENT key** — closed below by the
 *   `mismatched` check, which this module was missing until review caught
 *   that its #5180 sibling has one and it did not.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { logAdminActionAwait } from "@atlas/api/lib/audit/admin";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
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

interface SettingsAuditCommon {
  readonly key: string;
  /**
   * The registry definition, or `undefined` when the key has no entry.
   *
   * Passed rather than looked up here so the fail-closed arm of
   * {@link redactAuditValue} is reachable from a test. It is NOT reachable
   * from either live route: `admin.ts` 400s an unknown key before the write,
   * so through production callers this is always a real entry for `key`.
   */
  readonly definition: SettingDefinition | undefined;
  /**
   * True when the write targeted the GLOBAL row rather than a workspace's.
   * The route computes this as `!effectiveOrgId` — the truthiness spelling,
   * not `=== undefined`; see the ⚠️ table at the PUT call site in `admin.ts`
   * for the input class where the two disagree. It is the same condition the
   * route already annotates as `tier` in the metadata, so one fact now drives
   * both the metadata field and the row's `scope` column.
   */
  readonly platformTier: boolean;
  readonly ipAddress: string | null;
}

/**
 * ⚠️ A UNION, so the docstring's rule about `reset_to_default` is the TYPE
 * rather than prose. `{ action: "reset_to_default", value: "s3cret" }` was
 * previously well-typed and produced a reset row carrying a value — exactly
 * what {@link SettingsWriteAction} forbids in words. Its mirror,
 * `{ action: "update", value: undefined }`, produced an update row with no
 * value and no discriminator, indistinguishable from a bare key/tier row.
 * Both are now compile errors.
 *
 * This matters more than a normal illegal-state cleanup because
 * `metadata.action` is the ONLY thing separating the two verbs in
 * `admin_action_log`: `ADMIN_ACTIONS.settings` has a single member, so both
 * PUT and DELETE file `settings.update`.
 */
export type SettingsAuditWrite = SettingsAuditCommon &
  (
    | { readonly action: "update"; readonly value: string }
    | { readonly action: "reset_to_default"; readonly value?: undefined }
  );

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
  // ⚠️ A DEFINITION BELONGING TO A DIFFERENT KEY IS NOT EVIDENCE ABOUT THIS
  // ONE. `securitySensitiveAuditLine` (settings.ts) carries this check and
  // this module shipped without it — the brand fences the
  // OUTPUT of the redaction decision, so corrupting its INPUT costs no cast
  // and trips nothing. `auditSettingsWrite({ key: "RESEND_API_KEY",
  // definition: <ATLAS_MODEL's entry>, value: rawKey })` would otherwise
  // compile, run, and record the credential verbatim.
  //
  // Discarding the definition routes to `redactAuditValue`'s fail-closed arm,
  // which is the conservative direction: an unrecognised pairing withholds.
  // `maskReason` then says WHICH event it was, because "registry drift" and
  // "the call site passed the wrong entry" send an operator to different
  // places — the distinction `AuditMaskReason` exists to draw, and which this
  // module advertised in its type while being unable to produce it.
  const mismatched = entry.definition !== undefined && entry.definition.key !== entry.key;
  const redacted = redactAuditValue(mismatched ? undefined : entry.definition, entry.value);
  const tier = entry.platformTier ? "platform" : "workspace";

  // ⚠️ EMITTED UNCONDITIONALLY, AND NOT VIA `maskReason`. The first draft of
  // this guard recorded the mismatch ONLY in `metadata.maskReason` — one
  // JSONB field of one audit row, which nobody greps and nothing alerts on.
  // Worse, on the `reset_to_default` path there is no value, so the whole
  // metadata block below is skipped and `mismatched` was computed, found
  // true, and then DISCARDED: a clear against the wrong registry entry was
  // indistinguishable from a correct one.
  //
  // A definition that does not belong to its key is a programmer bug —
  // registry drift after a rename, an alias resolver handing back the old
  // entry, a call site reusing one `def` across keys in a loop. Detecting it
  // and saying nothing is the swallow this module's own header is about. The
  // #5180 sibling emits its whole line at `warn` for the same reason.
  if (mismatched) {
    log.warn(
      {
        key: entry.key,
        definitionKey: entry.definition?.key,
        action: entry.action,
        maskReason: "definition_mismatch",
      },
      "Settings audit: the definition passed does not belong to this key — value withheld and the audit row records maskReason=definition_mismatch. This is a caller bug: check for registry drift after a rename, or a call site resolving the definition for a different key.",
    );
  }

  const metadata: SettingsAuditMetadata = {
    key: entry.key,
    tier,
    ...(entry.action === "reset_to_default" ? { action: "reset_to_default" as const } : {}),
    ...(redacted.value !== undefined
      ? {
          value: redacted.value,
          valueMasked: redacted.masked,
          // `mismatched` needs no disjunct here: it forces the
          // `undefined`-definition arm, which always sets a `maskReason` when
          // a value exists — so `redacted.maskReason !== undefined` is
          // already true whenever this spread is reached.
          ...(redacted.maskReason !== undefined
            ? { maskReason: mismatched ? ("definition_mismatch" as const) : redacted.maskReason }
            : {}),
        }
      : {}),
  };

  // ⚠️ `logAdminActionAwait` RESOLVES WITHOUT INSERTING when there is no
  // internal DB (`audit/admin.ts`), so the COMMITTED line below would
  // otherwise assert a row that was never written. Both current callers check
  // `hasInternalDB()` and 404 first, making this unreachable today — but this
  // module's header invites three other settings writers to adopt the seam,
  // and "true by caller precondition" is not a property this function should
  // rely on when the failure is a log line confidently naming a row that does
  // not exist.
  if (!hasInternalDB()) {
    log.warn(
      { key: entry.key, tier, action: entry.action },
      "Settings write audit row NOT persisted — no internal database configured. The pino line is the only trail for this configuration change.",
    );
    return;
  }

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

  // ⚠️ `info`, and AFTER the await, because it is the only line that can say
  // the row COMMITTED. `logAdminActionAwait` calls `emitPino` BEFORE its
  // INSERT, so the stream already carries a routine `admin_action` line at
  // info for a row that may never land — nothing in it says "pending". At
  // `debug` (where this started) it is off in every production deploy and
  // duplicates fields the pre-commit line already has; at `info` it is the
  // difference an operator greps for between a committed row and an
  // emitted-then-lost one.
  log.info({ key: entry.key, tier, action: entry.action }, "Settings write audit row COMMITTED");
}
