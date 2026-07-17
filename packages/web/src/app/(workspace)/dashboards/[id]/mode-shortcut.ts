/**
 * Canvas View/Edit shortcut scoping (#4560, ADR-0034 / CONTEXT.md § Dashboard
 * editing — "View / Edit (canvas modes)").
 *
 * The page binds a global keyboard shortcut on the canvas — `e` toggles
 * View/Edit, `Escape` exits to View. "Global" means it listens on `window`, so
 * a keystroke meant for an interactive control — typeahead in an open Select, a
 * keypress while a toolbar button holds focus — would ALSO drive the mode. That
 * is the defect this predicate closes: the shortcut fires only when focus is on
 * the page surface, never inside a control that owns the key itself.
 *
 * Kept a pure, DOM-only predicate so the scoping rule is unit-testable without
 * mounting the whole dashboard page.
 */

/**
 * The controls whose focus swallows the mode shortcut. A match — the target IS
 * one, or is nested inside one (via `closest`) — means the keystroke belongs to
 * that control. Contenteditable surfaces are NOT listed here; they're matched
 * separately by `shouldIgnoreModeShortcut` via `HTMLElement.isContentEditable`
 * (which also reflects editability inherited from an ancestor).
 *
 *   - `input` / `textarea` — text entry.
 *   - `select` — a native option picker, where typing is typeahead.
 *   - `button` / `[role="button"]` — a toolbar control (refresh, fullscreen,
 *     the tile-actions trigger); `e`/`Escape` there must not drive the canvas.
 *   - `[role="combobox"]` — a Radix Select / Combobox trigger, where typing `e`
 *     is typeahead into the options, not "enter Edit".
 *   - `[role="menu"]` / `[role="menuitem"]` / `[role="listbox"]` / `[role="option"]`
 *     — an OPEN Select / dropdown popover: `Escape` closes it (Radix owns the
 *     key), and a letter is typeahead.
 */
const INTERACTIVE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "[role='button']",
  "[role='combobox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='listbox']",
  "[role='option']",
].join(",");

/**
 * Whether a keydown on `target` should be IGNORED by the canvas View/Edit
 * shortcut. True when focus sits on (or inside) an interactive control or an
 * editable field — the keystroke is the control's, not the page's.
 *
 * Narrows to `Element` (not `HTMLElement`) so an SVG target — a Lucide icon
 * inside a toolbar button is an `SVGElement` — still walks `closest` to its
 * interactive ancestor; `isContentEditable` is an `HTMLElement`-only property,
 * so it's checked under that narrower guard.
 */
export function shouldIgnoreModeShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}
