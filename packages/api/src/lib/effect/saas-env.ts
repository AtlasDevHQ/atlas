/**
 * Single source of truth for every env var the SaaS-mode boot
 * contract reads (#2226).
 *
 * Adding a new SaaS guard means appending a field to {@link SaasEnv}
 * and a sane default to {@link makeBootSmokeFixture} — the boot-smoke
 * gate (`.github/workflows/deploy-validation.yml :: boot-smoke`)
 * auto-picks up the new value via `scripts/saas-env-fixture.ts`. No
 * workflow edit, no separate env wiring.
 *
 * The shape is a typed view of `process.env` restricted to the
 * SaaS-required keys. Guards in `saas-guards.ts` plus `DpaGuardLive`
 * and `MigrationGuardLive` in `layers.ts` read via {@link readSaasEnv}
 * instead of free-standing `process.env.X` so a future contributor
 * adding a field touches one place rather than chasing references.
 *
 * Indirect reads (`getEncryptionKeyset()` reads `ATLAS_ENCRYPTION_KEYS`
 * inside `lib/db/encryption-keys.ts`; `dpa-guard.ts` reads
 * `RESEND_API_KEY` and `ATLAS_SMTP_URL`) are still listed here so the
 * fixture populates them — the contract is enumerated even when the
 * read site lives outside `effect/`.
 */

/**
 * Every env var the SaaS-mode boot contract reads.
 *
 * `ATLAS_DEPLOY_MODE` and `ATLAS_ENTERPRISE_ENABLED` are intentionally
 * NOT in this contract (#3702): on SaaS, `deploy/api/atlas.config.ts`
 * sets `deployMode: "saas"` and `enterprise.enabled: true`, and both
 * resolve from the config file when the env vars are unset. The two
 * precedences differ: `applyDeployMode` is `process.env.ATLAS_DEPLOY_MODE
 * ?? configFileValue` (env wins if set; config supplies the value only
 * because the env var is absent), whereas `isEnterpriseEnabled*` checks
 * `config.enterprise?.enabled` *before* env (config wins outright). So
 * a SaaS region boots correctly with both unset. `EnterpriseGuardLive`
 * still inspects the raw `process.env.ATLAS_DEPLOY_MODE` directly to
 * catch the self-host footgun (env requests saas, no `@atlas/ee`) — that
 * is a misconfiguration probe, not a SaaS-required input.
 */
export interface SaasEnv {
  // Internal DB (InternalDbGuardLive, MigrationGuardLive short-circuit)
  readonly DATABASE_URL: string | undefined;

  // Analytics datasource (config initialization)
  readonly ATLAS_DATASOURCE_URL: string | undefined;

  // Encryption keyset (EncryptionKeyGuardLive → getEncryptionKeyset)
  readonly ATLAS_ENCRYPTION_KEYS: string | undefined;
  readonly ATLAS_ENCRYPTION_KEY: string | undefined;
  readonly BETTER_AUTH_SECRET: string | undefined;

  // Rate limiting (RateLimitGuardLive)
  readonly ATLAS_RATE_LIMIT_RPM: string | undefined;

  // LLM provider key (ProviderKeyGuardLive, #3178). `ATLAS_PROVIDER` selects
  // the provider (unset → `getDefaultProvider()`, which is `gateway` in SaaS).
  // `AI_GATEWAY_API_KEY` is the key the SaaS gateway-default path requires; it
  // is listed here so `makeBootSmokeFixture` populates it (the boot-smoke gate
  // boots on the gateway default). The guard resolves the *required* key for
  // the configured provider dynamically via `PROVIDER_KEY_MAP` and reads it
  // straight from `process.env` — so a non-gateway key (ANTHROPIC_API_KEY,
  // OPENAI_API_KEY, AWS_ACCESS_KEY_ID) need not be enumerated here (same
  // dynamic-read pattern as ChatAdapterEnvGuardLive's adapter keys).
  readonly ATLAS_PROVIDER: string | undefined;
  readonly AI_GATEWAY_API_KEY: string | undefined;

  // Region routing (RegionGuardLive + atlas.config.ts residency)
  readonly ATLAS_API_REGION: string | undefined;
  readonly ATLAS_REGION_US_DB_URL: string | undefined;
  readonly ATLAS_REGION_EU_DB_URL: string | undefined;
  readonly ATLAS_REGION_APAC_DB_URL: string | undefined;

  // Plugin config strict mode (PluginConfigGuardLive)
  readonly ATLAS_STRICT_PLUGIN_SECRETS: string | undefined;

  // Platform email DPA (DpaGuardLive → assertSaasPlatformEmailIsResend)
  readonly ATLAS_SMTP_URL: string | undefined;
  readonly RESEND_API_KEY: string | undefined;

  // Cloudflare Turnstile abuse gate (TurnstileGuardLive, #3795). Backs the
  // bot-protection in front of the talk-to-sales contact form
  // (`lib/turnstile.ts :: verifyTurnstile`) AND the interactive web
  // email/password signup (Better Auth `captcha` plugin scoped to
  // `/sign-up/email`, #4159 — moved here off the headless `start_trial` door).
  // When the secret is unset the two fail differently, both silently: contact
  // fails CLOSED (submissions 403), while web signup fails OPEN (the captcha
  // plugin isn't registered without a secret → signups proceed unprotected, an
  // open signup door). Boots green either way, so `TurnstileGuardLive` fails
  // boot instead. Listed here so the boot-smoke fixture populates it and the
  // guard asserts on it via `readSaasEnv()`.
  readonly TURNSTILE_SECRET_KEY: string | undefined;

  // Boot-survival keys (not guard-enforced — required for the API
  // process to start in managed-auth + SaaS mode, but no Atlas guard
  // explicitly verifies them).
  //
  // BETTER_AUTH_URL — Better Auth's library boot path constructs
  // `new URL(baseURL)` inside its plugin init (verified locally:
  // `runPluginInit` in `node_modules/better-auth/dist/context/helpers.mjs`
  // throws `TypeError: "" cannot be parsed as a URL.` when unset under
  // the OAuth-provider plugin Atlas registers). Read separately by
  // `lib/auth/server.ts` for callback URL rewriting.
  //
  // BETTER_AUTH_TRUSTED_ORIGINS — read by `lib/auth/server.ts` to
  // anchor verification + password-reset link redirects to the web
  // app origin; missing-only emits a warn at boot, but a stale value
  // would silently land users on the API host instead of the web app.
  readonly BETTER_AUTH_URL: string | undefined;
  readonly BETTER_AUTH_TRUSTED_ORIGINS: string | undefined;

  // Slack plugin signing secret — required by `chatPlugin`'s Slack
  // adapter schema, which now enforces a 32-char lowercase hex format
  // at boot. Production deploys provide a real Slack app secret; the
  // boot-smoke fixture emits a syntactically-valid placeholder so the
  // schema parses without crashing the boot guards.
  readonly SLACK_SIGNING_SECRET: string | undefined;

  // Slack OAuth + at-rest credentials (#2672 — ChatAdapterEnvGuardLive).
  // When the chat catalog enables `slug: "slack"` with `install_model:
  // "oauth"`, the AdapterRegistry's `SLACK_BUILDER.build()` requires all
  // four envs (the signing secret above plus these three). Missing any
  // of them in SaaS silently drops the adapter — proactive chat keeps
  // booting, admin analytics keep returning 200s, and no Slack event
  // ever lands. The 2026-05-19 → 2026-05-20 incident hit exactly this
  // path (`SLACK_ENCRYPTION_KEY` unset across all three Railway api
  // services). Listed here so the boot-smoke fixture populates them and
  // `ChatAdapterEnvGuardLive` asserts on them via `readSaasEnv()`.
  readonly SLACK_CLIENT_ID: string | undefined;
  readonly SLACK_CLIENT_SECRET: string | undefined;
  readonly SLACK_ENCRYPTION_KEY: string | undefined;
}

/**
 * Ordered list of every key in {@link SaasEnv}. The `satisfies` clause
 * forces TypeScript to verify the array is exhaustive — adding a field
 * to `SaasEnv` without appending its key here is a compile error. Used
 * by `saas-env-fixture.ts` (emitting `KEY=VALUE` lines) and tests
 * (clearing every SaaS env var between cases).
 */
export const SAAS_ENV_KEYS = [
  "DATABASE_URL",
  "ATLAS_DATASOURCE_URL",
  "ATLAS_ENCRYPTION_KEYS",
  "ATLAS_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
  "ATLAS_RATE_LIMIT_RPM",
  "ATLAS_PROVIDER",
  "AI_GATEWAY_API_KEY",
  "ATLAS_API_REGION",
  "ATLAS_REGION_US_DB_URL",
  "ATLAS_REGION_EU_DB_URL",
  "ATLAS_REGION_APAC_DB_URL",
  "ATLAS_STRICT_PLUGIN_SECRETS",
  "ATLAS_SMTP_URL",
  "RESEND_API_KEY",
  "TURNSTILE_SECRET_KEY",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_ENCRYPTION_KEY",
] as const satisfies readonly (keyof SaasEnv)[];

// Compile-time exhaustiveness: every key in SaasEnv must appear in
// SAAS_ENV_KEYS. If TypeScript flags this with "Type ... is missing
// the following properties from type 'never'", a key was added to
// SaasEnv but not appended to SAAS_ENV_KEYS.
type _ExhaustiveCheck = Exclude<keyof SaasEnv, (typeof SAAS_ENV_KEYS)[number]>;
const _exhaustive: _ExhaustiveCheck extends never ? true : false = true;
// `void` is load-bearing — silences `noUnusedLocals` without disabling
// the compile-time check. Do not delete `_exhaustive` even though it
// looks dead; the assignment is the gate.
void _exhaustive;

/** Read `process.env` (or an injected env object) into a typed `SaasEnv`. */
export function readSaasEnv(env: NodeJS.ProcessEnv = process.env): SaasEnv {
  return {
    DATABASE_URL: env.DATABASE_URL,
    ATLAS_DATASOURCE_URL: env.ATLAS_DATASOURCE_URL,
    ATLAS_ENCRYPTION_KEYS: env.ATLAS_ENCRYPTION_KEYS,
    ATLAS_ENCRYPTION_KEY: env.ATLAS_ENCRYPTION_KEY,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    ATLAS_RATE_LIMIT_RPM: env.ATLAS_RATE_LIMIT_RPM,
    ATLAS_PROVIDER: env.ATLAS_PROVIDER,
    AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY,
    ATLAS_API_REGION: env.ATLAS_API_REGION,
    ATLAS_REGION_US_DB_URL: env.ATLAS_REGION_US_DB_URL,
    ATLAS_REGION_EU_DB_URL: env.ATLAS_REGION_EU_DB_URL,
    ATLAS_REGION_APAC_DB_URL: env.ATLAS_REGION_APAC_DB_URL,
    ATLAS_STRICT_PLUGIN_SECRETS: env.ATLAS_STRICT_PLUGIN_SECRETS,
    ATLAS_SMTP_URL: env.ATLAS_SMTP_URL,
    RESEND_API_KEY: env.RESEND_API_KEY,
    TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: env.BETTER_AUTH_TRUSTED_ORIGINS,
    SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
    SLACK_CLIENT_ID: env.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: env.SLACK_CLIENT_SECRET,
    SLACK_ENCRYPTION_KEY: env.SLACK_ENCRYPTION_KEY,
  };
}

export interface BootSmokeFixtureOptions {
  /** Postgres URL applied to internal DB, datasource, and every region. */
  readonly databaseUrl?: string;
  /**
   * Per-key overrides — useful for testing specific failure modes.
   *
   * Setting a key to an explicit `undefined` (e.g. `{ RESEND_API_KEY:
   * undefined }`) **drops** the fixture default and emits no value for
   * that key, which lets callers probe the failure path of a guard
   * that requires the key to be set. Omitting the key entirely leaves
   * the fixture default in place. The drop-on-`undefined` behavior is
   * implemented via spread (`{ ...fixture, ...overrides }`) and
   * pinned by `__tests__/saas-env.test.ts :: overrides win`. Note that
   * this depends on `exactOptionalPropertyTypes` being unset in the
   * project tsconfig — flipping that flag would break this contract.
   */
  readonly overrides?: Partial<SaasEnv>;
}

/**
 * Build a SaaS env block with sane defaults for the boot-smoke gate.
 * The returned shape is consumed by:
 *
 *   1. `scripts/saas-env-fixture.ts`, which emits the `KEY=VALUE` form
 *      to the GitHub Actions workflow.
 *   2. `__tests__/saas-env.test.ts`, which pins per-field shape so a
 *      future fixture tweak doesn't accidentally drop a required key.
 *
 * The `ATLAS_ENCRYPTION_KEYS` value is plain ASCII, not base64 —
 * `getEncryptionKeyset()` SHA-256s any non-empty raw entry to derive
 * the 32-byte AES key, so the format-level requirement is "non-empty
 * after the `v<N>:` prefix" (no character-set constraint). It is *not*
 * a secret — it is identical across every CI run and intentionally
 * documented as such. Production keys are minted via
 * `openssl rand -base64 32`, which is where the more restrictive
 * "44-char base64" shape comes from.
 */
export function makeBootSmokeFixture(
  opts: BootSmokeFixtureOptions = {},
): SaasEnv {
  const databaseUrl =
    opts.databaseUrl ?? "postgresql://atlas:atlas@127.0.0.1:5432/atlas";
  const fixture: SaasEnv = {
    DATABASE_URL: databaseUrl,
    ATLAS_DATASOURCE_URL: databaseUrl,
    ATLAS_ENCRYPTION_KEYS: "v1:ci-fixture-key-not-a-secret-do-not-use-in-prod",
    ATLAS_ENCRYPTION_KEY: undefined,
    // Better Auth requires ≥32 chars for session signing (`parseAuthSecret`
    // in lib/auth/server.ts). ATLAS_ENCRYPTION_KEYS takes precedence for
    // at-rest encryption — this is purely the Better Auth path.
    BETTER_AUTH_SECRET: "ci-fixture-better-auth-secret-not-a-secret-pad-pad",
    ATLAS_RATE_LIMIT_RPM: "300",
    // ProviderKeyGuardLive (#3178): leave ATLAS_PROVIDER unset so the guard
    // exercises the SaaS gateway default (getDefaultProvider() → "gateway"),
    // and supply the key that path requires. Not a secret — identical every
    // CI run, like the other fixture placeholders. The gateway SDK only reads
    // it at per-request model init, never at boot, so any non-empty value
    // satisfies the boot guard.
    ATLAS_PROVIDER: undefined,
    AI_GATEWAY_API_KEY: "ci-fixture-ai-gateway-key-not-a-secret",
    ATLAS_API_REGION: "us",
    ATLAS_REGION_US_DB_URL: databaseUrl,
    ATLAS_REGION_EU_DB_URL: databaseUrl,
    ATLAS_REGION_APAC_DB_URL: databaseUrl,
    ATLAS_STRICT_PLUGIN_SECRETS: undefined,
    ATLAS_SMTP_URL: undefined,
    RESEND_API_KEY: "ci-fixture-resend-key-not-a-secret",
    // TurnstileGuardLive (#3795) asserts presence only (non-empty) in SaaS —
    // `verifyTurnstile` reads it at per-request siteverify, never at boot, so
    // any non-empty value satisfies the boot guard. Not a secret — identical
    // every CI run, like the other fixture placeholders.
    TURNSTILE_SECRET_KEY: "ci-fixture-turnstile-secret-not-a-secret",
    BETTER_AUTH_URL: "http://127.0.0.1:3001",
    BETTER_AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:3000",
    // 32-char lowercase hex placeholder. Satisfies the new strict
    // `SLACK_SIGNING_SECRET_REGEX` in plugins/chat/src/config.ts so the
    // SaaS deploy config parses cleanly under Boot Smoke without
    // requiring a real Slack app credential.
    SLACK_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
    // #2672 — placeholders for the SLACK adapter's other three
    // requiredEnv keys. ChatAdapterEnvGuardLive only asserts presence
    // (non-empty), so any non-empty string suffices for the boot-smoke
    // gate. The encryption key reuses the 32-char hex shape for
    // consistency with `SLACK_SIGNING_SECRET`; the real key (used by
    // `lib/slack/installation-encryption.ts` to decode bot tokens) is
    // hex (64 chars) or base64 (44 chars), so this placeholder would
    // fail real decode — boot-smoke never reaches that path.
    SLACK_CLIENT_ID: "ci-fixture-slack-client-id-not-a-secret",
    SLACK_CLIENT_SECRET: "ci-fixture-slack-client-secret-not-a-secret",
    SLACK_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  };
  return { ...fixture, ...opts.overrides };
}
