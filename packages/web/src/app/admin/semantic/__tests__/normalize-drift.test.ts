/**
 * Tests for the defensive drift parser on the admin entities-list response
 * (#2459). The parser sits between the backend's untrusted JSON and the file
 * tree's strict `SemanticTreeDrift` type; a regression here would silently
 * kill the drift accent without surfacing an error.
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";

import { normalizeDrift } from "../normalize-drift";

describe("normalizeDrift", () => {
  // Silence console.debug for the "this is expected" cases; restore between
  // tests so the regression-signal cases can still assert it was called.
  let debugSpy: ReturnType<typeof mock>;
  beforeEach(() => {
    debugSpy = mock(() => {});
    console.debug = debugSpy as unknown as typeof console.debug;
  });
  afterEach(() => {
    debugSpy.mockReset();
  });

  it("returns null for null without complaining (normal no-drift path)", () => {
    expect(normalizeDrift(null)).toBeNull();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("returns null for undefined without complaining (legacy no-?connection path)", () => {
    expect(normalizeDrift(undefined)).toBeNull();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("parses every valid non-changed state", () => {
    expect(normalizeDrift({ state: "in-sync" })).toEqual({ state: "in-sync" });
    expect(normalizeDrift({ state: "removed" })).toEqual({ state: "removed" });
    expect(normalizeDrift({ state: "new" })).toEqual({ state: "new" });
  });

  it("parses changed with a numeric changeCount", () => {
    expect(normalizeDrift({ state: "changed", changeCount: 3 })).toEqual({
      state: "changed",
      changeCount: 3,
    });
  });

  it("drops a non-object payload and logs (regression signal)", () => {
    expect(normalizeDrift("oops")).toBeNull();
    expect(debugSpy).toHaveBeenCalled();
  });

  it("drops an unknown state and logs", () => {
    expect(normalizeDrift({ state: "wat" })).toBeNull();
    expect(debugSpy).toHaveBeenCalled();
  });

  it("drops missing state and logs", () => {
    expect(normalizeDrift({ changeCount: 5 })).toBeNull();
    expect(debugSpy).toHaveBeenCalled();
  });

  it("drops changed without changeCount and logs (discriminated-union violation)", () => {
    // The backend `EntityDrift` discriminated union guarantees `changed`
    // carries a `changeCount: number`. A response without it is a regression.
    expect(normalizeDrift({ state: "changed" })).toBeNull();
    expect(debugSpy).toHaveBeenCalled();
  });

  it("drops changed with non-numeric changeCount and logs", () => {
    expect(normalizeDrift({ state: "changed", changeCount: "3" })).toBeNull();
    expect(debugSpy).toHaveBeenCalled();
  });

  it("drops changed with NaN/Infinity changeCount", () => {
    // `typeof NaN === "number"` so the bare typeof guard isn't enough —
    // Number.isFinite is the actual gate.
    expect(normalizeDrift({ state: "changed", changeCount: Number.NaN })).toBeNull();
    expect(normalizeDrift({ state: "changed", changeCount: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
