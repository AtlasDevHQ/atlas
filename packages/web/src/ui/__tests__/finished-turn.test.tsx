/**
 * Integration smoke for the answer-first finished turn (#4298) with the REAL
 * leaf renderers (no mocks): the receipt line renders and expands to the real
 * explore card + narration, the answer is the dominant element, the promoted
 * artifact renders through the real SQLResultCard with its affordances (Show
 * SQL, data), and the <suggestions> block never reaches the transcript.
 *
 * The mocked-out behavioral matrix lives in
 * components/chat/__tests__/turn-receipt.test.tsx; this file pins that the
 * composition holds with today's actual cards.
 */

import { expect, test, afterEach } from "bun:test";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";

afterEach(cleanup);
import { FinishedTurn } from "@/ui/components/chat/finished-turn";
import type { TurnPart } from "@/ui/components/chat/turn-partitioner";

test("finished turn renders receipt, answer, and real SQL result card", () => {
  const parts = [
    { type: "text", text: "Let me check the schema." },
    {
      type: "tool-explore",
      toolCallId: "c1",
      state: "output-available",
      input: { command: "cat semantic/entities/orders.yml" },
      output: "columns: ...",
    },
    {
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
    },
    {
      type: "text",
      text: "US leads with $200.\n<suggestions>\nBreak down by month\n</suggestions>",
    },
  ] as TurnPart[];

  const { container, getByRole, getByTestId } = render(<FinishedTurn parts={parts} />);

  // Receipt line + dominant answer + promoted artifact with its affordances.
  const toggle = getByRole("button", { name: /Explored schema/ });
  expect(toggle.textContent).toContain("Explored schema");
  expect(getByTestId("turn-answer").textContent).toContain("US leads with $200.");
  const artifact = getByTestId("answer-artifact");
  expect(artifact.textContent).toContain("Revenue by region");
  expect(artifact.textContent).toContain("Show SQL");
  expect(artifact.textContent).toContain("EU");
  // The chart/table view toggles survive promotion (the fixture is chartable).
  expect(artifact.textContent).toContain("Chart");
  expect(artifact.textContent).toContain("Table");

  // Expand the receipt: the explore card + narration appear.
  fireEvent.click(toggle);
  expect(container.textContent).toContain("cat semantic/entities/orders.yml");
  expect(container.textContent).toContain("Let me check the schema.");
  // Suggestions never render as answer text.
  expect(container.textContent).not.toContain("Break down by month");
});
