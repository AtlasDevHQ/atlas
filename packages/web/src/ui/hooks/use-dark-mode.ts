"use client";

import { createContext, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Theme types
// ---------------------------------------------------------------------------

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "atlas-theme";

// ---------------------------------------------------------------------------
// Shared state — single source of truth for the chosen mode.
// Listeners are notified on change so useSyncExternalStore re-renders.
// ---------------------------------------------------------------------------

let _mode: ThemeMode = "system";
const _listeners = new Set<() => void>();

function notify() {
  for (const fn of _listeners) fn();
}

/** Read stored preference (called once on module load in the browser). */
function init() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      _mode = stored;
    }
  } catch (err) {
    console.warn("Could not read theme preference from localStorage:", err);
  }
}

if (typeof window !== "undefined") init();

// ---------------------------------------------------------------------------
// Derived boolean: is the effective theme dark?
// ---------------------------------------------------------------------------

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveIsDark(mode: ThemeMode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return systemPrefersDark();
}

function applyClass(isDark: boolean) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", isDark);
}

// ---------------------------------------------------------------------------
// External store for isDark (reacts to both mode changes AND system changes)
// ---------------------------------------------------------------------------

function subscribeIsDark(onChange: () => void) {
  _listeners.add(onChange);

  // Also listen for system preference changes (relevant when mode === "system")
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    applyClass(resolveIsDark(_mode));
    onChange();
  };
  mq.addEventListener("change", handler);

  return () => {
    _listeners.delete(onChange);
    mq.removeEventListener("change", handler);
  };
}

function getSnapshotIsDark() {
  return resolveIsDark(_mode);
}

function getServerSnapshotIsDark() {
  return false;
}

// ---------------------------------------------------------------------------
// External store for mode
// ---------------------------------------------------------------------------

function subscribeMode(onChange: () => void) {
  _listeners.add(onChange);
  return () => {
    _listeners.delete(onChange);
  };
}

function getSnapshotMode() {
  return _mode;
}

function getServerSnapshotMode(): ThemeMode {
  return "system";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setTheme(mode: ThemeMode) {
  _mode = mode;
  const isDark = resolveIsDark(mode);
  applyClass(isDark);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch (err) {
    console.warn("Could not persist theme preference to localStorage:", err);
  }
  notify();
}

export const DarkModeContext = createContext(false);

/** Returns whether the effective theme is dark. */
export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribeIsDark, getSnapshotIsDark, getServerSnapshotIsDark);
}

/** Returns the current ThemeMode ("light" | "dark" | "system"). */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeMode, getSnapshotMode, getServerSnapshotMode);
}
