import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, cleanup } from "@testing-library/react";
import type {
  ModeStatusResponse,
  ModeDraftCounts,
} from "@useatlas/types/mode";

// Mock the upstream mode hooks BEFORE importing the hook under test.
const modeState = { mode: "developer" as "developer" | "published" };
let modeStatusState: {
  data: ModeStatusResponse | null;
  loading: boolean;
} = { data: null, loading: false };

mock.module("@/ui/hooks/use-mode", () => ({
  useMode: () => ({
    mode: modeState.mode,
    setMode: () => {},
    isAdmin: true,
    isLoading: false,
  }),
}));

mock.module("@/ui/hooks/use-mode-status", () => ({
  useModeStatus: () => modeStatusState,
}));

import { useDevModeNoDrafts } from "../hooks/use-dev-mode-no-drafts";

function counts(partial: Partial<ModeDraftCounts> = {}): ModeDraftCounts {
  return {
    connections: 0,
    entities: 0,
    entityEdits: 0,
    entityDeletes: 0,
    prompts: 0,
    ...partial,
  };
}

function status(
  draftCounts: ModeDraftCounts | null,
  overrides: Partial<ModeStatusResponse> = {},
): ModeStatusResponse {
  return {
    mode: "developer",
    canToggle: true,
    demoIndustry: null,
    demoConnectionActive: false,
    hasDrafts: draftCounts !== null,
    draftCounts,
    ...overrides,
  };
}

describe("useDevModeNoDrafts", () => {
  beforeEach(() => {
    modeState.mode = "developer";
    modeStatusState = { data: null, loading: false };
  });

  afterEach(() => {
    cleanup();
  });

  test("returns false when mode is published, regardless of draft counts", () => {
    modeState.mode = "published";
    modeStatusState = { data: status(counts()), loading: false };
    const { result } = renderHook(() => useDevModeNoDrafts(["connections"]));
    expect(result.current).toBe(false);
  });

  test("returns false while modeStatus is loading (data is null)", () => {
    // This is the regression guard: without the null gate, the hook
    // would resolve to true here and cause a flash of the dev empty
    // state before /api/v1/mode responds for admins who already have
    // drafts.
    modeStatusState = { data: null, loading: true };
    const { result } = renderHook(() => useDevModeNoDrafts(["connections"]));
    expect(result.current).toBe(false);
  });

  test("returns false when modeStatus fetch failed (data is null, not loading)", () => {
    // Failed fetches surface as `data: null, loading: false`. We must
    // fail-closed (treat as "might have drafts") so we never show the
    // dev empty state over work admins have in progress.
    modeStatusState = { data: null, loading: false };
    const { result } = renderHook(() => useDevModeNoDrafts(["connections"]));
    expect(result.current).toBe(false);
  });

  test("returns true when in developer mode and the requested counter is zero", () => {
    modeStatusState = { data: status(counts()), loading: false };
    const { result } = renderHook(() => useDevModeNoDrafts(["connections"]));
    expect(result.current).toBe(true);
  });

  test("returns false when the requested counter is non-zero", () => {
    modeStatusState = {
      data: status(counts({ connections: 2 })),
      loading: false,
    };
    const { result } = renderHook(() => useDevModeNoDrafts(["connections"]));
    expect(result.current).toBe(false);
  });

  test("ignores counters that were not requested (prompts draft, connections gate is true)", () => {
    modeStatusState = {
      data: status(counts({ prompts: 3 })),
      loading: false,
    };
    const { result } = renderHook(() => useDevModeNoDrafts(["connections"]));
    expect(result.current).toBe(true);
  });

  test("sums multiple counters for the semantic-editor case", () => {
    // Admin has a draft_delete tombstone but no new drafts or edits.
    // The hook must still report "has drafts" because the tombstone
    // affects the published entity list.
    modeStatusState = {
      data: status(counts({ entityDeletes: 1 })),
      loading: false,
    };
    const { result } = renderHook(() =>
      useDevModeNoDrafts(["entities", "entityEdits", "entityDeletes"]),
    );
    expect(result.current).toBe(false);
  });

  test("sums to zero returns true for the semantic-editor case", () => {
    modeStatusState = { data: status(counts()), loading: false };
    const { result } = renderHook(() =>
      useDevModeNoDrafts(["entities", "entityEdits", "entityDeletes"]),
    );
    expect(result.current).toBe(true);
  });

  test("handles a null draftCounts field (API optimization when no drafts)", () => {
    // The API returns draftCounts: null when there are no drafts at
    // all. The `?? 0` must treat this the same as an all-zero object.
    modeStatusState = { data: status(null), loading: false };
    const { result } = renderHook(() => useDevModeNoDrafts(["connections"]));
    expect(result.current).toBe(true);
  });

  test("a non-admin in published mode cannot trigger the empty state", () => {
    // Non-admins are forced to published mode by useMode; the hook
    // short-circuits at the mode check and never inspects status.
    modeState.mode = "published";
    modeStatusState = { data: null, loading: false };
    const { result } = renderHook(() => useDevModeNoDrafts(["connections"]));
    expect(result.current).toBe(false);
  });
});
