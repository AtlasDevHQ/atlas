/**
 * System-prompt injection contracts for `buildSystemParam` (pure — no module
 * mocks, no request context). Four sibling contracts, one per describe:
 *
 *   - #3909 Cross-source composition guidance (ADR-0022 §2, slice (d))
 *   - #3894 Source-catalog block (ADR-0022 §4)
 *   - #4208 Knowledge Base collection ToC (ADR-0028 §3)
 *   - #3181 Error Recovery — infrastructure-outage guidance
 *
 * ---------------------------------------------------------------------------
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
 *
 * ---------------------------------------------------------------------------
 * #3894 — Source-catalog system-prompt injection (ADR-0022 §4).
 *
 * Pins the contract that `buildSystemParam` injects the Source-catalog block
 * when one is supplied, omits it when empty (single-source / no-DB workspaces
 * unchanged), and keeps the durable working-memory block LAST (the #3755
 * invariant) — the catalog sits ahead of memory, not after it.
 *
 * ---------------------------------------------------------------------------
 * #4208 — Knowledge Base collection-ToC system-prompt injection (ADR-0028 §3).
 *
 * Pins the contract that `buildSystemParam` injects the `orgKnowledgeToc` block
 * when supplied, omits it when empty (workspaces with no collections are
 * unchanged), and places it AFTER the authoritative semantic-layer index — the
 * descriptive Knowledge Base sits below the authoritative semantic layer, never
 * above it.
 *
 * ---------------------------------------------------------------------------
 * #3181 — the agent's "Error Recovery" prompt block must distinguish an
 * infrastructure outage (datasource unreachable / pool exhausted) from a fixable
 * query error. On an outage the agent should STOP and report, not burn its retry
 * + step budget reformulating SQL it cannot fix.
 *
 * Prompt-text contract test: build the system prompt for a plain-string provider
 * (openai — no cache-control wrapping) and assert the Error Recovery block now
 * carries the stop-and-report guidance referencing the tool's outage vocabulary
 * (`lib/tools/sql.ts` returns "Database unreachable at <host>" / pool-exhausted).
 */

import { describe, expect, it } from "bun:test";
import { buildSystemParam } from "@atlas/api/lib/agent";

// agent.ts reads env at module load; `??=` keeps the assignment hoisted (#3181).
process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

function promptText(result: ReturnType<typeof buildSystemParam>): string {
  if (typeof result === "string") return result;
  return typeof result.content === "string" ? result.content : "";
}

const CATALOG = "## Source catalog\n\nPick the data source...";
const MEMORY = "## Working memory\n\n- foo: bar";

const COMPOSITION_HEADING = "## Cross-source composition";

/** Build with just the catalog (and optionally memory), leaving the rest defaulted. */
function withCatalog(sourceCatalog: string | undefined, memoryBlock?: string) {
  return promptText(buildSystemParam("openai", { ...(memoryBlock !== undefined ? { memoryBlock } : {}), ...(sourceCatalog !== undefined ? { sourceCatalog } : {})}));
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

describe("buildSystemParam — Source catalog (#3894)", () => {
  it("injects the catalog block when supplied", () => {
    const prompt = promptText(buildSystemParam("openai", { sourceCatalog: CATALOG }));
    expect(prompt).toContain("## Source catalog");
  });

  it("omits the catalog when empty (no behavior change vs. today)", () => {
    const withCatalog = promptText(buildSystemParam("openai", { sourceCatalog: "" }));
    const without = promptText(buildSystemParam("openai", {}));
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
    const without = promptText(buildSystemParam("openai", {}));
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

function systemText(): string {
  // openai is a non-cache provider → buildSystemParam returns a plain string.
  const system = buildSystemParam("openai");
  return typeof system === "string" ? system : String(system.content);
}

describe("agent Error Recovery prompt — infrastructure outage guidance (#3181)", () => {
  it("keeps the Error Recovery block", () => {
    expect(systemText()).toContain("Error Recovery");
  });

  it("recognizes datasource-unreachable / pool-exhausted as an outage, not a query error", () => {
    const text = systemText();
    expect(text).toMatch(/unreachable/i);
    expect(text).toMatch(/connection pool|pool is exhausted|pool is/i);
  });

  it("instructs the agent to stop and report rather than retry/modify the SQL", () => {
    const text = systemText();
    // The outage branch must tell the agent NOT to retry, and to surface the
    // outage to the user as temporarily unavailable.
    expect(text).toMatch(/do not retry|don't retry|not retry at all/i);
    expect(text).toMatch(/temporarily unavailable/i);
  });
});
