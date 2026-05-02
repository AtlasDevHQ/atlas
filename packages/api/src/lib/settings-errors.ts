/**
 * Settings-domain error types.
 *
 * Lives in its own module so that tests partially-mocking
 * `@atlas/api/lib/settings` (common across admin route tests) don't
 * need a new export stub every time the settings layer adds a typed
 * error. Mock `@atlas/api/lib/settings-errors` separately when a test
 * needs the error class.
 *
 * Same pattern as `@atlas/api/lib/db/secret-encryption` keeping
 * `UnknownKeyVersionError` out of `db/internal.ts`.
 */

/**
 * Thrown by `setSetting` when an admin tries to mutate a SaaS-immutable
 * key at runtime. SaaS-immutable keys participate in boot-time guards
 * (`DpaGuardLive`, `EnterpriseGuardLive`, etc.) — hot-reloading them
 * would silently bypass the guard until next restart, exactly the
 * failure mode #1978 closed.
 *
 * Distinct error class so the route layer can map it to a 409 Conflict
 * with operator-actionable copy ("update the env var and restart").
 */
export class SaasImmutableSettingError extends Error {
  readonly _tag = "SaasImmutableSettingError" as const;
  readonly key: string;
  constructor(key: string) {
    super(
      `Setting "${key}" cannot be changed at runtime in SaaS mode — it participates ` +
        `in a boot-time contract guard. Update the env var and restart the API to apply changes.`,
    );
    this.name = "SaasImmutableSettingError";
    this.key = key;
  }
}
