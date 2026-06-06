/**
 * Door 1 (#3237) decision logic: the inline "Generate semantic layer" prompt
 * fires only when a created connection forms a *new* Connection group, never
 * when it joins an already-populated one (acceptance criteria 1 & 2).
 */

import { describe, expect, it } from "bun:test";
import {
  ENV_SENTINEL_NONE,
  ENV_SENTINEL_CREATE,
  createsNewGroup,
  shouldPromptGenerate,
  newGroupLabel,
} from "./generate-prompt";

describe("connections/generate-prompt", () => {
  describe("createsNewGroup", () => {
    it("fires for a brand-new named group (__create__)", () => {
      expect(createsNewGroup(ENV_SENTINEL_CREATE)).toBe(true);
    });

    it("fires for an ungrouped connection (__none__ → auto-singleton)", () => {
      // The common single-DB / first-DB-after-skip path: an ungrouped add
      // becomes its own group of one, which has no schema yet → prompt.
      expect(createsNewGroup(ENV_SENTINEL_NONE)).toBe(true);
    });

    it("does NOT fire when joining an existing populated group", () => {
      expect(createsNewGroup("prod")).toBe(false);
      expect(createsNewGroup("g_warehouse")).toBe(false);
    });
  });

  describe("shouldPromptGenerate", () => {
    it("prompts on a create that forms a new group", () => {
      expect(shouldPromptGenerate(false, ENV_SENTINEL_CREATE)).toBe(true);
      expect(shouldPromptGenerate(false, ENV_SENTINEL_NONE)).toBe(true);
    });

    it("does not prompt on a create that joins an existing group", () => {
      expect(shouldPromptGenerate(false, "prod")).toBe(false);
    });

    it("never prompts on edit, regardless of Environment selection", () => {
      expect(shouldPromptGenerate(true, ENV_SENTINEL_CREATE)).toBe(false);
      expect(shouldPromptGenerate(true, ENV_SENTINEL_NONE)).toBe(false);
      expect(shouldPromptGenerate(true, "prod")).toBe(false);
    });
  });

  describe("newGroupLabel", () => {
    it("uses the typed name for a new named group", () => {
      expect(newGroupLabel(ENV_SENTINEL_CREATE, "  Production ", "wh")).toBe("Production");
    });

    it("falls back to the connection id when the new name is blank", () => {
      expect(newGroupLabel(ENV_SENTINEL_CREATE, "   ", "warehouse")).toBe("warehouse");
    });

    it("labels an auto-singleton by its connection id", () => {
      expect(newGroupLabel(ENV_SENTINEL_NONE, "", "warehouse")).toBe("warehouse");
    });
  });
});
