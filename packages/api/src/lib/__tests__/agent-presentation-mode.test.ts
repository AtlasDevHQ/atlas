/**
 * #2705 — Presentation-mode prompt branching.
 *
 * Pins the contract that `buildSystemParam` appends the conversational
 * addendum when `presentationMode === "conversational"`, and that the
 * "developer" branch (default) is materially shorter and omits the
 * Slack-specific guidance. Without these assertions a future prompt
 * refactor could collapse the two modes without anyone noticing.
 */

import { describe, expect, it } from "bun:test";

import {
  buildSystemParam,
  CONVERSATIONAL_PROMPT_ADDENDUM,
} from "@atlas/api/lib/agent";

/**
 * Extract the prompt string from `buildSystemParam`'s return value.
 *
 * Anthropic-family providers return a SystemModelMessage object whose
 * `content` field holds the prompt. OpenAI / Ollama / Gateway return
 * a bare string. Tests pin the same prompt content across both branches
 * to avoid drift between provider-cached and uncached paths.
 */
function promptText(
  result: ReturnType<typeof buildSystemParam>,
): string {
  if (typeof result === "string") return result;
  return typeof result.content === "string" ? result.content : "";
}

describe("buildSystemParam — presentation mode (#2705)", () => {
  it("appends the conversational addendum when mode is 'conversational'", () => {
    const result = buildSystemParam(
      "openai",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "conversational",
    );
    const prompt = promptText(result);
    // The addendum heading is the canonical pin — guards a future
    // refactor that renames the section without updating callers.
    expect(prompt).toContain("Presentation mode — conversational");
    // Three specific instructions that shape the Slack reply must
    // survive any future cleanup of the addendum. Drop any of these
    // and the dogfood signal that triggered #2705 reappears.
    expect(prompt).toContain("1-2 sentences");
    expect(prompt).toContain("Do NOT include SQL");
    expect(prompt).toContain("Do NOT use markdown tables");
  });

  it("omits the conversational addendum in 'developer' mode (the default)", () => {
    const developer = buildSystemParam(
      "openai",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "developer",
    );
    const developerPrompt = promptText(developer);
    expect(developerPrompt).not.toContain("Presentation mode — conversational");
    expect(developerPrompt).not.toContain("Do NOT include SQL");
  });

  it("defaults to 'developer' when presentationMode is not supplied", () => {
    const defaulted = buildSystemParam("openai");
    const defaultedPrompt = promptText(defaulted);
    expect(defaultedPrompt).not.toContain("Presentation mode — conversational");
    expect(defaultedPrompt).not.toContain("Do NOT include SQL");
  });

  it("conversational prompt is materially longer than developer prompt (addendum present)", () => {
    // The two prompts diverge only by the addendum. Asserting on the
    // size delta (vs. parsing) pins the contract without coupling to
    // the exact wording of either branch — any future prompt edit
    // that materially shortens the conversational branch (e.g. dropping
    // the addendum entirely) breaks this assertion.
    const developer = promptText(buildSystemParam("openai"));
    const conversational = promptText(
      buildSystemParam(
        "openai",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "conversational",
      ),
    );
    expect(conversational.length).toBeGreaterThan(developer.length);
    // The exact delta IS the addendum (modulo no other branches differ
    // by mode today). Pin this so a future change that also branches
    // the developer prompt by mode trips the assertion and forces a
    // deliberate update.
    expect(conversational.length - developer.length).toBe(
      CONVERSATIONAL_PROMPT_ADDENDUM.length,
    );
  });

  it("conversational addendum survives the Anthropic cache-control wrapping path", () => {
    // Anthropic / Bedrock-Anthropic return a SystemModelMessage so the
    // adapter applies cache control. The addendum must live inside
    // `content`, not get stripped by the wrapping.
    const wrapped = buildSystemParam(
      "anthropic",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "conversational",
    );
    expect(typeof wrapped).toBe("object");
    if (typeof wrapped === "string") return; // unreachable, narrows TS
    expect(wrapped.role).toBe("system");
    expect(typeof wrapped.content).toBe("string");
    expect(wrapped.content as string).toContain(
      "Presentation mode — conversational",
    );
  });
});
