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
  /** nsjail permanently marked failed this process (exit 109 / hard init failure). */
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
 * can be `"fail-closed"` (the SaaS deny-all pin without `just-bash`). The
 * default chain always degrades to `just-bash` on exhaustion.
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

  if (env.atlasSandbox === "nsjail" && !env.nsjailFailed) {
    // Explicit nsjail is hard-fail by contract; nothing after it is reachable.
    // (Vercel still precedes it: an operator on Vercel with ATLAS_SANDBOX=nsjail
    // gets Vercel first, matching the long-standing explore behavior.)
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
 * The backend a health/status reporter would name for this plan: the first step
 * whose kind reports available, else `null` (⇒ the caller reports the fallback,
 * typically `"just-bash"`). Kept separate from {@link runSandboxPlan} because
 * reporting must not actually construct backends.
 */
export function firstAvailableBackend(
  plan: SandboxPlan,
  isAvailable: (kind: SandboxBackendName) => boolean,
): SandboxBackendName | null {
  for (const step of plan.steps) {
    if (isAvailable(step.kind)) return step.kind;
  }
  return null;
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
  const guidance: string[] = [];
  if (priority.includes("vercel-sandbox")) {
    guidance.push(
      "For Vercel Sandbox off-Vercel, set VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and VERCEL_TOKEN.",
    );
  }
  if (priority.includes("sidecar")) {
    guidance.push("For sidecar, set ATLAS_SANDBOX_URL.");
  }
  if (deployMode !== "saas") {
    guidance.push("Add 'just-bash' to the priority list if you want an unsandboxed fallback.");
  }
  guidance.push("Fix the backend configuration.");

  return `All backends in sandbox.priority (${priority.join(", ")}) failed to initialize.${summary} ${guidance.join(" ")}`;
}
