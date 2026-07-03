import { describe, expect, it } from "bun:test";
import {
  planSandboxSelection,
  runSandboxPlan,
  firstAvailableBackend,
  formatSandboxPriorityFailure,
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

  it("excludes nsjail entirely once it is marked failed — even when explicitly pinned", () => {
    const explicit = planSandboxSelection(
      env({ atlasSandbox: "nsjail", sidecarAvailable: true, nsjailAvailable: true, nsjailFailed: true }),
    );
    // Degraded: explicit nsjail is skipped, falls through to sidecar.
    expect(kinds(explicit.steps)).toEqual(["sidecar"]);

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

describe("firstAvailableBackend", () => {
  it("returns the first step whose kind reports available", () => {
    const plan = planSandboxSelection(env({ vercelAvailable: true, sidecarAvailable: true }));
    // Vercel unavailable at report time → sidecar is named.
    expect(firstAvailableBackend(plan, (k) => k === "sidecar")).toBe("sidecar");
  });

  it("returns null when no step is available (caller reports just-bash)", () => {
    const plan = planSandboxSelection(env({ sidecarAvailable: true }));
    expect(firstAvailableBackend(plan, () => false)).toBeNull();
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

// Type-level guard: the plan's kinds are drawn from the config backend names.
const _typecheck: SandboxBackendName = "vercel-sandbox";
void _typecheck;
