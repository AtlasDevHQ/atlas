/**
 * #4555 — bound-editor destructive ops apply straight to the draft and surface
 * a one-click Undo. In the live drawer the Undo button renders; in a read-only
 * History transcript the card is inert (undoing a finished session would act on
 * the current draft, not this stale receipt) and shows a static note instead.
 */

import { describe, expect, test, afterEach, mock } from "bun:test";

void mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({ apiUrl: "", isCrossOrigin: false }),
}));

import { render, cleanup } from "@testing-library/react";

const { DraftEditUndoCard } = await import("../draft-edit-undo-card");
const { BoundDraftProvider } = await import("@/ui/components/dashboards/bound-draft-context");

afterEach(cleanup);

const removedPart = {
  type: "tool-removeCard",
  toolCallId: "call-1",
  state: "output-available" as const,
  input: {},
  output: {
    kind: "removed",
    cardId: "c1",
    title: "Old card",
    undo: { kind: "restore_card", card: { id: "c1", sql: "SELECT 1" } },
  },
} as unknown;

const sqlUpdatedPart = {
  type: "tool-updateCardSql",
  toolCallId: "call-2",
  state: "output-available" as const,
  input: {},
  output: {
    kind: "sql_updated",
    cardId: "c1",
    title: "Revenue",
    previousSql: "SELECT 1",
    newSql: "SELECT 2",
    undo: { kind: "revert_sql", cardId: "c1", sql: "SELECT 1" },
  },
} as unknown;

describe("DraftEditUndoCard", () => {
  test("live drawer: renders the removed receipt + an Undo button", () => {
    const { getByTestId, queryByTestId } = render(
      <BoundDraftProvider value={{ dashboardId: "d1", onDraftChanged: () => {} }}>
        <DraftEditUndoCard part={removedPart} />
      </BoundDraftProvider>,
    );
    expect(getByTestId("undo-button")).toBeTruthy();
    expect(queryByTestId("undo-readonly")).toBeNull();
  });

  test("read-only: no Undo button, shows an inert receipt", () => {
    const { queryByTestId, getByTestId } = render(
      <BoundDraftProvider value={{ dashboardId: "d1", onDraftChanged: () => {}, readOnly: true }}>
        <DraftEditUndoCard part={removedPart} />
      </BoundDraftProvider>,
    );
    expect(queryByTestId("undo-button")).toBeNull();
    expect(getByTestId("undo-readonly").textContent).toContain("Removed in this session");
  });

  test("sql_updated: renders the previous / new SQL diff", () => {
    const { getByText, getByTestId } = render(
      <BoundDraftProvider value={{ dashboardId: "d1", onDraftChanged: () => {} }}>
        <DraftEditUndoCard part={sqlUpdatedPart} />
      </BoundDraftProvider>,
    );
    expect(getByTestId("undo-button")).toBeTruthy();
    expect(getByText("SELECT 1")).toBeTruthy();
    expect(getByText("SELECT 2")).toBeTruthy();
  });
});
