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
    const prompt = promptText(buildSystemParam("openai", { sourceCatalog: CATALOG }));
    expect(prompt).toContain("## Source catalog");
  });

  it("omits the catalog when empty (no behavior change vs. today)", () => {
    const withCatalog = promptText(buildSystemParam("openai", { sourceCatalog: "" }));
    const without = promptText(buildSystemParam("openai", { sourceCatalog: undefined }));
    expect(withCatalog).not.toContain("## Source catalog");
    expect(withCatalog).toBe(without);
  });

  it("keeps the durable memory block AFTER the catalog (memory-LAST invariant)", () => {
    const prompt = promptText(
      buildSystemParam("openai", { memoryBlock: MEMORY, sourceCatalog: CATALOG }),
    );
    expect(prompt).toContain("## Source catalog");
    expect(prompt).toContain("## Working memory");
    expect(prompt.indexOf("## Source catalog")).toBeLessThan(
      prompt.indexOf("## Working memory"),
    );
  });
});
