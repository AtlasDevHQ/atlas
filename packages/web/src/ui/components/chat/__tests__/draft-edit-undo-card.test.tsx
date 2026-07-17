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

import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

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

  test("clicking Undo POSTs the inverse edit verbatim and refetches the draft", async () => {
    const fetchMock = mock(async () => ({ ok: true, status: 204 }) as unknown as Response);
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onDraftChanged = mock(() => {});
    try {
      const { getByTestId } = render(
        <BoundDraftProvider value={{ dashboardId: "d1", onDraftChanged }}>
          <DraftEditUndoCard part={removedPart} />
        </BoundDraftProvider>,
      );
      fireEvent.click(getByTestId("undo-button"));
      await waitFor(() => expect(getByTestId("undo-done")).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/v1/dashboards/d1/draft/undo");
      expect(init.method).toBe("POST");
      // The `undo` payload is echoed back verbatim — the server validates it.
      expect(JSON.parse(init.body as string)).toEqual({
        kind: "restore_card",
        card: { id: "c1", sql: "SELECT 1" },
      });
      expect(onDraftChanged).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("a failed Undo surfaces an error and does NOT refetch", async () => {
    const fetchMock = mock(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: "Card not found.", requestId: "req-1" }),
    }) as unknown as Response);
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onDraftChanged = mock(() => {});
    try {
      const { getByTestId, getByRole } = render(
        <BoundDraftProvider value={{ dashboardId: "d1", onDraftChanged }}>
          <DraftEditUndoCard part={removedPart} />
        </BoundDraftProvider>,
      );
      fireEvent.click(getByTestId("undo-button"));
      await waitFor(() => expect(getByRole("alert").textContent).toContain("req-1"));
      expect(onDraftChanged).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
