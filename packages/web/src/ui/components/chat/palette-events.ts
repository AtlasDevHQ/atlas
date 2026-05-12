export const PALETTE_EVENT = "atlas:open-palette";
export const SHORTCUTS_EVENT = "atlas:open-shortcuts";

declare global {
  interface WindowEventMap {
    "atlas:open-palette": CustomEvent;
    "atlas:open-shortcuts": CustomEvent;
  }
}
