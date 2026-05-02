import { describe, expect, it } from "bun:test";
import { WIZARD_STEPS, wizardStepIdForNum } from "./wizard-steps";

describe("WIZARD_STEPS", () => {
  it("has 4 steps", () => {
    expect(WIZARD_STEPS).toHaveLength(4);
  });

  it("ends with done", () => {
    expect(WIZARD_STEPS[WIZARD_STEPS.length - 1].id).toBe("done");
  });
});

describe("wizardStepIdForNum", () => {
  it("maps each in-range number to its step id", () => {
    expect(wizardStepIdForNum(1)).toBe("datasource");
    expect(wizardStepIdForNum(2)).toBe("tables");
    expect(wizardStepIdForNum(3)).toBe("review");
    expect(wizardStepIdForNum(4)).toBe("done");
  });

  it("throws on numbers below 1", () => {
    expect(() => wizardStepIdForNum(0)).toThrow(/out of range/i);
    expect(() => wizardStepIdForNum(-1)).toThrow(/out of range/i);
  });

  it("throws on numbers above the step count", () => {
    expect(() => wizardStepIdForNum(99)).toThrow(/out of range/i);
  });
});
