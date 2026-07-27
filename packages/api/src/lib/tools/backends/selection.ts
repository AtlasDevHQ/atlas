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
 * The walk mirrors `runSandboxPlan`'s exactly, and that correspondence is the
 * whole contract — boot, `/api/health`, and the request path must not be able to
 * disagree about the same inputs (the #4824 invariant):
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
    guidance.push("For nsjail, install the binary or set ATLAS_NSJAIL_PATH.");
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
 * short-circuited the walk. Deriving that from the plan keeps this callable from
 * `startup.ts` without exporting explore's private `isBackendAvailable`, which
 * would be `undefined` under the partial `mock.module()` of `explore.ts` used by
 * 40+ test files.
 *
 * Precondition: `resolveSandboxBackend(plan, …)` returned `"fail-closed"`.
 */
export function formatSandboxFailClosed(
  plan: SandboxPlan,
  deployMode: "saas" | "self-hosted" | undefined,
): string {
  const hardFailAt = plan.steps.findIndex((s) => s.hardFail);
  const considered = hardFailAt === -1 ? plan.steps : plan.steps.slice(0, hardFailAt + 1);
  const unavailable = considered.map((s) => s.kind);
  const guidance = credentialGuidance(unavailable);

  if (plan.source === "config-priority") {
    if (deployMode !== "saas") {
      guidance.push("Add 'just-bash' to sandbox.priority if you want an unsandboxed fallback.");
    }
    return (
      `Explore tool: UNAVAILABLE — every backend in sandbox.priority ` +
      `(${plan.configPriority.join(", ")}) is unavailable and the pin has no 'just-bash' ` +
      `fallback, so the tool fails closed and refuses every request. ` +
      `Unavailable: ${unavailable.join(", ")}. ${guidance.join(" ")}`
    );
  }

  // Default chain — the only way here is an unavailable hard-fail step, which
  // today means the ATLAS_SANDBOX=nsjail pin.
  return (
    `Explore tool: UNAVAILABLE — ATLAS_SANDBOX=nsjail is pinned but nsjail is not usable ` +
    `on this host, so the tool fails closed and refuses every request (the pin is hard-fail ` +
    `by contract — it does not degrade to an unsandboxed backend). ` +
    `${guidance.join(" ")} ` +
    `Or unset ATLAS_SANDBOX to allow the normal fallback chain.`
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
