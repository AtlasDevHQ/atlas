/**
 * #3909 — Cross-source composition prompt guidance (ADR-0022 §2, slice (d)).
 *
 * Pins the contract that `buildSystemParam` carries explicit cross-source
 * composition guidance whenever a Source catalog is in reach (≥1 reachable
 * source), and nothing when there is no catalog (single-source / no-internal-DB
 * workspaces unchanged). The guidance teaches the agent to query each relevant
 * source and correlate the result sets by reasoning — never a cross-engine JOIN
 * or federated query engine — to report provenance, and to refuse a silent
 * fallback to an unrelated source.
 *
 * The guidance lives in the SYSTEM prompt (not the message transcript), riding
 * on the catalog block, and sits ahead of the durable working-memory block so
 * the memory-LAST invariant (#3755) still holds.
 */

import { describe, expect, it } from "bun:test";
import { buildSystemParam } from "@atlas/api/lib/agent";

function promptText(result: ReturnType<typeof buildSystemParam>): string {
  if (typeof result === "string") return result;
  return typeof result.content === "string" ? result.content : "";
}

const CATALOG = "## Source catalog\n\nPick the data source...";
const MEMORY = "## Working memory\n\n- foo: bar";

const COMPOSITION_HEADING = "## Cross-source composition";

/** Build with just the catalog (and optionally memory), leaving the rest defaulted. */
function withCatalog(sourceCatalog: string | undefined, memoryBlock?: string) {
  return promptText(buildSystemParam("openai", { memoryBlock, sourceCatalog }));
}

describe("buildSystemParam — cross-source composition guidance (#3909)", () => {
  it("emits composition guidance when a Source catalog is supplied", () => {
    const prompt = withCatalog(CATALOG);
    expect(prompt).toContain(COMPOSITION_HEADING);
  });

  it("teaches per-source querying + reasoning correlation, never a cross-engine join", () => {
    const prompt = withCatalog(CATALOG);
    // Query each source on its own…
    expect(prompt).toContain("executeSQL");
    expect(prompt).toContain("executeRestOperation");
    // …then correlate the result sets in reasoning.
    expect(prompt.toLowerCase()).toContain("correlate");
    // Assert the PROHIBITION, not just the token — a polarity flip ("you may
    // JOIN across sources") must fail this. ADR-0022 §2: no federation / no
    // single cross-engine JOIN.
    expect(prompt).toMatch(/never[^.]*JOIN/i);
  });

  it("lives in the SYSTEM message content on the cache (object) provider branch", () => {
    // anthropic/bedrock providers return a SystemModelMessage rather than a bare
    // string; the guidance must live in that message's `content` (the SYSTEM
    // prompt), never in the message transcript (ADR-0020 / memory-LAST #3755).
    const result = buildSystemParam("anthropic", { sourceCatalog: CATALOG });
    expect(typeof result).not.toBe("string");
    // Narrow off the string branch — the cache providers return an object.
    if (typeof result === "string") {
      throw new Error("expected a SystemModelMessage on the anthropic cache branch");
    }
    expect(result.role).toBe("system");
    expect(promptText(result)).toContain(COMPOSITION_HEADING);
  });

  it("directs the agent to report provenance (which source[s] it drew from)", () => {
    const prompt = withCatalog(CATALOG);
    expect(prompt.toLowerCase()).toContain("provenance");
  });

  it("forbids a silent fallback to an unrelated source", () => {
    const prompt = withCatalog(CATALOG);
    expect(prompt.toLowerCase()).toContain("fall back");
  });

  it("omits the guidance when there is no catalog (no behavior change vs. today)", () => {
    const withEmpty = withCatalog("");
    const without = withCatalog(undefined);
    expect(withEmpty).not.toContain(COMPOSITION_HEADING);
    expect(without).not.toContain(COMPOSITION_HEADING);
    // The whole prompt is byte-identical to today's no-catalog output.
    expect(withEmpty).toBe(without);
  });

  it("keeps the durable memory block AFTER the composition guidance (memory-LAST invariant)", () => {
    const prompt = withCatalog(CATALOG, MEMORY);
    expect(prompt).toContain(COMPOSITION_HEADING);
    expect(prompt).toContain("## Working memory");
    expect(prompt.indexOf(COMPOSITION_HEADING)).toBeLessThan(
      prompt.indexOf("## Working memory"),
    );
  });

  it("places the guidance right after the Source catalog block", () => {
    const prompt = withCatalog(CATALOG);
    expect(prompt.indexOf("## Source catalog")).toBeLessThan(
      prompt.indexOf(COMPOSITION_HEADING),
    );
  });

  it("places the guidance ahead of the per-datasource REST representation", () => {
    // The composition guidance (how to compose across the menu) belongs before
    // the deep per-REST-datasource detail it routes into.
    const REST = "## REST datasource: acme\n\noperations...";
    const prompt = promptText(
      buildSystemParam("openai", { restRepresentation: REST, sourceCatalog: CATALOG }),
    );
    expect(prompt).toContain(COMPOSITION_HEADING);
    expect(prompt).toContain("## REST datasource: acme");
    expect(prompt.indexOf(COMPOSITION_HEADING)).toBeLessThan(
      prompt.indexOf("## REST datasource: acme"),
    );
  });
});
