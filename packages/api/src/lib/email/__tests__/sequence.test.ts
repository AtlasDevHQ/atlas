/**
 * Tests for onboarding email sequence definition.
 */

import { describe, it, expect } from "bun:test";
import { ONBOARDING_SEQUENCE, MILESTONE_TO_STEP, getStepDef } from "../sequence";

describe("ONBOARDING_SEQUENCE", () => {
  it("has 5 steps", () => {
    expect(ONBOARDING_SEQUENCE).toHaveLength(5);
  });

  it("starts with welcome", () => {
    expect(ONBOARDING_SEQUENCE[0].step).toBe("welcome");
    expect(ONBOARDING_SEQUENCE[0].fallbackHours).toBe(0);
  });

  it("has unique step names", () => {
    const names = ONBOARDING_SEQUENCE.map((s) => s.step);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has unique triggers", () => {
    const triggers = ONBOARDING_SEQUENCE.map((s) => s.trigger);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it("has subject templates with {{appName}}", () => {
    for (const step of ONBOARDING_SEQUENCE) {
      expect(step.subject).toContain("{{appName}}");
    }
  });
});

describe("MILESTONE_TO_STEP", () => {
  it("maps all milestones to steps", () => {
    expect(MILESTONE_TO_STEP.size).toBe(ONBOARDING_SEQUENCE.length);
    expect(MILESTONE_TO_STEP.get("signup_completed")).toBe("welcome");
    expect(MILESTONE_TO_STEP.get("database_connected")).toBe("connect_database");
    expect(MILESTONE_TO_STEP.get("first_query_executed")).toBe("first_query");
    expect(MILESTONE_TO_STEP.get("team_member_invited")).toBe("invite_team");
    expect(MILESTONE_TO_STEP.get("feature_explored")).toBe("explore_features");
  });
});

describe("getStepDef", () => {
  it("returns step definition for valid step", () => {
    const def = getStepDef("welcome");
    expect(def).toBeDefined();
    expect(def!.step).toBe("welcome");
    expect(def!.trigger).toBe("signup_completed");
  });

  it("returns undefined for unknown step", () => {
    // @ts-expect-error testing invalid input
    expect(getStepDef("nonexistent")).toBeUndefined();
  });
});
