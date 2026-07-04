/**
 * Copy affordance on finished assistant answers (#4296): every finished turn
 * with answer text exposes a CopyButton that copies the answer's markdown
 * SOURCE with the <suggestions> block stripped. No answer text → no button;
 * still-streaming turns → no button (the answer is incomplete). Shared by the
 * chat transcript and the notebook cell output via AgentTurn.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React from "react";
import type { TurnPart } from "../turn-partitioner";

// Stub the heavy leaf renderers — this test pins the copy affordance, not
// card internals. CLAUDE.md "Mock all exports": tool-part.tsx exports only
// ToolPart; markdown.tsx exports only Markdown.
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

import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { AgentTurn } = await import("../agent-turn");

const writeTextMock = mock((_text: string) => Promise.resolve());

beforeEach(() => {
  writeTextMock.mockClear();
  // Use defineProperty to override readonly clipboard
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  });
});

afterEach(cleanup);

let nextCallId = 0;

function text(t: string): TurnPart {
  return { type: "text", text: t };
}

function sql(): TurnPart {
  return {
    type: "tool-executeSQL",
    toolCallId: `call-${nextCallId++}`,
    state: "output-available",
    input: { sql: "SELECT 1", explanation: "test" },
    output: { success: true, columns: ["n"], rows: [{ n: 1 }] },
  } as TurnPart;
}

function copyButton(container: HTMLElement): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Copy answer",
  ) ?? null;
}

describe("AgentTurn copy affordance", () => {
  test("answer with a <suggestions> block copies the markdown source without it", async () => {
    const answer =
      "US leads with **$200**.\n\n| region | sum |\n| --- | --- |\n| US | 200 |";
    // Narration BEFORE the tool part must never ride into the clipboard —
    // the copy source is the partitioner's answer bucket, not every text part.
    const { container } = render(
      <AgentTurn
        parts={[
          text("Looking at the data..."),
          sql(),
          text(`${answer}\n<suggestions>\nBreak down by month\n</suggestions>`),
        ]}
      />,
    );

    const button = copyButton(container);
    expect(button).not.toBeNull();
    fireEvent.click(button!);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(answer);
    });
    const copied = writeTextMock.mock.calls[0][0];
    expect(copied).not.toContain("<suggestions>");
    expect(copied).not.toContain("Break down by month");
    expect(copied).not.toContain("Looking at the data...");
  });

  test("multi-part answer copies all parts joined with a blank line", async () => {
    const { container } = render(
      <AgentTurn
        parts={[
          text("First paragraph."),
          text("Second paragraph.\n<suggestions>\nMore\n</suggestions>"),
        ]}
      />,
    );

    const button = copyButton(container);
    expect(button).not.toBeNull();
    fireEvent.click(button!);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        "First paragraph.\n\nSecond paragraph.",
      );
    });
  });

  test("exactly one copy button per turn even with multiple answer parts", () => {
    const { container } = render(
      <AgentTurn parts={[text("One."), text("Two.")]} />,
    );
    const buttons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent === "Copy answer",
    );
    expect(buttons.length).toBe(1);
  });

  test("no copy button while the turn is still streaming (settled answer, open stream)", () => {
    // #4300's settled-streaming state renders answer text before the stream
    // closes — copying then would hand out a truncated answer.
    const { container } = render(
      <AgentTurn parts={[sql(), text("US leads so far")]} streaming />,
    );
    expect(copyButton(container)).toBeNull();
  });

  test("no copy button when the turn has no answer text (interrupted stream)", () => {
    const { container } = render(<AgentTurn parts={[sql()]} />);
    expect(copyButton(container)).toBeNull();
  });

  test("no copy button when the answer is all <suggestions> block", () => {
    const { container } = render(
      <AgentTurn
        parts={[text("<suggestions>\nOnly chips\n</suggestions>")]}
      />,
    );
    expect(copyButton(container)).toBeNull();
  });
});
