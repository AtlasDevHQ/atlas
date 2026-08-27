/**
 * Gate + target-selection coverage for `atlas-operator ops gate-export` (#5335).
 *
 * The decision semantics live in `lib/brain/gate-export.ts` and are tested
 * there. What is this file's is the operator surface: the double-gate that
 * decides DRY RUN vs EXECUTE, and the region resolution that decides WHICH
 * tenant DB gets read. Both are pure functions of `(args, env)` on purpose —
 * the alternative is a test that has to boot a pool to find out whether a flag
 * was honoured.
 */
import { describe, expect, it } from "bun:test";
import {
  GATE_EXPORT_OK_ENV,
  checkGateExportGate,
  formatAnalytics,
  isDryRun,
  resolveRegionDbUrl,
} from "../commands/operator/ops-gate-export";

const OPEN_GATE = { [GATE_EXPORT_OK_ENV]: "1" } as NodeJS.ProcessEnv;

describe("ops gate-export — the execute double-gate", () => {
  it("refuses to execute with neither half", () => {
    expect(checkGateExportGate([], {})).toBe(`${GATE_EXPORT_OK_ENV} is not set to 1`);
  });

  it("refuses to execute with the env var alone", () => {
    expect(checkGateExportGate([], OPEN_GATE)).toBe("--confirm was not passed");
  });

  it("refuses to execute with --confirm alone", () => {
    expect(checkGateExportGate(["--confirm"], {})).toBe(
      `${GATE_EXPORT_OK_ENV} is not set to 1`,
    );
  });

  it("clears only when BOTH halves are present", () => {
    expect(checkGateExportGate(["--confirm"], OPEN_GATE)).toBeNull();
  });

  it("treats any value other than exactly \"1\" as closed", () => {
    // "true", "yes" and "0" are all the shape of an operator who thinks the
    // gate is open. It is not.
    for (const value of ["true", "yes", "0", "", "01"]) {
      expect(checkGateExportGate(["--confirm"], { [GATE_EXPORT_OK_ENV]: value })).toBe(
        `${GATE_EXPORT_OK_ENV} is not set to 1`,
      );
    }
  });
});

describe("ops gate-export — DRY RUN is the default", () => {
  it("previews when the gate is closed", () => {
    expect(isDryRun([], {})).toBe(true);
    expect(isDryRun(["--confirm"], {})).toBe(true);
    expect(isDryRun([], OPEN_GATE)).toBe(true);
  });

  it("executes only when the gate is fully open", () => {
    expect(isDryRun(["--confirm"], OPEN_GATE)).toBe(false);
  });

  it("honours an explicit --dry-run even against an open gate", () => {
    // Belt-and-braces: an operator who passes both should get the preview.
    expect(isDryRun(["--confirm", "--dry-run"], OPEN_GATE)).toBe(true);
  });
});

describe("ops gate-export — which DB gets read", () => {
  it("has NO bare DATABASE_URL fallback", () => {
    const resolved = resolveRegionDbUrl([], {
      DATABASE_URL: "postgresql://somewhere/prod",
    } as NodeJS.ProcessEnv);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    // Forgetting the flag must never silently read whatever DATABASE_URL
    // happens to point at — the wrong-region read is the footgun.
    expect(resolved.error).toContain("No region DB selected");
  });

  it("resolves --region through its own env var", () => {
    const resolved = resolveRegionDbUrl(["--region", "eu"], {
      ATLAS_REGION_EU_DB_URL: "postgresql://eu/atlas",
    } as NodeJS.ProcessEnv);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.url).toBe("postgresql://eu/atlas");
    expect(resolved.region).toBe("eu");
  });

  it("rejects an unknown region without walking the prototype chain", () => {
    // `--region constructor` would pass an `in` check. It must not pass this one.
    for (const bad of ["constructor", "toString", "usa"]) {
      const resolved = resolveRegionDbUrl(["--region", bad], {} as NodeJS.ProcessEnv);
      expect(resolved.ok).toBe(false);
    }
  });

  it("reports a region whose env var is unset rather than falling through", () => {
    const resolved = resolveRegionDbUrl(["--region", "apac"], {} as NodeJS.ProcessEnv);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("ATLAS_REGION_APAC_DB_URL");
  });

  it("lets --database-url win, with a null region label", () => {
    const resolved = resolveRegionDbUrl(["--database-url", "postgresql://x/y"], {
      ATLAS_REGION_US_DB_URL: "postgresql://us/atlas",
    } as NodeJS.ProcessEnv);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.url).toBe("postgresql://x/y");
    // The region of an arbitrary URL is unknowable, and guessing it would make
    // the containment check assert something it cannot know.
    expect(resolved.region).toBeNull();
  });
});

describe("ops gate-export — the operator's report", () => {
  it("renders an undecided queue as prose, never as 0%", () => {
    const out = formatAnalytics({
      positives: 0,
      rejected: 0,
      negatives: 5,
      approvalRate: null,
      topRejectedPredicates: [],
      medianHoursToRetraction: null,
    });
    expect(out).toContain("n/a (nothing decided yet)");
    expect(out).not.toContain("0.0%");
  });

  it("renders a real rate and the rejection ranking", () => {
    const out = formatAnalytics({
      positives: 3,
      rejected: 1,
      negatives: 2,
      approvalRate: 0.75,
      topRejectedPredicates: [{ predicate: "owns", rejections: 1 }],
      medianHoursToRetraction: 2.5,
    });
    expect(out).toContain("75.0%");
    expect(out).toContain("owns: 1");
    expect(out).toContain("2.50");
  });
});
