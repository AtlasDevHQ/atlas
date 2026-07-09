/**
 * #4322 — a staged change replayed inside a read-only History transcript is
 * inert: no live Accept / Discard buttons (a finished session has nothing to
 * resolve), just a static "staged in this session" note. The live drawer keeps
 * its interactive affordances.
 */

import { describe, expect, test, afterEach, mock } from "bun:test";

void mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({ apiUrl: "", isCrossOrigin: false }),
}));

import { render, cleanup } from "@testing-library/react";

const { StageChangeCard } = await import("../stage-change-card");
const { StageProvider } = await import("@/ui/components/dashboards/stage-context");

afterEach(cleanup);

const stagePart = {
  type: "tool-removeCard",
  toolCallId: "call-1",
  state: "output-available" as const,
  input: {},
  output: {
    kind: "stage_required",
    stageId: "stage-1",
    stageKind: "remove_card",
    target: { cardId: "c1", currentTitle: "Old card" },
  },
} as unknown;

describe("StageChangeCard — read-only history", () => {
  test("read-only: no Accept/Discard buttons, shows inert note", () => {
    const { queryByTestId, getByTestId } = render(
      <StageProvider value={{ dashboardId: "d1", onStagesChanged: () => {}, readOnly: true }}>
        <StageChangeCard part={stagePart} />
      </StageProvider>,
    );
    expect(queryByTestId("stage-accept-button")).toBeNull();
    expect(queryByTestId("stage-discard-button")).toBeNull();
    expect(getByTestId("stage-readonly").textContent).toContain("Staged in this session");
  });

  test("live drawer: Accept/Discard buttons render", () => {
    const { getByTestId } = render(
      <StageProvider value={{ dashboardId: "d1", onStagesChanged: () => {} }}>
        <StageChangeCard part={stagePart} />
      </StageProvider>,
    );
    expect(getByTestId("stage-accept-button")).toBeTruthy();
    expect(getByTestId("stage-discard-button")).toBeTruthy();
  });
});
