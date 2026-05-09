/**
 * Single source of truth for every env var the SaaS-mode boot
 * contract reads (#2226).
 *
 * Adding a new SaaS guard means appending a field to {@link SaasEnv}
 * and a sane default to {@link makeBootSmokeFixture} — the boot-smoke
 * gate (`.github/workflows/ci.yml :: boot-smoke`) auto-picks up the
 * new value via `scripts/saas-env-fixture.ts`. No workflow edit, no
 * separate env wiring.
 *
 * The shape is a typed view of `process.env` restricted to the
 * SaaS-required keys. Guards in `saas-guards.ts` and the boot-time
 * `MigrationGuardLive` short-circuit in `layers.ts` read via
 * {@link readSaasEnv} instead of free-standing `process.env.X` so a
 * future contributor adding a field touches one place rather than
 * chasing references.
 *
 * Indirect reads (`getEncryptionKeyset()` reads `ATLAS_ENCRYPTION_KEYS`
 * inside `lib/db/encryption-keys.ts`; `dpa-guard.ts` reads
 * `RESEND_API_KEY` and `ATLAS_SMTP_URL`) are still listed here so the
 * fixture populates them — the contract is enumerated even when the
 * read site lives outside `effect/`.
 */

/** Every env var the SaaS-mode boot contract reads. */
export interface SaasEnv {
  // Deploy mode + enterprise (EnterpriseGuardLive)
  readonly ATLAS_DEPLOY_MODE: string | undefined;
  readonly ATLAS_ENTERPRISE_ENABLED: string | undefined;

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

  // Better Auth public URL — required by the OAuth-provider plugin at
  // boot (`URL("")` throws inside `runPluginInit` when unset). Read by
  // `lib/auth/server.ts` via `env.BETTER_AUTH_URL` for callback URLs.
  readonly BETTER_AUTH_URL: string | undefined;
  readonly BETTER_AUTH_TRUSTED_ORIGINS: string | undefined;
}

/**
 * Ordered list of every key in {@link SaasEnv}. The `satisfies` clause
 * forces TypeScript to verify the array is exhaustive — adding a field
 * to `SaasEnv` without appending its key here is a compile error. Used
 * by `saas-env-fixture.ts` (emitting `KEY=VALUE` lines) and tests
 * (clearing every SaaS env var between cases).
 */
export const SAAS_ENV_KEYS = [
  "ATLAS_DEPLOY_MODE",
  "ATLAS_ENTERPRISE_ENABLED",
  "DATABASE_URL",
  "ATLAS_DATASOURCE_URL",
  "ATLAS_ENCRYPTION_KEYS",
  "ATLAS_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
  "ATLAS_RATE_LIMIT_RPM",
  "ATLAS_API_REGION",
  "ATLAS_REGION_US_DB_URL",
  "ATLAS_REGION_EU_DB_URL",
  "ATLAS_REGION_APAC_DB_URL",
  "ATLAS_STRICT_PLUGIN_SECRETS",
  "ATLAS_SMTP_URL",
  "RESEND_API_KEY",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
] as const satisfies readonly (keyof SaasEnv)[];

// Compile-time exhaustiveness: every key in SaasEnv must appear in
// SAAS_ENV_KEYS. If TypeScript flags this with "Type ... is missing
// the following properties from type 'never'", a key was added to
// SaasEnv but not appended to SAAS_ENV_KEYS.
type _ExhaustiveCheck = Exclude<keyof SaasEnv, (typeof SAAS_ENV_KEYS)[number]>;
const _exhaustive: _ExhaustiveCheck extends never ? true : false = true;
void _exhaustive;

/** Read `process.env` (or an injected env object) into a typed `SaasEnv`. */
export function readSaasEnv(env: NodeJS.ProcessEnv = process.env): SaasEnv {
  return {
    ATLAS_DEPLOY_MODE: env.ATLAS_DEPLOY_MODE,
    ATLAS_ENTERPRISE_ENABLED: env.ATLAS_ENTERPRISE_ENABLED,
    DATABASE_URL: env.DATABASE_URL,
    ATLAS_DATASOURCE_URL: env.ATLAS_DATASOURCE_URL,
    ATLAS_ENCRYPTION_KEYS: env.ATLAS_ENCRYPTION_KEYS,
    ATLAS_ENCRYPTION_KEY: env.ATLAS_ENCRYPTION_KEY,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    ATLAS_RATE_LIMIT_RPM: env.ATLAS_RATE_LIMIT_RPM,
    ATLAS_API_REGION: env.ATLAS_API_REGION,
    ATLAS_REGION_US_DB_URL: env.ATLAS_REGION_US_DB_URL,
    ATLAS_REGION_EU_DB_URL: env.ATLAS_REGION_EU_DB_URL,
    ATLAS_REGION_APAC_DB_URL: env.ATLAS_REGION_APAC_DB_URL,
    ATLAS_STRICT_PLUGIN_SECRETS: env.ATLAS_STRICT_PLUGIN_SECRETS,
    ATLAS_SMTP_URL: env.ATLAS_SMTP_URL,
    RESEND_API_KEY: env.RESEND_API_KEY,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: env.BETTER_AUTH_TRUSTED_ORIGINS,
  };
}

export interface BootSmokeFixtureOptions {
  /** Postgres URL applied to internal DB, datasource, and every region. */
  readonly databaseUrl?: string;
  /** Per-key overrides — useful for testing specific failure modes. */
  readonly overrides?: Partial<SaasEnv>;
}

/**
 * Build a SaaS env block with sane defaults for the boot-smoke gate
 * and Effect tests that need a complete contract. The returned shape
 * is consumed two ways:
 *
 *   1. `scripts/saas-env-fixture.ts` emits its `KEY=VALUE` form to the
 *      GitHub Actions workflow.
 *   2. Effect tests pass it to `withSaasEnv()` to populate
 *      `process.env` for a single test case.
 *
 * The encryption-key value is a fixed 44-char base64 string that
 * `getEncryptionKeyset()` accepts as well-formed (SHA-256 derives the
 * 32-byte AES key from any non-empty raw). It is *not* a secret — it
 * is identical across every CI run and intentionally documented as
 * such. Production keys are minted via `openssl rand -base64 32`.
 */
export function makeBootSmokeFixture(
  opts: BootSmokeFixtureOptions = {},
): SaasEnv {
  const databaseUrl =
    opts.databaseUrl ?? "postgresql://atlas:atlas@127.0.0.1:5432/atlas";
  const fixture: SaasEnv = {
    ATLAS_DEPLOY_MODE: "saas",
    ATLAS_ENTERPRISE_ENABLED: "true",
    DATABASE_URL: databaseUrl,
    ATLAS_DATASOURCE_URL: databaseUrl,
    ATLAS_ENCRYPTION_KEYS: "v1:ci-fixture-key-not-a-secret-do-not-use-in-prod",
    ATLAS_ENCRYPTION_KEY: undefined,
    // Better Auth requires ≥32 chars for session signing (`parseAuthSecret`
    // in lib/auth/server.ts). ATLAS_ENCRYPTION_KEYS takes precedence for
    // at-rest encryption — this is purely the Better Auth path.
    BETTER_AUTH_SECRET: "ci-fixture-better-auth-secret-not-a-secret-pad-pad",
    ATLAS_RATE_LIMIT_RPM: "300",
    ATLAS_API_REGION: "us",
    ATLAS_REGION_US_DB_URL: databaseUrl,
    ATLAS_REGION_EU_DB_URL: databaseUrl,
    ATLAS_REGION_APAC_DB_URL: databaseUrl,
    ATLAS_STRICT_PLUGIN_SECRETS: undefined,
    ATLAS_SMTP_URL: undefined,
    RESEND_API_KEY: "ci-fixture-resend-key-not-a-secret",
    BETTER_AUTH_URL: "http://127.0.0.1:3001",
    BETTER_AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:3000",
  };
  return { ...fixture, ...opts.overrides };
}
