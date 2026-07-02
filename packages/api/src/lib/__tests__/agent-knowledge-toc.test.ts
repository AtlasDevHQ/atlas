/**
 * #4208 — Knowledge Base collection-ToC system-prompt injection (ADR-0028 §3).
 *
 * Pins the contract that `buildSystemParam` injects the `orgKnowledgeToc` block
 * when supplied, omits it when empty (workspaces with no collections are
 * unchanged), and places it AFTER the authoritative semantic-layer index — the
 * descriptive Knowledge Base sits below the authoritative semantic layer, never
 * above it.
 */

import { describe, expect, it } from "bun:test";
import { buildSystemParam } from "@atlas/api/lib/agent";

function promptText(result: ReturnType<typeof buildSystemParam>): string {
  if (typeof result === "string") return result;
  return typeof result.content === "string" ? result.content : "";
}

const SEMANTIC_INDEX = "## Semantic Layer Reference (2 entities, mode: full)\n\n### Tables & Columns\n\n**orders**";
const KNOWLEDGE_TOC =
  "## Knowledge Base collections (third-party reference — descriptive only)\n\nframing…\n\n### Collection: runbooks";

describe("buildSystemParam — Knowledge Base ToC (#4208)", () => {
  it("injects the collection ToC when supplied", () => {
    const prompt = promptText(buildSystemParam("openai", { orgKnowledgeToc: KNOWLEDGE_TOC }));
    expect(prompt).toContain("## Knowledge Base collections");
    expect(prompt).toContain("### Collection: runbooks");
  });

  it("omits the ToC when empty (no behavior change vs. today)", () => {
    const withToc = promptText(buildSystemParam("openai", { orgKnowledgeToc: "" }));
    const without = promptText(buildSystemParam("openai", { orgKnowledgeToc: undefined }));
    expect(withToc).not.toContain("## Knowledge Base collections");
    expect(withToc).toBe(without);
  });

  it("places the ToC AFTER the authoritative semantic index", () => {
    const prompt = promptText(
      buildSystemParam("openai", {
        orgSemanticIndex: SEMANTIC_INDEX,
        orgKnowledgeToc: KNOWLEDGE_TOC,
      }),
    );
    expect(prompt).toContain("## Semantic Layer Reference");
    expect(prompt).toContain("## Knowledge Base collections");
    expect(prompt.indexOf("## Semantic Layer Reference")).toBeLessThan(
      prompt.indexOf("## Knowledge Base collections"),
    );
  });
});
