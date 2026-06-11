/**
 * Component tests for DeliveryStatusBadge (#3379).
 *
 * Pins the distinct `failed_permanent` rendering — a permanent
 * (misconfiguration) delivery failure must be visually distinguishable from
 * a transient `failed` so admins know retrying won't help.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import React, { type ReactNode } from "react";

// Tooltip primitives portal their content; stub them to passthrough divs so
// the error text is assertable in the rendered tree. CLAUDE.md "Mock all
// exports" — the module exports exactly these four.
mock.module("@/components/ui/tooltip", () => {
  const passthrough =
    (tag: string) =>
    ({ children, asChild: _asChild, ...rest }: { children?: ReactNode; asChild?: boolean } & Record<string, unknown>) =>
      React.createElement(tag, rest, children as React.ReactNode);
  const div = passthrough("div");
  return {
    Tooltip: div,
    TooltipTrigger: div,
    TooltipContent: div,
    TooltipProvider: div,
  };
});

import { render, cleanup } from "@testing-library/react";

const { DeliveryStatusBadge } = await import("../delivery-status-badge");

afterEach(() => {
  cleanup();
});

describe("DeliveryStatusBadge", () => {
  test("renders an em dash for null status", () => {
    const { container } = render(<DeliveryStatusBadge status={null} error={null} />);
    expect(container.textContent).toBe("—");
  });

  test("renders sent and failed with their canonical labels", () => {
    const sent = render(<DeliveryStatusBadge status="sent" error={null} />);
    expect(sent.container.textContent).toBe("sent");
    cleanup();
    const failed = render(<DeliveryStatusBadge status="failed" error={null} />);
    expect(failed.container.textContent).toBe("failed");
  });

  test("renders failed_permanent with a distinct config label (#3379)", () => {
    const { container } = render(
      <DeliveryStatusBadge status="failed_permanent" error={null} />,
    );
    // Distinct from plain "failed" — signals misconfiguration, not a
    // transient outage.
    expect(container.textContent).toContain("failed — config");
    expect(container.textContent).not.toBe("failed");
  });

  test("surfaces the misconfiguration error in the tooltip for failed_permanent (#3379)", () => {
    const { container } = render(
      <DeliveryStatusBadge
        status="failed_permanent"
        error="All 1 deliveries failed — No email delivery backend configured"
      />,
    );
    expect(container.textContent).toContain("failed — config");
    expect(container.textContent).toContain("No email delivery backend configured");
  });

  test("unknown statuses still fall back to the outline badge", () => {
    const { container } = render(
      <DeliveryStatusBadge status="pending" error={null} />,
    );
    expect(container.textContent).toBe("pending");
  });
});
