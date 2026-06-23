/**
 * #3894 — Source-catalog system-prompt injection (ADR-0022 §4).
 *
 * Pins the contract that `buildSystemParam` injects the Source-catalog block
 * when one is supplied, omits it when empty (single-source / no-DB workspaces
 * unchanged), and keeps the durable working-memory block LAST (the #3755
 * invariant) — the catalog sits ahead of memory, not after it.
 */

import { describe, expect, it } from "bun:test";
import { buildSystemParam } from "@atlas/api/lib/agent";

function promptText(result: ReturnType<typeof buildSystemParam>): string {
  if (typeof result === "string") return result;
  return typeof result.content === "string" ? result.content : "";
}

const CATALOG = "## Source catalog\n\nPick the data source...";
const MEMORY = "## Working memory\n\n- foo: bar";

describe("buildSystemParam — Source catalog (#3894)", () => {
  it("injects the catalog block when supplied", () => {
    const prompt = promptText(
      buildSystemParam(
        "openai",
        undefined, // registry
        undefined, // warnings
        undefined, // orgSemanticIndex
        undefined, // learnedPatternsSection
        undefined, // routingContext
        undefined, // boundDashboardContext
        "developer",
        undefined, // restRepresentation
        undefined, // modelId
        undefined, // memoryBlock
        CATALOG, // sourceCatalog
      ),
    );
    expect(prompt).toContain("## Source catalog");
  });

  it("omits the catalog when empty (no behavior change vs. today)", () => {
    const withCatalog = promptText(
      buildSystemParam(
        "openai", undefined, undefined, undefined, undefined, undefined,
        undefined, "developer", undefined, undefined, undefined, "",
      ),
    );
    const without = promptText(
      buildSystemParam(
        "openai", undefined, undefined, undefined, undefined, undefined,
        undefined, "developer", undefined, undefined, undefined, undefined,
      ),
    );
    expect(withCatalog).not.toContain("## Source catalog");
    expect(withCatalog).toBe(without);
  });

  it("keeps the durable memory block AFTER the catalog (memory-LAST invariant)", () => {
    const prompt = promptText(
      buildSystemParam(
        "openai", undefined, undefined, undefined, undefined, undefined,
        undefined, "developer", undefined, undefined, MEMORY, CATALOG,
      ),
    );
    expect(prompt).toContain("## Source catalog");
    expect(prompt).toContain("## Working memory");
    expect(prompt.indexOf("## Source catalog")).toBeLessThan(
      prompt.indexOf("## Working memory"),
    );
  });
});
