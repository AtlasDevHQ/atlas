/**
 * UsageChip — Settings → AI Agents per-row weighted-request gauge (#2216).
 *
 * The chip is a pure presentation component over `{ used, ceiling }`.
 * Three visual states pinned by tests:
 *
 *   - <80%   → neutral / default (informational)
 *   - 80–99% → amber soft-warning ("approaching the limit")
 *   - ≥100%  → red hard-cap, with display clamped to "100/100"
 *
 * The clamp is load-bearing — the API route also clamps `percentUsed`
 * server-side, but the chip ALSO accepts raw `used / ceiling` numbers
 * for cases where the page wants to show the live ratio without
 * round-tripping through the wire shape (e.g. an upcoming optimistic
 * local count for the agent's last dispatch). Both clamps must agree.
 */

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { UsageChip } from "../components/settings/usage-chip";

describe("UsageChip", () => {
  test("renders the literal used/ceiling pair below the soft-warning threshold", () => {
    const { container } = render(<UsageChip used={30} ceiling={60} />);
    expect(container.textContent).toContain("30/60");
  });

  test("uses the neutral tone class below 80%", () => {
    const { container } = render(<UsageChip used={47} ceiling={60} />);
    const root = container.querySelector("[data-tone]");
    expect(root?.getAttribute("data-tone")).toBe("ok");
  });

  test("flips to amber at the 80% soft-warning threshold", () => {
    // 48 / 60 = 80% — the threshold is inclusive on the lower bound so
    // a precise hit on the boundary already trips the warning.
    const { container } = render(<UsageChip used={48} ceiling={60} />);
    const root = container.querySelector("[data-tone]");
    expect(root?.getAttribute("data-tone")).toBe("warn");
  });

  test("renders amber tone class for percent=85", () => {
    const { container } = render(<UsageChip used={51} ceiling={60} />);
    expect(container.textContent).toContain("51/60");
    const root = container.querySelector("[data-tone]");
    expect(root?.getAttribute("data-tone")).toBe("warn");
  });

  test("renders red tone class at exactly 100%", () => {
    const { container } = render(<UsageChip used={60} ceiling={60} />);
    const root = container.querySelector("[data-tone]");
    expect(root?.getAttribute("data-tone")).toBe("danger");
    expect(container.textContent).toContain("60/60");
  });

  test("clamps display to ceiling/ceiling when used exceeds the ceiling", () => {
    // A future limiter regression that allowed bucket overshoot would
    // surface as "65/60" in the chip — visually misleading. The clamp
    // makes the saturated chip render exactly at the cap regardless of
    // the input ratio.
    const { container } = render(<UsageChip used={65} ceiling={60} />);
    expect(container.textContent).toContain("60/60");
    const root = container.querySelector("[data-tone]");
    expect(root?.getAttribute("data-tone")).toBe("danger");
  });

  test("treats ceiling=0 as a degenerate state and does not divide-by-zero", () => {
    // Defensive: a misconfigured upstream passing ceiling=0 must render
    // a stable, visible chip rather than NaN%, and must NOT classify as
    // "100% danger" (that would falsely indicate a saturated bucket).
    const { container } = render(<UsageChip used={5} ceiling={0} />);
    const root = container.querySelector("[data-tone]");
    expect(root?.getAttribute("data-tone")).toBe("ok");
    // The numeric label still renders — operators looking at the chip
    // can see the underlying numbers and recognize the misconfiguration.
    expect(container.textContent).toContain("5/0");
  });

  test("rounds to a whole number — no fractional percent label leaks", () => {
    // 11 / 60 = 18.33% — the chip displays a whole-percent in its
    // accessible label. A regression that wrote 18.333333% would slip
    // through the visible text but would surface in the aria-label test.
    const { container } = render(<UsageChip used={11} ceiling={60} />);
    const root = container.querySelector("[role='img']");
    expect(root?.getAttribute("aria-label")).toMatch(/(18|19)% used/);
  });
});
