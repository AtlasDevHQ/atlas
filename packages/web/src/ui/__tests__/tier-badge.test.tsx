/**
 * The tier chip, as the falsifiable half of ADR-0036's invariant (#5451).
 *
 * The invariant was carried by a model instruction, so it held statistically
 * and nothing would report a turn where the model simply omitted it. These
 * tests are the "or it fails" half: every tier renders a visible label, and the
 * unrecognized case renders something LOUD rather than nothing.
 */
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { ANSWER_TRUST_TIERS, TRUST_TIER_PRESENTATION } from "@useatlas/schemas";

import { TierBadge } from "../components/chat/tier-badge";

describe("TierBadge", () => {
  test("every tier in the vocabulary renders a visible label", () => {
    for (const tier of ANSWER_TRUST_TIERS) {
      const { container } = render(<TierBadge tier={tier} />);
      const badge = container.querySelector('[data-testid="tier-badge"]');
      expect(badge).not.toBeNull();
      expect(badge?.getAttribute("data-tier")).toBe(tier);
      expect(badge?.getAttribute("data-tier-known")).toBe("true");
      expect(badge?.textContent?.trim()).toBe(TRUST_TIER_PRESENTATION[tier].label);
    }
  });

  test("every tier carries an accessible name that explains it", () => {
    // The chip's word alone is not the label for someone using a screen reader,
    // and colour is not the label for anyone who cannot see it.
    for (const tier of ANSWER_TRUST_TIERS) {
      const { container } = render(<TierBadge tier={tier} />);
      const badge = container.querySelector('[data-testid="tier-badge"]');
      expect(badge?.getAttribute("aria-label")).toContain(
        TRUST_TIER_PRESENTATION[tier].meaning,
      );
      expect(badge?.getAttribute("title")).toBe(TRUST_TIER_PRESENTATION[tier].meaning);
    }
  });

  test("the three brain tiers are visually distinct — document is not collapsed into either", () => {
    const classes = (["fact", "raw-episode", "document"] as const).map((tier) => {
      const { container } = render(<TierBadge tier={tier} />);
      return container.querySelector('[data-testid="tier-badge"]')?.className ?? "";
    });
    expect(new Set(classes).size).toBe(3);
  });

  test("an unrecognized tier renders a loud chip, never nothing", () => {
    const { container } = render(<TierBadge tier="episode" />);
    const badge = container.querySelector('[data-testid="tier-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("data-tier-known")).toBe("false");
    expect(badge?.textContent).toContain("episode");
  });

  test("an empty tier still renders a chip", () => {
    // A row whose `tier` did not survive the wire is the failure this whole
    // component exists for; it must be visible, not absent.
    const { container } = render(<TierBadge tier="" />);
    expect(container.querySelector('[data-testid="tier-badge"]')).not.toBeNull();
  });
});
