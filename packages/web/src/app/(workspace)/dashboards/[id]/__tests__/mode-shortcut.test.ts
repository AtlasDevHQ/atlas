import { afterEach, describe, expect, test } from "bun:test";
import { shouldIgnoreModeShortcut } from "../mode-shortcut";

/**
 * #4560 — the canvas View/Edit shortcut (`e` / `Escape`) is page-surface only:
 * a keystroke aimed at an interactive control (Select typeahead, an open
 * dropdown's Escape, a focused toolbar button) must not toggle the mode.
 */
describe("shouldIgnoreModeShortcut (#4560)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("does not suppress on a bare, non-interactive page surface", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(shouldIgnoreModeShortcut(div)).toBe(false);
  });

  test("suppresses inside text-entry fields", () => {
    for (const tag of ["input", "textarea", "select"] as const) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      expect(shouldIgnoreModeShortcut(el)).toBe(true);
    }
  });

  test("suppresses on a contenteditable surface", () => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    document.body.appendChild(el);
    expect(shouldIgnoreModeShortcut(el)).toBe(true);
  });

  test("suppresses on a toolbar button (and its nested icon)", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.appendChild(icon);
    document.body.appendChild(button);
    // The event target can be the button itself or a child of it.
    expect(shouldIgnoreModeShortcut(button)).toBe(true);
    expect(shouldIgnoreModeShortcut(icon)).toBe(true);
  });

  test("suppresses on an SVG icon nested inside a toolbar button (closest walks past the SVG)", () => {
    // Lucide icons render as <svg> (an SVGElement, not HTMLElement); a keydown
    // that lands on one inside a button must still be treated as the button's.
    const button = document.createElement("button");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    button.appendChild(svg);
    document.body.appendChild(button);
    expect(shouldIgnoreModeShortcut(svg)).toBe(true);
  });

  test("does not suppress on a bare SVG that has no interactive ancestor", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    document.body.appendChild(svg);
    expect(shouldIgnoreModeShortcut(svg)).toBe(false);
  });

  test("suppresses inside a Select trigger (role=combobox) — `e` is typeahead there", () => {
    const trigger = document.createElement("div");
    trigger.setAttribute("role", "combobox");
    document.body.appendChild(trigger);
    expect(shouldIgnoreModeShortcut(trigger)).toBe(true);
  });

  test("suppresses inside an open dropdown/select popover (menu / listbox / option)", () => {
    for (const role of ["menu", "menuitem", "listbox", "option"] as const) {
      const el = document.createElement("div");
      el.setAttribute("role", role);
      document.body.appendChild(el);
      expect(shouldIgnoreModeShortcut(el)).toBe(true);
    }
  });

  test("returns false for a null / non-element target", () => {
    expect(shouldIgnoreModeShortcut(null)).toBe(false);
  });
});
