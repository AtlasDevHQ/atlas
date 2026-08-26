/**
 * ADR-0036's tier label, on the embeddable widget (#5451).
 *
 * The invariant says "every UI surface", and the widget is one. The property
 * asserted is the same as the first-party chat's: **rows and chips are the same
 * count** — no row reaches a render path without a label, including rows this
 * build cannot classify.
 */
import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";

void mock.module("ai", () => ({
  getToolName: (part: Record<string, unknown>) => {
    if (!part || typeof part.toolName !== "string") throw new Error("No tool name");
    return part.toolName;
  },
}));

const { ToolPart } = await import("../chat/tool-part");
const { TierBadge } = await import("../chat/tier-badge");
const { ANSWER_TRUST_TIERS, TRUST_TIER_PRESENTATION } = await import("../../lib/trust-tier");

function part(toolName: string, input: unknown, output: unknown) {
  return { toolName, input, output, state: "output-available" };
}

function chips(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-testid="tier-badge"]'));
}

describe("widget tier label", () => {
  test("every tier renders a visible label with an accessible name", () => {
    for (const tier of ANSWER_TRUST_TIERS) {
      const { container } = render(<TierBadge tier={tier} />);
      const badge = chips(container)[0];
      expect(badge?.textContent?.trim()).toBe(TRUST_TIER_PRESENTATION[tier].label);
      expect(badge?.getAttribute("aria-label")).toContain(
        TRUST_TIER_PRESENTATION[tier].meaning,
      );
    }
  });

  test("an unrecognized tier renders loudly rather than not at all", () => {
    const { container } = render(<TierBadge tier="episode" />);
    expect(chips(container)).toHaveLength(1);
    expect(chips(container)[0]?.getAttribute("data-tier-known")).toBe("false");
  });

  test("searchBrain dispatches to the card and labels every row", () => {
    const { container } = render(
      <ToolPart
        part={part("searchBrain", { query: "who owns billing" }, {
          results: [
            { tier: "fact", subject: "Billing", predicate: "is owned by", object: "Payments", corroborationCount: 1, decay: { level: "fresh" } },
            { tier: "raw-episode", source: "slack", body: "we moved billing", extraction: "complete" },
            { tier: "document", path: "runbooks/billing.md", collection: "runbooks", title: "Billing runbook" },
          ],
          neighbors: [],
          tensionsTruncated: false,
        })}
      />,
    );
    expect(container.textContent).not.toContain("Tool: searchBrain");
    expect(container.querySelectorAll('[data-testid="brain-result"]')).toHaveLength(3);
    expect(chips(container).map((c) => c.getAttribute("data-tier"))).toEqual([
      "fact",
      "raw-episode",
      "document",
    ]);
  });

  test("executeSQL carries the warehouse tier — SURVEYED is this card", () => {
    const { container } = render(
      <ToolPart
        part={part("executeSQL", { sql: "SELECT 1", explanation: "Test" }, {
          success: true,
          columns: ["a"],
          rows: [{ a: 1 }],
        })}
      />,
    );
    expect(chips(container)[0]?.getAttribute("data-tier")).toBe("warehouse");
  });
});
