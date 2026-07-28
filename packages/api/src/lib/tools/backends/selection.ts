/**
 * Sandbox backend selection — the ONE priority policy shared by the explore and
 * Python tools.
 *
 * Before #4187 the priority "dance" was hand-rolled at ~5 sites and the two
 * tools had diverged: explore ranked `vercel > nsjail-explicit > sidecar >
 * nsjail-auto` (and honored `sandbox.priority` / `ATLAS_SANDBOX_PRIORITY` /
 * sandbox plugins), while Python ranked `sidecar > vercel > nsjail` and ignored
 * the operator's priority override entirely — a latent posture bug given SaaS
 * pins `sandbox.priority: ["vercel-sandbox"]` (deny-all, no fallback).
 *
 * This module makes the decision a PURE function of an environment snapshot:
 *   {@link planSandboxSelection} turns an immutable {@link SandboxSelectionEnv}
 *   into an ordered {@link SandboxPlan}, and {@link runSandboxPlan} walks that
 *   plan with a tool-specific construction callback. Both tools feed the SAME
 *   planner, so they resolve the SAME backend for the same env/config, and the
 *   policy is unit-testable without cache-busting a stateful tool module.
 *
 * The planner covers only the env/config-driven chain. The plugin front-of-line
 * (explore's `wireSandboxPlugins`) and the per-workspace BYOC override sit
 * ahead of it in each tool and are attempted before this plan is built.
 */

import type { SandboxBackendName } from "@atlas/api/lib/config";

/**
 * Immutable snapshot of the environment + config inputs that decide which
 * sandbox backend is used. Captured once by the caller so {@link
 * planSandboxSelection} is pure — no live `process.env` / config reads happen
 * inside the policy, which is what makes it testable without import-cache
 * busting.
 */
export interface SandboxSelectionEnv {
  /** `process.env.ATLAS_SANDBOX` — `"nsjail"` pins nsjail as the explicit (hard-fail) backend. */
  readonly atlasSandbox: string | undefined;
  /** Vercel Sandbox usable this process (`useVercelSandbox()`). */
  readonly vercelAvailable: boolean;
  /** Sidecar configured (`useSidecar()` — `ATLAS_SANDBOX_URL` set). */
  readonly sidecarAvailable: boolean;
  /**
   * nsjail binary detected on this host (auto-detect). Producers may feed a
   * pin-inclusive value (explore's `useNsjail()` returns true for the explicit
   * pin OR a detected binary); the planner only consults this field on the
   * auto-detect branch (`atlasSandbox !== "nsjail"`), where it is exactly binary
   * detection, so the pin-inclusive and pure-detection producers agree there.
   */
  readonly nsjailAvailable: boolean;
  /**
   * nsjail permanently marked failed this process (exit 109 / hard init
   * failure). This is a RUNTIME-DEGRADATION signal only — "do not retry this
   * backend" — and the planner consults it exclusively on the SOFT auto-detect
   * branch, where skipping a known-broken backend is the whole point.
   *
   * It deliberately does NOT reach the explicit-pin branch. Letting it delete
   * the pin's hard-fail step made a failed nsjail read as permission to run
   * unsandboxed: `ATLAS_SANDBOX=nsjail` degraded silently to just-bash the
   * moment the boot capability probe failed (#4829). A backend that broke is
   * never a reason to weaken the operator's posture.
   */
  readonly nsjailFailed: boolean;
  /**
   * Operator-configured backend priority. Sourced from `getConfig().sandbox
   * .priority`, which `config.ts` also populates from `ATLAS_SANDBOX_PRIORITY`,
   * so honoring this field honors BOTH the config-file and env-var overrides.
   */
  readonly configPriority: readonly SandboxBackendName[] | undefined;
}

/** A single backend to attempt, in order. */
export interface SandboxStep {
  readonly kind: SandboxBackendName;
  /**
   * When true, a construction failure at this step must fail the whole tool
   * (never fall through to a weaker backend). Set for the explicit-nsjail step:
   * `ATLAS_SANDBOX=nsjail` is hard-fail by contract.
   */
  readonly hardFail: boolean;
}

/**
 * Discriminated on `source` so illegal states are unrepresentable: only the
 * config-priority arm carries `configPriority` (non-optional there) and only it
 * can have `onExhausted: "fail-closed"` (the SaaS deny-all pin without
 * `just-bash`).
 *
 * `onExhausted` is not the whole story about refusal, though. A `default-chain`
 * plan carries `onExhausted: "just-bash"` and still RESOLVES fail-closed when it
 * contains an unavailable hard-fail step (the `ATLAS_SANDBOX=nsjail` pin), which
 * short-circuits before exhaustion is ever reached. Two independent channels
 * lead to a refusal; `resolveSandboxBackend` is where they are combined, and it
 * is the function to consult rather than this field.
 */
export type SandboxPlan =
  | {
      readonly source: "config-priority";
      readonly steps: readonly SandboxStep[];
      /**
       * `"just-bash"` when the operator kept it in the list (degrade allowed);
       * `"fail-closed"` when they omitted it (throw a config error).
       */
      readonly onExhausted: "just-bash" | "fail-closed";
      readonly configPriority: readonly SandboxBackendName[];
    }
  | {
      readonly source: "default-chain";
      readonly steps: readonly SandboxStep[];
      /** The default chain always degrades to the unsandboxed fallback on exhaustion. */
      readonly onExhausted: "just-bash";
    };

/**
 * Turn an env snapshot into an ordered backend plan. Pure — the single
 * statement of the priority policy for both tools.
 *
 * Operator-configured priority (`sandbox.priority` / `ATLAS_SANDBOX_PRIORITY`)
 * takes precedence over the built-in chain. Absent that, the default chain is
 * `Vercel > nsjail-explicit > sidecar > nsjail-auto > just-bash`, matching the
 * documented order in CLAUDE.md.
 */
export function planSandboxSelection(env: SandboxSelectionEnv): SandboxPlan {
  // Operator-configured priority wins (config file or ATLAS_SANDBOX_PRIORITY).
  const configPriority = env.configPriority;
  if (configPriority && configPriority.length > 0) {
    return {
      source: "config-priority",
      steps: configPriority.map((kind) => ({ kind, hardFail: false })),
      // just-bash in the list ⇒ an unsandboxed fallback is allowed; omit it and
      // the pin fails closed (the SaaS deny-all posture).
      onExhausted: configPriority.includes("just-bash") ? "just-bash" : "fail-closed",
      configPriority,
    };
  }

  // Default chain.
  const steps: SandboxStep[] = [];

  // Vercel Sandbox is highest priority — a soft step (init failure falls
  // through to the next backend, unless a single-backend config pin says
  // otherwise, which is the config-priority path above).
  if (env.vercelAvailable) {
    steps.push({ kind: "vercel-sandbox", hardFail: false });
  }

  if (env.atlasSandbox === "nsjail") {
    // Explicit nsjail is hard-fail by contract; nothing after it is reachable.
    // (Vercel still precedes it: an operator on Vercel with ATLAS_SANDBOX=nsjail
    // gets Vercel first, matching the long-standing explore behavior.)
    //
    // `nsjailFailed` is NOT consulted here (#4829). The step stands whether or
    // not nsjail is currently usable: an unusable pinned backend must make the
    // tool REFUSE, and a step that is present-but-unconstructible is exactly how
    // that refusal is expressed (`runSandboxPlan` short-circuits to
    // `"hard-fail"`, `resolveSandboxBackend` reports `"fail-closed"`). Gating it
    // on the flag deleted the step instead, which turned a broken sandbox into
    // an unsandboxed one.
    steps.push({ kind: "nsjail", hardFail: true });
  } else {
    // Sidecar takes priority over nsjail auto-detection (Railway sets
    // ATLAS_SANDBOX_URL), then nsjail auto-detect on PATH.
    if (env.sidecarAvailable) {
      steps.push({ kind: "sidecar", hardFail: false });
    }
    if (env.nsjailAvailable && !env.nsjailFailed) {
      steps.push({ kind: "nsjail", hardFail: false });
    }
  }

  return { source: "default-chain", steps, onExhausted: "just-bash" };
}

/**
 * What a status surface should report for a plan.
 *
 * `"fail-closed"` is NOT a backend — it means no backend will construct and the
 * tool refuses every request. It is a distinct member rather than a collapse
 * into `"just-bash"` precisely because those two states are opposites: one runs
 * agent shell on the host with no isolation, the other runs nothing at all.
 * Reporting the second as the first told operators their deployment was
 * unsandboxed-but-working when it was fail-closed-and-broken (#4828).
 */
export type SandboxResolution = SandboxBackendName | "fail-closed";

/**
 * The backend a health/status reporter should name for this plan, resolved
 * WITHOUT constructing anything (reporting must have no side effects, which is
 * why this is separate from {@link runSandboxPlan}).
 *
 * The WALK mirrors `runSandboxPlan`'s, and that correspondence is the contract
 * that keeps boot, `/api/health`, and the request path from disagreeing about
 * the same inputs (the #4824 invariant):
 *
 * - first available step wins, same as the first step that constructs;
 * - an UNAVAILABLE hard-fail step short-circuits, same as `runSandboxPlan`
 *   returning `"hard-fail"` there. Nothing after it is reachable, so naming a
 *   later backend would describe a fall-through that cannot happen;
 * - exhaustion defers to `plan.onExhausted`, so a fail-closed pin reports
 *   `"fail-closed"` and only a genuinely degrading plan reports `"just-bash"`.
 *
 * Total by construction: every plan maps to a backend or to `"fail-closed"`, so
 * callers have no `?? "just-bash"` fallback to get wrong.
 *
 * The walks agree only for the SAME predicate. In production they are fed
 * different ones — reporting passes availability (`isBackendAvailable`), the
 * runner passes constructibility (`tryCreateBackend`) — and availability is an
 * upper bound on constructibility. So `"fail-closed"` is a LOWER bound on
 * brokenness: this can still name a backend that then fails to construct.
 *
 * How TIGHT that bound is, is a property of the availability predicate, and
 * #4834 tightened it. The predicate used to answer a different question for
 * nsjail — "is nsjail pinned or detected?" rather than "would nsjail build?" —
 * so the bare `ATLAS_SANDBOX=nsjail` pin reported available on a host with no
 * binary, and this function named `"nsjail"` for deployments that refused every
 * request. `isBackendAvailable` now probes the binary, so intent can no longer
 * masquerade as capability.
 *
 * What remains is the irreducible part: availability is a cheap CHECK and
 * construction is the real thing, so a present-but-broken backend (an nsjail
 * binary the kernel won't let create namespaces, before the probe has run) is
 * still reported available. That residue is why this stays documented as a
 * bound rather than an equality — and why a future backend whose availability
 * check drifts further from its construction cost would widen it again.
 */
export function resolveSandboxBackend(
  plan: SandboxPlan,
  isAvailable: (kind: SandboxBackendName) => boolean,
): SandboxResolution {
  for (const step of plan.steps) {
    if (isAvailable(step.kind)) return step.kind;
    if (step.hardFail) return "fail-closed";
  }
  return plan.onExhausted === "fail-closed" ? "fail-closed" : "just-bash";
}

/** A backend that could not be constructed, with a sanitized operator-facing reason. */
export interface BackendInitFailure {
  readonly name: SandboxBackendName;
  readonly reason: string;
}

/** Result of attempting one plan step's tool-specific construction. */
export type StepAttempt<T> = { readonly backend: T } | { readonly failure: BackendInitFailure };

/**
 * The outcome of walking a plan. The runner never constructs the `just-bash`
 * fallback or formats error messages itself — that stays tool-specific (explore
 * builds a bash backend; Python refuses). The runner owns only the shared WALK
 * semantics (soft fall-through, hard-fail short-circuit, exhaustion), so both
 * tools enforce one policy.
 */
export type SandboxPlanOutcome<T> =
  /** A step constructed a backend. */
  | { readonly kind: "backend"; readonly backend: T; readonly selected: SandboxBackendName }
  /** A hard-fail step (explicit nsjail) failed to construct — do not fall through. */
  | { readonly kind: "hard-fail"; readonly step: SandboxStep; readonly reason: string; readonly failures: readonly BackendInitFailure[] }
  /** Config-priority exhausted with no `just-bash` in the list — fail closed. */
  | { readonly kind: "fail-closed"; readonly failures: readonly BackendInitFailure[] }
  /** Every step exhausted and `onExhausted === "just-bash"` — caller degrades (explore) or refuses (Python). */
  | { readonly kind: "exhausted"; readonly failures: readonly BackendInitFailure[] };

/**
 * Walk a plan, attempting each step's tool-specific construction in order.
 *
 * A `tryStep` returning `{ failure }` (or throwing) falls through to the next
 * step, except at a hard-fail step where it short-circuits to `"hard-fail"`.
 * When the steps are exhausted, the outcome reflects `plan.onExhausted`. The
 * caller maps the outcome to a backend / degraded fallback / error message.
 *
 * `onStepError` is invoked when a step *throws* (as opposed to returning a
 * `{ failure }`): a throw is unexpected (a module-load or construction bug), so
 * the caller logs it rather than letting exhaustion silently erase the reason.
 * Returned `{ failure }` values are anticipated and logged by the caller's own
 * `tryStep`; they are surfaced to the caller via the outcome's `failures[]`.
 */
export async function runSandboxPlan<T>(
  plan: SandboxPlan,
  tryStep: (step: SandboxStep) => Promise<StepAttempt<T>>,
  onStepError?: (step: SandboxStep, reason: string) => void,
): Promise<SandboxPlanOutcome<T>> {
  const failures: BackendInitFailure[] = [];

  for (const step of plan.steps) {
    let attempt: StepAttempt<T>;
    try {
      attempt = await tryStep(step);
    } catch (err) {
      // A thrown error from a soft step is treated as that step's failure and
      // falls through; a hard-fail step surfaces it below. Surface the throw to
      // the caller's logger — it is unexpected and would otherwise vanish.
      const reason = err instanceof Error ? err.message : String(err);
      onStepError?.(step, reason);
      attempt = { failure: { name: step.kind, reason } };
    }

    if ("backend" in attempt) {
      return { kind: "backend", backend: attempt.backend, selected: step.kind };
    }

    failures.push(attempt.failure);
    if (step.hardFail) {
      return { kind: "hard-fail", step, reason: attempt.failure.reason, failures };
    }
  }

  return plan.onExhausted === "fail-closed"
    ? { kind: "fail-closed", failures }
    : { kind: "exhausted", failures };
}

/**
 * Exhaustiveness guard for the `SandboxPlanOutcome` switches in both tools.
 * Pins the "every outcome is handled" contract at the switch (a new outcome
 * member becomes a compile error at the `default` case) rather than relying
 * solely on each function's return-type annotation.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled sandbox selection outcome: ${JSON.stringify(value)}`);
}

/**
 * Operator-facing message for a `config-priority` plan that failed closed (all
 * pinned backends failed and `just-bash` was not in the list — the SaaS
 * deny-all posture). Shared by explore and Python so the guidance can't drift.
 */
export function formatSandboxPriorityFailure(
  priority: readonly SandboxBackendName[],
  failures: readonly BackendInitFailure[],
  deployMode: "saas" | "self-hosted" | undefined,
): string {
  const summary =
    failures.length > 0
      ? ` Failed backends: ${failures.map((f) => `${f.name}: ${f.reason}`).join("; ")}.`
      : "";
  const guidance = [
    ...credentialGuidance(priority),
    ...(deployMode !== "saas"
      ? ["Add 'just-bash' to the priority list if you want an unsandboxed fallback."]
      : []),
    "Fix the backend configuration.",
  ];

  return `All backends in sandbox.priority (${priority.join(", ")}) failed to initialize.${summary} ${guidance.join(" ")}`;
}

/**
 * Per-backend remediation naming the credential each one actually needs.
 *
 * Scoped to the backends in play, which is the point: under a
 * `priority: ["vercel-sandbox"]` pin the generic "install nsjail or configure
 * ATLAS_SANDBOX_URL" advice is not merely unhelpful, it is impossible to act on
 * — the pin excludes both, so an operator who follows it changes nothing while
 * the real cause (a missing `VERCEL_TOKEN`) goes unnamed (#4828).
 */
function credentialGuidance(backends: readonly SandboxBackendName[]): string[] {
  const guidance: string[] = [];
  if (backends.includes("vercel-sandbox")) {
    guidance.push(
      "For Vercel Sandbox off-Vercel, set VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and VERCEL_TOKEN.",
    );
  }
  if (backends.includes("sidecar")) {
    guidance.push("For sidecar, set ATLAS_SANDBOX_URL.");
  }
  if (backends.includes("nsjail")) {
    // Deliberately names BOTH failure modes. The #4829 scenario is a host where
    // the binary IS installed and the kernel denies CLONE_NEWUSER, so
    // "install the binary" alone is advice the operator has already followed.
    // The probe's specific error is in the startup warnings.
    guidance.push(
      "For nsjail, install the binary or set ATLAS_NSJAIL_PATH, and confirm the platform " +
        "permits user namespaces (the boot probe's specific error is in the startup warnings).",
    );
  }
  return guidance;
}

/**
 * Operator-facing explanation of a plan that {@link resolveSandboxBackend}
 * reports as `"fail-closed"` — every request to the tool will be refused.
 *
 * Reports availability rather than construction failure because the caller is a
 * REPORTING surface: it never constructed anything, so it must not claim
 * backends "failed to initialize". The distinction matters to the operator —
 * "never configured" and "configured but broken" have different fixes.
 *
 * Takes no availability predicate: given the documented precondition, every step
 * the resolver CONSIDERED is by definition unavailable (an available one would
 * have been returned instead), up to and including the hard-fail step that
 * short-circuited the walk. Deriving that from the plan also keeps the guidance
 * side-effect-free and gives the caller no predicate to pass wrongly.
 *
 * Precondition: `resolveSandboxBackend(plan, …)` returned `"fail-closed"`. Not
 * checkable here without the predicate this deliberately does not take, so it is
 * enforced by having exactly one caller, immediately after that check.
 */
export function formatSandboxFailClosed(
  plan: SandboxPlan,
  env: SandboxSelectionEnv,
  deployMode: "saas" | "self-hosted" | undefined,
): string {
  // Backends that sit AHEAD of this plan and are invisible to the planner, so a
  // flat "every request is refused" would be a false alarm for a deployment that
  // actually works through one of them.
  //
  // The two are gated differently and the caveat must not overstate either. The
  // per-workspace BYOC override (explore's priority -1) always applies. Operator
  // sandbox PLUGINS are skipped outright when `ATLAS_SANDBOX=nsjail` — explore
  // gates its plugin front-of-line on that env var precisely because the pin
  // means "nsjail only" — so on the pin the plugin half is guaranteed false, and
  // saying it would invite an operator to dismiss a real total outage as
  // "probably my plugin". Sandbox plugins are also explore-only; python has no
  // plugin front-of-line at all.
  const pinnedNsjail = env.atlasSandbox === "nsjail";
  const aheadCaveat = pinnedNsjail
    ? " A per-workspace BYOC backend, if configured, still takes priority and is not visible " +
      "to this check; operator sandbox plugins are skipped entirely under the pin."
    : " If a sandbox plugin (explore only) or a workspace BYOC backend is configured it takes " +
      "priority and is not visible to this check until the first explore request.";

  if (plan.source === "config-priority") {
    // No hard-fail step exists on this arm (config steps are all soft), so every
    // step was walked and every one was unavailable.
    const unavailable = plan.steps.map((s) => s.kind);
    const guidance = credentialGuidance(unavailable);
    if (deployMode !== "saas") {
      guidance.push("Add 'just-bash' to sandbox.priority if you want an unsandboxed fallback.");
    }
    return (
      `Explore tool: UNAVAILABLE — every backend in sandbox.priority ` +
      `(${plan.configPriority.join(", ")}) is unavailable and the pin has no 'just-bash' ` +
      `fallback, so the tool fails closed and refuses every request. ` +
      `Unavailable: ${unavailable.join(", ")}. ${guidance.join(" ")}` +
      aheadCaveat
    );
  }

  // Default chain — the only route to fail-closed here is an unavailable
  // hard-fail step. Read the backend off the STEP rather than assuming nsjail:
  // that is true today (nsjail is the only `hardFail: true` step) but a second
  // one would otherwise make this message silently lie.
  const hardFailStep = plan.steps.find((s) => s.hardFail);
  if (!hardFailStep) {
    // Precondition violated — a degradable default chain was passed here. Refuse
    // to invent a pin rather than defaulting to "nsjail": fabricating
    // `ATLAS_SANDBOX=nsjail is pinned` is precisely the silent lie the
    // read-it-off-the-step change above exists to prevent.
    return (
      "Explore tool: UNAVAILABLE — no sandbox backend is available and the plan cannot " +
      "degrade, so every explore request is refused. No pinned backend could be identified; " +
      "check ATLAS_SANDBOX and sandbox.priority in atlas.config.ts." +
      aheadCaveat
    );
  }
  const pinned = hardFailStep.kind;
  // Guidance is scoped to the pinned backend alone. The earlier soft steps are
  // unavailable too, but naming their credentials here would splice, say, Vercel
  // advice into an nsjail-pin message — the same unactionable-advice failure
  // #4828 is about, at a different site.
  const guidance = credentialGuidance([pinned]);
  return (
    `Explore tool: UNAVAILABLE — ATLAS_SANDBOX=${pinned} is pinned but ${pinned} is not usable ` +
    `on this host, so the tool fails closed and refuses every request (the pin is hard-fail ` +
    `by contract — it does not degrade to an unsandboxed backend). ` +
    `${guidance.join(" ")} ` +
    `Or unset ATLAS_SANDBOX to allow the normal fallback chain.` +
    aheadCaveat
  );
}

/** Isolation posture of a sandbox backend. */
export type SandboxIsolationPosture = "isolated" | "unsandboxed" | "plugin-declared";

/**
 * Isolation posture of each backend, so operator-facing surfaces don't have to
 * re-derive "does this one actually isolate?" from a string equality check.
 *
 * `satisfies Record<…>` is the point: adding a backend to
 * `SANDBOX_BACKEND_NAMES` without classifying it HERE is a compile error, so a
 * new unsandboxed backend cannot slip in unclassified — the fail-open shape
 * that let the #4824 boot dispatch assert the wrong isolation posture. Callers
 * must still route through this table rather than string-comparing; nothing
 * lints for that. The three that do: `health.ts` (twice) and `startup.ts`.
 *
 * `plugin` is `plugin-declared`: the plugin supplies its own security metadata
 * (surfaced by `logSandboxPlugins()`), and `/api/health` reports
 * `isolationVerified: false` for it because Atlas has not verified that claim.
 * This table must not claim isolation on the plugin's behalf.
 *
 * Both current consumers collapse `plugin-declared` to "not unsandboxed"; the
 * separate value exists so a future surface can distinguish verified from
 * declared isolation without re-deriving it.
 *
 * Lives here rather than beside `ExploreBackendType` in `lib/tools/explore.ts`
 * deliberately: explore is partially mocked in 40+ test files, so a new VALUE
 * export there is `undefined` for any production importer running under those
 * mocks (`health.ts` imports this table statically). This module is pure policy
 * and is mocked nowhere.
 */
export const BACKEND_ISOLATION = {
  "vercel-sandbox": "isolated",
  nsjail: "isolated",
  sidecar: "isolated",
  "just-bash": "unsandboxed",
  plugin: "plugin-declared",
} as const satisfies Record<SandboxBackendName | "plugin", SandboxIsolationPosture>;

/** The inputs {@link formatSandboxFailClosed} needs, gathered by the caller. */
export interface SandboxFailClosedInputs {
  readonly plan: SandboxPlan;
  readonly env: SandboxSelectionEnv;
  readonly deployMode: "saas" | "self-hosted" | undefined;
}

/**
 * {@link formatSandboxFailClosed}, plus the degraded message for when the inputs
 * cannot be gathered OR the formatter itself throws — the one place both
 * fail-closed reporters get their prose.
 *
 * Two surfaces must say the same thing about the same outage: the boot warning
 * (`startup.ts`) and `/admin/sandbox` (`admin-sandbox.ts`). They reach it by
 * different routes — boot resolves the backend during `validateEnvironment()`,
 * the admin route on each request — so "share the formatter" was not enough:
 * each also needed the fallback for a formatter that throws, and two hand-rolled
 * fallbacks are two messages that drift. #4837 made that concrete by adding the
 * second caller. `/api/health` is deliberately NOT a third caller: it reports the
 * same fail-closed STATE from the same resolver but keeps its own, more hedged
 * message (`health.ts`) and no remediation at all.
 *
 * The fallback is deliberately NOT the generic "install nsjail or configure
 * ATLAS_SANDBOX_URL" advice. Under the SaaS `priority: ["vercel-sandbox"]` pin
 * that advice is impossible to act on — the pin excludes both — so it would hide
 * the real cause the same way #4828 did. Naming the two knobs that actually
 * decide the plan is the honest degradation.
 *
 * Losing the remediation must never downgrade the reported STATE: the caller
 * already knows the resolution is `"fail-closed"`, and this returns a
 * fail-closed message either way.
 *
 * `failureDetail` is set only on the degraded arm and is **log-only** — it is
 * deliberately NOT interpolated into `message`. `message` reaches an admin HTTP
 * response body via `failClosed.remediation`, and reaches the UNAUTHENTICATED
 * `/api/health` through `startup.ts`'s `_startupWarnings`. A caught error's text
 * is arbitrary (module-resolution paths, config fragments, third-party client
 * errors echoing URLs or tokens), so putting it there would ship exactly the
 * "no stack traces / secrets to the user" hazard CLAUDE.md forbids. The caller
 * logs it instead; nothing is swallowed.
 *
 * **Never rejects.** `admin-sandbox.ts` calls this under `Effect.promise`, where
 * a rejection becomes a defect — a 500 on the very page an operator opened to
 * diagnose the outage. Both arms return, and the catch arm stays total (no
 * `await`, no logging, no imported helper) so it cannot itself throw. Keep it
 * that way if you touch this.
 *
 * `resolveInputs` is a thunk rather than three parameters because gathering the
 * inputs is itself what can throw. `admin-sandbox.ts` reaches
 * `lib/tools/explore` through a dynamic `import()` inside the thunk — the shared
 * test factory `packages/api/src/__mocks__/api-test-mocks.ts` partially mocks
 * that module for every test built on `createApiTestMocks`, so a STATIC import
 * of a rarely-used export there is a module LINK error in all of them, whether
 * or not they ever run this branch. (`startup.ts` differs: it imports explore in
 * its own outer try, where an import failure legitimately means "posture
 * unknown", and defers only the config read into the thunk.) Either way the
 * throw lands in this `try` and still produces a fail-closed message.
 *
 * Precondition (inherited from {@link formatSandboxFailClosed}): the caller has
 * already resolved `"fail-closed"`.
 */
export async function describeSandboxFailClosed(
  resolveInputs: () => SandboxFailClosedInputs | PromiseLike<SandboxFailClosedInputs>,
): Promise<{ readonly message: string; readonly failureDetail?: string }> {
  try {
    const { plan, env, deployMode } = await resolveInputs();
    return { message: formatSandboxFailClosed(plan, env, deployMode) };
  } catch (err) {
    return {
      message:
        "Explore tool: UNAVAILABLE — no sandbox backend will construct, so every explore " +
        "request is refused. Detailed remediation could not be built — see the server log " +
        "for the cause. Check ATLAS_SANDBOX and sandbox.priority in atlas.config.ts.",
      // Inlined rather than routed through `errorMessage` so this catch stays
      // total (see "Never rejects" above): `lib/audit/error-scrub` is itself
      // partially `mock.module()`d in 8 test files, and a mock that omitted the
      // export would make the error path itself throw.
      //
      // This value is therefore RAW — unscrubbed and untruncated. Both callers
      // run it through `errorMessage` at their `log` call before it goes
      // anywhere, which is where scrubbing belongs anyway: the hazard
      // `error-scrub` exists for (a pg/better-auth error echoing a connection
      // string) lands in a log field, not here.
      failureDetail: describeThrown(err),
    };
  }
}

/**
 * `err.message` / `String(err)` for the one caller that cannot afford either to
 * throw: {@link describeSandboxFailClosed}'s catch arm, which is contracted
 * never to reject.
 *
 * Both of those CAN throw — a throwing `message` getter, or a `String()` on a
 * null-prototype object or a hostile `Symbol.toPrimitive`. Vanishingly unlikely
 * from that call site's inputs, but "vanishingly unlikely" is not the contract:
 * `admin-sandbox.ts` runs the caller under `Effect.promise`, where a rejection
 * becomes a defect and 500s the page an operator opened to diagnose the outage.
 * The inner catch buys totality for two lines and no imports.
 *
 * Returns RAW text — callers scrub at their `log` site (see the caller's doc).
 */
function describeThrown(err: unknown): string {
  try {
    // @atlas-ok-ternary: raw by design; the caller's log sites apply errorMessage
    return err instanceof Error ? err.message : String(err);
  } catch {
    // intentionally ignored: the thrown value is unrepresentable as a string,
    // and the whole point here is that this path cannot itself throw.
    return "<unrepresentable thrown value>";
  }
}
