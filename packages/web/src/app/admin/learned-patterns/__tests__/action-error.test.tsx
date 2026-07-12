import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ActionErrorAlert } from "../action-error";

/**
 * Cockpit failure-honesty (#4574): the two affordances must be labelled for
 * what they do. The old page banner shipped a lone "Retry" whose handler only
 * called `setActionError(null)` — a dismiss masquerading as a retry. These pins
 * fail if the labels are swapped or the handlers are crossed.
 */
afterEach(() => {
  cleanup();
});

function findButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!btn) throw new Error(`button "${label}" not found`);
  return btn as HTMLButtonElement;
}

describe("ActionErrorAlert", () => {
  test("renders the friendly error copy inside an alert region", () => {
    render(
      <ActionErrorAlert
        error={{ message: "Approve failed", requestId: "req-lp-1" }}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );
    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Approve failed");
    // friendlyError threads the requestId through for a status-less failure.
    expect(alert?.textContent).toContain("req-lp-1");
  });

  test('"Retry" runs onRetry only — never the dismiss handler', () => {
    const onRetry = mock(() => {});
    const onDismiss = mock(() => {});
    render(
      <ActionErrorAlert
        error={{ message: "Reject failed" }}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(findButton("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('"Dismiss" runs onDismiss only — it does not retry', () => {
    const onRetry = mock(() => {});
    const onDismiss = mock(() => {});
    render(
      <ActionErrorAlert
        error={{ message: "Delete failed" }}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(findButton("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("exposes exactly one Retry and one Dismiss affordance", () => {
    render(
      <ActionErrorAlert
        error={{ message: "boom" }}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );
    const labels = Array.from(document.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels.filter((l) => l === "Retry")).toHaveLength(1);
    expect(labels.filter((l) => l === "Dismiss")).toHaveLength(1);
  });
});
