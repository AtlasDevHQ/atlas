/**
 * #4508 — expert persona role section (PRD #4502; "expert is a mode").
 *
 * Pins the persona's shape as a first-class ROLE section, not a warnings
 * footnote: it opens with the expert identity, structurally mirrors the analyst
 * `SYSTEM_PROMPT_PREFIX` (a `## Your Workflow` heading whose `### 1.` step flows
 * into the tool-guidance steps), and carries none of the analyst identity. The
 * seam that threads it into a built prompt is pinned separately at the agent
 * seam (agent-expert-persona-prompt.test.ts) and the route seam
 * (admin-semantic-improve.test.ts).
 */

import { describe, expect, it } from "bun:test";

import { EXPERT_PERSONA_PROMPT } from "../persona";

describe("EXPERT_PERSONA_PROMPT (#4508)", () => {
  it("opens with the semantic expert identity", () => {
    // The role line is the first thing the model reads — the persona IS the
    // identity, not an addendum to a different one.
    expect(EXPERT_PERSONA_PROMPT.startsWith("You are the Atlas Semantic Expert Agent.")).toBe(true);
  });

  it("carries none of the analyst role section's identity", () => {
    // If this ever contains the analyst identity, the two would coexist and the
    // "one identity" invariant would be broken — the exact bug #4508 closes.
    expect(EXPERT_PERSONA_PROMPT).not.toContain("You are Atlas, an expert data analyst");
  });

  it("mirrors the prefix shape so the numbered tool workflow stays coherent", () => {
    // `registry.describe()` appends the tool-guidance steps starting at
    // "### 2. Explore …", so the persona must end its own workflow at "### 1."
    // for the numbering to read as one sequence across the seam.
    expect(EXPERT_PERSONA_PROMPT).toContain("## Your Workflow");
    expect(EXPERT_PERSONA_PROMPT).toContain("### 1.");
    expect(EXPERT_PERSONA_PROMPT).not.toContain("### 2.");
  });

  it("frames the work product as a reviewable Amendment, evidence-first", () => {
    // The persona vocabulary must match CONTEXT.md § Semantic improvement — the
    // agent proposes Amendments backed by evidence, it does not answer data
    // questions.
    expect(EXPERT_PERSONA_PROMPT).toContain("Amendment");
    expect(EXPERT_PERSONA_PROMPT.toLowerCase()).toContain("evidence");
  });
});
