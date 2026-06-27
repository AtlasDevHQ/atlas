import { describe, it, expect } from "bun:test";
import {
  parseGatewayCostUsd,
  sumStepGatewayCostUsd,
  type StepProviderMetadata,
} from "@atlas/api/lib/billing/gateway-cost";

/** Build a step carrying a gateway cost value (or none). */
function step(cost?: unknown): StepProviderMetadata {
  if (cost === undefined) return { providerMetadata: {} };
  return { providerMetadata: { gateway: { cost } } };
}

describe("parseGatewayCostUsd", () => {
  it("parses the gateway's decimal-string cost", () => {
    expect(parseGatewayCostUsd("0.0234")).toBe(0.0234);
    expect(parseGatewayCostUsd("1")).toBe(1);
  });

  it("tolerates a numeric cost", () => {
    expect(parseGatewayCostUsd(0.5)).toBe(0.5);
  });

  it("treats a recorded zero as zero (not null)", () => {
    expect(parseGatewayCostUsd("0")).toBe(0);
    expect(parseGatewayCostUsd(0)).toBe(0);
  });

  it("returns null for absent / unparseable / negative / non-finite values", () => {
    expect(parseGatewayCostUsd(null)).toBeNull();
    expect(parseGatewayCostUsd(undefined)).toBeNull();
    expect(parseGatewayCostUsd("")).toBeNull(); // Number("") === 0, but empty is "not recorded"
    expect(parseGatewayCostUsd("not-a-number")).toBeNull();
    expect(parseGatewayCostUsd(-0.01)).toBeNull(); // never a negative cost
    expect(parseGatewayCostUsd(Number.NaN)).toBeNull();
    expect(parseGatewayCostUsd(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseGatewayCostUsd({})).toBeNull();
  });
});

describe("sumStepGatewayCostUsd", () => {
  it("sums the per-step gateway cost across a multi-step turn", () => {
    const total = sumStepGatewayCostUsd([step("0.01"), step("0.02"), step("0.005")]);
    expect(total).toBeCloseTo(0.035, 10);
  });

  it("returns null when no step carried a gateway cost (non-gateway provider)", () => {
    expect(sumStepGatewayCostUsd([step(), step()])).toBeNull();
  });

  it("returns null for an empty or absent steps array", () => {
    expect(sumStepGatewayCostUsd([])).toBeNull();
    expect(sumStepGatewayCostUsd(null)).toBeNull();
    expect(sumStepGatewayCostUsd(undefined)).toBeNull();
  });

  it("includes recorded-zero steps and returns a number (not null)", () => {
    expect(sumStepGatewayCostUsd([step("0"), step("0")])).toBe(0);
  });

  it("skips unparseable steps but keeps the parseable ones", () => {
    const total = sumStepGatewayCostUsd([step("0.02"), step("garbage"), step(), step("0.03")]);
    expect(total).toBeCloseTo(0.05, 10);
  });

  it("tolerates missing providerMetadata / gateway shapes", () => {
    expect(
      sumStepGatewayCostUsd([
        { providerMetadata: null },
        { providerMetadata: undefined },
        {},
        { providerMetadata: { gateway: undefined } },
        { providerMetadata: { gateway: { cost: "0.04" } } },
      ]),
    ).toBeCloseTo(0.04, 10);
  });
});
