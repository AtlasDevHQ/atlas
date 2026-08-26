/**
 * `searchBrain`'s card, and the one property that makes ADR-0036's invariant
 * falsifiable on this surface (#5451): **rows and chips are the same count.**
 *
 * That is the assertion worth having. "A fact renders a fact chip" would pass
 * on a card that dropped the other two classes; counting proves no row reached
 * the render path without a label, which is the thing the invariant asserts and
 * the thing that was untrue everywhere before this.
 */
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";

import { SearchBrainCard } from "../components/chat/search-brain-card";

function part(output: unknown, state = "output-available") {
  return { toolName: "searchBrain", input: { query: "who owns billing" }, output, state };
}

const FACT = {
  tier: "fact",
  trustTier: 2,
  id: "f1",
  subject: "Billing",
  predicate: "is owned by",
  object: "Payments team",
  status: "published",
  validFrom: "2026-03-01T00:00:00.000Z",
  validTo: null,
  ingestedAt: null,
  snippet: "Billing <b>is owned by</b> Payments team",
  provenance: { attribution: { visible: false } },
  corroborationCount: 3,
  decay: { level: "aging", ageDays: 120, lastObservedAt: null },
  tensions: [],
};

const EPISODE = {
  tier: "raw-episode",
  trustTier: 3,
  id: "e1",
  source: "slack",
  sourceId: "C123/p1",
  sourceActor: "slack:U0AQW6KF2EM",
  body: "we moved billing under payments last quarter",
  bodyTruncated: false,
  locator: null,
  occurredAt: "2026-02-14T00:00:00.000Z",
  ingestedAt: null,
  snippet: null,
  extraction: "pending",
  extractedAt: null,
};

const DOCUMENT = {
  tier: "document",
  trustTier: null,
  path: "runbooks/billing.md",
  collection: "runbooks",
  title: "Billing runbook",
  snippet: "escalation path for <b>billing</b>",
  provenance: { type: null, tags: [], resource: null, source: null, ingestedAt: null, timestamp: null, status: "published" },
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    results: [],
    neighbors: [],
    stores: {
      fact: { queried: true, matched: 0, truncated: false },
      "raw-episode": { queried: true, matched: 0, truncated: false },
      document: { queried: true, matched: 0, truncated: false },
    },
    tensionsTruncated: false,
    unavailable: null,
    ...overrides,
  };
}

function chips(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-testid="tier-badge"]'));
}

function rows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-testid="brain-result"]'));
}

describe("SearchBrainCard", () => {
  test("every rendered row carries exactly one tier chip", () => {
    const { container } = render(
      <SearchBrainCard part={part(response({ results: [FACT, EPISODE, DOCUMENT] }))} />,
    );
    expect(rows(container)).toHaveLength(3);
    expect(chips(container)).toHaveLength(3);
    for (const row of rows(container)) {
      expect(row.querySelectorAll('[data-testid="tier-badge"]')).toHaveLength(1);
    }
  });

  test("the three tiers render as three distinct labels", () => {
    const { container } = render(
      <SearchBrainCard part={part(response({ results: [FACT, EPISODE, DOCUMENT] }))} />,
    );
    const labels = chips(container).map((c) => c.getAttribute("data-tier"));
    expect(labels).toEqual(["fact", "raw-episode", "document"]);
    expect(new Set(chips(container).map((c) => c.textContent?.trim())).size).toBe(3);
  });

  test("document is not collapsed into a brain tier", () => {
    const { container } = render(<SearchBrainCard part={part(response({ results: [DOCUMENT] }))} />);
    const chip = chips(container)[0];
    expect(chip?.getAttribute("data-tier")).toBe("document");
    expect(chip?.textContent).not.toContain("fact");
    expect(chip?.textContent).not.toContain("episode");
  });

  test("1-hop neighbors are labeled too — an expansion result is not a lesser class of row", () => {
    const neighbor = { ...DOCUMENT, path: "runbooks/dunning.md", via: ["runbooks/billing.md"], direction: ["outbound"], anchors: [] };
    const { container } = render(
      <SearchBrainCard part={part(response({ results: [FACT], neighbors: [neighbor] }))} />,
    );
    expect(rows(container)).toHaveLength(2);
    expect(chips(container)).toHaveLength(2);
    expect(chips(container)[1]?.getAttribute("data-tier")).toBe("document");
  });

  test("a row with an unrecognized tier is still rendered, and still chipped", () => {
    // The regression this whole issue is about: a tier value reaching a render
    // path with no label. It must be impossible to draw a row without one.
    const { container } = render(
      <SearchBrainCard part={part(response({ results: [{ tier: "episode", snippet: "stray" }, {}] }))} />,
    );
    expect(rows(container)).toHaveLength(2);
    expect(chips(container)).toHaveLength(2);
    for (const chip of chips(container)) {
      expect(chip.getAttribute("data-tier-known")).toBe("false");
      expect(chip.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  test("the fact row shows its claim and its age, not just a chip", () => {
    const { container } = render(<SearchBrainCard part={part(response({ results: [FACT] }))} />);
    expect(container.textContent).toContain("Billing is owned by Payments team");
    expect(container.textContent).toContain("aging");
    expect(container.textContent).toContain("3 sources");
  });

  test("the episode row names its source and that it is not yet distilled", () => {
    const { container } = render(<SearchBrainCard part={part(response({ results: [EPISODE] }))} />);
    expect(container.textContent).toContain("we moved billing under payments");
    expect(container.textContent).toContain("slack");
    expect(container.textContent).toContain("not yet distilled");
  });

  test("`unavailable` reads as 'could not search', never as 'nothing is known'", () => {
    const { container } = render(
      <SearchBrainCard part={part(response({ unavailable: "no_workspace" }))} />,
    );
    expect(container.textContent).toContain("could not be searched");
    expect(container.textContent).not.toContain("nothing matched");
  });

  test("an empty read says it searched and matched nothing", () => {
    const { container } = render(<SearchBrainCard part={part(response())} />);
    expect(container.textContent).toContain("nothing matched");
    expect(chips(container)).toHaveLength(0);
  });

  test("an `{ error }` envelope renders its prose verbatim", () => {
    const { container } = render(
      <SearchBrainCard part={part({ error: "Company Atlas search was refused: ..." })} />,
    );
    expect(container.textContent).toContain("Company Atlas search was refused");
  });

  test("an in-flight call shows a loading card, not an empty result", () => {
    const { container } = render(<SearchBrainCard part={part(null, "input-available")} />);
    expect(container.textContent).toContain("Searching the Atlas");
    expect(container.textContent).not.toContain("nothing matched");
  });
});
