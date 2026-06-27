import { describe, it, expect } from "bun:test";
import { normalizeUserCode } from "./normalize-user-code";

describe("normalizeUserCode (#4043 / ADR-0026)", () => {
  it("strips surrounding whitespace", () => {
    expect(normalizeUserCode("  aB3xK9pQ  ")).toBe("aB3xK9pQ");
  });

  it("removes internal spaces from a pasted code", () => {
    expect(normalizeUserCode("aB3x K9pQ")).toBe("aB3xK9pQ");
  });

  it("preserves case — the code is case-sensitive", () => {
    expect(normalizeUserCode("AbCdEfGh")).toBe("AbCdEfGh");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeUserCode("   ")).toBe("");
    expect(normalizeUserCode("")).toBe("");
  });
});
