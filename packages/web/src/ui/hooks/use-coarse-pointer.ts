"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the device's primary pointer is COARSE — i.e. a touch screen with no
 * precise cursor. Backs the dashboard's "viewing-first on touch" behaviour
 * (#4323): the layout-Edit affordance is hidden on touch (drag-to-arrange needs
 * a fine pointer) rather than shown-and-inert.
 *
 * Uses `(pointer: coarse)` rather than a width breakpoint so a narrow desktop
 * window (fine pointer) still gets the editor, while a large tablet (coarse
 * pointer) does not — the affordance tracks the INPUT, not the viewport. Mirrors
 * the `useSyncExternalStore` + `matchMedia` pattern in `use-dark-mode.ts`, and
 * is SSR-safe (`getServerSnapshot` returns `false`, so the editor renders on the
 * server and only collapses on a real touch device after hydration).
 */

const QUERY = "(pointer: coarse)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/** Returns `true` when the primary pointer is coarse (touch). */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
