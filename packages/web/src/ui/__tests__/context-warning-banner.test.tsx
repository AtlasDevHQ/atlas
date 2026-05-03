import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { ContextWarningBanner } from "../components/chat/context-warning-banner";
import type { ChatContextWarning } from "@useatlas/types";

describe("ContextWarningBanner", () => {
  test("renders nothing when warnings array is empty", () => {
    const { container } = render(<ContextWarningBanner warnings={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders a single context warning with code, title, detail, requestId", () => {
    const warnings: ChatContextWarning[] = [
      {
        severity: "warning",
        code: "semantic_layer_unavailable",
        title: "Semantic layer unavailable",
        detail: "Falling back to defaults.",
        requestId: "req-abc",
      },
    ];
    const { container } = render(<ContextWarningBanner warnings={warnings} />);
    expect(container.textContent).toContain("Semantic layer unavailable");
    expect(container.textContent).toContain("Falling back to defaults.");
    expect(container.textContent).toContain("semantic_layer_unavailable");
    expect(container.textContent).toContain("req-abc");
  });

  test("renders all context warning codes (semantic / learned-patterns / plan-limit)", () => {
    const warnings: ChatContextWarning[] = [
      {
        severity: "warning",
        code: "plan_limit_warning",
        title: "Approaching plan limit",
        detail: "You are at 85% of your monthly token budget.",
      },
      {
        severity: "warning",
        code: "semantic_layer_unavailable",
        title: "Semantic layer unavailable",
      },
      {
        severity: "warning",
        code: "learned_patterns_unavailable",
        title: "Learned patterns unavailable",
      },
    ];
    const { container } = render(<ContextWarningBanner warnings={warnings} />);
    expect(container.textContent).toContain("Approaching plan limit");
    expect(container.textContent).toContain("Semantic layer unavailable");
    expect(container.textContent).toContain("Learned patterns unavailable");
    expect(container.textContent).toContain("plan_limit_warning");
    expect(container.textContent).toContain("semantic_layer_unavailable");
    expect(container.textContent).toContain("learned_patterns_unavailable");
  });

  test("uses role=alert for accessibility", () => {
    const warnings: ChatContextWarning[] = [
      {
        severity: "warning",
        code: "semantic_layer_unavailable",
        title: "x",
      },
    ];
    const { container } = render(<ContextWarningBanner warnings={warnings} />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
  });

  test("renders code as monospace tag", () => {
    const warnings: ChatContextWarning[] = [
      {
        severity: "warning",
        code: "semantic_layer_unavailable",
        title: "x",
      },
    ];
    const { container } = render(<ContextWarningBanner warnings={warnings} />);
    // code is rendered with a font-mono class so the catalog code reads as a tag
    const codeEl = container.querySelector(".font-mono");
    expect(codeEl).not.toBeNull();
    expect(codeEl?.textContent).toBe("semantic_layer_unavailable");
  });

  test("renders as the non-destructive 'warning' variant (degraded ≠ failure)", () => {
    const warnings: ChatContextWarning[] = [
      {
        severity: "warning",
        code: "semantic_layer_unavailable",
        title: "x",
      },
    ];
    const { container } = render(<ContextWarningBanner warnings={warnings} />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    // The error-banner is the destructive treatment; this banner must
    // declare itself as the warning variant so future restyles cannot
    // accidentally lift it to destructive (which would scare users away
    // from a still-useful answer). data-variant is the stable behavioral
    // marker — not the className, which is volatile.
    expect(alert?.getAttribute("data-variant")).toBe("warning");
    // SVG presence as a cheap pin against an icon swap.
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
