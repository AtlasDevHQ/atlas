import { describe, it, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useAtlasTheme } from "../use-atlas-theme";

describe("useAtlasTheme", () => {
  beforeEach(() => {
    const { result } = renderHook(() => useAtlasTheme());
    act(() => {
      result.current.setTheme("system");
    });
  });

  it("returns current theme mode", () => {
    const { result } = renderHook(() => useAtlasTheme());
    expect(["light", "dark", "system"]).toContain(result.current.theme);
    expect(typeof result.current.isDark).toBe("boolean");
  });

  it("sets theme to dark", () => {
    const { result } = renderHook(() => useAtlasTheme());

    act(() => {
      result.current.setTheme("dark");
    });

    expect(result.current.theme).toBe("dark");
    expect(result.current.isDark).toBe(true);
  });

  it("toggles between light and dark", () => {
    const { result } = renderHook(() => useAtlasTheme());

    act(() => {
      result.current.setTheme("light");
    });
    expect(result.current.theme).toBe("light");
    expect(result.current.isDark).toBe(false);

    act(() => {
      result.current.setTheme("dark");
    });
    expect(result.current.theme).toBe("dark");
    expect(result.current.isDark).toBe(true);
  });

  it("applyBrandColor sets CSS custom property", () => {
    const { result } = renderHook(() => useAtlasTheme());

    act(() => {
      result.current.applyBrandColor("oklch(0.759 0.148 167.71)");
    });

    const value = document.documentElement.style.getPropertyValue("--atlas-brand");
    expect(value).toBe("oklch(0.759 0.148 167.71)");
  });
});
