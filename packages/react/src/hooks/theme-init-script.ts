/**
 * Blocking inline script for layout.tsx — prevents dark-mode flash on load.
 *
 * This file intentionally has NO "use client" directive so it can be imported
 * by server components (layout.tsx). The storage key must stay in sync with
 * use-dark-mode.ts.
 */

export const THEME_STORAGE_KEY = "atlas-theme";

/**
 * Returns the inline script string for the blocking `<script>` in layout.tsx.
 * Reads atlas-theme from localStorage and sets the `dark` class before first paint.
 */
export function buildThemeInitScript(): string {
  return `try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}`;
}
