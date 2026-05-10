import { describe, expect, test } from "bun:test";
import { deriveInitials } from "../components/user-menu";

describe("deriveInitials", () => {
  test("uses first letter of two name parts", () => {
    expect(deriveInitials("Ada Lovelace", null)).toBe("AL");
  });

  test("falls back to email when name is missing", () => {
    expect(deriveInitials(null, "ada.lovelace@example.com")).toBe("AL");
  });

  test("returns single letter for one-word name", () => {
    expect(deriveInitials("Ada", null)).toBe("A");
  });

  test("falls back to '?' when both inputs are blank", () => {
    expect(deriveInitials(null, null)).toBe("?");
    expect(deriveInitials("", "")).toBe("?");
    expect(deriveInitials("   ", "   ")).toBe("?");
  });

  test("name takes precedence over email", () => {
    expect(deriveInitials("Bob Builder", "ada@example.com")).toBe("BB");
  });

  test("handles email-only input with single local part", () => {
    expect(deriveInitials(null, "ada@example.com")).toBe("AE");
  });
});
