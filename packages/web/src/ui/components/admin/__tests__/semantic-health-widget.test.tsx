import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";

/**
 * #4514 AC4 — the health widget must distinguish a parse-failure zero from a
 * no-data zero. A corrupt layer shows a "fix the YAML" caption; an empty layer
 * shows a "build the layer" caption; a healthy layer shows the sub-score bars.
 * Conflating all three as "0% coverage" gave no actionable signal.
 */

interface Score {
  overall: number;
  coverage: number;
  descriptionQuality: number;
  measureCoverage: number;
  joinCoverage: number;
  entityCount: number;
  dimensionCount: number;
  measureCount: number;
  glossaryTermCount: number;
  status?: "ok" | "no_entities" | "corrupt";
  parseFailures?: number;
  totalRows?: number;
}

let mockScore: Score | null = null;

void mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({ data: mockScore, loading: false, error: null, refetch: () => {} }),
}));

const { SemanticHealthWidget } = await import("../semantic-health-widget");

function baseScore(overrides: Partial<Score> = {}): Score {
  return {
    overall: 0,
    coverage: 0,
    descriptionQuality: 0,
    measureCoverage: 0,
    joinCoverage: 0,
    entityCount: 0,
    dimensionCount: 0,
    measureCount: 0,
    glossaryTermCount: 0,
    ...overrides,
  };
}

describe("SemanticHealthWidget — status discriminator (#4514)", () => {
  test("corrupt status shows the parse-failure caption, not the sub-score bars", () => {
    mockScore = baseScore({ status: "corrupt", parseFailures: 3, totalRows: 3 });
    const { container } = render(<SemanticHealthWidget />);
    expect(container.textContent).toContain("3 of 3 entities failed to parse");
    expect(container.textContent).not.toContain("Coverage");
  });

  test("no_entities status shows the build-the-layer caption", () => {
    mockScore = baseScore({ status: "no_entities" });
    const { container } = render(<SemanticHealthWidget />);
    expect(container.textContent).toContain("No entities yet");
    expect(container.textContent).not.toContain("failed to parse");
    expect(container.textContent).not.toContain("Coverage");
  });

  test("ok status renders the sub-score bars, no captions", () => {
    mockScore = baseScore({ status: "ok", overall: 82, coverage: 90, entityCount: 12 });
    const { container } = render(<SemanticHealthWidget />);
    expect(container.textContent).toContain("Coverage");
    expect(container.textContent).toContain("Descriptions");
    expect(container.textContent).not.toContain("failed to parse");
    expect(container.textContent).not.toContain("No entities yet");
  });

  test("a pre-#4514 response with no status degrades to the sub-score bars", () => {
    mockScore = baseScore({ overall: 70, coverage: 80 });
    const { container } = render(<SemanticHealthWidget />);
    expect(container.textContent).toContain("Coverage");
  });
});
