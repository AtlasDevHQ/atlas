/**
 * Direct unit coverage for `deriveTextCardTitle` (#4562) — the standalone SSOT
 * both authoring tools share. Previously exercised only transitively through the
 * tool suites; the blockquote-marker and length-cap branches had no coverage.
 */
import { describe, expect, it } from "bun:test";
import { deriveTextCardTitle } from "@atlas/api/lib/dashboard-text-card";

describe("deriveTextCardTitle", () => {
  it("strips a leading heading marker", () => {
    expect(deriveTextCardTitle("## Top of funnel")).toBe("Top of funnel");
  });

  it("strips a leading list bullet and takes the first non-empty line", () => {
    expect(deriveTextCardTitle("\n\n- A bullet\nmore")).toBe("A bullet");
  });

  it("strips a leading blockquote marker", () => {
    expect(deriveTextCardTitle("> quoted note")).toBe("quoted note");
  });

  it("caps the derived title at 120 characters", () => {
    const long = "x".repeat(200);
    expect(deriveTextCardTitle(long)).toHaveLength(120);
  });

  it("falls back to 'Section' on whitespace-only content", () => {
    expect(deriveTextCardTitle("   \n  ")).toBe("Section");
  });
});
