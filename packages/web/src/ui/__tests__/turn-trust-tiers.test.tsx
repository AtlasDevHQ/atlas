/**
 * The tier reaches the reader WITHOUT a click (#5451).
 *
 * This is the test that would have failed on a card-only fix. Every tool card
 * carrying a tier lives inside the turn receipt, and a finished turn renders
 * that receipt COLLAPSED — so "a surface renders the tier" can be true while
 * the reading experience is unchanged: answer prose, a summary line, no label.
 * The assertions below are about the collapsed row.
 */
import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";

void mock.module("next/dynamic", () => ({
  default: () => function DynamicStub() {
    return <div data-testid="chart-placeholder" />;
  },
}));

const { TurnReceipt } = await import("../components/chat/turn-receipt");
const { answerTrustTiers, summarizeActivity } = await import(
  "../components/chat/turn-partitioner"
);

function toolPart(toolName: string, output: unknown, state = "output-available") {
  return { type: `tool-${toolName}`, toolCallId: `c-${toolName}`, input: {}, output, state };
}

function activity(...parts: unknown[]) {
  return parts.map((part, index) => ({ part, index })) as never;
}

const SQL_OK = toolPart("executeSQL", { success: true, columns: ["a"], rows: [{ a: 1 }] });
const SQL_FAILED = toolPart("executeSQL", { success: false, error: "boom" });
const BRAIN = toolPart("searchBrain", {
  results: [
    { tier: "raw-episode", source: "slack", body: "we moved billing" },
    { tier: "fact", subject: "Billing", predicate: "is owned by", object: "Payments" },
  ],
  neighbors: [{ tier: "document", path: "runbooks/billing.md", title: "Billing runbook" }],
});

describe("answerTrustTiers", () => {
  test("a SQL turn contributes warehouse — SURVEYED, which searchBrain never carries", () => {
    expect(answerTrustTiers(activity(SQL_OK))).toEqual(["warehouse"]);
  });

  test("a failed query contributes nothing — it grounded no part of the answer", () => {
    expect(answerTrustTiers(activity(SQL_FAILED))).toEqual([]);
  });

  test("searchBrain contributes each distinct row tier, neighbors included", () => {
    expect(answerTrustTiers(activity(BRAIN))).toEqual(["fact", "raw-episode", "document"]);
  });

  test("a mixed turn reports every tier once, in trust order", () => {
    expect(answerTrustTiers(activity(SQL_OK, BRAIN, SQL_OK))).toEqual([
      "warehouse",
      "fact",
      "raw-episode",
      "document",
    ]);
  });

  test("an unrecognized row tier is carried through, not filtered out", () => {
    // Filtering here is how a tier would reach a reader unlabelled — the
    // whole regression. It must survive to the badge, which draws it loudly.
    const tiers = answerTrustTiers(
      activity(toolPart("searchBrain", { results: [{ tier: "episode" }, {}] })),
    );
    expect(tiers).toContain("episode");
    expect(tiers).toContain("");
  });

  test("an in-flight searchBrain contributes nothing yet", () => {
    expect(
      answerTrustTiers(activity(toolPart("searchBrain", null, "input-available"))),
    ).toEqual([]);
  });
});

describe("TurnReceipt", () => {
  test("renders the tier chips on the COLLAPSED row", () => {
    const { container } = render(<TurnReceipt activity={activity(SQL_OK, BRAIN)} />);
    // Collapsed: the receipt body is absent, so anything asserted below is
    // what a reader sees without interacting.
    expect(container.querySelector("[aria-expanded='true']")).toBeNull();
    const chips = Array.from(container.querySelectorAll('[data-testid="tier-badge"]'));
    expect(chips.map((c) => c.getAttribute("data-tier"))).toEqual([
      "warehouse",
      "fact",
      "raw-episode",
      "document",
    ]);
  });

  test("the chip row carries an accessible name naming every tier", () => {
    const { container } = render(<TurnReceipt activity={activity(BRAIN)} />);
    const row = container.querySelector('[data-testid="turn-trust-tiers"]');
    expect(row?.getAttribute("aria-label")).toBe(
      "Grounded in: fact, raw-episode, document",
    );
  });

  test("a turn that grounded in nothing shows no chip row", () => {
    const { container } = render(
      <TurnReceipt activity={activity(toolPart("explore", "entities/"))} />,
    );
    expect(container.querySelector('[data-testid="turn-trust-tiers"]')).toBeNull();
  });

  test("the summary line names the Atlas read rather than counting it as a step", () => {
    expect(summarizeActivity(activity(BRAIN))).toBe("Searched the Atlas");
    expect(summarizeActivity(activity(SQL_OK, BRAIN))).toBe("1 query · Searched the Atlas");
    expect(summarizeActivity(activity(BRAIN, BRAIN))).toBe("2 Atlas searches");
  });
});
