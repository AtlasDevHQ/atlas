import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import type { ModeStatusResponse, ModeDraftCounts } from "@useatlas/types/mode";

let modeStatusState: {
  data: ModeStatusResponse | null;
  loading: boolean;
} = { data: null, loading: false };

mock.module("@/ui/hooks/use-mode-status", () => ({
  useModeStatus: () => modeStatusState,
}));

// Import AFTER mocks so the module binds to the mocked hook.
import {
  PendingChangesSummary,
  formatDraftSegments,
} from "../components/pending-changes-summary";

function statusWith(counts: ModeDraftCounts | null): ModeStatusResponse {
  return {
    mode: "developer",
    canToggle: true,
    demoIndustry: null,
    demoConnectionActive: false,
    hasDrafts: counts !== null,
    draftCounts: counts,
  };
}

function counts(partial: Partial<ModeDraftCounts> = {}): ModeDraftCounts {
  return {
    connections: 0,
    entities: 0,
    entityEdits: 0,
    entityDeletes: 0,
    prompts: 0,
    starterPrompts: 0,
    ...partial,
  };
}

describe("formatDraftSegments", () => {
  test("returns empty array when all counts are zero", () => {
    expect(formatDraftSegments(counts())).toEqual([]);
  });

  test("pluralizes entity correctly at 1 and >1", () => {
    expect(formatDraftSegments(counts({ entities: 1 }))).toEqual(["1 entity"]);
    expect(formatDraftSegments(counts({ entities: 2 }))).toEqual(["2 entities"]);
  });

  test("pluralizes connection correctly", () => {
    expect(formatDraftSegments(counts({ connections: 1 }))).toEqual(["1 connection"]);
    expect(formatDraftSegments(counts({ connections: 3 }))).toEqual(["3 connections"]);
  });

  test("pluralizes prompt correctly", () => {
    expect(formatDraftSegments(counts({ prompts: 1 }))).toEqual(["1 prompt"]);
    expect(formatDraftSegments(counts({ prompts: 5 }))).toEqual(["5 prompts"]);
  });

  test("pluralizes starter prompt correctly", () => {
    expect(formatDraftSegments(counts({ starterPrompts: 1 }))).toEqual([
      "1 starter prompt",
    ]);
    expect(formatDraftSegments(counts({ starterPrompts: 4 }))).toEqual([
      "4 starter prompts",
    ]);
  });

  test("folds entities + entityEdits + entityDeletes into a single entity total", () => {
    const segments = formatDraftSegments(
      counts({ entities: 3, entityEdits: 2, entityDeletes: 1 }),
    );
    expect(segments).toEqual(["6 entities"]);
  });

  test("orders segments connections -> entities -> prompts -> starter prompts", () => {
    const segments = formatDraftSegments(
      counts({ connections: 1, entities: 4, prompts: 2, starterPrompts: 3 }),
    );
    expect(segments).toEqual([
      "1 connection",
      "4 entities",
      "2 prompts",
      "3 starter prompts",
    ]);
  });

  test("skips zero-count buckets", () => {
    const segments = formatDraftSegments(
      counts({ connections: 0, entities: 2, prompts: 1 }),
    );
    expect(segments).toEqual(["2 entities", "1 prompt"]);
  });
});

describe("PendingChangesSummary", () => {
  beforeEach(() => {
    modeStatusState = { data: null, loading: false };
  });

  afterEach(() => {
    cleanup();
  });

  test("hides when loading", () => {
    modeStatusState = { data: null, loading: true };
    const { container } = render(<PendingChangesSummary />);
    expect(container.textContent).toBe("");
  });

  test("hides when no draft counts are returned", () => {
    modeStatusState = { data: statusWith(null), loading: false };
    const { container } = render(<PendingChangesSummary />);
    expect(container.textContent).toBe("");
  });

  test("hides when all counts are zero", () => {
    modeStatusState = { data: statusWith(counts()), loading: false };
    const { container } = render(<PendingChangesSummary />);
    expect(container.textContent).toBe("");
  });

  test("renders segments joined by middle dot for multiple resource types", () => {
    modeStatusState = {
      data: statusWith(counts({ connections: 1, entities: 4, prompts: 2 })),
      loading: false,
    };
    const { container } = render(<PendingChangesSummary />);
    // Default (sm:) variant shows full label; the responsive mobile
    // variant is hidden but still in the DOM. Both are acceptable matches.
    expect(container.textContent).toContain("1 connection");
    expect(container.textContent).toContain("4 entities");
    expect(container.textContent).toContain("2 prompts");
  });

  test("renders accessible label with total and breakdown", () => {
    modeStatusState = {
      data: statusWith(counts({ entities: 1 })),
      loading: false,
    };
    const { container } = render(<PendingChangesSummary />);
    const label = container.querySelector("[aria-label]");
    expect(label?.getAttribute("aria-label")).toBe("1 pending change: 1 entity");
  });

  test("total pluralizes 'changes' when > 1", () => {
    modeStatusState = {
      data: statusWith(counts({ entities: 3 })),
      loading: false,
    };
    const { container } = render(<PendingChangesSummary />);
    const label = container.querySelector("[aria-label]");
    expect(label?.getAttribute("aria-label")).toContain("3 pending changes");
  });
});
