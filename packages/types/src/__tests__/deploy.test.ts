/**
 * `isDeployRegion` narrowing-guard tests (#2985).
 *
 * `isDeployRegion` is the type guard the staging email-clamp wiring
 * (`packages/api/src/lib/email/delivery.ts`) uses to narrow the raw
 * `getApiRegion(): string | null` read into a `DeployRegion` instead of an
 * unchecked cast. Its WHOLE JOB is to be exact: only the four first-party
 * deploy regions pass. A value that is "close" — wrong case, trailing
 * whitespace, a granular `"us-west"`, a typo, `null` — must return `false`
 * so the caller fails CLOSED (clamps / hard-fails) rather than treating a
 * mislabelled staging box as a prod region and emailing a real recipient.
 *
 * These cases pin that exactness so a future "be lenient" edit (trim,
 * lowercase, prefix-match) trips the suite.
 */

import { describe, test, expect } from "bun:test";
import { isDeployRegion, type DeployRegion } from "../deploy";

describe("isDeployRegion — accepts exactly the four deploy regions", () => {
  for (const region of ["us", "eu", "apac", "staging"] as const) {
    test(`accepts "${region}"`, () => {
      expect(isDeployRegion(region)).toBe(true);
    });
  }
});

describe("isDeployRegion — rejects everything else (fail-closed inputs)", () => {
  test("rejects null (region unset)", () => {
    expect(isDeployRegion(null)).toBe(false);
  });

  test("rejects the empty string", () => {
    expect(isDeployRegion("")).toBe(false);
  });

  // The exact misconfig vectors #2985 must not let leak: a staging box whose
  // ATLAS_API_REGION is "Staging" / "staging " must NOT narrow to a
  // DeployRegion (which would skip the clamp and email real recipients).
  test("rejects wrong case", () => {
    expect(isDeployRegion("Staging")).toBe(false);
    expect(isDeployRegion("US")).toBe(false);
  });

  test("rejects leading/trailing whitespace", () => {
    expect(isDeployRegion("staging ")).toBe(false);
    expect(isDeployRegion(" staging")).toBe(false);
  });

  // Granular residency keys (`us-west`, `eu-west`) are the OPEN `Region`
  // concept, not the coarse first-party `DeployRegion`. They are not
  // DeployRegions, so they must not narrow.
  test("rejects granular residency keys", () => {
    expect(isDeployRegion("us-west")).toBe(false);
    expect(isDeployRegion("eu-west")).toBe(false);
    expect(isDeployRegion("ap-southeast")).toBe(false);
  });

  test("rejects typos / unknown strings", () => {
    expect(isDeployRegion("stg")).toBe(false);
    expect(isDeployRegion("prod")).toBe(false);
    expect(isDeployRegion("production")).toBe(false);
  });
});

describe("isDeployRegion — narrows the type for the compiler", () => {
  // The guard's value is the static narrowing it gives the wiring site. This
  // asserts the predicate flows: inside the `true` branch, `value` is a
  // `DeployRegion` and is assignable to one with no cast.
  test("narrows string | null to DeployRegion in the true branch", () => {
    const value: string | null = "staging";
    if (isDeployRegion(value)) {
      const narrowed: DeployRegion = value;
      expect(narrowed).toBe("staging");
    } else {
      throw new Error("expected isDeployRegion to narrow 'staging'");
    }
  });
});
