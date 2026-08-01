/**
 * The `executePython` REGISTRATION precondition, stated exactly once (#4940).
 *
 * `ATLAS_PYTHON_ENABLED=true` is an operator asking for a capability.
 * `buildRegistry` (`lib/tools/registry.ts`) will not register `executePython`
 * unless `ATLAS_SANDBOX_URL` is also set, and throws instead. So the pair is a
 * contract, and this module is the one place that states it.
 *
 * TWO seams act on that fact and they must not drift:
 *
 *   - `buildRegistry` throws rather than registering the tool — the runtime
 *     backstop.
 *   - `PythonSandboxGuardLive` (`lib/effect/saas-guards.ts`) fails the boot
 *     Layer — the reason the backstop is now unreachable in the api server.
 *
 * Before the guard existed the throw was the whole contract, and every caller of
 * `buildRegistry` in the repo caught it (five sites), so a misconfigured box
 * booted green and ran indefinitely with `executePython` silently absent. The
 * guard is what makes the word "fatal" true. This module exists so the guard's
 * predicate and the builder's predicate are the SAME predicate rather than two
 * hand-written copies — the drift mode `SandboxCredsGuardLive` hit in #4838.
 *
 * WHAT THIS IS NOT: an isolation check. `ATLAS_SANDBOX_URL` gates only the
 * `sidecar` step of `planSandboxSelection`; `lib/tools/python.ts` can also run
 * Python under `vercel-sandbox` or `nsjail`, and a box with either is properly
 * isolated. `buildRegistry`'s gate is nonetheless sidecar-only (pre-existing,
 * predating this module), which means `executePython` is absent on a
 * vercel-sandbox or nsjail deploy regardless. This module deliberately encodes
 * the REGISTRATION rule as it actually is, not the isolation rule it is
 * sometimes mistaken for — an operator on such a deploy really does not get the
 * tool, so failing boot on it is truthful. Widening this to the real selection
 * chain means widening `buildRegistry` too, which would newly register the tool
 * on deploys that do not have it today: a product change, not a fix. Change both
 * or neither.
 *
 * ENV-ONLY, also deliberately. `ATLAS_SANDBOX_URL` is additionally a
 * workspace-scoped runtime setting (`lib/settings.ts`), writable from the
 * self-hosted `/admin/sandbox` view, but `python.ts`'s sidecar step reads
 * `process.env` directly — so a DB-stored value does not make the tool work, and
 * must not satisfy the boot contract either.
 *
 * Pure policy: no runtime imports at all, so `saas-guards.ts` can import it
 * statically (like `backends/selection.ts`) without pulling the tool graph into
 * the boot Layer, and so no other test file's partial `mock.module()` can erase
 * it.
 */

/** The env var that requests the Python tool. */
export const PYTHON_ENABLED_ENV = "ATLAS_PYTHON_ENABLED";

/** The env var naming the sandbox sidecar the Python tool is registered against. */
export const PYTHON_SANDBOX_URL_ENV = "ATLAS_SANDBOX_URL";

/**
 * The subset of the environment this policy reads. It admits `process.env` and
 * `readSaasEnv()`'s typed `SaasEnv` view — the boot guard reads through that
 * view (the `saas-env.ts` convention), the registry builder reads `process.env`
 * directly, and both reach the same function.
 *
 * A UNION rather than one all-optional interface, for a reason specific to this
 * repo: an interface whose properties are all optional is a "weak type", and
 * TypeScript rejects a source with no declared property in common. `@types/node`
 * would be exempt (its `ProcessEnv` has a plain string index signature), but the
 * api package compiles with `types: ["bun", "node"]` and bun's `ProcessEnv` is
 * not — verified, the all-optional form fails here with TS2559. Naming
 * `NodeJS.ProcessEnv` as an arm is what accepts the raw env.
 *
 * The cost, accepted: because one arm admits any index-signature object, an
 * object LITERAL with a misspelled key type-checks instead of tripping the
 * excess-property check. Nothing in the repo passes a literal — both real
 * callers pass `process.env` or `readSaasEnv()` — and the anti-drift sweep in
 * `saas-guards.test.ts` is what actually pins the two seams together.
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
 * The tool was requested but will not be registered — the fatal misconfiguration.
 *
 * Empty-string `ATLAS_SANDBOX_URL` counts as absent (falsy), matching what
 * `python.ts`'s sidecar step does with it.
 */
export function isPythonSandboxMisconfigured(env: PythonSandboxEnv = process.env): boolean {
  return isPythonToolRequested(env) && !env.ATLAS_SANDBOX_URL;
}

/**
 * The operator-facing account of the misconfiguration, shared by the boot guard
 * and the registry throw so one remediation is stated once.
 *
 * Names {@link PYTHON_SANDBOX_URL_ENV} explicitly: an operator reading a boot
 * failure needs the variable to set, not a description of the invariant. Says
 * "env var" outright because the same name exists as a runtime setting that will
 * not satisfy this check.
 */
export const PYTHON_SANDBOX_MISCONFIGURED_MESSAGE =
  `${PYTHON_ENABLED_ENV}=true requires the ${PYTHON_SANDBOX_URL_ENV} environment variable to be ` +
  `set. Atlas registers executePython only against the sandbox sidecar, so without it the tool is ` +
  `absent however the rest of the sandbox is configured — a Vercel-sandbox or nsjail deploy is not ` +
  `enough, and neither is the workspace ATLAS_SANDBOX_URL setting stored in the database. Set the ` +
  `${PYTHON_SANDBOX_URL_ENV} env var to the sidecar's base URL (see deployment docs for sidecar ` +
  `setup), or unset ${PYTHON_ENABLED_ENV} to run without the Python tool.`;
