/**
 * Component tests for the collapsed receipt + finished-turn rendering (#4298,
 * now AgentTurn's streaming=false shape):
 * a finished turn renders receipt → answer → promoted artifact; the receipt
 * expands on click to the full activity; narration never renders outside it.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import React from "react";
import type { TurnPart } from "../turn-partitioner";

// Stub the heavy leaf renderers — this test pins the partition/receipt
// composition, not card internals. CLAUDE.md "Mock all exports": tool-part.tsx
// exports only ToolPart; markdown.tsx exports only Markdown.
mock.module("@/ui/components/chat/tool-part", () => ({
  ToolPart: ({ part }: { part: unknown }) =>
    React.createElement(
      "div",
      { "data-testid": "tool-part-stub" },
      String((part as { type?: string }).type),
    ),
}));
mock.module("@/ui/components/chat/markdown", () => ({
  Markdown: ({ content }: { content: string }) =>
    React.createElement("div", null, content),
}));

import { render, cleanup, fireEvent } from "@testing-library/react";

const { TurnReceipt } = await import("../turn-receipt");
const { AgentTurn } = await import("../agent-turn");
const { partitionTurn } = await import("../turn-partitioner");

afterEach(cleanup);

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

let nextCallId = 0;

function text(t: string): TurnPart {
  return { type: "text", text: t };
}

function sql(success = true): TurnPart {
  return {
    type: "tool-executeSQL",
    toolCallId: `call-${nextCallId++}`,
    state: "output-available",
    input: { sql: "SELECT 1", explanation: "test" },
    output: success
      ? { success: true, columns: ["n"], rows: [{ n: 1 }] }
      : { success: false, error: "boom" },
  } as TurnPart;
}

function explore(): TurnPart {
  return {
    type: "tool-explore",
    toolCallId: `call-${nextCallId++}`,
    state: "output-available",
    input: { command: "ls" },
    output: "entities.yml",
  } as TurnPart;
}

/* ------------------------------------------------------------------ */
/*  TurnReceipt                                                        */
/* ------------------------------------------------------------------ */

describe("TurnReceipt", () => {
  test("renders nothing for empty activity", () => {
    const { container } = render(<TurnReceipt activity={[]} />);
    expect(container.innerHTML).toBe("");
  });

  test("collapsed by default: one summary line, no activity content", () => {
    const { activity } = partitionTurn([
      text("Checking the schema..."),
      explore(),
      sql(false),
      text("Answer."),
    ]);
    const { getByRole, queryByTestId, queryByText } = render(
      <TurnReceipt activity={activity} />,
    );

    const toggle = getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Explored schema · 1 query");
    expect(queryByTestId("tool-part-stub")).toBeNull();
    expect(queryByText("Checking the schema...")).toBeNull();
  });

  test("expands on click to the full activity (tools + narration), collapses again", () => {
    const { activity } = partitionTurn([
      text("Checking the schema..."),
      explore(),
      sql(false),
      text("Answer."),
    ]);
    const { getByRole, queryAllByTestId, queryByText } = render(
      <TurnReceipt activity={activity} />,
    );

    const toggle = getByRole("button");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(queryAllByTestId("tool-part-stub")).toHaveLength(2);
    expect(queryByText("Checking the schema...")).not.toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(queryAllByTestId("tool-part-stub")).toHaveLength(0);
  });

  test("defaultOpen starts expanded", () => {
    const { activity } = partitionTurn([explore(), text("Answer.")]);
    const { getByRole, queryAllByTestId } = render(
      <TurnReceipt activity={activity} defaultOpen />,
    );
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(queryAllByTestId("tool-part-stub")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  AgentTurn                                                       */
/* ------------------------------------------------------------------ */

describe("AgentTurn", () => {
  test("renders receipt → answer → promoted artifact, in that order", () => {
    const { container, getByTestId, getByRole } = render(
      <AgentTurn
        parts={[
          text("Looking at the data..."),
          explore(),
          sql(),
          text("Revenue was $1.2M."),
        ]}
      />,
    );

    const receipt = getByRole("button");
    const answer = getByTestId("turn-answer");
    const artifact = getByTestId("answer-artifact");
    expect(answer.textContent).toContain("Revenue was $1.2M.");
    expect(artifact.textContent).toContain("tool-executeSQL");

    const order = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(order(receipt, answer)).toBe(true);
    expect(order(answer, artifact)).toBe(true);
    // Narration stays inside the (collapsed) receipt — never at answer weight.
    expect(container.textContent).not.toContain("Looking at the data...");
  });

  test("suggestions block is stripped from the answer text", () => {
    const { getByTestId } = render(
      <AgentTurn
        parts={[
          sql(),
          text("Here you go.\n<suggestions>\nWhat about Q2?\n</suggestions>"),
        ]}
      />,
    );
    const answer = getByTestId("turn-answer");
    expect(answer.textContent).toContain("Here you go.");
    expect(answer.textContent).not.toContain("What about Q2?");
  });

  test("zero-tool turn renders the answer with no receipt", () => {
    const { queryByRole, getByTestId } = render(
      <AgentTurn parts={[text("Just an answer.")]} />,
    );
    expect(queryByRole("button")).toBeNull();
    expect(getByTestId("turn-answer").textContent).toContain("Just an answer.");
  });

  test("empty answer with no artifact: the receipt starts expanded so the work stays visible", () => {
    // An interrupted stream (or an approval-parked action) ends the turn with
    // activity only — collapsing it would hide the only content of the turn.
    const { getByRole, queryAllByTestId } = render(
      <AgentTurn parts={[text("Working on it..."), explore()]} />,
    );
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(queryAllByTestId("tool-part-stub")).toHaveLength(1);
  });

  test("empty answer with a promoted artifact: the receipt stays collapsed", () => {
    const { getByRole, getByTestId } = render(
      <AgentTurn parts={[explore(), sql()]} />,
    );
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(getByTestId("answer-artifact")).not.toBeNull();
  });

  test("pending interactive card with trailing answer text: the receipt starts expanded", () => {
    // An action approval's buttons are the turn's point — collapsing them
    // behind the receipt would stall the flow even though answer text exists.
    const pendingApproval = {
      type: "tool-sendEmail",
      toolCallId: "call-approval",
      state: "output-available",
      input: {},
      output: { status: "pending", actionId: "a1", summary: "Send the email" },
    } as TurnPart;
    const { getByRole, queryAllByTestId, getByTestId } = render(
      <AgentTurn parts={[pendingApproval, text("I need your approval to send this.")]} />,
    );
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(queryAllByTestId("tool-part-stub")).toHaveLength(1);
    expect(getByTestId("turn-answer").textContent).toContain("I need your approval");
  });

  test("resolved action with trailing answer text: the receipt stays collapsed", () => {
    const executed = {
      type: "tool-sendEmail",
      toolCallId: "call-executed",
      state: "output-available",
      input: {},
      output: { status: "executed", actionId: "a1", result: { ok: true } },
    } as TurnPart;
    const { getByRole } = render(
      <AgentTurn parts={[executed, text("The email went out.")]} />,
    );
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });
});
