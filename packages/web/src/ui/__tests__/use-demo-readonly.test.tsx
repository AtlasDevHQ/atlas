import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, cleanup } from "@testing-library/react";
import type { ModeStatusResponse } from "@useatlas/types/mode";
import type { AtlasMode } from "@useatlas/types/auth";

// Controls for the mocked hooks.
const modeState = {
  mode: "published" as AtlasMode,
  isLoading: false,
  isAdmin: true,
};
let modeStatusState: {
  data: ModeStatusResponse | null;
  loading: boolean;
} = { data: null, loading: false };

mock.module("@/ui/hooks/use-mode", () => ({
  useMode: () => ({ ...modeState, setMode: () => {} }),
}));

mock.module("@/ui/hooks/use-mode-status", () => ({
  useModeStatus: () => modeStatusState,
}));

import { useDemoReadonly, demoIndustryLabel } from "../hooks/use-demo-readonly";

function status(partial: Partial<ModeStatusResponse> = {}): ModeStatusResponse {
  return {
    mode: "published",
    canToggle: true,
    demoIndustry: null,
    demoConnectionActive: false,
    hasDrafts: false,
    draftCounts: null,
    ...partial,
  };
}

describe("demoIndustryLabel", () => {
  test("returns label for known slugs", () => {
    expect(demoIndustryLabel("saas")).toBe("SaaS CRM");
    expect(demoIndustryLabel("cybersec")).toBe("Sentinel Security");
    expect(demoIndustryLabel("cybersecurity")).toBe("Sentinel Security");
    expect(demoIndustryLabel("ecommerce")).toBe("NovaMart");
  });

  test("returns null for unknown / nullish", () => {
    expect(demoIndustryLabel(null)).toBeNull();
    expect(demoIndustryLabel(undefined)).toBeNull();
    expect(demoIndustryLabel("")).toBeNull();
    expect(demoIndustryLabel("unknown-vertical")).toBeNull();
  });
});

describe("useDemoReadonly", () => {
  beforeEach(() => {
    modeState.mode = "published";
    modeState.isLoading = false;
    modeState.isAdmin = true;
    modeStatusState = { data: null, loading: false };
  });

  afterEach(() => {
    cleanup();
  });

  test("readOnly = true when published mode + demo connection active", () => {
    modeState.mode = "published";
    modeStatusState = {
      data: status({ demoConnectionActive: true, demoIndustry: "cybersec" }),
      loading: false,
    };
    const { result } = renderHook(() => useDemoReadonly());
    expect(result.current.readOnly).toBe(true);
    expect(result.current.demoIndustry).toBe("cybersec");
  });

  test("readOnly = false in developer mode even when demo is active", () => {
    modeState.mode = "developer";
    modeStatusState = {
      data: status({ demoConnectionActive: true, demoIndustry: "saas" }),
      loading: false,
    };
    const { result } = renderHook(() => useDemoReadonly());
    expect(result.current.readOnly).toBe(false);
    // demoIndustry still surfaces so callers can render subtitles.
    expect(result.current.demoIndustry).toBe("saas");
  });

  test("readOnly = false when there's no active demo connection", () => {
    modeState.mode = "published";
    modeStatusState = {
      data: status({ demoConnectionActive: false }),
      loading: false,
    };
    const { result } = renderHook(() => useDemoReadonly());
    expect(result.current.readOnly).toBe(false);
  });

  test("readOnly = false while session is still loading (fail-open)", () => {
    modeState.isLoading = true;
    modeStatusState = {
      data: status({ demoConnectionActive: true }),
      loading: false,
    };
    const { result } = renderHook(() => useDemoReadonly());
    expect(result.current.readOnly).toBe(false);
    expect(result.current.loading).toBe(true);
  });

  test("readOnly = false while mode status is still loading (fail-open)", () => {
    modeState.mode = "published";
    modeStatusState = { data: null, loading: true };
    const { result } = renderHook(() => useDemoReadonly());
    expect(result.current.readOnly).toBe(false);
    expect(result.current.loading).toBe(true);
  });
});
