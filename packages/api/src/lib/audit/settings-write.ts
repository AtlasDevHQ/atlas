/**
 * The seam through which the `PUT`/`DELETE /admin/settings/{key}` verbs reach
 * `admin_action_log` (#5270, #5262).
 *
 * ⚠️ **NOT "the one seam for settings writes" — three other writers exist and
 * none of them routes through here.** `platform-demo.ts` files its own
 * `settings.update` with the fire-and-forget `logAdminAction` (it does pass
 * `scope: "platform"`, so defect 2 below does not apply to it — but it puts
 * its written values straight into `metadata` with no redaction, which is
 * structurally defect 1, safe only because those keys are not `secret: true`);
 * `onboarding.ts` writes `ATLAS_DEMO_INDUSTRY` and `admin-sandbox.ts` clears
 * `ATLAS_SANDBOX_BACKEND`. None of the three files an audit row today, so "the
 * seam" must not be read as coverage nobody built.
 *
 * ⚠️ **THREE DEFECTS SHARED ONE CALL SITE. ONE WAS LIVE; TWO WERE NOT WHAT THE
 * ISSUES SAID THEY WERE.** Both stated mechanisms were checked and both were
 * wrong, recorded because a fix resting on a false rationale gets deleted at the
 * first verification:
 *
 * 1. **The value was recorded verbatim — but a `secret: true` value cannot
 *    reach it.** `metadata: { key, value, tier }` carried the raw string, and
 *    #5270 claimed that put the registry's `secret: true` credentials in a DB
 *    row.
 *    It does not: both verbs in `api/routes/admin.ts` 403 a `secret: true`
 *    key *before* the write — grep the guard by its copy, `"Secret settings
 *    cannot be modified from the UI."`, which appears once per verb — and
 *    that guard is on `main` already, so there was no window. So
 *    all THREE of the decision's withholding arms — `secret`,
 *    `unknown_definition` and `definition_mismatch` — are route-unreachable
 *    today, and every production entry THAT CARRIES A VALUE takes the verbatim
 *    arm. (Not every entry: the union below forces `value?: undefined` on
 *    `reset_to_default`, so a DELETE row takes the no-value arm instead.)
 *
 *    ⚠️ Cited by MESSAGE, not line: line pins here went stale within one round,
 *    and a citation that rots is worse than none.
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
 *    `ATLAS_LOG_LEVEL` silences the drop's `log.warn`. There IS such a warn on
 *    the synchronous-throw drop in `logAdminAction` (`audit/admin.ts`), but not
 *    on the drop that matters. Once the internal-DB circuit breaker is open,
 *    `internalExecute`'s `_circuitOpen` early return increments `_droppedCount`
 *    and returns with NO log line at any level — the only trace is an anonymous
 *    count on a later recovery line, naming no key, actor or value. Before the
 *    breaker opens, its `if (!_circuitOpen)` branch logs at `error`, which names
 *    no key — and which only `fatal` silences, a level that is itself in
 *    `ATLAS_LOG_LEVEL`'s own option list, so even that trace is
 *    operator-revocable. #5262's instinct was not baseless; it named the wrong
 *    line and the wrong branch. Either way the settings change is unrecorded and
 *    unattributable, so `logAdminActionAwait` is the right instrument — for the
 *    reason its own docstring gives about the audit-retention surface, not for
 *    the reason #5262 gave.
 *
 * ⚠️ **AND THE RULE FLAGS LAND HERE TOO (#5262, the surviving finding).** The
 * row carries `disablesControl` / `widensAuthority` for a
 * `SECURITY_SENSITIVE_KEYS` member, so the durable channel holds the JUDGEMENT
 * and not only the fact. Before that the split was backwards — the pino
 * `security_setting.changed` line had the analysis and `admin_action_log` had
 * the value — which meant reading *"that disabled an abuse control"* out of the
 * retained table required reimplementing the rules against it. Folded in at this
 * seam precisely because it already holds `key`, `definition`, `value` and
 * `action`: no new sink, and no second classification of "which writes are
 * weakening" to drift from the first. The two callers of
 * `securitySensitiveAuditFields` are both in `lib/` (the pino builder in
 * `settings.ts` and this one); the route layer has none.
 *
 * ⚠️ **WHY THE WHOLE ENTRY IS BUILT HERE rather than at the route.** The
 * redaction is not something a call site can be trusted to remember: #5180
 * measured that re-inlining `log.warn({ ...line, value })` passed the suite AS
 * IT THEN STOOD, because redacted equalled raw on every input that suite
 * reached. (Not "on every reachable input" — the registry-flip block in
 * `settings-audit-log.test.ts` later made them differ on a fully reachable one.
 * That distinction is #5264 item 3, and this paragraph was carrying the same
 * stale premise one file over.) The brand is a guard for the seam-preserving
 * edit — and a brand only bites where something is EXPECTED to carry it.
 * `AdminActionEntry`'s `metadata` is `Record<string, unknown>`, so a route that
 * builds its own object gets no help at all. Hence: the route hands
 * over the definition and the raw value, and never touches `metadata`.
 *
 * A definition belonging to a DIFFERENT key IS closed, by the `mismatched`
 * check below — added after review caught that its #5180 sibling had one and
 * this module did not.
 *
 * ⚠️ **WHAT THIS DOES NOT CLOSE**, stated because the fence invites the wrong
 * confidence. The spread case was measured by compiling both spellings; the
 * other is stated from the type system's rules:
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
 */

import { createLogger } from "@atlas/api/lib/logger";
import { logAdminActionAwait } from "@atlas/api/lib/audit/admin";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";
import {
  definitionMismatchesKey,
  redactAuditValue,
  securitySensitiveAuditFields,
  type AuditedValue,
  type AuditMaskReason,
  type SecuritySensitiveAudit,
  type SettingAuditAction,
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
 * Everything that depends on WHICH VERB produced the row, in one table (#5262).
 *
 * ⚠️ **THREE DISPATCHES BECAME ONE, and the third is why.** This module had two
 * total `Record`s — the rule-engine vocabulary and the row's discriminator — and
 * then grew an inline `entry.action === "reset_to_default"` ternary for
 * `judgement`, in the same commit that praised the `Record`s for making a missing
 * verb a compile error. Adding a third valueless verb would have reddened both
 * tables and forced a line, while the ternary answered `false` silently: the row
 * would carry `disablesControl: false, widensAuthority: false` with no caveat on
 * a write whose value the rules never saw — exactly the false exoneration
 * `judgement` exists to prevent, reachable by the one edit the tables are
 * designed for.
 *
 * `null` rather than `undefined` throughout, so "deliberately absent" is an
 * answer a third verb has to give rather than the default of forgetting.
 *
 * ⚠️ It closes a MISSING verb, not a SWAPPED one. Nothing about `update → clear`
 * is ill-typed and the rules answer confidently either way, so the swap is a
 * test's job.
 *
 * ⚠️ **A SWAPPED `rule` IS ONLY VISIBLE FROM THE `update` SIDE**, which is where
 * the tests drive it. (A swap of the whole ROWS is caught on the clear path
 * instead, by `metadataAction` — the exact-shape assertion there pins
 * `action: "reset_to_default"` alongside `judgement`.) Measured against the shipped rules: on `reset_to_default` there is no
 * value, and with `value: undefined` all three rules return `false`/`false`
 * whichever action they are handed — the abuse rule short-circuits on
 * `action !== "set"` *and* on the missing value, the alias source rule's
 * `(value ?? "")` splits to nothing, and the alias threshold rule has its own
 * `value === undefined` guard. So a clear-path-only suite would pass with the two `rule`
 * values exchanged. Driven from `update`, `ATLAS_TRIAL_IP_RATE_LIMIT_RPM="0"` and
 * `ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES="warehouse_key,extractor"` both go
 * `true → false` under a swap. The axis that hides a swap is the VERB, not the
 * family — recorded because the wrong axis sends the next reader to add a second
 * family instead of a second verb.
 */
const VERBS: Record<
  SettingsWriteAction,
  {
    /** How the rule engine names this verb ({@link SettingAuditAction}). */
    readonly rule: SettingAuditAction;
    /**
     * The row's `metadata.action`. `null` for `update` because absence already
     * means `update` in every row written before the field existed; labelling it
     * would split one verb across two spellings and break those rows' readers.
     */
    readonly metadataAction: "reset_to_default" | null;
    /**
     * The caveat the row carries for a security-sensitive key. `null` where the
     * rules judged the written value, so no caveat is owed.
     */
    readonly judgement: "reverted_value_not_evaluated" | null;
  }
> = {
  update: { rule: "set", metadataAction: null, judgement: null },
  reset_to_default: {
    rule: "clear",
    metadataAction: "reset_to_default",
    judgement: "reverted_value_not_evaluated",
  },
};

/**
 * The rule flags plus the caveat that qualifies them, as one type.
 *
 * The pair is all-or-nothing because `securitySensitiveAuditFields` returns both
 * or `null`; `judgement` is present on a clear of a SECURITY-SENSITIVE key. A
 * clear of any other key produces no `RuleFields` at all. Naming the shape is what
 * lets the builder write the field as a checked literal instead of an unchecked
 * spread — see the binding for the measured typo hole.
 */
type RuleFields = SecuritySensitiveAudit & {
  /**
   * Present only on a clear: the two rule flags describe what the RULE answered,
   * and for a clear that is structurally `false`/`false` on every key — the rules
   * judge the WRITTEN value, and a clear has none. What the setting reverts to
   * (the env var, the default, or a platform override that may itself be wide) is
   * not evaluated.
   *
   * ⚠️ **It exists because `false` would otherwise read as an exoneration.**
   * Clearing a `"10"` override on `ATLAS_TRIAL_IP_RATE_LIMIT_RPM` when the env var
   * holds `"0"` turns the per-IP limiter OFF, and the row said
   * `disablesControl: false`. So the incident query is
   *
   * ```sql
   * WHERE metadata->>'disablesControl' = 'true'
   *    OR metadata->>'widensAuthority' = 'true'
   *    OR metadata->>'judgement'       = 'reverted_value_not_evaluated'
   * ```
   *
   * and the last disjunct is the difference between "no weakening" and "nobody
   * checked". ⚠️ The `widensAuthority` disjunct is not optional: it is the ONLY
   * flag the alias family ever sets — `disablesControl` is structurally `false` on
   * both alias keys by design — so a query without it never surfaces an
   * alias-family WIDENING. It still surfaces alias clears, via the last disjunct.
   */
  readonly judgement?: "reverted_value_not_evaluated";
};

/**
 * Everything in the row's metadata except the rule flags, which are derived from
 * {@link SecuritySensitiveAudit} by {@link SettingsAuditMetadata} below.
 *
 * ⚠️ `value` is {@link AuditedValue}, not `string`. That is the compile-time
 * half of defect (1) above: the only way to obtain one is
 * {@link redactAuditValue}, so `value: rawValue` here is a type error on the
 * day it is harmless and on the day it is a breach.
 */
type SettingsAuditMetadataBase = {
  readonly key: string;
  readonly tier: "workspace" | "platform";
  readonly action?: "reset_to_default";
  readonly value?: AuditedValue;
  /** Present whenever a value is; `true` means the characters were withheld. */
  readonly valueMasked?: boolean;
  /** Present only when `valueMasked` is true. */
  readonly maskReason?: AuditMaskReason;
};

/**
 * The metadata shape that reaches `admin_action_log.metadata` (#5262).
 *
 * ⚠️ **DERIVED FROM {@link RuleFields} RATHER THAN THE FLAGS RESTATED, and the
 * restatement was the bug.** The first draft declared `disablesControl?:
 * boolean` and `widensAuthority?: boolean` here and copied them across
 * field-by-field. Add a third flag to `SecuritySensitiveAudit` and the pino line
 * would get it for free — `SecuritySensitiveAuditLine extends
 * SecuritySensitiveAudit` — while this row silently would not, with no compile
 * error anywhere. That is the exact pino-has-it / durable-row-lacks-it asymmetry
 * #5262 was filed to remove, reproduced one field over by its own fix.
 *
 * Deriving from the interface makes it one fact. The builder spreads `ruleFlags`
 * whole rather than naming fields, so a third flag flows into the row the day it
 * is added.
 *
 * FLAT, not nested under a `security` key, deliberately: #5262's acceptance
 * criterion writes the incident query as `metadata->>'disablesControl'`, and
 * nesting would move every reader to `metadata->'security'->>'disablesControl'`
 * for no gain the spread does not already give.
 *
 * ⚠️ **`Partial<RuleFields>` FORBIDS NOTHING STRUCTURALLY, and an earlier draft of
 * this paragraph claimed it forbade a bare `judgement`.** Measured: `Partial` is
 * homomorphic over `keyof (SecuritySensitiveAudit & { judgement?: … })`, so all
 * three properties are optional and both
 * `{ key, tier, judgement: "reverted_value_not_evaluated" }` (nobody checked, and
 * no rule applied) and `{ key, tier, disablesControl: true }` (half a pair) compile
 * clean.
 *
 * What deriving from {@link RuleFields} actually buys is narrower and still worth
 * having: the caveat is DECLARED next to the flags it qualifies rather than on the
 * base type, and a third flag added to {@link SecuritySensitiveAudit} flows in the
 * day it is added.
 *
 * The atomicity is on the VALUE side, not the type side: the only producer is the
 * `ruleFields` binding, typed `RuleFields | undefined` and spread whole, so no code
 * path can emit a half pair. Do not hand-build one.
 */
type SettingsAuditMetadata = SettingsAuditMetadataBase & Partial<RuleFields>;

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
  const verb = VERBS[entry.action];
  const redacted = redactAuditValue(entry.key, entry.definition, entry.value);
  // ⚠️ THE SHARED PREDICATE, not `redacted.maskReason`. Reading the reason off the
  // redaction looks tidier and is wrong on the clear path: with no value the
  // decision never consults the definition, so it reports nothing — while the
  // caller bug is just as real. Deriving it that way silently dropped the warn on
  // a DELETE, and the test for that arm caught it. `definitionMismatchesKey` is
  // the one rule; the row's `maskReason` and this warn are its two consumers.
  const mismatched = definitionMismatchesKey(entry.key, entry.definition);
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

  // ⚠️ **THE JUDGEMENT, IN THE DURABLE CHANNEL (#5262).** Before this the split
  // was backwards: the pino `security_setting.changed` line carried
  // `disablesControl`/`widensAuthority` while `admin_action_log` carried the
  // value — so the SUPPRESSIBLE channel held the analysis and the RETAINED one
  // held only the fact. An incident query could see *"someone set
  // ATLAS_TRIAL_IP_RATE_LIMIT_RPM to 0"* and not *"that disabled an abuse
  // control"*, and the only way to learn the second was to reimplement
  // `securitySensitiveAuditFields` against the row — a second classification of
  // "which writes are weakening", which is a second thing that drifts from the
  // first.
  //
  // ⚠️ Computed from `entry.key`, NOT from `entry.definition` — so the mismatch
  // above does not touch it, and that is correct rather than an oversight. The
  // rules key off the setting's NAME and the written value; a definition
  // belonging to another key is evidence about neither. The value's characters
  // may be withheld from the row while the judgement derived from them is
  // recorded in full, which is the whole point: the analysis is the part worth
  // retaining.
  //
  // ⚠️ `null` for a non-sensitive key, and the flags are then ABSENT rather than
  // `false`. A row that always carries `disablesControl: false` cannot be
  // filtered on — `WHERE metadata->>'disablesControl' = 'false'` would match
  // every settings write in the table — so absence has to mean "no rule
  // applies" and `false` has to mean "a rule ran and said no".
  const ruleFlags = securitySensitiveAuditFields(
    entry.key,
    verb.rule,
    entry.value,
  );

  // The flags travel WITH their caveat: every sink that reports the judgement
  // reports its limits, and no sink can take one without the other because there
  // is nothing else to take.
  // ⚠️ ANNOTATED `RuleFields | undefined`, and a nested ternary rather than a
  // conditional spread, because excess-property checking does not reach spread-in
  // properties. Misspelling the field as `judgment` inside a `...(cond ? {…} : {})`
  // lands the typo in the JSONB and makes the documented query return nothing
  // while the row still reads `disablesControl: false`.
  //
  // ⚠️ **AND `| undefined`, NOT `| Record<never, never>`.** Measured, both
  // spellings, with the typo applied:
  //
  //   `RuleFields | Record<never, never>`  ->  0 errors. EPC is skipped entirely
  //                                            when ANY union member is an empty
  //                                            object type, the same rule that
  //                                            lets `const x: {} = { a: 1 }` pass.
  //   `RuleFields | undefined`             ->  TS2561, with a "did you mean
  //                                            'judgement'?" hint.
  //
  // `RuleFields` also states the pair-plus-caveat as one type, so the atomicity is
  // declared rather than left as a fact about an inferred union.
  const ruleFields: RuleFields | undefined =
    ruleFlags === null
      ? undefined
      : verb.judgement !== null
        ? { ...ruleFlags, judgement: verb.judgement }
        : ruleFlags;

  const metadata: SettingsAuditMetadata = {
    key: entry.key,
    tier,
    // ⚠️ From the total table, for the reason {@link VERBS} gives. This was a
    // ternary with a silent `{}` default, and this is the field where a
    // fall-through actually costs something: `ADMIN_ACTIONS.settings` has ONE
    // member, so `metadata.action` is the only thing separating the two verbs in
    // `admin_action_log`. A third verb would have filed rows indistinguishable
    // from an `update`.
    // See {@link VERBS} for why `update` maps to absence.
    ...(verb.metadataAction !== null ? { action: verb.metadataAction } : {}),
    // ⚠️ SPREAD WHOLE, never field-by-field — see {@link SettingsAuditMetadata}.
    // Naming the fields here is what let the first draft reproduce #5262's own
    // asymmetry: a third flag added to `SecuritySensitiveAudit` reaches the pino
    // line by inheritance and would have missed the durable row silently.
    //
    // `ruleFields`, not `ruleFlags` — the judgement travels with its caveat; see
    // that binding above for the branch that proved they must not be separable.
    ...(ruleFields ?? {}),
    ...(redacted.value !== undefined
      ? {
          value: redacted.value,
          valueMasked: redacted.masked,
          // No fixup: the decision already reported the right reason, so this is
          // a pass-through. It used to overwrite `maskReason` with a locally
          // recomputed `definition_mismatch`, which is how the two sinks came to
          // hold two implementations of one rule.
          ...(redacted.masked ? { maskReason: redacted.maskReason } : {}),
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
    // ⚠️ The flags ride along, because on THIS branch the pino line is the only
    // trail — so it should carry the most, not the least. The first draft
    // computed `ruleFlags` above and dropped them here, which is the same
    // computed-then-discarded defect this module fixes forty lines up for
    // `mismatched`, reappearing on the one path that has no second record.
    log.warn(
      { key: entry.key, tier, action: entry.action, ...(ruleFields ?? {}) },
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
  //
  // ⚠️ NOT wrapped in a try/catch. Swallowing a fault here would make this line's
  // ABSENCE ambiguous between "the row was lost" and "the logger faulted", and the
  // absence is the whole signal. If a synchronous throw is ever observed, the fix
  // is a `console.error` fallback that keeps the COMMITTED fact recorded — not a
  // silent catch.
  log.info({ key: entry.key, tier, action: entry.action }, "Settings write audit row COMMITTED");
}
