/**
 * The assistant turn's rendering — receipt, working phase, and copy affordance.
 *
 * Merged 2026-09-04 into this file; formerly also
 * agent-turn-copy.test.tsx (#4296) and working-phase.test.tsx (#4300).
 *
 * - Finished turn (#4298, AgentTurn's streaming=false shape): a turn renders
 *   receipt -> answer -> promoted artifact; the receipt expands on click to the
 *   full activity; narration never renders outside it.
 * - Live working phase (#4300): the activity feed renders one compact line per
 *   step from the moment of send, results accumulate collapsed (no card expands
 *   mid-flight), pending interactive cards still surface at full weight, and the
 *   feed settles into the TurnReceipt — preserving user-expanded state — once
 *   the answer streams.
 * - Copy affordance (#4296): every finished turn with answer text exposes a
 *   CopyButton that copies the answer's markdown SOURCE with the <suggestions>
 *   block stripped. No answer text -> no button; still-streaming turns -> no
 *   button. Shared by the chat transcript and the dashboard bound editor's
 *   drawer via AgentTurn.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React from "react";
import type { TurnPart } from "../turn-partitioner";

// Stub the heavy leaf renderers — these tests pin the partition/receipt and
// working-phase composition, not card internals. CLAUDE.md "Mock all exports":
// tool-part.tsx exports only ToolPart; markdown.tsx exports only Markdown.
void mock.module("@/ui/components/chat/tool-part", () => ({
  ToolPart: ({ part }: { part: unknown }) =>
    React.createElement(
      "div",
      { "data-testid": "tool-part-stub" },
      String((part as { type?: string }).type),
    ),
}));
void mock.module("@/ui/components/chat/markdown", () => ({
  Markdown: ({ content }: { content: string }) =>
    React.createElement("div", null, content),
}));

import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { TurnReceipt } = await import("../turn-receipt");
const { AgentTurn } = await import("../agent-turn");
const { partitionTurn } = await import("../turn-partitioner");
const { WorkingActivity, showPreStreamActivity } = await import("../working-activity");

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

function explore(state: "input-available" | "output-available" = "output-available"): TurnPart {
  return {
    type: "tool-explore",
    toolCallId: `call-${nextCallId++}`,
    state,
    input: { command: "ls" },
    ...(state === "output-available" ? { output: "entities.yml" } : {}),
  } as TurnPart;
}

function pendingApproval(): TurnPart {
  return {
    type: "tool-sendEmail",
    toolCallId: `call-${nextCallId++}`,
    state: "output-available",
    input: {},
    output: { status: "pending", actionId: "a1", summary: "Send the email" },
  } as TurnPart;
}

function copyButton(container: HTMLElement): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Copy answer",
  ) ?? null;
}

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

    // The receipt toggle is the only button carrying aria-expanded — the
    // answer's CopyButton (#4296) shares the turn now.
    const receipt = getByRole("button", { expanded: false });
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
    const { queryByRole, getByRole, getByTestId } = render(
      <AgentTurn parts={[text("Just an answer.")]} />,
    );
    // No receipt toggle (nothing carries aria-expanded) — the only button is
    // the answer's copy affordance (#4296).
    expect(queryByRole("button", { expanded: true })).toBeNull();
    expect(queryByRole("button", { expanded: false })).toBeNull();
    expect(getByRole("button", { name: "Copy answer" })).not.toBeNull();
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
    expect(getByRole("button", { expanded: true })).not.toBeNull();
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
    expect(getByRole("button", { expanded: false })).not.toBeNull();
  });
});

describe("WorkingActivity", () => {
  test("empty parts render a lone Working… line — visible from the moment of send", () => {
    const { getByTestId } = render(<WorkingActivity parts={[]} />);
    expect(getByTestId("working-activity")).not.toBeNull();
    expect(getByTestId("activity-working").textContent).toContain("Working…");
  });

  test("an in-flight step renders its active label and suppresses the trailing Working… line", () => {
    const { getByTestId, queryByTestId } = render(
      <WorkingActivity parts={[explore("input-available")]} />,
    );
    expect(getByTestId("activity-step").textContent).toContain("Reading semantic layer…");
    expect(queryByTestId("activity-working")).toBeNull();
  });

  test("completed steps tick to their done labels; results stay collapsed (no cards)", () => {
    const { getAllByTestId, getByTestId, queryAllByTestId } = render(
      <WorkingActivity parts={[explore(), sql()]} />,
    );
    const steps = getAllByTestId("activity-step");
    expect(steps).toHaveLength(2);
    expect(steps[0].textContent).toContain("Read semantic layer");
    expect(steps[1].textContent).toContain("Ran query");
    // No in-flight step — the trailing line keeps the container alive.
    expect(getByTestId("activity-working")).not.toBeNull();
    // Collapsed accumulation: completed results never render their cards.
    expect(queryAllByTestId("tool-part-stub")).toHaveLength(0);
  });

  test("a failed step carries a failure marker", () => {
    const { getByTestId } = render(<WorkingActivity parts={[sql(false)]} />);
    expect(getByTestId("activity-step").textContent).toContain("failed");
  });

  test("a pending interactive card renders at full weight, not as a line", () => {
    const { getAllByTestId, queryAllByTestId } = render(
      <WorkingActivity parts={[explore(), pendingApproval()]} />,
    );
    // The approval is a card; the explore stays a compact line.
    expect(getAllByTestId("tool-part-stub")).toHaveLength(1);
    expect(queryAllByTestId("activity-step")).toHaveLength(1);
  });

  test("an action envelope resolved to failed carries the failure marker, not a clean checkmark", () => {
    // Post-approval execution failure ({ status: "failed" } at
    // output-available, no `success` field) — the compact line is the ONLY
    // rendering of this step in the feed, so the marker must fire.
    const failedAction = {
      type: "tool-sendEmail",
      toolCallId: `call-${nextCallId++}`,
      state: "output-available",
      input: {},
      output: { status: "failed", actionId: "a1", error: "SMTP connection refused" },
    } as TurnPart;
    const { getByTestId } = render(<WorkingActivity parts={[failedAction]} />);
    expect(getByTestId("activity-step").textContent).toContain("failed");
  });

  test("unknown tools fall back to their wire name rather than vanishing", () => {
    const plugin = {
      type: "tool-somePluginAction",
      toolCallId: `call-${nextCallId++}`,
      state: "input-available",
      input: {},
    } as TurnPart;
    const { getByTestId } = render(<WorkingActivity parts={[plugin]} />);
    expect(getByTestId("activity-step").textContent).toContain("Running somePluginAction…");
  });

  test("narration renders as a muted feed line, suggestions stripped", () => {
    const { getByTestId, queryByText } = render(
      <WorkingActivity
        parts={[
          text("Checking the schema...\n<suggestions>\nQ2?\n</suggestions>"),
          explore("input-available"),
        ]}
      />,
    );
    expect(getByTestId("working-activity").textContent).toContain("Checking the schema...");
    expect(queryByText(/Q2\?/)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  AgentTurn — streaming lifecycle                                    */
/* ------------------------------------------------------------------ */

describe("AgentTurn (streaming)", () => {
  test("working phase: no answer yet → the live feed, no receipt", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentTurn parts={[explore(), sql()]} streaming />,
    );
    expect(getByTestId("working-activity")).not.toBeNull();
    expect(queryByTestId("turn-receipt")).toBeNull();
    expect(queryByTestId("answer-artifact")).toBeNull();
  });

  test("suggestions-only trailing text does not end the working phase", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentTurn
        parts={[explore(), text("<suggestions>\nQ2?\n</suggestions>")]}
        streaming
      />,
    );
    expect(getByTestId("working-activity")).not.toBeNull();
    expect(queryByTestId("turn-receipt")).toBeNull();
  });

  test("settles when the answer streams: receipt + answer, artifact held back", () => {
    const { getByTestId, getByRole, queryByTestId } = render(
      <AgentTurn parts={[explore(), sql(), text("The answer is 42.")]} streaming />,
    );
    expect(queryByTestId("working-activity")).toBeNull();
    expect(getByTestId("turn-answer").textContent).toContain("The answer is 42.");
    // Mid-stream the would-be artifact stays inside the receipt: the summary
    // counts the query and nothing expands next to the streaming answer.
    const toggle = getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Explored schema · 1 query");
    expect(queryByTestId("answer-artifact")).toBeNull();
  });

  test("stream end promotes the artifact out of the receipt", () => {
    const parts = [explore(), sql(), text("The answer is 42.")];
    const { rerender, getByTestId, getByRole } = render(
      <AgentTurn parts={parts} streaming />,
    );
    rerender(<AgentTurn parts={parts} streaming={false} />);
    expect(getByTestId("answer-artifact")).not.toBeNull();
    // Settling also reveals the answer's CopyButton (#4296) — locate the
    // receipt toggle by its aria-expanded state, not as the only button.
    const settledToggle = getByRole("button", { expanded: false });
    expect(settledToggle.textContent).toContain("Explored schema");
    expect(settledToggle.textContent).not.toContain("query");
  });

  test("a receipt expanded mid-stream stays expanded when the stream settles", () => {
    const parts = [explore(), sql(), text("The answer is 42.")];
    const { rerender, getByRole, queryAllByTestId } = render(
      <AgentTurn parts={parts} streaming />,
    );
    const toggle = getByRole("button");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    rerender(<AgentTurn parts={parts} streaming={false} />);
    // Settling also reveals the answer's CopyButton (#4296) — locate the
    // receipt toggle by its aria-expanded state, not as the only button.
    expect(getByRole("button", { expanded: true })).not.toBeNull();
    // Expanded receipt (explore card) + the now-promoted artifact.
    expect(queryAllByTestId("tool-part-stub")).toHaveLength(2);
  });

  test("interrupted during the working phase with only activity: receipt opens on settle", () => {
    // Stop / error / empty stream — streaming flips false with no answer text.
    const parts = [text("Working on it..."), explore()];
    const { rerender, getByRole, queryByTestId, getByTestId } = render(
      <AgentTurn parts={parts} streaming />,
    );
    expect(getByTestId("working-activity")).not.toBeNull();

    rerender(<AgentTurn parts={parts} streaming={false} />);
    expect(queryByTestId("working-activity")).toBeNull();
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("true");
  });

  test("no parts yet (assistant message just mounted): the feed renders, not a null receipt", () => {
    const empty = render(<AgentTurn parts={[]} streaming />);
    expect(empty.getByTestId("working-activity")).not.toBeNull();
    expect(empty.getByTestId("activity-working").textContent).toContain("Working…");
    empty.unmount();
    const undef = render(<AgentTurn parts={undefined} streaming />);
    expect(undef.getByTestId("working-activity")).not.toBeNull();
  });

  test("narration reclassified by a later step reopens the feed; the receipt remounts fresh on the next settle", () => {
    // v1 heuristic churn (documented in the AgentTurn comment): text streams
    // (settle), then another tool call arrives and partitionTurn reclassifies
    // the text as narration — the turn reverts to the working feed, and a
    // user-opened receipt is deliberately discarded (it remounts collapsed at
    // the next settle; there is no receipt while the feed is live).
    const settled = [explore(), sql(), text("Narration that looks like an answer.")];
    const { rerender, getByRole, getByTestId, queryByTestId } = render(
      <AgentTurn parts={settled} streaming />,
    );
    fireEvent.click(getByRole("button"));
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("true");

    const reopened = [...settled, explore("input-available")];
    rerender(<AgentTurn parts={reopened} streaming />);
    expect(getByTestId("working-activity")).not.toBeNull();
    expect(queryByTestId("turn-receipt")).toBeNull();

    rerender(<AgentTurn parts={[...reopened, text("The real answer.")]} streaming />);
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  test("pending interactive card mid-stream surfaces during the working phase", () => {
    const { getAllByTestId } = render(
      <AgentTurn parts={[explore(), pendingApproval()]} streaming />,
    );
    expect(getAllByTestId("tool-part-stub")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  showPreStreamActivity — the transcript's pre-stream gate           */
/* ------------------------------------------------------------------ */

describe("showPreStreamActivity", () => {
  test("first send of a fresh conversation (no messages at all) shows the feed", () => {
    // The old typing-dots gate (messages.length > 0) hid exactly this case.
    expect(showPreStreamActivity(true, undefined)).toBe(true);
  });

  test("turn in flight, last message is the user's: feed shows until the assistant mounts", () => {
    expect(showPreStreamActivity(true, "user")).toBe(true);
  });

  test("assistant message mounted: the streaming turn owns the feed, standalone hides", () => {
    expect(showPreStreamActivity(true, "assistant")).toBe(false);
  });

  test("idle transcript never shows the feed", () => {
    expect(showPreStreamActivity(false, "user")).toBe(false);
    expect(showPreStreamActivity(false, undefined)).toBe(false);
  });
});

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

  test("mixed answer parts: an all-suggestions part contributes nothing to the copy", async () => {
    const { container } = render(
      <AgentTurn
        parts={[
          text("Real answer."),
          text("<suggestions>\nOnly chips\n</suggestions>"),
        ]}
      />,
    );

    const button = copyButton(container);
    expect(button).not.toBeNull();
    fireEvent.click(button!);

    await waitFor(() => {
      // No trailing blank-line join from the empty stripped part.
      expect(writeTextMock).toHaveBeenCalledWith("Real answer.");
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
