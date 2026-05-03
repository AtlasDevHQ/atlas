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
import { Config } from "./layers";

const ISSUE_REF = "#1978";
const RATE_LIMIT_ISSUE_REF = "#1983";
const ISSUE_REF_1988 = "#1988";

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

    if (!process.env.DATABASE_URL) {
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
 * Reads `process.env.ATLAS_RATE_LIMIT_RPM` directly rather than via
 * `getSetting()`. Two reasons: matches the env-direct pattern of
 * `InternalDbGuardLive`, and makes the operator contract crisp — the
 * env var must be set at deploy time. Post-boot writes via `setSetting`
 * are blocked by `SAAS_IMMUTABLE_KEYS` in `lib/settings.ts`, so a
 * platform admin cannot re-open the hole at runtime.
 */
export const RateLimitGuardLive: Layer.Layer<never, RateLimitRequiredError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;

    const raw = process.env.ATLAS_RATE_LIMIT_RPM;
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
): string | null {
  const envRegion = process.env.ATLAS_API_REGION;
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

    const claimedRegion = resolveClaimedRegion(config);
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
      yield* Effect.fail(
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
function isStrictPluginMode(): boolean {
  return process.env.ATLAS_STRICT_PLUGIN_SECRETS === "true";
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
export const PluginConfigGuardLive: Layer.Layer<never, PluginConfigStaleError | PluginConfigCheckFailedError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Config;

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
      if (isStrictPluginMode()) {
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
      // validation" behavior.
      return;
    }

    if (result.issues.length === 0) return;

    if (isStrictPluginMode()) {
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
