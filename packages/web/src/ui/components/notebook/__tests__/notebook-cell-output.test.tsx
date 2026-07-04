/**
 * Notebook cell output renders finished assistant turns through the SHARED
 * turn partitioner + turn components (#4301) — the same FinishedTurn the chat
 * transcript uses (#4298) — so the two surfaces cannot drift in formatting.
 * Notebook-specific chrome (typing indicator, "No output yet", collapsed
 * preview, the AssistantTurn gutter, rerun comparison, live-run failure
 * dedup) is pinned here too.
 *
 * The partition/receipt policy matrix (defaultOpen, pending interactive
 * cards, suggestion stripping) lives in
 * ui/components/chat/__tests__/turn-receipt.test.tsx and
 * ui/__tests__/finished-turn.test.tsx (both relative to src/) — not
 * re-tested here.
 */

import { expect, test, afterEach } from "bun:test";
import React from "react";
import { render, cleanup } from "@testing-library/react";
import type { UIMessage } from "@ai-sdk/react";

afterEach(cleanup);

import { NotebookCellOutput } from "../notebook-cell-output";

function makeMessage(parts: unknown[]): UIMessage {
  return { id: "a1", role: "assistant", parts } as UIMessage;
}

const narration = { type: "text", text: "Let me check the schema." };
const exploreCall = {
  type: "tool-explore",
  toolCallId: "c1",
  state: "output-available",
  input: { command: "cat semantic/entities/orders.yml" },
  output: "columns: ...",
};
const successfulQuery = {
  type: "tool-executeSQL",
  toolCallId: "c2",
  state: "output-available",
  input: {
    sql: "SELECT region, sum(total) FROM orders GROUP BY 1",
    explanation: "Revenue by region",
  },
  output: {
    success: true,
    columns: ["region", "sum"],
    rows: [
      { region: "EU", sum: 100 },
      { region: "US", sum: 200 },
    ],
    executionMs: 42,
  },
};
const answerText = { type: "text", text: "US leads with $200." };

function failedQuery(toolCallId: string) {
  return {
    type: "tool-executeSQL",
    toolCallId,
    state: "output-available",
    input: { sql: "SELECT broken", explanation: "Broken query" },
    output: { success: false, error: "column does not exist" },
  };
}

test("finished cell renders receipt → answer → promoted artifact via the shared turn components, inside the notebook gutter", () => {
  const { container, getByTestId, getByRole } = render(
    <NotebookCellOutput
      assistantMessage={makeMessage([narration, exploreCall, successfulQuery, answerText])}
      status="idle"
      collapsed={false}
    />,
  );

  // Shared composition: collapsed receipt, dominant answer, promoted artifact.
  const receipt = getByTestId("turn-receipt");
  expect(receipt.textContent).toContain("Explored schema");
  expect(getByTestId("turn-answer").textContent).toContain("US leads with $200.");
  const artifact = getByTestId("answer-artifact");
  expect(artifact.textContent).toContain("Revenue by region");
  expect(artifact.textContent).toContain("Show SQL");
  // Receipt is collapsed: activity narration stays hidden until expanded.
  expect(container.textContent).not.toContain("Let me check the schema.");
  expect(getByRole("button", { name: /Explored schema/ })).toBeTruthy();
  // Notebook chrome: everything sits inside the AssistantTurn gutter.
  const gutter = container.querySelector('[data-slot="assistant-turn"]');
  expect(gutter).not.toBeNull();
  expect(gutter!.contains(receipt)).toBe(true);
  expect(gutter!.contains(artifact)).toBe(true);
});

test("rerun comparison (previousExecution) reaches the promoted artifact's result card", () => {
  const { getByTestId } = render(
    <NotebookCellOutput
      assistantMessage={makeMessage([successfulQuery, answerText])}
      status="idle"
      collapsed={false}
      previousExecution={{ rowCount: 5, executionMs: 3000 }}
    />,
  );
  // 5 previous rows vs 2 current → "(was 5 rows · 3.0s)" in the card header.
  expect(getByTestId("answer-artifact").textContent).toContain("was 5 rows · 3.0s");
});

test("running cell keeps the live part-by-part renderer — no receipt, parts in stream order", () => {
  const { container, queryByTestId } = render(
    <NotebookCellOutput
      assistantMessage={makeMessage([narration, exploreCall])}
      status="running"
      collapsed={false}
    />,
  );
  expect(queryByTestId("turn-receipt")).toBeNull();
  expect(queryByTestId("turn-answer")).toBeNull();
  // Narration is visible immediately while streaming.
  expect(container.textContent).toContain("Let me check the schema.");
});

test("running cell still folds repeated identical SQL failures (Tried N times badge)", () => {
  const { container } = render(
    <NotebookCellOutput
      assistantMessage={makeMessage([failedQuery("c1"), failedQuery("c2")])}
      status="running"
      collapsed={false}
    />,
  );
  expect(container.textContent).toContain("Tried 2 times");
  // The duplicate is skipped — the error renders once, not twice.
  const occurrences = container.textContent!.split("column does not exist").length - 1;
  expect(occurrences).toBe(1);
});

test("error-status cell takes the finished path: receipt with a failure count, no live-path fold", () => {
  const { container, getByTestId, queryByTestId } = render(
    <NotebookCellOutput
      assistantMessage={makeMessage([failedQuery("c1"), failedQuery("c2")])}
      status="error"
      collapsed={false}
    />,
  );
  // The receipt's summary counts the retries; the live-path badge is gone.
  const receipt = getByTestId("turn-receipt");
  expect(receipt.textContent).toContain("2 queries · 2 failed");
  expect(container.textContent).not.toContain("Tried 2 times");
  expect(queryByTestId("turn-answer")).toBeNull();
  // No answer and no artifact → the receipt starts expanded (shared policy),
  // so the failed cards are visible without a click — both of them: the
  // finished path accepts the un-folded stacking (see notebook-cell-output).
  const occurrences = container.textContent!.split("column does not exist").length - 1;
  expect(occurrences).toBe(2);
});

test("collapsed cell renders the truncated text preview, not the turn components", () => {
  const { container, queryByTestId } = render(
    <NotebookCellOutput
      assistantMessage={makeMessage([narration, exploreCall, successfulQuery, answerText])}
      status="idle"
      collapsed
    />,
  );
  expect(queryByTestId("turn-receipt")).toBeNull();
  expect(container.textContent).toContain("Let me check the schema.");
});

test("running with no message yet shows the typing indicator; idle with no message shows the empty state", () => {
  const running = render(
    <NotebookCellOutput assistantMessage={null} status="running" collapsed={false} />,
  );
  // The animated dots are the indicator's only stable hook — no text/testid.
  expect(running.container.querySelector(".animate-typing-dot")).not.toBeNull();
  expect(running.container.querySelector('[data-slot="assistant-turn"]')).toBeNull();
  running.unmount();

  const idle = render(
    <NotebookCellOutput assistantMessage={null} status="idle" collapsed={false} />,
  );
  expect(idle.container.textContent).toContain("No output yet");
});
