/**
 * Unit tests for the shared mid-fan-out failure wrapper (#4235). The
 * load-bearing property is the tagged-error PASSTHROUGH: a plan/billing denial
 * must reach the route with its `_tag` intact (so it maps to 403/503), never
 * flattened into a plain Error that would surface as a 500 claiming "retrying
 * is safe". The handler suites all mock the cap to `allowed`, so this is the
 * only place that passthrough is exercised behaviorally.
 */

import { describe, expect, it } from "bun:test";
import { isPlanDenial, retryableInstallError } from "../retryable-install-error";
import {
  BillingCheckFailedError,
  FeatureEntitlementError,
} from "@atlas/api/lib/effect/errors";

const denial = new FeatureEntitlementError({
  message: "over cap",
  feature: "knowledge_collections",
  requiredPlan: "pro",
  currentPlan: "starter",
});
const checkFailed = new BillingCheckFailedError({ message: "try again", workspaceId: "org-1" });

describe("isPlanDenial", () => {
  it("is true for both tagged plan/billing errors", () => {
    expect(isPlanDenial(denial)).toBe(true);
    expect(isPlanDenial(checkFailed)).toBe(true);
  });
  it("is false for a plain error or a non-error value", () => {
    expect(isPlanDenial(new Error("db down"))).toBe(false);
    expect(isPlanDenial("nope")).toBe(false);
    expect(isPlanDenial(null)).toBe(false);
  });
});

describe("retryableInstallError", () => {
  it("returns a plan denial UNCHANGED — preserving its _tag for the route mapper", () => {
    // Identity, not a copy: the tagged error must reach `classifyError` intact.
    expect(retryableInstallError("brand-1", denial, "brand")).toBe(denial);
    expect(retryableInstallError("brand-1", checkFailed, "brand")).toBe(checkFailed);
  });

  it("wraps a genuine write-path failure with retry-safe guidance and the cause", () => {
    const cause = new Error("row write failed");
    const wrapped = retryableInstallError("brand-1", cause, "brand");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).not.toBe(cause);
    const err = wrapped as Error;
    expect(err.message).toContain("brand-1");
    expect(err.message).toContain("Retrying the install is safe");
    expect(err.message).toContain("brand collections");
    expect(err.cause).toBe(cause);
  });

  it("stringifies a non-error cause rather than throwing", () => {
    const wrapped = retryableInstallError("kb-1", "weird", "KB") as Error;
    expect(wrapped.message).toContain("weird");
    expect(wrapped.message).toContain("KB collections");
  });
});
