/**
 * Component tests for the live working phase (#4300): the activity feed
 * renders one compact line per step from the moment of send, results
 * accumulate collapsed (no card expands mid-flight), pending interactive
 * cards still surface at full weight, and the feed settles into the
 * TurnReceipt — preserving user-expanded state — once the answer streams.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import React from "react";
import type { TurnPart } from "../turn-partitioner";

// Stub the heavy leaf renderers — these tests pin the working-phase
// composition, not card internals. CLAUDE.md "Mock all exports":
// tool-part.tsx exports only ToolPart; markdown.tsx exports only Markdown.
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

const { WorkingActivity, showPreStreamActivity } = await import("../working-activity");
const { AgentTurn } = await import("../agent-turn");

afterEach(cleanup);

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

let nextCallId = 0;

function text(t: string): TurnPart {
  return { type: "text", text: t };
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

function pendingApproval(): TurnPart {
  return {
    type: "tool-sendEmail",
    toolCallId: `call-${nextCallId++}`,
    state: "output-available",
    input: {},
    output: { status: "pending", actionId: "a1", summary: "Send the email" },
  } as TurnPart;
}

/* ------------------------------------------------------------------ */
/*  WorkingActivity — the live feed                                    */
/* ------------------------------------------------------------------ */

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
    expect(getByRole("button").textContent).toContain("Explored schema");
    expect(getByRole("button").textContent).not.toContain("query");
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
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("true");
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
