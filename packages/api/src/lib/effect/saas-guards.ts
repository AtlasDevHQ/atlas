/**
 * SaaS boot-guard family (#1978, extended in #1983).
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
 *   4. {@link RateLimitGuardLive} (#1983) — `ATLAS_RATE_LIMIT_RPM`
 *      unset, empty, or `<= 0` in SaaS. `auth/middleware.ts` treats
 *      that as "rate limiting disabled" — a SaaS region without a
 *      per-user RPM ceiling is a DDoS hole. Self-hosted preserves the
 *      opt-in behavior because lightweight evaluations and trial dev
 *      loops don't need a baseline cap.
 *
 * Tagged errors are defined locally rather than added to
 * `ATLAS_ERROR_TAG_LIST`/`mapTaggedError()` — same precedent as
 * `DpaInconsistencyError`. These guards fail process boot before any
 * HTTP listener starts, so an HTTP status mapping would be misleading.
 *
 * Naming note: section dividers below use `(#1)`, `(#2 + #3)`, `(#5)` —
 * those are the issue's sub-finding numbers (#1978 enumerated findings
 * 1-6 with no #4 by the auditor's convention). They're kept verbatim
 * so cross-references back to the issue stay grep-able.
 */

import { Data, Effect, Layer } from "effect";
import { Config } from "./layers";

const ISSUE_REF = "#1978";
const RATE_LIMIT_ISSUE_REF = "#1983";

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
 * runtime path in `auth/middleware.ts` treats unset / empty / `0` /
 * non-numeric values as "rate limiting disabled" — fine for trial dev
 * loops but a DDoS hole on a hosted region. The boot guard mirrors
 * the runtime parser so a typo (`-300`, `abc`) fails boot rather than
 * silently disabling the limiter.
 */
export class RateLimitRequiredError extends Data.TaggedError("RateLimitRequiredError")<{
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
// ██  RateLimitGuardLive (#1983)
// ══════════════════════════════════════════════════════════════════════

/**
 * Fail boot in SaaS when `ATLAS_RATE_LIMIT_RPM` is unset, empty,
 * `0`, or non-numeric. Mirrors the parsing in `auth/middleware.ts:38`
 * (`Number(raw)` → `Number.isFinite && >= 0`) so the same value the
 * runtime would treat as "rate-limit disabled" is the value the boot
 * guard rejects. Self-hosted skips entirely — operators running a
 * trial / evaluation deploy can legitimately leave the limiter off.
 *
 * Reads `process.env.ATLAS_RATE_LIMIT_RPM` directly (not through the
 * settings cache) for two reasons: it matches the boot-time pattern
 * established by `InternalDbGuardLive`, and it makes the operator
 * contract clear — env var must be set at deploy time. Per-workspace
 * DB overrides via `setSetting` adjust the limit on top of the env
 * baseline; they don't replace the boot requirement.
 */
export const RateLimitGuardLive: Layer.Layer<never, RateLimitRequiredError, Config> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;

    const raw = process.env.ATLAS_RATE_LIMIT_RPM;
    if (raw === undefined || raw === "") {
      yield* Effect.fail(
        new RateLimitRequiredError({
          message:
            `SaaS region booted without ATLAS_RATE_LIMIT_RPM set — auth/middleware.ts treats unset ` +
            `as "rate limiting disabled", which leaves the region exposed to DDoS and per-user abuse. ` +
            `Set ATLAS_RATE_LIMIT_RPM to a positive integer (e.g. 300 for ~5 RPS per caller). ` +
            `See ${RATE_LIMIT_ISSUE_REF}.`,
        }),
      );
      return;
    }

    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      yield* Effect.fail(
        new RateLimitRequiredError({
          message:
            `SaaS region booted with ATLAS_RATE_LIMIT_RPM=${JSON.stringify(raw)} — value is ` +
            `${Number.isFinite(n) ? "non-positive" : "non-numeric"} and would parse to "rate limiting disabled" ` +
            `at runtime (auth/middleware.ts:38). Set ATLAS_RATE_LIMIT_RPM to a positive integer. ` +
            `See ${RATE_LIMIT_ISSUE_REF}.`,
        }),
      );
    }
  }),
);

// Note: `warnIfDeployModeSilentlyDowngraded()` previously lived here.
// It was inlined into `lib/config.ts` because importing the helper
// from this module forced `layers.ts` (and its dynamic
// `@atlas/api/lib/telemetry` import) into the static reachability
// graph of every `config.ts` consumer. Next.js App Router tracing
// then failed the `create-atlas` standalone scaffold build trying to
// resolve `@opentelemetry/sdk-node`. Keeping the boot-time guards
// here and the config-file warning in `config.ts` walls the
// boot-only modules off from request-path consumers.
