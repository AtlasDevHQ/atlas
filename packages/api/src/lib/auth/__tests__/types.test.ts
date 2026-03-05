/**
 * Tests for createAtlasUser validation and AUTH_MODES constant.
 */

import { describe, it, expect } from "bun:test";
import { createAtlasUser, AUTH_MODES } from "../types";

describe("createAtlasUser()", () => {
  it("throws when id is empty string", () => {
    expect(() => createAtlasUser("", "simple-key", "label")).toThrow(
      "AtlasUser id must be non-empty",
    );
  });

  it("throws when label is empty string", () => {
    expect(() => createAtlasUser("usr_1", "managed", "")).toThrow(
      "AtlasUser label must be non-empty",
    );
  });

  it("returns an object with correct id, mode, and label", () => {
    const user = createAtlasUser("usr_1", "byot", "alice@example.com");
    expect(user.id).toBe("usr_1");
    expect(user.mode).toBe("byot");
    expect(user.label).toBe("alice@example.com");
  });

  it("returns a frozen object", () => {
    const user = createAtlasUser("usr_1", "simple-key", "api-key-sk-t");
    expect(Object.isFrozen(user)).toBe(true);
  });
});

describe("AUTH_MODES", () => {
  it("contains all four auth modes", () => {
    expect(AUTH_MODES).toEqual(["none", "simple-key", "managed", "byot"]);
  });

  it("is a readonly tuple at the type level", () => {
    // `as const` makes the array readonly at compile time; at runtime it's a plain array
    expect(Array.isArray(AUTH_MODES)).toBe(true);
    expect(AUTH_MODES.length).toBe(4);
  });
});
