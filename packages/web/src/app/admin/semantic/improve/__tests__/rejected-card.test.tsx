import { describe, expect, test, afterEach, mock } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { RejectedCard, type RejectedAmendment } from "../rejected";

// The Rejected view + Reconsider (#4512). RejectedCard is the presentational
// unit: it renders a rejected Amendment (entity, type, diff, rejection
// metadata) and offers exactly one action — Reconsider, which lifts the
// rejection. Tested in isolation from the chat harness (same split as
// proposals.ts / proposals.test.ts); this also transitively exercises the
// extracted amendment-display.tsx primitives (DiffViewer / formatAmendment).

afterEach(() => cleanup());

const base: RejectedAmendment = {
  id: "amd-r1",
  entityName: "orders",
  description: "[add_measure] orders: total revenue",
  confidence: 0.9,
  amendmentType: "add_measure",
  amendment: { name: "total_revenue", type: "number" },
  rationale: "Frequently aggregated in the audit log.",
  diff: "--- a/orders.yml\n+++ b/orders.yml\n+  - name: total_revenue",
  testQuery: null,
  testResult: null,
  rejectedAt: "2026-07-10T01:00:00Z",
  rejectedBy: "admin@test.dev",
  createdAt: "2026-07-10T00:00:00Z",
};

describe("RejectedCard", () => {
  test("renders the entity, type, rationale, and the diff", () => {
    const { container } = render(
      <RejectedCard amendment={base} onReconsider={() => {}} reconsidering={false} />,
    );
    expect(container.textContent).toContain("orders");
    // amendmentType is humanized (underscores → spaces).
    expect(container.textContent).toContain("add measure");
    expect(container.textContent).toContain("Frequently aggregated in the audit log.");
    // The stored diff renders (a `+` line survives the DiffViewer split).
    expect(container.textContent).toContain("+  - name: total_revenue");
    // Rejection provenance is surfaced.
    expect(container.textContent).toContain("admin@test.dev");
  });

  test("Reconsider button invokes onReconsider", () => {
    const onReconsider = mock(() => {});
    const { getByRole } = render(
      <RejectedCard amendment={base} onReconsider={onReconsider} reconsidering={false} />,
    );
    fireEvent.click(getByRole("button", { name: /reconsider/i }));
    expect(onReconsider).toHaveBeenCalledTimes(1);
  });

  test("Reconsider button is disabled while reconsidering is in flight", () => {
    const onReconsider = mock(() => {});
    const { getByRole } = render(
      <RejectedCard amendment={base} onReconsider={onReconsider} reconsidering={true} />,
    );
    const btn = getByRole("button", { name: /reconsider/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onReconsider).not.toHaveBeenCalled();
  });

  test("falls back to the amendment preview when no diff is present", () => {
    const noDiff: RejectedAmendment = { ...base, diff: null };
    const { container } = render(
      <RejectedCard amendment={noDiff} onReconsider={() => {}} reconsidering={false} />,
    );
    // formatAmendment renders the payload as key: value lines.
    expect(container.textContent).toContain("name: total_revenue");
  });

  test("tolerates a null rejectedAt/rejectedBy (legacy rows) without crashing", () => {
    const legacy: RejectedAmendment = { ...base, rejectedAt: null, rejectedBy: null };
    const { container } = render(
      <RejectedCard amendment={legacy} onReconsider={() => {}} reconsidering={false} />,
    );
    // Still renders the row + the bare "Rejected" label, no date/actor.
    expect(container.textContent).toContain("orders");
    expect(container.textContent).toContain("Rejected");
  });
});
