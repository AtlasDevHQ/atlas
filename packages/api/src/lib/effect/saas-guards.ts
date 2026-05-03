/**
 * SaaS boot-guard family (#1978 + #1988).
 *
 * Extends the `DpaGuardLive` precedent (architecture-wins #45) — a
 * `Layer.effectDiscard` that throws a typed `Data.TaggedError` at boot
 * when SaaS-mode contracts are violated. Self-hosted is unaffected.
 *
 * Each guard exists because the corresponding misconfig used to silently
 * downgrade to a degraded runtime: a SaaS pod would boot, accept HTTP
 * traffic, and only surface the misconfig at first I/O (encryption),
 * first DB write (DATABASE_URL), or never (deploy-mode rejection). The
 * /prod-audit pass on 2026-05-02 turned each into a tagged error that
 * fails the boot Layer before any HTTP listener starts.
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
 *   4. {@link RegionGuardLive} (#1988 C7) — claimed `ATLAS_API_REGION`
 *      missing from `config.residency.regions` or pointing at a
 *      malformed `databaseUrl`. Without this guard, a region-routing
 *      misconfiguration silently treats every workspace request as
 *      misrouted (and in strict mode 421s legitimate traffic).
 *
 *   5. {@link PluginConfigGuardLive} (#1988 C8) — stored
 *      `workspace_plugins.config` rows are validated against each
 *      plugin's current `getConfigSchema()`. Stale configs (renamed
 *      keys, removed required fields) log warnings; with
 *      `ATLAS_STRICT_PLUGIN_SECRETS=true` they fail boot — same knob
 *      as `secrets.ts:checkStrictPluginSecrets`.
 *
 *   6. {@link MigrationGuardLive} (#1988 C9) — Drizzle migrations
 *      MUST succeed in SaaS. The legacy `MigrationLive` is non-fatal
 *      so self-hosted operators can boot a stateless instance even
 *      when the internal DB schema is partially set up. In SaaS the
 *      same condition would silently downgrade `loadSettings()` to
 *      env-var-only (the `42P01` fallback) and bypass admin overrides
 *      that boot-time guards rely on (e.g. DPA-flagged provider).
 *
 * Tagged errors are defined locally rather than added to
 * `ATLAS_ERROR_TAG_LIST`/`mapTaggedError()` — same precedent as
 * `DpaInconsistencyError`. These guards fail process boot before any
 * HTTP listener starts, so an HTTP status mapping would be misleading.
 *
 * Naming note: section dividers below use `(#1)`, `(#2 + #3)`, `(#5)` —
 * those are the issue's sub-finding numbers (#1978 enumerated findings
 * 1-6 with no #4 by the auditor's convention). They're kept verbatim
 * so cross-references back to the issue stay grep-able. Sections marked
 * `(#1988 ...)` extend the family for the prod-audit medium-severity tail.
 */

import { Data, Effect, Layer } from "effect";
import { Config } from "./layers";

const ISSUE_REF = "#1978";

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
 */
export class RegionMisconfiguredError extends Data.TaggedError("RegionMisconfiguredError")<{
  readonly message: string;
  readonly claimedRegion: string;
  readonly availableRegions: readonly string[];
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
 */
export interface PluginConfigIssue {
  readonly catalogId: string;
  readonly installationId: string;
  readonly workspaceId: string;
  readonly reason: string;
}

export class PluginConfigStaleError extends Data.TaggedError("PluginConfigStaleError")<{
  readonly message: string;
  readonly issues: readonly PluginConfigIssue[];
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
 */
export class MigrationsRequiredError extends Data.TaggedError("MigrationsRequiredError")<{
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
// ██  RegionGuardLive (#1988 C7)
// ══════════════════════════════════════════════════════════════════════

const ISSUE_REF_1988 = "#1988";

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
      yield* Effect.fail(
        new RegionMisconfiguredError({
          claimedRegion,
          availableRegions,
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
 * The validation function lives in `lib/plugins/validation.ts` so it
 * can be unit-tested in isolation (no Layer DAG, no Config Tag
 * dependency). The Layer here is a thin wrapper that:
 *   - dynamic-imports the plugin registry + InternalDB at boot time
 *     (same lazy-import pattern as `EncryptionKeyGuardLive`, keeps
 *     `saas-guards.ts` free of the plugin reachability graph)
 *   - delegates to `validateStoredPluginConfigs()` for per-row checks
 *   - decides warn-only vs fail-fast based on `isStrictPluginMode()`
 *
 * Self-hosted is unaffected when strict mode is off — a missing
 * stored config is not fatal in any deployment.
 *
 * The guard skips silently when no internal DB is configured
 * (`hasInternalDB() === false`) — that case is already covered by
 * `InternalDbGuardLive` in SaaS, and self-hosted may legitimately run
 * without persisted plugin configs.
 */
export const PluginConfigGuardLive: Layer.Layer<never, PluginConfigStaleError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Config;

    const result = yield* Effect.promise(async () => {
      const { hasInternalDB } = await import("@atlas/api/lib/db/internal");
      if (!hasInternalDB()) return { issues: [] as PluginConfigIssue[] };
      const { plugins } = await import("@atlas/api/lib/plugins/registry");
      const { validateStoredPluginConfigs } = await import(
        "@atlas/api/lib/plugins/validation"
      );
      return validateStoredPluginConfigs({ pluginRegistry: plugins });
    });

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
