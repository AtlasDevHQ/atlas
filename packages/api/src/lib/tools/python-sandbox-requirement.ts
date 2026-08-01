/**
 * The `executePython` precondition, stated exactly once (#4940).
 *
 * `ATLAS_PYTHON_ENABLED=true` is an operator asking for a capability;
 * `ATLAS_SANDBOX_URL` is the sidecar that capability runs inside. Enabling the
 * first without the second is a misconfiguration with no safe interpretation —
 * Atlas will not register `executePython` unsandboxed, so the request cannot be
 * honoured.
 *
 * TWO seams act on that fact and they must not drift:
 *
 *   - {@link buildRegistry} (`lib/tools/registry.ts`) throws rather than
 *     registering the tool — the runtime backstop.
 *   - `PythonSandboxGuardLive` (`lib/effect/saas-guards.ts`) fails the boot
 *     Layer — the reason the backstop is now unreachable on a real deploy.
 *
 * Before the guard existed the throw was the whole contract, and every caller
 * of `buildRegistry` in the repo caught it (five sites), so a misconfigured box
 * booted green and ran indefinitely with `executePython` silently absent. The
 * guard is what makes the word "fatal" true. This module exists so the guard's
 * predicate and the builder's predicate are the SAME predicate rather than two
 * hand-written copies — the drift mode `SandboxCredsGuardLive` hit in #4838.
 *
 * Pure policy, deliberately: no runtime imports at all, so `saas-guards.ts` can
 * import it statically (like `backends/selection.ts`) without pulling the tool
 * graph into the boot Layer, and so no other test file's partial
 * `mock.module()` can erase it.
 */

/** The env var that requests the Python tool. */
export const PYTHON_ENABLED_ENV = "ATLAS_PYTHON_ENABLED";

/** The env var naming the sandbox sidecar the Python tool runs inside. */
export const PYTHON_SANDBOX_URL_ENV = "ATLAS_SANDBOX_URL";

/**
 * The subset of the environment this policy reads. Structural rather than
 * `NodeJS.ProcessEnv` so `readSaasEnv()`'s typed `SaasEnv` view satisfies it
 * too — the boot guard reads through that view (the `saas-env.ts` convention),
 * the registry builder reads `process.env` directly, and both reach the same
 * function.
 *
 * A UNION rather than one all-optional interface, and deliberately: an interface
 * whose properties are all optional is a "weak type", and TypeScript rejects
 * `process.env` against it outright (`no properties in common` — an index
 * signature declares no named property). Naming `NodeJS.ProcessEnv` as an arm
 * accepts the raw env; the explicit arm accepts `readSaasEnv()`'s `SaasEnv`,
 * whose two keys are declared required-but-possibly-`undefined`.
 */
export type PythonSandboxEnv =
  | NodeJS.ProcessEnv
  | {
      readonly ATLAS_PYTHON_ENABLED: string | undefined;
      readonly ATLAS_SANDBOX_URL: string | undefined;
    };

/**
 * Did the operator ask for the Python tool? Exact `"true"` — the same literal
 * comparison every other Atlas boolean env gate uses, so `1` / `yes` / `TRUE`
 * are all "not requested" and this function does not quietly widen that.
 */
export function isPythonToolRequested(env: PythonSandboxEnv = process.env): boolean {
  return env.ATLAS_PYTHON_ENABLED === "true";
}

/**
 * The tool was requested but cannot be isolated — the fatal misconfiguration.
 *
 * Empty-string `ATLAS_SANDBOX_URL` counts as absent (falsy), matching what the
 * sidecar client would do with it.
 */
export function isPythonSandboxMisconfigured(env: PythonSandboxEnv = process.env): boolean {
  return isPythonToolRequested(env) && !env.ATLAS_SANDBOX_URL;
}

/**
 * The operator-facing account of the misconfiguration, shared by the boot guard
 * and the registry throw so one remediation is stated once.
 *
 * Names {@link PYTHON_SANDBOX_URL_ENV} explicitly: an operator reading a boot
 * failure needs the variable to set, not a description of the invariant.
 */
export const PYTHON_SANDBOX_MISCONFIGURED_MESSAGE =
  `${PYTHON_ENABLED_ENV}=true requires ${PYTHON_SANDBOX_URL_ENV} to be set. ` +
  `The Python tool runs in the sandbox sidecar for security isolation, so Atlas will not ` +
  `register executePython without one. Set ${PYTHON_SANDBOX_URL_ENV} to the sidecar's base URL ` +
  `(see deployment docs for sidecar setup), or unset ${PYTHON_ENABLED_ENV} to run without the ` +
  `Python tool.`;
