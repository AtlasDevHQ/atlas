import { describe, it, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useAtlasTheme } from "../use-atlas-theme";

describe("useAtlasTheme", () => {
  beforeEach(() => {
    // Reset to system default
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

  it("exposes setTheme function", () => {
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

  it("exposes applyBrandColor function", () => {
    const { result } = renderHook(() => useAtlasTheme());
    expect(typeof result.current.applyBrandColor).toBe("function");
  });
});
