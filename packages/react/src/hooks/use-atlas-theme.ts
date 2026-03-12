"use client";

import {
  useDarkMode,
  useThemeMode,
  setTheme,
  applyBrandColor,
  type ThemeMode,
} from "./use-dark-mode";

export type { ThemeMode };

export interface UseAtlasThemeReturn {
  /** Current theme setting: "light", "dark", or "system". */
  theme: ThemeMode;
  /** Whether the effective (resolved) theme is dark. */
  isDark: boolean;
  /** Set the theme mode. Persists to localStorage. */
  setTheme: (mode: ThemeMode) => void;
  /** Apply a brand color via CSS custom property --atlas-brand. */
  applyBrandColor: (color: string) => void;
}

export function useAtlasTheme(): UseAtlasThemeReturn {
  const theme = useThemeMode();
  const isDark = useDarkMode();

  return {
    theme,
    isDark,
    setTheme,
    applyBrandColor,
  };
}
