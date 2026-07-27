import { describe, expect, it } from "bun:test";
import {
  planSandboxSelection,
  runSandboxPlan,
  resolveSandboxBackend,
  formatSandboxPriorityFailure,
  formatSandboxFailClosed,
  type SandboxSelectionEnv,
  type SandboxStep,
  type StepAttempt,
} from "@atlas/api/lib/tools/backends/selection";
import type { SandboxBackendName } from "@atlas/api/lib/config";

// ---------------------------------------------------------------------------
// The whole point of this module (#4187): the priority policy is a PURE
// function of an env snapshot, so it is unit-testable WITHOUT the `import(...?t=)`
// cache-busting the old module-level-state selection forced (see the historical
// explore-backend.test.ts helper). Every test here builds a plain object.
// ---------------------------------------------------------------------------

const BASE: SandboxSelectionEnv = {
  atlasSandbox: undefined,
  vercelAvailable: false,
  sidecarAvailable: false,
  nsjailAvailable: false,
  nsjailFailed: false,
  configPriority: undefined,
};

function env(overrides: Partial<SandboxSelectionEnv>): SandboxSelectionEnv {
  return { ...BASE, ...overrides };
}

const kinds = (steps: readonly SandboxStep[]) => steps.map((s) => s.kind);

describe("planSandboxSelection — default chain", () => {
  it("degrades to just-bash (no steps) when nothing is available", () => {
    const plan = planSandboxSelection(BASE);
    expect(plan.source).toBe("default-chain");
    expect(plan.steps).toHaveLength(0);
    expect(plan.onExhausted).toBe("just-bash");
  });

  it("ranks Vercel above sidecar (the canonical order — resolves the divergence)", () => {
    const plan = planSandboxSelection(env({ vercelAvailable: true, sidecarAvailable: true }));
    expect(kinds(plan.steps)).toEqual(["vercel-sandbox", "sidecar"]);
  });

  it("ranks sidecar above nsjail auto-detect", () => {
    const plan = planSandboxSelection(env({ sidecarAvailable: true, nsjailAvailable: true }));
    expect(kinds(plan.steps)).toEqual(["sidecar", "nsjail"]);
  });

  it("makes explicit nsjail (ATLAS_SANDBOX=nsjail) a hard-fail step and drops sidecar/auto after it", () => {
    const plan = planSandboxSelection(
      env({ atlasSandbox: "nsjail", sidecarAvailable: true, nsjailAvailable: true }),
    );
    expect(kinds(plan.steps)).toEqual(["nsjail"]);
    expect(plan.steps[0]!.hardFail).toBe(true);
  });

  it("still ranks Vercel ahead of explicit nsjail (soft Vercel, then hard-fail nsjail)", () => {
    const plan = planSandboxSelection(env({ atlasSandbox: "nsjail", vercelAvailable: true }));
    expect(kinds(plan.steps)).toEqual(["vercel-sandbox", "nsjail"]);
    expect(plan.steps[0]!.hardFail).toBe(false);
    expect(plan.steps[1]!.hardFail).toBe(true);
  });

  it("KEEPS the pin's hard-fail step when nsjail is marked failed (#4829)", () => {
    // The security-critical inversion. `nsjailFailed` used to delete this step,
    // so a failed capability probe silently converted `ATLAS_SANDBOX=nsjail`
    // into an unsandboxed just-bash deployment: the flag meant "do not retry
    // this backend" at one call site and "the operator's pin no longer applies"
    // at another.
    //
    // A broken backend is never permission to weaken the posture. The step
    // stands and simply cannot construct, which is how the refusal is expressed.
    const explicit = planSandboxSelection(
      env({ atlasSandbox: "nsjail", sidecarAvailable: true, nsjailAvailable: true, nsjailFailed: true }),
    );
    expect(kinds(explicit.steps)).toEqual(["nsjail"]);
    expect(explicit.steps[0]!.hardFail).toBe(true);
    // Emphatically NOT a fall-through to the sidecar sitting right there.
    expect(kinds(explicit.steps)).not.toContain("sidecar");
  });

  it("still skips nsjail on the SOFT auto-detect branch once marked failed", () => {
    // The legitimate meaning of the flag, preserved: with no pin, a backend that
    // failed once must not be retried into the request path. Narrowing #4829's
    // fix to the pin branch is what keeps this true.
    const auto = planSandboxSelection(env({ nsjailAvailable: true, nsjailFailed: true }));
    expect(auto.steps).toHaveLength(0);
  });
});

describe("planSandboxSelection — config priority", () => {
  it("uses the configured order verbatim and fails closed without just-bash (SaaS pin)", () => {
    const plan = planSandboxSelection(env({ configPriority: ["vercel-sandbox"] }));
    expect(kinds(plan.steps)).toEqual(["vercel-sandbox"]);
    expect(plan.onExhausted).toBe("fail-closed");
    // Narrow on the discriminant — `configPriority` lives only on this arm.
    expect(plan.source).toBe("config-priority");
    if (plan.source === "config-priority") {
      expect(plan.configPriority).toEqual(["vercel-sandbox"]);
    }
  });

  it("degrades to just-bash when the operator includes it in the list", () => {
    const plan = planSandboxSelection(env({ configPriority: ["sidecar", "just-bash"] }));
    expect(plan.onExhausted).toBe("just-bash");
    expect(kinds(plan.steps)).toEqual(["sidecar", "just-bash"]);
  });

  it("config priority overrides the env-driven default chain", () => {
    // Even with Vercel available, an explicit pin to sidecar wins.
    const plan = planSandboxSelection(
      env({ vercelAvailable: true, configPriority: ["sidecar", "just-bash"] }),
    );
    expect(kinds(plan.steps)).toEqual(["sidecar", "just-bash"]);
  });
});

describe("resolveSandboxBackend", () => {
  const none = () => false;

  it("returns the first step whose kind reports available", () => {
    const plan = planSandboxSelection(env({ vercelAvailable: true, sidecarAvailable: true }));
    // Vercel unavailable at report time → sidecar is named.
    expect(resolveSandboxBackend(plan, (k: SandboxBackendName) => k === "sidecar")).toBe("sidecar");
  });

  it("degrades to just-bash when a degradable plan is exhausted", () => {
    const plan = planSandboxSelection(env({ sidecarAvailable: true }));
    expect(resolveSandboxBackend(plan, none)).toBe("just-bash");
  });

  it("reports fail-closed for an exhausted pin with no just-bash (#4828)", () => {
    // The staging/prod shape: `priority: ["vercel-sandbox"]` and a dropped
    // VERCEL_TOKEN. This used to collapse to `just-bash` — a WORKING but
    // unsandboxed deploy — for a region where explore throws on every request.
    // The two states are opposites, so reporting one as the other is not an
    // imprecision, it inverts the operator's remediation.
    const plan = planSandboxSelection(env({ configPriority: ["vercel-sandbox"] }));
    expect(resolveSandboxBackend(plan, none)).toBe("fail-closed");
  });

  it("reports just-bash when the operator kept it in the pin", () => {
    // The control for the case above: `onExhausted` is the discriminator, not
    // "nothing was available". An operator who listed just-bash really is
    // running unsandboxed and must keep being told so.
    const plan = planSandboxSelection(env({ configPriority: ["sidecar", "just-bash"] }));
    expect(resolveSandboxBackend(plan, none)).toBe("just-bash");
  });

  it("short-circuits at an unavailable hard-fail step (#4829)", () => {
    // Mirrors runSandboxPlan: nothing after a hard-fail step is reachable, so
    // the reporter must not name a later backend the runner would never build.
    const plan = planSandboxSelection(env({ atlasSandbox: "nsjail", nsjailFailed: true }));
    expect(resolveSandboxBackend(plan, none)).toBe("fail-closed");
  });

  it("names the hard-fail step's backend while it IS available", () => {
    const plan = planSandboxSelection(env({ atlasSandbox: "nsjail" }));
    expect(resolveSandboxBackend(plan, (k: SandboxBackendName) => k === "nsjail")).toBe("nsjail");
  });

  it("prefers an available soft step ahead of the hard-fail step", () => {
    // Vercel outranks the nsjail pin; reaching fail-closed requires the earlier
    // steps to be unavailable too.
    const plan = planSandboxSelection(env({ atlasSandbox: "nsjail", vercelAvailable: true }));
    expect(resolveSandboxBackend(plan, (k: SandboxBackendName) => k === "vercel-sandbox")).toBe(
      "vercel-sandbox",
    );
    expect(resolveSandboxBackend(plan, none)).toBe("fail-closed");
  });

  it("agrees with runSandboxPlan's outcome for the same plan and predicate", async () => {
    // The invariant that keeps boot, /api/health, and the request path from
    // disagreeing (#4824). Reporting `just-bash` for a plan the runner
    // fail-closes is exactly the divergence #4828 filed.
    const cases: readonly SandboxSelectionEnv[] = [
      env({ configPriority: ["vercel-sandbox"] }),
      env({ configPriority: ["sidecar", "just-bash"] }),
      env({ atlasSandbox: "nsjail", nsjailFailed: true }),
      env({ atlasSandbox: "nsjail", vercelAvailable: true }),
      env({ sidecarAvailable: true }),
    ];

    for (const e of cases) {
      const plan = planSandboxSelection(e);
      const reported = resolveSandboxBackend(plan, none);
      // Nothing constructs, matching the `none` availability predicate.
      const outcome = await runSandboxPlan<string>(plan, async (step) => ({
        failure: { name: step.kind, reason: "unavailable" },
      }));
      const runnerRefuses = outcome.kind === "fail-closed" || outcome.kind === "hard-fail";
      expect(reported === "fail-closed", JSON.stringify(e)).toBe(runnerRefuses);
    }
  });
});

describe("runSandboxPlan — shared walk semantics", () => {
  const okStep = async (): Promise<StepAttempt<string>> => ({ backend: "backend" });
  const failStep =
    (reason: string) =>
    async (step: SandboxStep): Promise<StepAttempt<string>> => ({
      failure: { name: step.kind, reason },
    });

  it("returns the first step that constructs a backend", async () => {
    const plan = planSandboxSelection(env({ vercelAvailable: true, sidecarAvailable: true }));
    const outcome = await runSandboxPlan<string>(plan, async (step) =>
      step.kind === "vercel-sandbox" ? failStep("nope")(step) : okStep(),
    );
    expect(outcome.kind).toBe("backend");
    if (outcome.kind === "backend") expect(outcome.selected).toBe("sidecar");
  });

  it("falls through soft failures and reports 'exhausted' with the collected failures", async () => {
    const plan = planSandboxSelection(env({ vercelAvailable: true, sidecarAvailable: true }));
    const outcome = await runSandboxPlan<string>(plan, failStep("down"));
    expect(outcome.kind).toBe("exhausted");
    if (outcome.kind === "exhausted") {
      expect(outcome.failures.map((f) => f.name)).toEqual(["vercel-sandbox", "sidecar"]);
    }
  });

  it("short-circuits to 'hard-fail' when the explicit-nsjail step fails", async () => {
    const plan = planSandboxSelection(env({ atlasSandbox: "nsjail" }));
    const outcome = await runSandboxPlan<string>(plan, failStep("binary missing"));
    expect(outcome.kind).toBe("hard-fail");
    if (outcome.kind === "hard-fail") {
      expect(outcome.step.kind).toBe("nsjail");
      expect(outcome.reason).toBe("binary missing");
    }
  });

  it("treats a thrown tryStep as a soft failure and keeps walking", async () => {
    const plan = planSandboxSelection(env({ vercelAvailable: true, sidecarAvailable: true }));
    const outcome = await runSandboxPlan<string>(plan, async (step) => {
      if (step.kind === "vercel-sandbox") throw new Error("boom");
      return okStep();
    });
    expect(outcome.kind).toBe("backend");
    if (outcome.kind === "backend") expect(outcome.selected).toBe("sidecar");
  });

  it("reports 'fail-closed' for a config pin with no just-bash", async () => {
    const plan = planSandboxSelection(env({ configPriority: ["vercel-sandbox"] }));
    const outcome = await runSandboxPlan<string>(plan, failStep("401"));
    expect(outcome.kind).toBe("fail-closed");
  });
});

describe("SaaS pin resolves identically for both tools (AC1 + AC4)", () => {
  // The SaaS deploy config is `sandbox.priority: ["vercel-sandbox"]` with no
  // fallback. Both tools build the SAME plan from it and, on a Vercel failure,
  // BOTH fail closed — no silent downgrade to a weaker backend.
  const saasEnv = env({ configPriority: ["vercel-sandbox"], vercelAvailable: true });

  it("plans a single Vercel step that fails closed", () => {
    const plan = planSandboxSelection(saasEnv);
    expect(kinds(plan.steps)).toEqual(["vercel-sandbox"]);
    expect(plan.onExhausted).toBe("fail-closed");
  });

  it("even a mistakenly-configured sidecar cannot override the pin", () => {
    const plan = planSandboxSelection({ ...saasEnv, sidecarAvailable: true });
    // Only the pinned backend is ever attempted.
    expect(kinds(plan.steps)).toEqual(["vercel-sandbox"]);
  });
});

describe("formatSandboxPriorityFailure", () => {
  it("includes per-backend reasons and self-hosted just-bash guidance", () => {
    const msg = formatSandboxPriorityFailure(
      ["vercel-sandbox", "sidecar"],
      [
        { name: "vercel-sandbox", reason: "401 invalid token" },
        { name: "sidecar", reason: "connection refused" },
      ],
      "self-hosted",
    );
    expect(msg).toContain("vercel-sandbox: 401 invalid token");
    expect(msg).toContain("sidecar: connection refused");
    expect(msg).toContain("VERCEL_TEAM_ID");
    expect(msg).toContain("ATLAS_SANDBOX_URL");
    expect(msg).toContain("Add 'just-bash'");
  });

  it("suppresses the just-bash suggestion in SaaS mode", () => {
    const msg = formatSandboxPriorityFailure(
      ["vercel-sandbox"],
      [{ name: "vercel-sandbox", reason: "401" }],
      "saas",
    );
    expect(msg).not.toContain("Add 'just-bash'");
  });
});

describe("formatSandboxFailClosed", () => {
  it("names the pinned backend and its missing credential, not 'install nsjail' (#4828)", () => {
    const plan = planSandboxSelection(env({ configPriority: ["vercel-sandbox"] }));
    const msg = formatSandboxFailClosed(plan, "saas");

    expect(msg).toContain("vercel-sandbox");
    expect(msg).toContain("VERCEL_TOKEN");
    // The remediation the pin makes IMPOSSIBLE to act on. `sandbox.priority`
    // excludes nsjail and the sidecar, so an operator following the old generic
    // advice changes nothing while the real cause goes unnamed.
    expect(msg).not.toContain("Install nsjail");
    expect(msg).not.toContain("ATLAS_SANDBOX_URL");
    // SaaS cannot opt into an unsandboxed fallback.
    expect(msg).not.toContain("Add 'just-bash'");
  });

  it("offers the just-bash escape hatch to a self-hosted operator", () => {
    const plan = planSandboxSelection(env({ configPriority: ["sidecar"] }));
    const msg = formatSandboxFailClosed(plan, "self-hosted");

    expect(msg).toContain("ATLAS_SANDBOX_URL");
    expect(msg).toContain("Add 'just-bash'");
  });

  it("explains the nsjail pin as hard-fail rather than as a degradation", () => {
    const plan = planSandboxSelection(env({ atlasSandbox: "nsjail", nsjailFailed: true }));
    const msg = formatSandboxFailClosed(plan, "self-hosted");

    expect(msg).toContain("ATLAS_SANDBOX=nsjail");
    expect(msg).toContain("ATLAS_NSJAIL_PATH");
    expect(msg).toContain("refuses every request");
    // Must NOT reuse the "no process isolation" phrasing — that string is the
    // genuine-just-bash warning, and a security review greps for it. Claiming it
    // here would be #4824's false claim at inverted polarity.
    expect(msg).not.toContain("no process isolation");
  });
});

// Type-level guard: the plan's kinds are drawn from the config backend names.
const _typecheck: SandboxBackendName = "vercel-sandbox";
void _typecheck;
