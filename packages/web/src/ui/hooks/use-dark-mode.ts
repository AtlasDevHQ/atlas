"use client";

import { createContext, useSyncExternalStore } from "react";

export const DarkModeContext = createContext(false);

/** SSR-safe snapshot: reads current prefers-color-scheme without hydration flicker. */
function subscribeToColorScheme(onChange: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getServerSnapshot() {
  return false;
}

export function useDarkMode() {
  return useSyncExternalStore(subscribeToColorScheme, getSnapshot, getServerSnapshot);
}
