/**
 * SaaS boot-guard family (#1978 + #1983 + #1988).
 *
 * Each guard is a `Layer.effectDiscard` that throws a typed
 * `Data.TaggedError` at boot when a SaaS-mode contract is violated.
 * Self-hosted is unaffected. The shape comes from `DpaGuardLive`
 * (architecture-wins #45) and was extended into a family in #1978;
 * subsequent extensions (#1983, #1988) follow the same shape mechanically.
 *
 * Each guard exists because the corresponding misconfig used to silently
 * downgrade to a degraded runtime: a SaaS pod would boot, accept HTTP
 * traffic, and only surface the misconfig at first I/O (encryption),
 * first DB write (DATABASE_URL), or never (deploy-mode rejection).
 * Turning them into tagged errors fails the boot Layer before any HTTP
 * listener starts.
 *
 *   1. {@link EnterpriseGuardLive} — `ATLAS_DEPLOY_MODE=saas` requested
 *      via env but enterprise is not enabled (silent downgrade to
 *      self-hosted with all SaaS contracts disabled). Env-set is
 *      operator intent — boot fails; config-file-set logs CRITICAL.
 *
 *   2. {@link EncryptionKeyGuardLive} — combines two related findings:
 *      a) no encryption key derivable in SaaS — every new credential
 *         would land plaintext via the `encryptSecret` passthrough.
 *      b) malformed `ATLAS_ENCRYPTION_KEYS` (duplicate version, mixed
 *         prefix, non-numeric label, empty raw) — the keyset parser
 *         throws lazily at first I/O without this guard.
 *      Eagerly invokes `getEncryptionKeyset()` so both fire at boot.
 *
 *   3. {@link InternalDbGuardLive} — `DATABASE_URL` unset in SaaS.
 *      Better Auth, audit, admin console, settings persistence, and
 *      the scheduler all depend on the internal DB; missing it is
 *      not a degraded-but-functional state in SaaS.
 *
 *   4. {@link RateLimitGuardLive} (#1983) — `ATLAS_RATE_LIMIT_RPM` unset,
 *      empty, `<= 0`, or `< 1` (fractional) in SaaS. The combined
 *      runtime path in `getRpmLimit()` plus `checkRateLimit()`'s
 *      short-circuit treats any of those as "rate limiting disabled" —
 *      a SaaS region without a per-user RPM ceiling is a DDoS hole.
 *      Self-hosted preserves the opt-in behavior because lightweight
 *      evaluations and trial dev loops don't need a baseline cap.
 *      Pairs with the `SAAS_IMMUTABLE_KEYS` entry in `lib/settings.ts`
 *      so a platform admin can't re-open the hole at runtime via
 *      `setSetting`.
 *
 *   4b. {@link ProviderKeyGuardLive} (#3178 + #3200 + #3203) — a configured LLM
 *      provider's required config is incomplete. Without it the api boots green
 *      and chat/proactive 503s at first I/O. Validates per-provider required env
 *      as a SET (`getMissingProviderConfig` — Bedrock access key + secret,
 *      openai-compatible base URL; #3200), for BOTH the env-only main-chat
 *      provider AND the settings-backed proactive provider (#3203). Self-hosted
 *      keeps the per-request 503 so keyless dev loops still boot.
 *
 *   5. {@link RegionGuardLive} (#1988 C7) — claimed `ATLAS_API_REGION`
 *      missing from `config.residency.regions` or pointing at a
 *      malformed `databaseUrl`. Without this guard, a region-routing
 *      misconfiguration silently treats every workspace request as
 *      misrouted (and in strict mode 421s legitimate traffic).
 *
 *   6. {@link PluginConfigGuardLive} (#1988 C8) — stored
 *      `workspace_plugins.config` rows are validated against each
 *      plugin's current `getConfigSchema()`. Stale configs (renamed
 *      keys, removed required fields) log warnings; with
 *      `ATLAS_STRICT_PLUGIN_SECRETS=true` they fail boot — same knob
 *      as `secrets.ts:checkStrictPluginSecrets`.
 *
 *   7. {@link MigrationGuardLive} (#1988 C9, defined in `layers.ts`)
 *      — Drizzle migrations MUST succeed in SaaS. The legacy
 *      `MigrationLive` is non-fatal so self-hosted operators can boot
 *      a stateless instance even when the internal DB schema is
 *      partially set up. In SaaS the same condition would silently
 *      downgrade `loadSettings()` to env-var-only (the `42P01`
 *      fallback) and bypass admin overrides that boot-time guards
 *      rely on (e.g. DPA-flagged provider).
 *
 * Tagged errors are defined locally rather than added to
 * `ATLAS_ERROR_TAG_LIST`/`mapTaggedError()` — same precedent as
 * `DpaInconsistencyError`. These guards fail process boot before any
 * HTTP listener starts, so an HTTP status mapping would be misleading.
 *
 * Naming note: the original #1978 dividers use sub-finding numbers
 * `(#1)`, `(#2 + #3)`, `(#5)` from that issue's auditor enumeration
 * (no #4 by convention). Subsequent extensions use the issue number
 * directly (e.g. `(#1983)`, `(#1988 C7)`). Both remain grep-able back
 * to context.
 */

import { Data, Effect, Layer } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { resolveDeployEnv } from "@atlas/api/lib/env-profile";
import { Config, Settings } from "./layers";
import { Migration, PluginRegistry } from "./services";
import { readSaasEnv, type SaasEnv } from "./saas-env";

const log = createLogger("effect:saas-guards");

/**
 * Local-dev SaaS escape hatch — an INTENTIONAL, narrowly-gated security footgun.
 *
 * The SaaS boot-guard family fails CLOSED on any missing prod-only secret
 * (Turnstile, rate-limit RPM, billing config, …). That is correct on a
 * customer-facing region, but it turns local `ATLAS_DEPLOY_MODE=saas` dev into
 * whack-a-mole: each missing secret crashes boot one at a time, so an operator
 * running the SaaS code path locally rediscovers the whole env bundle by
 * attrition. When `ATLAS_DEPLOY_ENV=development`, the "missing prod infra"
 * guards (the ones that opt in by calling this) relax to a no-op so the API
 * boots against whatever the dev `.env` already has.
 *
 * Gated SOLELY on the deploy *env* being `development` — a coherent single gate:
 * a `development` deploy is ALREADY in dev shape across the board (email
 * verification off + onboarding emails off via `env-profile.ts`; admin-MFA gate
 * off via `admin-mfa-required.ts`), so relaxing the boot guards is consistent
 * with it. The only footgun is setting `ATLAS_DEPLOY_ENV=development` on a
 * customer-facing deploy — which would already have disabled those other
 * protections too, and which a
 * real region never does (it sets `production` or leaves it unset, and pins
 * `deployMode` in `deploy/api/atlas.config.ts`, #3702). Each relaxation logs a
 * loud per-guard warning so it can never pass silently.
 *
 * NOT relaxed: the migration, encryption-key, and internal-DB guards — those are
 * real correctness signals (and pass for free in any working dev box: DB up,
 * `BETTER_AUTH_SECRET` set, migrations applied), not missing-prod-infra checks.
 *
 * MUST be called AFTER each guard's `deployMode !== "saas"` early-return — it
 * asserts nothing about the deploy mode itself.
 */
function relaxSaasGuardForDev(guardName: string): boolean {
  if (resolveDeployEnv() !== "development") return false;
  log.warn(
    `SaaS boot guard '${guardName}' RELAXED — ATLAS_DEPLOY_ENV=development. ` +
      `Local-dev escape hatch so the SaaS code path boots without prod-only secrets. ` +
      `NEVER set ATLAS_DEPLOY_ENV=development on a customer-facing deploy.`,
  );
  return true;
}

const ISSUE_REF = "#1978";
const RATE_LIMIT_ISSUE_REF = "#1983";
const ISSUE_REF_1988 = "#1988";
const CHAT_ADAPTER_ISSUE_REF = "#2672";
const PROVIDER_KEY_ISSUE_REF = "#3178";
const BILLING_CONFIG_ISSUE_REF = "#3435";
const MCP_SPINE_ISSUE_REF = "#3687";
const TURNSTILE_ISSUE_REF = "#3795";

/**
 * Sentinel org id for the boot-time `mcp_action_policy` reachability probe. It
 * is never a real workspace, so the `WHERE org_id = $1` SELECT returns zero rows
 * and the probe only proves the table + query path is reachable — it asserts
 * nothing about any tenant's policy.
 */
const MCP_POLICY_PROBE_ORG_ID = "__mcp_spine_boot_probe__";

// ══════════════════════════════════════════════════════════════════════
// ██  Tagged errors
// ══════════════════════════════════════════════════════════════════════

/**
 * `ATLAS_DEPLOY_MODE=saas` was requested in the env but enterprise is
 * not enabled, so `resolveDeployMode` silently returned `self-hosted`.
 * Env-set is operator intent — fail boot rather than run degraded.
 *
 * Config-file rejections do NOT construct this error — they fall
 * through to a CRITICAL log line emitted directly from
 * `lib/config.ts:applyDeployMode()`. The intent-strength split is
 * documented under `EnterpriseGuardLive`.
 */
export class EnterpriseRequiredError extends Data.TaggedError("EnterpriseRequiredError")<{
  readonly message: string;
}> {}

/**
 * SaaS region booted without any derivable encryption key. With no
 * key, `encryptSecret` passes plaintext through and integration
 * credentials, plugin secrets, and email/sandbox JSON blobs land
 * un-encrypted in the internal DB. Always P0 in SaaS.
 */
export class EncryptionKeyMissingError extends Data.TaggedError("EncryptionKeyMissingError")<{
  readonly message: string;
}> {}

/**
 * `ATLAS_ENCRYPTION_KEYS` parsed but failed validation (duplicate
 * versions, mixed prefix/bare entries, non-numeric labels, empty
 * material). Without this guard the parser throws lazily at first
 * credential I/O — minutes or hours after boot.
 *
 * `cause` carries the original `Error` from the parser (not a
 * stringified message) so the stack trace is preserved for telemetry.
 * The user-readable message is built into `.message` separately.
 */
export class EncryptionKeyMalformedError extends Data.TaggedError("EncryptionKeyMalformedError")<{
  readonly message: string;
  readonly cause: Error;
}> {}

/**
 * SaaS region booted without `DATABASE_URL`. Better Auth, audit,
 * admin console, settings persistence, and the scheduler all depend
 * on the internal DB. Self-hosted treats missing DATABASE_URL as a
 * warning (audit log will not persist) — SaaS treats it as fatal.
 */
export class InternalDatabaseRequiredError extends Data.TaggedError("InternalDatabaseRequiredError")<{
  readonly message: string;
}> {}

/**
 * SaaS region booted without a usable `ATLAS_RATE_LIMIT_RPM`. The
 * runtime in `auth/middleware.ts` ends up with a "disabled" limiter for
 * any of: unset, empty, non-numeric, negative, exactly `0`, or
 * fractional `0 < n < 1`. `getRpmLimit()` parses to `Math.floor(n)` and
 * `checkRateLimit()` short-circuits when the resulting limit is `0`, so
 * the disabled set spans the parser AND its consumer. Fine for trial
 * dev loops; a DDoS hole on a hosted region. The boot guard rejects
 * every value the combined runtime path would treat as disabled.
 */
export class RateLimitRequiredError extends Data.TaggedError("RateLimitRequiredError")<{
  readonly message: string;
}> {}

/**
 * SaaS region booted without `TURNSTILE_SECRET_KEY` (#3795). Turnstile is
 * the bot-protection gate in front of the talk-to-sales contact form AND
 * the self-serve `start_trial` MCP onboarding bootstrap (#3654). With the
 * secret unset, `verifyTurnstile` fails CLOSED — every contact submission
 * and every trial attempt 403s — while boot and `/health` stay green. The
 * fail-closed posture is correct (fail-open would be an abuse hole), but the
 * silent-100%-rejection outage is invisible until conversions hit zero.
 * Self-hosted is unaffected: the onboarding router/contact route are SaaS
 * carve-outs, and a self-host operator who wants Turnstile sets it opt-in.
 */
export class TurnstileSecretRequiredError extends Data.TaggedError("TurnstileSecretRequiredError")<{
  readonly message: string;
}> {}

/**
 * SaaS region booted with `ATLAS_PROVIDER` (or the gateway default) set to a
 * provider whose API key env var is unset. Without this guard the api boots
 * green, `/health` liveness stays green, and every real chat 503s via
 * `validateEnvironment`'s per-request `MISSING_API_KEY` diagnostic — the exact
 * "broken at first I/O" class the guard family exists to prevent (#3178).
 *
 * `provider` is the resolved provider string and `missingKeys` the full SET of
 * required env vars that were absent (#3200) — e.g. `bedrock` /
 * `["AWS_SECRET_ACCESS_KEY"]` when only the access key was set, or `anthropic` /
 * `["ANTHROPIC_API_KEY"]`. Both exposed so the operator-actionable boot log
 * names every missing key without re-parsing `message`. `source` records which
 * resolution surfaced the misconfig — the env-only main-chat path or the
 * settings-backed proactive path (#3203) — so a settings-only divergence is
 * self-describing in the log. Self-hosted is unaffected — operators may run
 * keyless dev loops and keep the per-request 503.
 */
export class ProviderKeyMissingError extends Data.TaggedError("ProviderKeyMissingError")<{
  readonly message: string;
  readonly provider: string;
  readonly missingKeys: readonly string[];
  readonly source: ProviderResolutionSource;
}> {}

/**
 * Which provider resolution surfaced a provider misconfig. The boot guard
 * validates two: the env-only provider the main chat uses (`getModel()` →
 * `resolveProvider()`), and the settings-backed provider the SaaS proactive
 * runtime uses (`getSettingAuto("ATLAS_PROVIDER")` via `getProactiveAiRuntime`,
 * #3203). Carried on the tagged errors so the boot log names the surface.
 */
export type ProviderResolutionSource = "main-chat (env)" | "proactive (settings)";

/**
 * SaaS region booted with `ATLAS_PROVIDER` set to a value that isn't a
 * supported provider (a typo / unsupported vendor). `resolveSelection()` in
 * `lib/providers.ts` throws `Unknown provider "<x>"` at model init, so the api
 * boots green and then 503s every chat — the same boot-green-then-broken class
 * `ProviderKeyMissingError` catches, but for the provider *name* rather than its
 * key. Distinct error so the operator log names "unsupported provider" (not a
 * missing key). `source` records which resolution tripped it (env main-chat vs
 * settings-backed proactive, #3203). Self-hosted keeps the per-request throw
 * (#3198).
 */
export class ProviderUnsupportedError extends Data.TaggedError("ProviderUnsupportedError")<{
  readonly message: string;
  readonly provider: string;
  readonly source: ProviderResolutionSource;
}> {}

/**
 * SaaS region claims a residency region (`ATLAS_API_REGION` env var or
 * `residency.defaultRegion` in `atlas.config.ts`) that does not have a
 * matching entry in `config.residency.regions`, or whose entry has a
 * malformed Postgres URL. Without this guard,
 * `lib/residency/misrouting.ts:detectMisrouting` would treat every
 * request as misrouted (and in strict mode 421 legitimate traffic).
 *
 * `availableRegions` is exposed on the error so the operator-actionable
 * log line can list the valid keys without re-reading config — important
 * because the typo class for region keys (`eu` vs `eu-west`) is exactly
 * what produces this misconfig.
 *
 * `cause` discriminates the two failure modes (`unknown_region` vs
 * `malformed_database_url`) so consumers can branch programmatically
 * without parsing `message` — the second mode fires when
 * `claimedRegion ∈ availableRegions` and the URL is bad, which the
 * first mode's "key not present" wording would contradict.
 */
export class RegionMisconfiguredError extends Data.TaggedError("RegionMisconfiguredError")<{
  readonly message: string;
  readonly claimedRegion: string;
  readonly availableRegions: readonly string[];
  readonly cause: "unknown_region" | "malformed_database_url";
}> {}

/**
 * Stored `workspace_plugins.config` row(s) failed validation against
 * the current plugin's `getConfigSchema()`. The error carries the
 * per-row issues so an operator hitting this in strict mode can fix
 * the offending workspace configs before the next boot rather than
 * grepping the log for individual warnings.
 *
 * Strict mode is opt-in via `ATLAS_STRICT_PLUGIN_SECRETS=true` — the
 * same knob `secrets.ts:checkStrictPluginSecrets` already uses for
 * F-42 secret-residue checks. Reusing the knob keeps the strict-mode
 * surface small (one env var, two related contracts).
 *
 * `PluginConfigIssue` is re-exported from `lib/plugins/validation.ts`
 * (the producer of these values) — kept as the single declaration so a
 * future field addition there flows through here without two structural
 * shapes drifting apart.
 */
import type { PluginConfigIssue } from "@atlas/api/lib/plugins/validation";
export type { PluginConfigIssue };

export class PluginConfigStaleError extends Data.TaggedError("PluginConfigStaleError")<{
  readonly message: string;
  readonly issues: readonly PluginConfigIssue[];
}> {}

/**
 * `PluginConfigGuardLive` ran but the underlying validation function
 * threw before it could produce an issue list (e.g. third-party plugin
 * `getConfigSchema()` raised, lazy import of the validation module
 * failed). Distinct from `PluginConfigStaleError`: this is "we couldn't
 * even check", not "we checked and found drift".
 *
 * In strict mode this fails boot; otherwise the guard logs and continues
 * (consistent with how the validation function itself handles unexpected
 * DB errors — proceed without checks rather than wedge the boot Layer).
 */
export class PluginConfigCheckFailedError extends Data.TaggedError("PluginConfigCheckFailedError")<{
  readonly message: string;
  readonly cause: Error;
}> {}

/**
 * SaaS region declared a chat catalog entry with `install_model:
 * "oauth"` and `enabled: true` but the env vars the adapter builder
 * needs to instantiate are missing. Without this guard the
 * `AdapterRegistry` builder returns `null`, the adapter is silently
 * dropped, and the api still boots — the proactive listener registers,
 * admin analytics keep returning 200s, and no Slack event ever lands.
 * The 2026-05-19 → 2026-05-20 incident in `#sandbox-atlas` (~22h of
 * silent outage) hit exactly this path: `SLACK_ENCRYPTION_KEY` was
 * unset across all three Railway api services and every health signal
 * stayed green while no events were processed.
 *
 * `slug` is the catalog entry slug (e.g. `"slack"`) the guard tripped
 * on; `missingEnv` is the subset of the builder's `requiredEnv` that
 * `process.env` resolved as undefined/empty. Both exposed on the
 * error so the operator log line names the missing keys without
 * re-parsing `message`.
 */
export class ChatAdapterEnvMissingError extends Data.TaggedError("ChatAdapterEnvMissingError")<{
  readonly message: string;
  readonly slug: string;
  readonly missingEnv: readonly string[];
}> {}

/**
 * SaaS region booted but Drizzle migrations did not complete. The
 * legacy `MigrationLive` is non-fatal (`Effect.catchAll → Effect.succeed(false)`)
 * because self-hosted operators may legitimately run a stateless
 * instance with no internal DB. In SaaS that fallback would silently
 * downgrade `loadSettings()` to env-var-only (the `42P01 / does not
 * exist` branch in `lib/settings.ts`) and bypass admin overrides that
 * other boot guards rely on (e.g. `ATLAS_EMAIL_PROVIDER` for the DPA
 * check). Promote the failure to fatal so a missing schema can never
 * masquerade as "first boot, nothing configured yet".
 *
 * `cause` carries the underlying error message threaded through
 * `MigrationLive` (when available) so the boot-failure log line names
 * the actual Drizzle / pg error rather than punting to "see the prior
 * log line". Optional because the legacy fallback in `MigrationLive`
 * predates the threading; older boots without it surface as `undefined`.
 */
export class MigrationsRequiredError extends Data.TaggedError("MigrationsRequiredError")<{
  readonly message: string;
  readonly cause?: string;
}> {}

/**
 * SaaS region booted with `STRIPE_SECRET_KEY` set but a genuine env-level
 * billing misconfig: a missing `STRIPE_WEBHOOK_SECRET`, OR a secret key whose
 * mode prefix isn't a standard `sk_test_` / `sk_live_` (#3435). Both are pure,
 * network-free misconfigs of env-only inputs caught at boot:
 *
 *   - A missing webhook secret makes `auth/server.ts` decline to mount the
 *     `@better-auth/stripe` plugin (it logs and continues), so checkout, the
 *     billing portal, and webhook plan-sync are all dead while boot stays green.
 *   - A non-standard key shape (`rk_…` restricted, `pk_…` publishable paste, a
 *     typo) means we can't pin the test/live mode the price-resolution warn
 *     path compares against, and a restricted key may lack `prices.retrieve`
 *     scope outright.
 *
 * Since #3703 a MISSING PRICE ID no longer constructs this error: price IDs are
 * runtime-editable platform settings (registry-backed, env-fallback), so an
 * absent one is an operator-actionable boot WARNING (`BillingConfigGuardLive`
 * logs it), never a boot crash. `missingPriceIdEnvVars` therefore is always
 * empty on this error today; it is retained for shape stability and possible
 * future reuse. `keyMode` carries the detected mode so the boot-failure log is
 * operator-actionable without re-parsing `message`. The key itself is NEVER
 * placed on the error or in the message — only its mode classification.
 * Self-hosted, and SaaS-without-Stripe, never construct this.
 */
export class BillingConfigInvalidError extends Data.TaggedError("BillingConfigInvalidError")<{
  readonly message: string;
  readonly missingPriceIdEnvVars: readonly string[];
  readonly keyMode: "test" | "live" | "unknown";
}> {}

/**
 * SaaS region exposes hosted MCP (always mounted in SaaS — see `api/index.ts`'s
 * unconditional `/mcp/{workspace_id}/sse` mount) but the v0.0.15 MCP security
 * spine's OAuth audience set is not derivable at boot (#3687):
 * `resolveOAuthValidAudiences(process.env)` returns an EMPTY list because neither
 * `ATLAS_OAUTH_VALID_AUDIENCES` nor a base URL (`ATLAS_PUBLIC_API_URL` /
 * `BETTER_AUTH_URL`) is set. Better Auth would then validate every MCP bearer
 * token against an empty `validAudiences`, so all OAuth-authenticated MCP calls
 * 401 while boot and `/health` stay green.
 *
 * This is the FAIL-FAST half of the MCP-spine coherence check — it is a
 * deterministic, env-only assertion (no I/O), so failing boot is safe and
 * surfaces the misconfig before any HTTP listener starts. The companion
 * `mcp_action_policy` store reachability check is a boot WARNING (not a boot
 * failure) — see `McpSpineGuardLive` for why that half is warn-only. Self-hosted
 * never constructs this — the guard only *enforces* spine coherence in SaaS,
 * where hosted MCP is always mounted and the audience set is operator-critical.
 * (A self-hoster who opts into hosted MCP on their own host owns their audience
 * config; the guard deliberately doesn't police that surface.)
 *
 * Carries a `check` discriminant + `resolvedAudienceCount` (mirrors the
 * structured-field convention of `BillingConfigInvalidError` above) so the
 * boot-failure log and tests are actionable without re-parsing `message`. Only
 * `check: "audiences"` is constructed today; the field leaves room for a future
 * check to fail-boot under the same tag.
 */
export class McpSpineIncoherentError extends Data.TaggedError("McpSpineIncoherentError")<{
  readonly check: "audiences";
  readonly resolvedAudienceCount: number;
  readonly message: string;
}> {}

// ══════════════════════════════════════════════════════════════════════
// ██  Helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Whether the operator explicitly requested SaaS mode via env var.
 * Distinguished from config-file or `auto` resolution because env
 * is unambiguous operator intent — config-file and `auto` can fall
 * through to `self-hosted` quietly.
 */
function explicitSaasFromEnv(): boolean {
  // Read raw `process.env` directly — `ATLAS_DEPLOY_MODE` is deliberately not
  // part of the `SaasEnv` boot contract (#3702; SaaS resolves it from
  // `atlas.config.ts`). This guard inspects the operator's raw env intent to
  // catch the self-host footgun (env requests saas, no `@atlas/ee`), which is
  // independent of the SaaS-required input set.
  return process.env.ATLAS_DEPLOY_MODE === "saas";
}

// ══════════════════════════════════════════════════════════════════════
// ██  EnterpriseGuardLive (#1)
// ══════════════════════════════════════════════════════════════════════

/**
 * Fail boot when `ATLAS_DEPLOY_MODE=saas` is set in the env but the
 * resolved `deployMode` came back as `self-hosted` — that means
 * `resolveDeployMode` silently rejected the request because
 * `isEnterpriseEnabled()` was false. Without this guard the SaaS
 * contracts (DPA guard, encryption key requirement, DB requirement)
 * all silently skip.
 *
 * Config-file overrides (`atlas.config.ts` setting `deployMode: "saas"`)
 * are downgraded to a CRITICAL warning rather than failing boot —
 * the enterprise import may legitimately be unavailable in dev or in
 * a self-hosted distribution that pinned the config file. Env var is
 * operator intent and a stronger signal.
 */
export const EnterpriseGuardLive: Layer.Layer<never, EnterpriseRequiredError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;

    const requestedSaas = explicitSaasFromEnv();
    const resolvedSaas = config.deployMode === "saas";

    if (requestedSaas && !resolvedSaas) {
      yield* Effect.fail(
        new EnterpriseRequiredError({
          message:
            `ATLAS_DEPLOY_MODE=saas is set in the environment but enterprise is not enabled — ` +
            `the resolved deploy mode silently downgraded to "self-hosted", which would skip the ` +
            `DPA, encryption-key, and internal-DB guards. ` +
            `Either remove ATLAS_DEPLOY_MODE from the env (self-hosted is the default) or build with ` +
            `the @atlas/ee module installed and ATLAS_ENTERPRISE_ENABLED=true. See ${ISSUE_REF}.`,
        }),
      );
    }
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  EncryptionKeyGuardLive (#2 + #3)
// ══════════════════════════════════════════════════════════════════════

/**
 * Fail boot in SaaS when no encryption key is derivable, OR when
 * `ATLAS_ENCRYPTION_KEYS` is set but malformed (parser throws).
 *
 * Self-hosted preserves the dev-friendly passthrough: an operator
 * spinning up Atlas locally without any key gets plaintext writes
 * and boot succeeds. (`secret-encryption.ts`'s module-load IIFE also
 * fires a `log.error`, but only when `NODE_ENV=production` or
 * `ATLAS_DEPLOY_MODE=saas` — pure self-hosted dev gets a silent
 * passthrough by design.) SaaS regions cannot tolerate that — the
 * silent passthrough would land integration credentials in the DB
 * un-encrypted, which is why the SaaS path fails boot here.
 */
export const EncryptionKeyGuardLive: Layer.Layer<never, EncryptionKeyMissingError | EncryptionKeyMalformedError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;

    // Eagerly invoke the keyset resolver. Two failure modes:
    //   - Throws → ATLAS_ENCRYPTION_KEYS malformed (#3 — surfaces at boot
    //     instead of waiting for first credential I/O).
    //   - Returns null → no env var set at all (#2 — would otherwise
    //     fall through to plaintext via encryptSecret).
    type Keyset = ReturnType<
      typeof import("@atlas/api/lib/db/encryption-keys").getEncryptionKeyset
    >;
    // The inner async function catches every synchronous throw and the
    // dynamic `import()` rejection, converting both into a discriminated
    // `{ ok, ... }` result. This keeps the surrounding Effect's E channel
    // narrowed to the two tagged errors produced by `Effect.fail` below
    // (without the inner catch a generic `Error` from a rejected import
    // would widen the channel and break the typed Layer signature).
    const result = yield* Effect.promise(
      async (): Promise<{ ok: true; keyset: Keyset } | { ok: false; cause: Error }> => {
        try {
          const { getEncryptionKeyset } = await import(
            "@atlas/api/lib/db/encryption-keys"
          );
          return { ok: true, keyset: getEncryptionKeyset() };
        } catch (err) {
          return { ok: false, cause: err instanceof Error ? err : new Error(String(err)) };
        }
      },
    );

    if (!result.ok) {
      return yield* Effect.fail(
        new EncryptionKeyMalformedError({
          cause: result.cause,
          message:
            `ATLAS_ENCRYPTION_KEYS failed to parse: ${result.cause.message}. ` +
            `Without a valid keyset, every new credential would land plaintext and every ` +
            `existing encrypted value would 500 on first read. Fix the env var format ` +
            `(see docs/platform-ops/encryption-key-rotation) before booting. See ${ISSUE_REF}.`,
        }),
      );
    }

    if (!result.keyset) {
      return yield* Effect.fail(
        new EncryptionKeyMissingError({
          message:
            `SaaS region booted without an encryption key — set ATLAS_ENCRYPTION_KEYS=v1:<base64> ` +
            `(preferred), ATLAS_ENCRYPTION_KEY (legacy single-key), or BETTER_AUTH_SECRET (deprecated ` +
            `under SaaS — entangles session signing with at-rest encryption). Without a key, ` +
            `integration credentials, plugin secrets, and email/sandbox JSON blobs would be written ` +
            `plaintext via the encryptSecret passthrough. See ${ISSUE_REF}.`,
        }),
      );
    }
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  InternalDbGuardLive (#5)
// ══════════════════════════════════════════════════════════════════════

/**
 * Fail boot in SaaS when `DATABASE_URL` is unset. Self-hosted preserves
 * the existing warning-only behavior in `lib/startup.ts` — operators
 * running a stateless self-hosted instance (e.g. lightweight evaluation,
 * ephemeral Docker) intentionally skip the internal DB.
 *
 * In SaaS, missing `DATABASE_URL` disables every contract that makes
 * the platform usable: Better Auth (no sessions), audit (no compliance),
 * admin console (no settings persistence), scheduler (no cleanup fibers),
 * billing (no Stripe events). The pod would boot and immediately start
 * 500'ing every authenticated request.
 */
export const InternalDbGuardLive: Layer.Layer<never, InternalDatabaseRequiredError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;

    const env = readSaasEnv();
    if (!env.DATABASE_URL) {
      yield* Effect.fail(
        new InternalDatabaseRequiredError({
          message:
            `SaaS region booted without DATABASE_URL — the internal Postgres is required for ` +
            `Better Auth (sessions), audit log persistence, the admin console, settings persistence, ` +
            `and scheduler cleanup fibers. Set DATABASE_URL to the internal Postgres connection string. ` +
            `See ${ISSUE_REF}.`,
        }),
      );
    }
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  RateLimitGuardLive (#1983)
// ══════════════════════════════════════════════════════════════════════

/**
 * Fail boot in SaaS when `ATLAS_RATE_LIMIT_RPM` resolves to "rate
 * limiting disabled" at runtime. Self-hosted skips entirely — operators
 * running a trial / evaluation deploy can legitimately leave the
 * limiter off.
 *
 * The rejection set is `n < 1` (in addition to non-finite). This is
 * STRICTER than the runtime parser at `getRpmLimit()` in
 * `auth/middleware.ts`, which only early-returns on `n < 0` and lets
 * `0` flow through to `Math.floor(n) === 0`. The disabled-at-runtime
 * effect is identical because `checkRateLimit()` short-circuits on
 * `limit === 0`, but the boot guard tightens to a single parser-level
 * check that also rejects fractional `0 < n < 1` (where `Math.floor`
 * would yield `0` and disable the limiter). Loosening this branch
 * back to `n <= 0` would leave `ATLAS_RATE_LIMIT_RPM=0.5` passing
 * boot then disabled at runtime — exactly the silent hole this guard
 * exists to close. The pinning test in `saas-guards.test.ts` covers
 * `"0"`, `"0.5"`, `"-300"`, `"abc"`.
 *
 * Reads the env var via `readSaasEnv()` rather than `getSetting()`.
 * Two reasons: matches the env-direct pattern of `InternalDbGuardLive`,
 * and makes the operator contract crisp — the env var must be set at
 * deploy time. Post-boot writes via `setSetting` are blocked by
 * `SAAS_IMMUTABLE_KEYS` in `lib/settings.ts`, so a platform admin
 * cannot re-open the hole at runtime.
 */
export const RateLimitGuardLive: Layer.Layer<never, RateLimitRequiredError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;
    if (relaxSaasGuardForDev("RateLimit")) return;

    const raw = readSaasEnv().ATLAS_RATE_LIMIT_RPM;
    if (raw === undefined || raw === "") {
      return yield* Effect.fail(
        new RateLimitRequiredError({
          message:
            `SaaS region booted without ATLAS_RATE_LIMIT_RPM set — getRpmLimit() in auth/middleware.ts ` +
            `treats unset as "rate limiting disabled", leaving the region exposed to DDoS and per-user abuse. ` +
            `Set ATLAS_RATE_LIMIT_RPM to a positive integer (e.g. 300 for ~5 RPS per caller). ` +
            `See ${RATE_LIMIT_ISSUE_REF}.`,
        }),
      );
    }

    const n = Number(raw);
    // `n < 1` covers negative, zero, and fractional 0 < n < 1 — every
    // value where `Math.floor(n) <= 0` would land at runtime, plus the
    // explicit `0` disabled-sentinel.
    if (!Number.isFinite(n) || n < 1) {
      return yield* Effect.fail(
        new RateLimitRequiredError({
          message:
            `SaaS region booted with ATLAS_RATE_LIMIT_RPM=${JSON.stringify(raw)} — value would parse to ` +
            `"rate limiting disabled" at runtime via getRpmLimit() + checkRateLimit() in auth/middleware.ts. ` +
            `Set ATLAS_RATE_LIMIT_RPM to a positive integer (>= 1). See ${RATE_LIMIT_ISSUE_REF}.`,
        }),
      );
    }
  }),
);

/**
 * {@link TurnstileGuardLive} (#3795) — `TURNSTILE_SECRET_KEY` unset (or
 * empty) in SaaS. The secret backs the talk-to-sales contact form AND the
 * interactive web email/password signup (Better Auth `captcha` plugin scoped to
 * `/sign-up/email`, #4159 — it moved here off the headless `start_trial` door,
 * which a non-browser caller can't solve). The two surfaces fail DIFFERENTLY
 * when the secret is missing, and both are silent:
 *   - Contact form (`verifyTurnstile`) fails CLOSED — every submission 403s.
 *   - Web signup fails OPEN — `buildSignupCaptchaPlugin` returns null without a
 *     secret, so the captcha plugin is never registered and signups proceed with
 *     NO bot-protection (an open signup door). Registering it secretless would
 *     instead 500 every signup, which is exactly why we gate on the secret —
 *     see `buildSignupCaptchaPlugin`.
 * Either way the deploy boots green and serves a 200 `/health`, so the misconfig
 * is invisible at runtime. This guard turns it into a loud boot failure.
 * `Config`-only and reads env directly (same shape as `RateLimitGuardLive`), so
 * it fails fast alongside the other env-checking guards. Presence-only: the
 * value is validated at per-request siteverify, not here. The web signup +
 * contact route are SaaS carve-outs, so the guard is inert on self-hosted
 * (Turnstile stays opt-in there).
 */
export const TurnstileGuardLive: Layer.Layer<never, TurnstileSecretRequiredError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;
    if (relaxSaasGuardForDev("Turnstile")) return;

    const raw = readSaasEnv().TURNSTILE_SECRET_KEY;
    if (raw === undefined || raw === "") {
      return yield* Effect.fail(
        new TurnstileSecretRequiredError({
          message:
            `SaaS region booted without TURNSTILE_SECRET_KEY set — the talk-to-sales contact form ` +
            `fails CLOSED (every submission 403s) while the interactive web signup fails OPEN (the ` +
            `captcha plugin isn't registered without the secret, so bots sign up freely) — all while ` +
            `boot and /health stay green. Set TURNSTILE_SECRET_KEY from the Cloudflare Turnstile ` +
            `dashboard. See ${TURNSTILE_ISSUE_REF}.`,
        }),
      );
    }
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  ProviderKeyGuardLive (#3178/#3200) + ProactiveProviderKeyGuardLive (#3203)
// ══════════════════════════════════════════════════════════════════════

/** Lazy-import the provider-config SSOT, walling off `providers.ts`'s heavy
 * `@ai-sdk/*` static graph from this module (same pattern as
 * `EncryptionKeyGuardLive`). A rejected import → defect via `Effect.orDie`:
 * `providers.ts` is core and always loadable at boot, so a rejection means the
 * api can't run anyway, and silently skipping would reopen the boot-green-then
 * -503 hole these guards close. */
const importProviderConfig = () =>
  Effect.tryPromise({
    try: () => import("@atlas/api/lib/providers"),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(Effect.orDie);

/**
 * Validate one resolved provider string against its required config. Returns a
 * tagged-error Effect to fail boot, or `Effect.void` when complete. `source`
 * names which resolution this is (env main-chat vs settings-backed proactive)
 * for the operator-actionable boot log.
 *
 *   - not in the supported set → a typo / unsupported vendor: fail boot with
 *     {@link ProviderUnsupportedError} (`resolveSelection()` would otherwise throw
 *     on every chat/proactive answer — boot-green-then-broken). Checked first so a
 *     typo isn't mistaken for a keyless provider (both yield an empty set).
 *   - otherwise → `getMissingProviderConfig(provider)` (the required-config SET
 *     SSOT in `lib/providers.ts`, #3200) returns the env vars that must be present
 *     but aren't. `[]` → satisfied (`ollama` needs none; a Bedrock
 *     credential-provider-chain deploy needs no static keys). Non-empty → fail
 *     with {@link ProviderKeyMissingError} carrying the full set.
 */
function validateResolvedProvider(
  provider: string,
  source: ProviderResolutionSource,
  isSupportedProvider: (value: string) => boolean,
  getMissingProviderConfig: (provider: string) => string[],
): Effect.Effect<void, ProviderKeyMissingError | ProviderUnsupportedError> {
  if (!isSupportedProvider(provider)) {
    return Effect.fail(
      new ProviderUnsupportedError({
        provider,
        source,
        message:
          `SaaS region booted with the ${source} provider resolved to "${provider}", which is not a ` +
          `supported provider — model initialization (resolveSelection) would throw at first I/O while ` +
          `boot and /health stay green. Set ATLAS_PROVIDER to one of: anthropic, openai, bedrock, ollama, ` +
          `openai-compatible, gateway (or unset it to use the SaaS gateway default). See ${PROVIDER_KEY_ISSUE_REF}.`,
      }),
    );
  }

  const missingKeys = getMissingProviderConfig(provider);
  if (missingKeys.length === 0) return Effect.void;

  return Effect.fail(
    new ProviderKeyMissingError({
      provider,
      missingKeys,
      source,
      message:
        `SaaS region booted with the ${source} provider "${provider}" but its required config is ` +
        `incomplete — missing: [${missingKeys.join(", ")}]. The api would boot green, /health would ` +
        `stay green, and every ${source === "proactive (settings)" ? "proactive answer" : "chat/query"} ` +
        `would fail at first I/O. Set the missing env var(s) on every region's api service before ` +
        `booting (or point ATLAS_PROVIDER at a fully-configured provider). See ${PROVIDER_KEY_ISSUE_REF}.`,
    }),
  );
}

/**
 * Fail boot in SaaS when the MAIN-CHAT provider's required config is incomplete.
 *
 * `/api/v1/chat` (`chat.ts`) calls `runAgent()` without an injected model →
 * `getModel()` / `getProviderType()` → `resolveProvider()` → `resolveSelection()`
 * (no args) → `process.env.ATLAS_PROVIDER ?? getDefaultProvider()`. **Env-only** —
 * it does NOT consult persisted admin settings. Without this guard the api boots
 * green, `/health` stays green, and every chat/query 503s at first I/O.
 *
 * Validates the env provider's required config as a SET via
 * {@link validateResolvedProvider} (#3200 — Bedrock access key + secret,
 * openai-compatible base URL). The settings-backed proactive provider is a
 * separate resolution, validated by {@link ProactiveProviderKeyGuardLive} (#3203).
 *
 * Depends ONLY on `Config` (reads env directly) so it fails as fast as the other
 * env-only guards — it does NOT wait on `loadSettings`, which keeps its
 * `buildAppLayer` wiring canary deterministic (a main-chat misconfig must beat
 * the `Settings`-gated sibling guards to the boot Layer's failure channel).
 * Self-hosted is intentionally unaffected: a keyless dev loop keeps the existing
 * per-request 503 from `validateEnvironment` rather than a hard boot failure.
 */
export const ProviderKeyGuardLive: Layer.Layer<never, ProviderKeyMissingError | ProviderUnsupportedError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;
    if (relaxSaasGuardForDev("ProviderKey")) return;

    const { getDefaultProvider, isSupportedProvider, getMissingProviderConfig } = yield* importProviderConfig();
    const envProvider = readSaasEnv().ATLAS_PROVIDER ?? getDefaultProvider();
    yield* validateResolvedProvider(
      envProvider,
      "main-chat (env)",
      isSupportedProvider,
      getMissingProviderConfig,
    );
  }),
);

/**
 * Fail boot in SaaS when the SETTINGS-BACKED PROACTIVE provider's required config
 * is incomplete (#3203).
 *
 * The SaaS proactive listener (Slack classifier + answer adapters) resolves its
 * model via `getProactiveAiRuntime()` (`deploy/api/atlas.config.ts`), whose
 * `AtlasAiModelLive` calls `resolveModelFromSettings()` →
 * `getModelForConfig(getSettingAuto("ATLAS_PROVIDER"))` → `resolveSelection()` —
 * i.e. `getSettingAuto("ATLAS_PROVIDER") ?? process.env.ATLAS_PROVIDER ??
 * getDefaultProvider()`. A DB-persisted `ATLAS_PROVIDER` whose key is absent
 * passes {@link ProviderKeyGuardLive}'s env-only check (the main chat still
 * resolves to the env/gateway provider) yet fails every proactive answer at model
 * init despite green boot/health. `ATLAS_PROVIDER` is `requiresRestart: true`, so
 * a post-boot settings change only takes effect on the next boot — which re-runs
 * this guard — making the boot-time check authoritative without a revalidation
 * fiber. (And `setSetting` can't mutate `process.env`, so the boot decision can't
 * be bypassed at runtime.)
 *
 * Split from {@link ProviderKeyGuardLive} rather than folded in because validating
 * the settings-backed provider needs the settings cache: it depends on `Settings`
 * (like `DpaGuardLive`) so `yield* Settings` sequences it after `loadSettings()`
 * warms the in-process cache — without that ordering `getSettingAuto` would miss a
 * DB override and fall back to env. Keeping this as a separate `Settings`-gated
 * layer leaves the env guard above `Config`-only and fast-failing.
 *
 * Only validates when the settings provider DIVERGES from the env provider — the
 * common case (no DB override) resolves identically and is already covered by
 * {@link ProviderKeyGuardLive}, so re-validating would double-report. `settings.ts`
 * is lazy-imported for the same wall-off reason as `providers.ts`.
 */
export const ProactiveProviderKeyGuardLive: Layer.Layer<never, ProviderKeyMissingError | ProviderUnsupportedError, Config | Settings> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;
    if (relaxSaasGuardForDev("ProactiveProviderKey")) return;
    yield* Settings; // sequence after loadSettings warms the in-process cache

    const { getDefaultProvider, isSupportedProvider, getMissingProviderConfig } = yield* importProviderConfig();
    const { getSettingAuto } = yield* Effect.tryPromise({
      try: () => import("@atlas/api/lib/settings"),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(Effect.orDie);

    const envProvider = readSaasEnv().ATLAS_PROVIDER ?? getDefaultProvider();
    const settingsProvider =
      getSettingAuto("ATLAS_PROVIDER") ?? readSaasEnv().ATLAS_PROVIDER ?? getDefaultProvider();
    if (settingsProvider === envProvider) return; // covered by ProviderKeyGuardLive

    yield* validateResolvedProvider(
      settingsProvider,
      "proactive (settings)",
      isSupportedProvider,
      getMissingProviderConfig,
    );
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  RegionGuardLive (#1988 C7)
// ══════════════════════════════════════════════════════════════════════

/**
 * Liberal Postgres URL well-formedness check for boot guards. We only
 * reject obvious typos (missing scheme, mistyped vendor) — full
 * connectivity verification belongs in the connection-pool warmup,
 * not the boot guard. The guard runs in parallel with the migration
 * Layer; opening a real socket here would race against InternalDB's
 * pool initialization for the same URL.
 */
function isPlausiblePostgresUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  return raw.startsWith("postgres://") || raw.startsWith("postgresql://");
}

/**
 * Resolve the region this API instance claims to serve. Mirrors
 * `lib/residency/misrouting.ts:getApiRegion()` so the boot-time check
 * uses the same precedence the request-path uses — env var first,
 * then `residency.defaultRegion`. Duplicated rather than imported to
 * keep `saas-guards.ts` free of the static request-path reachability
 * graph (same wall-off rationale as the inlined `config.ts` warning).
 */
function resolveClaimedRegion(
  config: { residency?: { defaultRegion?: string } | undefined },
  env: SaasEnv,
): string | null {
  const envRegion = env.ATLAS_API_REGION;
  if (envRegion && envRegion.length > 0) return envRegion;
  return config.residency?.defaultRegion ?? null;
}

/**
 * Fail boot in SaaS when the API instance claims a region that is not
 * declared in `config.residency.regions`, or whose declaration has a
 * malformed `databaseUrl`. Self-hosted is unaffected — residency is a
 * SaaS concept (multi-region routing) and self-hosted operators that
 * don't configure `residency` legitimately leave `ATLAS_API_REGION`
 * unset.
 *
 * The misrouting middleware in `lib/residency/misrouting.ts` already
 * tolerates `null` (no region configured at all → check skipped). The
 * dangerous case is "claimed region exists but doesn't match anything
 * in config" — the middleware then treats every workspace request as
 * misrouted because the workspace's assigned region != this instance's
 * claimed region, and in strict mode it 421s the request. That class
 * of misconfig is what this guard catches at boot.
 */
export const RegionGuardLive: Layer.Layer<never, RegionMisconfiguredError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;

    const claimedRegion = resolveClaimedRegion(config, readSaasEnv());
    // No region claimed at all. The misrouting middleware also no-ops
    // in this case, so the contract is consistent.
    if (claimedRegion === null) return;

    const regions = config.residency?.regions ?? {};
    const availableRegions = Object.keys(regions);

    if (!(claimedRegion in regions)) {
      return yield* Effect.fail(
        new RegionMisconfiguredError({
          claimedRegion,
          availableRegions,
          cause: "unknown_region",
          message:
            `SaaS region booted with ATLAS_API_REGION="${claimedRegion}" (or residency.defaultRegion) ` +
            `but config.residency.regions does not declare that key. Available regions: ` +
            `[${availableRegions.join(", ") || "(none configured)"}]. Without this guard, the ` +
            `misrouting middleware would treat every workspace request as misrouted (and in strict ` +
            `mode 421 legitimate traffic). Add the region to atlas.config.ts or correct ` +
            `ATLAS_API_REGION. See ${ISSUE_REF_1988}.`,
        }),
      );
    }

    const regionEntry = regions[claimedRegion] as { databaseUrl?: unknown } | undefined;
    if (!isPlausiblePostgresUrl(regionEntry?.databaseUrl)) {
      return yield* Effect.fail(
        new RegionMisconfiguredError({
          claimedRegion,
          availableRegions,
          cause: "malformed_database_url",
          message:
            `SaaS region "${claimedRegion}" is declared in config.residency.regions but its ` +
            `databaseUrl is missing or malformed (must start with postgres:// or postgresql://). ` +
            `Region-scoped writes would fail at first I/O. See ${ISSUE_REF_1988}.`,
        }),
      );
    }
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  PluginConfigGuardLive (#1988 C8)
// ══════════════════════════════════════════════════════════════════════

/**
 * `ATLAS_STRICT_PLUGIN_SECRETS=true` is the existing F-42 strict-mode
 * flag (see `lib/plugins/secrets.ts:checkStrictPluginSecrets`). We
 * reuse it here so a SaaS region operator opting in to strict secret
 * residue checks also gets strict stale-config rejection — both are
 * "fail boot rather than run with stale plugin state" contracts and
 * splitting the knob would force operators to remember two flags.
 */
function isStrictPluginMode(env: SaasEnv): boolean {
  return env.ATLAS_STRICT_PLUGIN_SECRETS === "true";
}

/**
 * Validate every stored `workspace_plugins.config` row against its
 * plugin's current `getConfigSchema()`. Stale configs (renamed keys,
 * removed required fields) are always logged as warnings; in strict
 * mode (`ATLAS_STRICT_PLUGIN_SECRETS=true`) they fail boot.
 *
 * **Unlike its siblings, this guard runs in every deploy mode** —
 * stale plugin configs are a real risk for self-hosted operators too,
 * and the strict-mode env knob (`ATLAS_STRICT_PLUGIN_SECRETS=true`) is
 * the SaaS-vs-self-hosted decision lever rather than `deployMode`. The
 * SaaS-only `log.error` summary inside `validateStoredPluginConfigs`
 * handles the unattended-region visibility concern separately.
 *
 * The validation function lives in `lib/plugins/validation.ts` so it
 * can be unit-tested in isolation (no Layer DAG, no Config Tag
 * dependency). The Layer here is a thin wrapper that:
 *   - dynamic-imports the plugin registry + InternalDB at boot time
 *     (same lazy-import pattern as `EncryptionKeyGuardLive`, keeps
 *     `saas-guards.ts` free of the plugin reachability graph)
 *   - delegates to `validateStoredPluginConfigs()` for per-row checks
 *   - decides warn-only vs fail-fast based on `isStrictPluginMode()`
 *
 * The lazy-import + validator call is wrapped in an inner try/catch
 * that converts any throw (module-load failure, third-party plugin
 * `getConfigSchema()` raising, malformed JSONB tripping the per-row
 * walker) into a discriminated `{ ok, ... }` result — same
 * defect-channel-narrowing pattern as `EncryptionKeyGuardLive`. Without
 * this wrap, `Effect.promise` would route rejections into the defect
 * channel and bypass the typed `E` channel the boot Layer relies on.
 *
 * The guard skips silently when no internal DB is configured
 * (`hasInternalDB() === false`) — that case is already covered by
 * `InternalDbGuardLive` in SaaS, and self-hosted may legitimately run
 * without persisted plugin configs.
 */
export const PluginConfigGuardLive: Layer.Layer<never, PluginConfigStaleError | PluginConfigCheckFailedError, Config | PluginRegistry> = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Config;
    // #3743 — ordering barrier: this guard validates stored plugin configs
    // against each plugin's `getConfigSchema()`, so it must run AFTER the wired
    // plugin layer registers plugins into the global registry. In the pre-#3743
    // imperative boot plugins were registered before `buildAppLayer`; now the
    // wired layer is part of the DAG, so this edge prevents the guard from
    // racing registration and validating against an empty registry. Value
    // unused — the dependency ordering is the point.
    yield* PluginRegistry;
    const env = readSaasEnv();

    // The inner async function catches every synchronous throw and the
    // dynamic `import()` rejection, converting both into a discriminated
    // `{ ok, ... }` result. Mirror the `EncryptionKeyGuardLive` pattern
    // to keep the surrounding Effect's E channel narrowed to the two
    // tagged errors below; without this wrap a rejected dynamic import
    // would land in the defect channel and bypass typed handling.
    const result = yield* Effect.promise(
      async (): Promise<
        | { ok: true; issues: readonly PluginConfigIssue[] }
        | { ok: false; cause: Error }
      > => {
        try {
          const { hasInternalDB } = await import("@atlas/api/lib/db/internal");
          if (!hasInternalDB()) return { ok: true, issues: [] };
          const { plugins } = await import("@atlas/api/lib/plugins/registry");
          const { validateStoredPluginConfigs } = await import(
            "@atlas/api/lib/plugins/validation"
          );
          const issues = await validateStoredPluginConfigs({ pluginRegistry: plugins });
          return { ok: true, issues };
        } catch (err) {
          return { ok: false, cause: err instanceof Error ? err : new Error(String(err)) };
        }
      },
    );

    if (!result.ok) {
      // In strict mode a check failure fails boot (operator opted in to
      // "fail boot rather than run with stale plugin state" — they get
      // the same default for "we couldn't even check"). Otherwise log
      // and continue; the validation function itself follows the same
      // policy for unexpected DB errors so the contract is consistent.
      if (isStrictPluginMode(env)) {
        return yield* Effect.fail(
          new PluginConfigCheckFailedError({
            cause: result.cause,
            message:
              `ATLAS_STRICT_PLUGIN_SECRETS=true and the boot-time plugin config validation threw: ` +
              `${result.cause.message}. Either fix the underlying issue (third-party plugin throwing ` +
              `in getConfigSchema(), JSONB shape drift) or unset ATLAS_STRICT_PLUGIN_SECRETS to fall ` +
              `back to warn-only mode. See ${ISSUE_REF_1988}.`,
          }),
        );
      }
      // Warn-only: surface the failure but keep booting. The strict
      // path covers operators who explicitly chose "fail boot on this
      // class of error"; everyone else keeps the existing "best effort
      // validation" behavior. Log loudly so the cause is in the boot
      // log even when boot continues — without this the underlying
      // error (third-party plugin throwing in `getConfigSchema()`,
      // JSONB shape drift, module-load failure) would be dropped on
      // the floor (#2252).
      log.warn(
        { err: result.cause },
        `Plugin config validation threw — proceeding without stale-config checks ` +
          `(set ATLAS_STRICT_PLUGIN_SECRETS=true to fail boot instead). See ${ISSUE_REF_1988} / #2252.`,
      );
      return;
    }

    if (result.issues.length === 0) return;

    if (isStrictPluginMode(env)) {
      yield* Effect.fail(
        new PluginConfigStaleError({
          issues: result.issues,
          message:
            `ATLAS_STRICT_PLUGIN_SECRETS=true and ${result.issues.length} stored plugin config row(s) ` +
            `failed validation against the current plugin schema. Either fix the workspace configs in ` +
            `the admin UI or unset ATLAS_STRICT_PLUGIN_SECRETS to fall back to warn-only mode. ` +
            `See ${ISSUE_REF_1988}.`,
        }),
      );
    }
    // Warn-only stale-config branch: per-issue `log.warn` lines are
    // already emitted by `validateStoredPluginConfigs()` itself
    // (`lib/plugins/validation.ts:180`), and SaaS regions ALSO get a
    // single `log.error` summary there (line 195). No additional log
    // call needed at this site — but the cross-reference is load-bearing
    // because the docstring at the top of this guard claims "stale
    // configs are always logged as warnings", and that promise lives
    // in the validator, not here. See #2252.
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  ChatAdapterEnvGuardLive (#2672)
// ══════════════════════════════════════════════════════════════════════

/**
 * Fail boot in SaaS when a chat catalog entry declares
 * `install_model: "oauth"` and `enabled: true` but the platform
 * adapter's `requiredEnv` keys aren't all present.
 *
 * Background: between 2026-05-19 17:59 UTC and 2026-05-20 16:39 UTC,
 * proactive chat silently stopped in prod because `SLACK_ENCRYPTION_KEY`
 * was unset across all three Railway api services. The chat plugin's
 * `AdapterRegistry.SLACK_BUILDER.build()` returns `null` when any of
 * its four envs (`SLACK_CLIENT_ID`, `_SECRET`, `_SIGNING_SECRET`,
 * `_ENCRYPTION_KEY`) is missing, so the adapter was dropped, the api
 * still booted, the proactive listener still registered, and the
 * admin analytics endpoints kept returning 200s — every signal looked
 * green except actual events.
 *
 * Self-hosted is intentionally unaffected: a self-hosted dev box can
 * legitimately have an OAuth catalog entry without populated creds
 * (the adapter quietly doesn't activate, the api boots, the operator
 * fixes the env when they're ready). The SaaS contract is stricter
 * because there's no operator at the keyboard to notice the silent
 * downgrade.
 *
 * Walks `config.catalog`, filters by `type === "chat"` AND
 * `install_model === "oauth"` AND `enabled === true`, then for each
 * entry looks up `getChatAdapterRequiredEnv(slug)` from
 * `@useatlas/chat`. The per-slug `requiredEnv` lives there as the
 * single source of truth — duplicating in core would let the lists
 * drift between packages. Unknown slugs are ignored (the
 * AdapterRegistry's `unrecognizedSlugs` diagnostic already covers
 * operator typos at runtime).
 *
 * The `@useatlas/chat` accessor is loaded via dynamic `import()` to
 * match the lazy-import pattern of `EncryptionKeyGuardLive` and
 * `PluginConfigGuardLive` — keeps the chat plugin's static graph out
 * of `saas-guards.ts` (the wall-off rationale is documented at the
 * bottom of this file). A rejected import is rare-but-possible (build
 * artefact missing); we promote it to a defect via `Effect.orDie` so
 * the boot Layer dies rather than silently skipping the check. The
 * silent-skip path was the exact #2672 outage pattern — log+continue
 * here would reintroduce the same class of bug this guard exists to
 * prevent. `@useatlas/chat` is a workspace dep used throughout core
 * (proactive listeners, install handlers, executeQuery wiring), so
 * in practice an import rejection means the api can't run anyway —
 * dying here surfaces the root cause at boot instead of letting a
 * downstream route 500 minutes later.
 */
export const ChatAdapterEnvGuardLive: Layer.Layer<never, ChatAdapterEnvMissingError, Config | Migration> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;
    if (relaxSaasGuardForDev("ChatAdapterEnv")) return;

    const catalog = config.catalog ?? [];
    if (catalog.length === 0) return;

    // Ordering barrier (#3704): the DB-or-env presence check below reads
    // `operator_integration_credentials` (created by migration 0140) for any
    // managed operator platform. Yielding `Migration` here forces this guard
    // to construct AFTER `migrationLayer` so the table is guaranteed to exist
    // — without this edge the guard runs in parallel with migrations and a
    // first-deploy boot would throw `relation "operator_integration_credentials"
    // does not exist`, which `importGetMissingOperatorEnv`'s `Effect.orDie`
    // would promote to a boot crash. Pre-#3704 the guard read only env and had
    // no DB dependency, so this edge is new with the operator-credential read.
    yield* Migration;

    // Lazy-import the per-slug requiredEnv accessor from the chat
    // plugin. `Effect.tryPromise` routes a rejected import into the E
    // channel; `Effect.orDie` then converts that into a defect, which
    // crashes the boot Layer. This keeps the E channel narrow (still
    // just `ChatAdapterEnvMissingError`) while ensuring an
    // accessor-unreachable failure doesn't silently bypass the check.
    const accessor = yield* Effect.tryPromise({
      try: async (): Promise<(slug: string) => ReadonlyArray<string> | null> => {
        const mod = await import("@useatlas/chat");
        return mod.getChatAdapterRequiredEnv;
      },
      catch: (err) =>
        err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.orDie);

    for (const entry of catalog) {
      if (entry.type !== "chat") continue;
      if (entry.install_model !== "oauth") continue;
      if (!entry.enabled) continue;

      const requiredEnv = accessor(entry.slug);
      // Unknown slug — let the runtime AdapterRegistry warn about the
      // operator typo; this guard's contract is "if Atlas ships a
      // builder, every key the builder needs must be present."
      if (!requiredEnv) continue;

      // Presence check is "operator-credential DB row OR env" (#3704).
      // The builder's `requiredEnv` stays the single source of truth for
      // WHICH keys must be present (passed straight through to the resolver
      // helper); the operator credential resolver decides whether each is
      // satisfied by a row set via Admin or by the env fallback. When the
      // slug isn't a managed operator platform, or no internal DB exists
      // (self-host stateless), the helper collapses to the original
      // env-only check — so this remains a faithful superset of the
      // pre-#3704 guard, never a looser one.
      const missingEnv = yield* importGetMissingOperatorEnv(entry.slug, requiredEnv);

      if (missingEnv.length > 0) {
        return yield* Effect.fail(
          new ChatAdapterEnvMissingError({
            slug: entry.slug,
            missingEnv,
            message:
              `SaaS region booted with catalog entry slug="${entry.slug}" (type=chat, ` +
              `install_model=oauth, enabled=true) but the adapter builder's required ` +
              `credentials are missing from BOTH the operator-credentials store (Admin → ` +
              `Operator Integrations) and the environment: [${missingEnv.join(", ")}]. ` +
              `Without them the AdapterRegistry silently drops the adapter — the api would ` +
              `boot, proactive chat would register, and every health signal would stay green ` +
              `while no chat event ever lands. Set the missing credential(s) via the Admin ` +
              `console or env on every region's api service before booting. ` +
              `See ${CHAT_ADAPTER_ISSUE_REF} / #3704.`,
          }),
        );
      }
    }
  }),
);

/**
 * Lazy-import the operator-credentials resolver helper. Same wall-off
 * rationale as the chat accessor import above — keeps the operator
 * credential store's static graph (internalQuery, secret-encryption) out of
 * `saas-guards.ts`. A rejected import is promoted to a defect via
 * `Effect.orDie`: the resolver is core and always loadable at boot, so a
 * rejection means the api can't run anyway, and silently skipping would
 * reopen the silent-degradation hole this guard exists to close.
 *
 * Note `orDie` also covers the live `internalQuery` the resolver runs against
 * `operator_integration_credentials` (decrypt/corruption or a DB error), not
 * just the import — that is deliberate: a corrupt operator row SHOULD fail
 * boot loudly rather than degrade to env-only. The guard's `Migration`
 * dependency edge guarantees the table exists before this runs, so the only
 * remaining die-able cause is a genuine read/decrypt failure that the operator
 * must fix anyway.
 */
function importGetMissingOperatorEnv(
  catalogSlug: string,
  requiredKeys: readonly string[],
): Effect.Effect<string[]> {
  return Effect.tryPromise({
    try: async () => {
      const mod = await import("@atlas/api/lib/integrations/operator-credentials/resolver");
      return mod.getMissingOperatorEnvForCatalogSlug(catalogSlug, requiredKeys);
    },
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(Effect.orDie);
}

// ══════════════════════════════════════════════════════════════════════
// ██  BillingConfigGuardLive (#3435)
// ══════════════════════════════════════════════════════════════════════

/**
 * Fail boot in SaaS when Stripe billing is configured (`STRIPE_SECRET_KEY`
 * set) but the price-ID / key-mode config is internally inconsistent — and
 * loudly WARN (never crash) when the configured price IDs can't be resolved in
 * the live Stripe account, or a resolved price's `livemode` doesn't match the
 * key mode.
 *
 * Three ways a misconfigured prod looked healthy before this guard (#3435):
 *
 *   1. A missing monthly `STRIPE_{STARTER,PRO,BUSINESS}_PRICE_ID` silently
 *      omits that plan from `getStripePlans()` — no warning, the tier just
 *      vanishes from checkout.
 *   2. A test-mode price ID configured against a live key (or vice-versa)
 *      produces valid-signature webhooks whose plan sync silently no-ops
 *      (`resolvePlanTierFromPriceId` returns null in `auth/server.ts`).
 *   3. (Companion fix, not here) `GET /api/v1/billing` reporting a missing
 *      `subscription` table as `subscription: null` — addressed in `billing.ts`.
 *
 * **warn vs fail-fast decision (#3435 + #3703).** The remaining pure,
 * network-free FAIL-FAST checks are both on env-only inputs:
 *   - a missing `STRIPE_WEBHOOK_SECRET` (genuine secret, env-only), and
 *   - a secret key whose mode prefix isn't a standard `sk_test_` / `sk_live_`.
 * A MISSING PRICE ID is NO LONGER fail-fast (#3703): price IDs are now
 * runtime-editable platform settings, so a boot crash would prevent an operator
 * from ever fixing pricing without a redeploy — the exact footgun this train of
 * issues exists to remove. Instead, prices are resolved through `getSettingAuto`
 * (settings → env → default) and any still-missing monthly tier is a loud,
 * operator-actionable `log.error` WARNING that does not wedge boot.
 * The "do these price IDs exist in the account, and does each price's
 * `livemode` match the key mode?" check is a network call, so it is likewise a
 * loud `log.error` (with a per-price breakdown) but NEVER fails boot — a
 * transient Stripe outage or rate-limit at deploy time must not wedge a region.
 *
 * Gate: `deployMode === "saas"` AND `STRIPE_SECRET_KEY` present. Self-hosted is
 * untouched (no Stripe), and a SaaS region that hasn't turned on billing yet
 * (no `STRIPE_SECRET_KEY`) boots silently — matching the existing conditional
 * mount of the billing routes and the `@better-auth/stripe` plugin.
 *
 * Depends on `Settings` (like `DpaGuardLive` / `ProactiveProviderKeyGuardLive`):
 * the `yield* Settings` edge sequences it after `loadSettings()` warms the
 * in-process cache so `getSettingAuto` sees platform DB overrides rather than
 * falling back to env. The Stripe SDK + `config-validation` SSOT + `settings`
 * are lazy-imported (same wall-off pattern as `EncryptionKeyGuardLive`) so this
 * module stays free of the `stripe` static graph. The network resolution is
 * wrapped so an SDK/import rejection becomes a warn, not a boot-killing defect.
 */
export const BillingConfigGuardLive: Layer.Layer<never, BillingConfigInvalidError, Config | Settings> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;
    if (relaxSaasGuardForDev("BillingConfig")) return;
    yield* Settings; // sequence after loadSettings warms the in-process cache

    // Gate on Stripe being configured at all. A SaaS region can legitimately
    // run pre-billing (no STRIPE_SECRET_KEY) — the billing routes and the
    // Stripe auth plugin are themselves conditionally mounted on this var.
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) return;

    // Once Stripe IS configured (secret key present), the webhook secret is
    // mandatory: `auth/server.ts` only LOGS and then silently declines to mount
    // the @better-auth/stripe plugin when STRIPE_WEBHOOK_SECRET is absent, so a
    // region boots green with checkout + plan-sync dead. This is the exact
    // silent-billing-outage class this guard exists to convert into a boot
    // failure — keep it in the pure fail-fast block below.
    const webhookSecretMissing =
      !process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET.length === 0;

    const {
      findMissingMonthlyPriceIds,
      findMissingOveragePriceIds,
      detectStripeKeyMode,
      isPriceModeConsistent,
      MONTHLY_PRICE_ID_ENV_VARS,
      ANNUAL_PRICE_ID_ENV_VARS,
      OVERAGE_PRICE_ID_ENV_VARS,
    } = yield* Effect.tryPromise({
      try: () => import("@atlas/api/lib/billing/config-validation"),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(Effect.orDie);

    const { getSettingAuto } = yield* Effect.tryPromise({
      try: () => import("@atlas/api/lib/settings"),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(Effect.orDie);

    const keyMode = detectStripeKeyMode(secretKey);

    // ── Fail-fast check: env-only misconfigs (webhook secret + key shape) ──
    // Collected together so a region missing both gets one boot-failure log
    // naming both, rather than fixing one then re-failing. Missing price IDs
    // are NO LONGER fail-fast (#3703) — they are warned about below.
    if (keyMode === "unknown" || webhookSecretMissing) {
      const parts: string[] = [];
      if (webhookSecretMissing) {
        parts.push(
          `STRIPE_WEBHOOK_SECRET is unset — the @better-auth/stripe plugin declines to mount ` +
            `(auth/server.ts logs and continues), so checkout, the billing portal, and webhook ` +
            `plan-sync are all dead while the region boots green`,
        );
      }
      if (keyMode === "unknown") {
        parts.push(
          `STRIPE_SECRET_KEY is not a standard secret key (expected an sk_test_… or sk_live_… ` +
            `prefix) — restricted (rk_…) or publishable (pk_…) keys can't be mode-checked against ` +
            `the configured prices and may lack prices.retrieve scope`,
        );
      }
      return yield* Effect.fail(
        new BillingConfigInvalidError({
          missingPriceIdEnvVars: [],
          keyMode,
          message:
            `SaaS region booted with STRIPE_SECRET_KEY set but the billing config is invalid: ` +
            `${parts.join("; ")}. Fix the env var(s) on every region's api service before booting. ` +
            `See ${BILLING_CONFIG_ISSUE_REF}.`,
        }),
      );
    }

    // ── Settings-presence WARN: monthly price IDs (#3703) ────────────────
    // Resolve each monthly price through the settings registry (settings → env
    // → default). A still-missing tier is silently omitted from checkout by
    // `getStripePlans()`, so surface it as a loud, operator-actionable warning
    // — but never crash boot, because the fix is a runtime Admin → Settings
    // edit, not a redeploy.
    const missingMonthlyPriceIds = findMissingMonthlyPriceIds((key) => getSettingAuto(key));
    if (missingMonthlyPriceIds.length > 0) {
      log.error(
        {
          missingMonthlyPriceIds,
          event: "billing_config.price_missing",
        },
        `Stripe billing is enabled but ${missingMonthlyPriceIds.length} monthly price ID(s) are ` +
          `unset after settings resolution: [${missingMonthlyPriceIds.join(", ")}]. getStripePlans() ` +
          `silently omits each absent tier from checkout, so customers can't buy it. Set the price ` +
          `ID(s) in Admin → Settings (Billing) — no redeploy needed. See ${BILLING_CONFIG_ISSUE_REF}.`,
      );
    }

    // ── Settings-presence WARN: metered-overage price IDs (#3992) ────────
    // Same posture as the monthly IDs: a missing per-tier overage price means
    // `ensureOverageSubscriptionItem` (the webhook seam) can't attach that
    // tier's metered subscription item, so Stripe still records the reporter's
    // meter events but has no metered price to invoice them against — usage is
    // metered, not billed. The fix is a runtime Admin → Settings edit, so WARN
    // (never crash boot).
    const missingOveragePriceIds = findMissingOveragePriceIds((key) => getSettingAuto(key));
    if (missingOveragePriceIds.length > 0) {
      log.error(
        {
          missingOveragePriceIds,
          event: "billing_config.overage_price_missing",
        },
        `Stripe billing is enabled but ${missingOveragePriceIds.length} metered-overage price ID(s) ` +
          `are unset after settings resolution: [${missingOveragePriceIds.join(", ")}]. ` +
          `ensureOverageSubscriptionItem won't attach the metered subscription item for the affected ` +
          `tier(s), so their token overage is metered in Stripe but never invoiced. Set the price ` +
          `ID(s) in Admin → Settings (Billing) — no redeploy needed. See ${BILLING_CONFIG_ISSUE_REF}.`,
      );
    }

    // ── Network check: price existence + livemode↔key-mode (loud WARN) ───
    // A transient Stripe error here must NOT crash boot, so everything below
    // resolves to a logged warning. We resolve every CONFIGURED price ID
    // (monthly + annual + overage) through settings and check each price's
    // livemode against keyMode.
    const configuredPriceVars = [
      ...MONTHLY_PRICE_ID_ENV_VARS,
      ...ANNUAL_PRICE_ID_ENV_VARS,
      ...OVERAGE_PRICE_ID_ENV_VARS,
    ]
      .map((envVar): { envVar: string; priceId: string | undefined } => ({
        envVar,
        priceId: getSettingAuto(envVar),
      }))
      .filter((p): p is { envVar: string; priceId: string } => Boolean(p.priceId));

    const resolution = yield* Effect.promise(
      async (): Promise<
        | { ok: true; mismatches: string[]; unresolved: string[] }
        | { ok: false; error: string }
      > => {
        try {
          const { getStripeClient } = await import(
            "@atlas/api/lib/billing/stripe-client"
          );
          const stripe = getStripeClient();
          // Unreachable: STRIPE_SECRET_KEY was non-empty above. Guard anyway so
          // a future refactor of getStripeClient() can't turn this into a throw.
          if (!stripe) return { ok: true, mismatches: [], unresolved: [] };

          const mismatches: string[] = [];
          const unresolved: string[] = [];
          for (const { envVar, priceId } of configuredPriceVars) {
            try {
              const price = await stripe.prices.retrieve(priceId);
              if (!isPriceModeConsistent(keyMode, price.livemode)) {
                mismatches.push(
                  `${envVar} (${priceId}) is livemode=${price.livemode} but the key is ${keyMode}-mode`,
                );
              }
            } catch (priceErr) {
              // Most commonly a "No such price" — the price doesn't exist in
              // THIS account/mode (the classic test-price-in-prod mixup).
              unresolved.push(
                `${envVar} (${priceId}): ${priceErr instanceof Error ? priceErr.message : String(priceErr)}`,
              );
            }
          }
          return { ok: true, mismatches, unresolved };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    );

    if (!resolution.ok) {
      log.error(
        { err: new Error(resolution.error), event: "billing_config.resolution_failed" },
        `Could not verify Stripe price IDs against the configured account at boot ` +
          `(network/SDK error) — proceeding, but a test/live price mixup would stay undetected ` +
          `until a checkout no-ops. See ${BILLING_CONFIG_ISSUE_REF}.`,
      );
      return;
    }

    if (resolution.unresolved.length > 0) {
      log.error(
        {
          unresolved: resolution.unresolved,
          keyMode,
          event: "billing_config.price_unresolved",
        },
        `One or more configured Stripe price IDs do not exist in the ${keyMode}-mode account — ` +
          `a webhook carrying one of these prices would pass signature verification then no-op the ` +
          `plan sync (resolvePlanTierFromPriceId → null). This is the classic test-price-in-prod ` +
          `mixup. Fix the STRIPE_*_PRICE_ID values for the ${keyMode} account. See ${BILLING_CONFIG_ISSUE_REF}.`,
      );
    }

    if (resolution.mismatches.length > 0) {
      log.error(
        {
          mismatches: resolution.mismatches,
          keyMode,
          event: "billing_config.mode_mismatch",
        },
        `One or more configured Stripe prices resolved with a livemode inconsistent with the ` +
          `secret key's ${keyMode} mode — checkout / webhook plan sync will silently no-op for the ` +
          `affected tier(s). See ${BILLING_CONFIG_ISSUE_REF}.`,
      );
    }
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  McpSpineGuardLive (#3687)
// ══════════════════════════════════════════════════════════════════════

/**
 * Surface MCP-spine incoherence at BOOT in SaaS when hosted MCP is exposed
 * (#3687). Two checks with deliberately DIFFERENT severities:
 *
 *   1. OAuth valid-audiences DERIVABLE — `resolveOAuthValidAudiences` returns a
 *      non-empty list. An empty list means Better Auth validates MCP bearer
 *      tokens against `validAudiences: []`, so every OAuth MCP call 401s at first
 *      I/O while boot stays green. This is a deterministic, env-only check (no
 *      I/O), so a violation FAILS BOOT ({@link McpSpineIncoherentError}) — the
 *      same fail-fast posture as the rest of the guard family.
 *   2. `mcp_action_policy` STORE reachable — a cheap sentinel-org SELECT
 *      succeeds. The dispatch gate's action-policy check fails CLOSED on a read
 *      error, so an unreachable store turns every hosted MCP action into an
 *      opaque `internal_error` at first call. This is a live DB probe, so a
 *      failure is a loud `log.warn` (operator-actionable, event-tagged) — NOT a
 *      boot failure.
 *
 * **Why check 2 warns instead of failing boot.** A boot-time DB probe that fails
 * the boot Layer would (a) wedge a whole region on a transient DB blip at deploy
 * time — even though `InternalDbGuardLive` + the SaaS migration guard already
 * fail boot when the DB is genuinely absent — and (b) compete non-deterministically
 * with the other guards in the parallel `Layer.mergeAll`. It mirrors
 * `PluginConfigGuardLive`'s non-strict posture (a DB read error there warns and
 * continues rather than wedging boot). The runtime is ALSO already fail-closed on
 * a policy read error (dispatch Gate 1), so the security property holds regardless
 * — the warn just moves DISCOVERY of an unreachable store to boot.
 *
 * **MCP-enabled predicate.** Hosted MCP is mounted UNCONDITIONALLY on every SaaS
 * api instance (`api/index.ts` mounts `/mcp/{workspace_id}/sse` with no toggle),
 * so `deployMode === "saas"` IS the "MCP is exposed" gate — there is no separate
 * enable flag to consult. The guard only *enforces* spine coherence in SaaS and
 * skips self-hosted entirely: a self-hoster who opts into hosted MCP on their own
 * host owns their audience/policy config, and the common self-host path is stdio
 * MCP, which uses neither spine component.
 *
 * Depends on `Config` + `Migration` (`mcp_action_policy` is created by migration
 * 0134; the `Migration` edge mirrors `ChatAdapterEnvGuardLive` so the table
 * exists before the probe runs and the warn can't false-positive on first boot).
 * Both modules are lazy-imported (same wall-off rationale as
 * `EncryptionKeyGuardLive`) so this file stays free of the auth-server / MCP
 * static graphs. A rejected `oauth-audiences` import is promoted to a defect via
 * `Effect.orDie` (it is core and always loadable at boot); a rejected
 * `action-policy` import or query is caught and folded into the same warn as a
 * live read failure.
 */
export const McpSpineGuardLive: Layer.Layer<never, McpSpineIncoherentError, Config | Migration> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;
    if (relaxSaasGuardForDev("McpSpine")) return;
    yield* Migration; // mcp_action_policy created by migration 0134 — order after migrations

    // ── Check 1 (FAIL BOOT): OAuth valid-audiences derivable ─────────────
    const { resolveOAuthValidAudiences } = yield* Effect.tryPromise({
      try: () => import("@atlas/api/lib/auth/oauth-audiences"),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(Effect.orDie);

    const audiences = resolveOAuthValidAudiences(process.env);
    if (audiences.length === 0) {
      return yield* Effect.fail(
        new McpSpineIncoherentError({
          check: "audiences",
          resolvedAudienceCount: audiences.length,
          message:
            `SaaS region exposes hosted MCP but no OAuth valid-audiences are derivable — ` +
            `resolveOAuthValidAudiences() returned an empty list because neither ` +
            `ATLAS_OAUTH_VALID_AUDIENCES nor a base URL (ATLAS_PUBLIC_API_URL / BETTER_AUTH_URL) ` +
            `is set. Better Auth would then verify every MCP bearer token against an empty ` +
            `audience set, 401-ing all OAuth-authenticated MCP calls while boot and /health stay ` +
            `green. Set ATLAS_PUBLIC_API_URL (or BETTER_AUTH_URL) on every region's api service ` +
            `before booting. See ${MCP_SPINE_ISSUE_REF}.`,
        }),
      );
    }

    // ── Check 2 (WARN): mcp_action_policy store reachable ────────────────
    // Live DB probe — a failure WARNS (never fails boot). The inner try/catch
    // converts a rejected import OR a query failure into a discriminated result.
    const probe = yield* Effect.promise(
      async (): Promise<{ ok: true } | { ok: false; cause: Error }> => {
        try {
          const { loadMcpActionPolicy } = await import("@atlas/api/lib/mcp/action-policy");
          // Sentinel org — proves the table + query path is reachable without
          // asserting anything about a real tenant's policy.
          await loadMcpActionPolicy(MCP_POLICY_PROBE_ORG_ID);
          return { ok: true };
        } catch (err) {
          return { ok: false, cause: err instanceof Error ? err : new Error(String(err)) };
        }
      },
    );

    if (!probe.ok) {
      log.warn(
        { err: probe.cause, event: "mcp_spine.policy_store_unreachable" },
        `SaaS region exposes hosted MCP but the mcp_action_policy store could not be reached at ` +
          `boot: ${probe.cause.message}. The dispatch gate's action-policy check fails CLOSED on a ` +
          `read error, so until this is resolved every hosted MCP action returns an opaque ` +
          `internal_error at first call. Verify the internal DB is reachable and migration 0134 ` +
          `(mcp_action_policy) has applied. See ${MCP_SPINE_ISSUE_REF}.`,
      );
    }
  }),
);

// `MigrationGuardLive` (#1988 C9) lives in `lib/effect/layers.ts` next
// to `DpaGuardLive` because it directly yields the `Migration` Tag
// defined in that module — sibling pattern, same wall-off rationale.
// Its tagged error (`MigrationsRequiredError`) stays here so the
// family's failure shapes remain co-located for grep / docs.

// Note: `warnIfDeployModeSilentlyDowngraded()` previously lived here.
// It was inlined into `lib/config.ts` because importing the helper
// from this module forced `layers.ts` (and its dynamic
// `@atlas/api/lib/telemetry` import) into the static reachability
// graph of every `config.ts` consumer. Next.js App Router tracing
// then failed the `create-atlas` standalone scaffold build trying to
// resolve `@opentelemetry/sdk-node`. Keeping the boot-time guards
// here and the config-file warning in `config.ts` walls the
// boot-only modules off from request-path consumers.
