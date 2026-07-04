/**
 * #4322 — the bound editor's building tools get first-class receipt cards
 * (icon + what changed) instead of the gray "Tool: addCard" fallback. These
 * tests pin: (1) DashboardEditCard renders a labeled success/summary line,
 * (2) the error envelope surfaces the sanitized message, and (3) ToolPart
 * routes the building-tool names here rather than to the generic box.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";

const { DashboardEditCard } = await import("../dashboard-edit-card");
const { ToolPart } = await import("../tool-part");

afterEach(cleanup);

function toolPart(name: string, output: unknown) {
  return {
    type: `tool-${name}`,
    toolCallId: `call-${name}`,
    state: "output-available" as const,
    input: {},
    output,
  } as unknown;
}

describe("DashboardEditCard", () => {
  test("addCard success renders the card title, not a gray box", () => {
    const { getByTestId, queryByText } = render(
      <DashboardEditCard
        part={toolPart("addCard", {
          kind: "ok",
          card: { id: "c1", title: "Weekly signups", chartType: "bar", position: 0 },
        })}
      />,
    );
    const card = getByTestId("dashboard-edit-card");
    expect(card.getAttribute("data-tool")).toBe("addCard");
    expect(card.getAttribute("data-state")).toBe("ok");
    expect(card.textContent).toContain("Added a card");
    expect(card.textContent).toContain("Weekly signups");
    // Never the generic fallback copy.
    expect(queryByText(/^Tool: /)).toBeNull();
  });

  test("getDashboardState success summarizes the card count", () => {
    const { getByTestId } = render(
      <DashboardEditCard
        part={toolPart("getDashboardState", {
          kind: "ok",
          dashboard: { title: "Sales", cardCount: 3 },
          summary: "…",
        })}
      />,
    );
    const card = getByTestId("dashboard-edit-card");
    expect(card.textContent).toContain("Read the dashboard");
    expect(card.textContent).toContain("3 cards");
  });

  test("updateLayout partial failure shows the failed count", () => {
    const { getByTestId } = render(
      <DashboardEditCard
        part={toolPart("updateLayout", {
          kind: "partial",
          results: [
            { cardId: "a", ok: true },
            { cardId: "b", ok: false, reason: "bad" },
          ],
          failedCount: 1,
        })}
      />,
    );
    const card = getByTestId("dashboard-edit-card");
    expect(card.getAttribute("data-state")).toBe("partial");
    expect(card.textContent).toContain("1 failed");
  });

  test("error envelope surfaces the sanitized message", () => {
    const { getByTestId, getByRole } = render(
      <DashboardEditCard
        part={toolPart("addCard", {
          kind: "err",
          error: "SQL validation failed: syntax error. Fix the query and retry.",
        })}
      />,
    );
    expect(getByTestId("dashboard-edit-card").getAttribute("data-state")).toBe("err");
    expect(getByRole("alert").textContent).toContain("SQL validation failed");
  });

  test("in-flight (no output) renders the active label", () => {
    const { getByTestId } = render(
      <DashboardEditCard
        part={{ type: "tool-addCard", toolCallId: "c", state: "input-available", input: {} }}
      />,
    );
    expect(getByTestId("dashboard-edit-card").textContent).toContain("Adding a card…");
  });
});

describe("ToolPart routes building tools to DashboardEditCard", () => {
  for (const name of [
    "addCard",
    "getDashboardState",
    "getCardDetail",
    "updateCard",
    "updateLayout",
    "updateDashboardMeta",
  ]) {
    test(`${name} → first-class edit card (no gray fallback)`, () => {
      const { getByTestId, queryByText } = render(
        <ToolPart part={toolPart(name, { kind: "ok" })} />,
      );
      expect(getByTestId("dashboard-edit-card").getAttribute("data-tool")).toBe(name);
      expect(queryByText(`Tool: ${name}`)).toBeNull();
    });
  }
});
