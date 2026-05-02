/**
 * Settings-domain error types.
 *
 * Lives in its own module so that tests partially-mocking
 * `@atlas/api/lib/settings` (common across admin route tests) don't
 * need a new export stub every time the settings layer adds a typed
 * error. Mock `@atlas/api/lib/settings-errors` separately when a test
 * needs the error class.
 *
 * Similar motivation to keeping `UnknownKeyVersionError` in
 * `db/secret-encryption.ts` rather than `db/internal.ts` — partial-mock
 * sites of the consuming module don't need a stub for every new typed
 * error. The structural fact shared with that precedent is "the error
 * lives in a module distinct from the one most likely to be partially
 * mocked," even though `secret-encryption.ts` is co-located with the
 * encrypt/decrypt helpers rather than being an errors-only module.
 */

import type { SaasImmutableKey } from "./settings";

/**
 * Thrown by `setSetting` when an admin tries to mutate a SaaS-immutable
 * key at runtime. SaaS-immutable keys participate in boot-time guards
 * (`DpaGuardLive`, `EnterpriseGuardLive`, etc.) — hot-reloading them
 * would silently bypass the guard until next restart, exactly the
 * failure mode #1978 closed.
 *
 * `key` is narrowed to `SaasImmutableKey` (the closed union derived
 * from `SAAS_IMMUTABLE_KEYS_LITERAL`). A typo in a future caller
 * fails compilation rather than producing a runtime-only oddity.
 *
 * Distinct error class so the route layer can map it to a 409 Conflict
 * with operator-actionable copy ("update the env var and restart").
 */
export class SaasImmutableSettingError extends Error {
  readonly _tag = "SaasImmutableSettingError" as const;
  readonly key: SaasImmutableKey;
  constructor(key: SaasImmutableKey) {
    super(
      `Setting "${key}" cannot be changed at runtime in SaaS mode — it participates ` +
        `in a boot-time contract guard. Update the env var and restart the API to apply changes.`,
    );
    this.name = "SaasImmutableSettingError";
    this.key = key;
  }
}
