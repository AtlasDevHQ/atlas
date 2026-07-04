/**
 * #4299 — answer-style registry prompt assembly (PRD #4292).
 *
 * Supersedes the #2705 presentation-mode tests. Pins four contracts:
 *
 *   1. Every registered style resolves through the registry to exactly ONE
 *      addendum, and `buildSystemParam` appends that style's addendum and
 *      no other (per-style prompt-assembly tests).
 *   2. The default style is `analyst` — the answer-first web voice — and
 *      its editorial rules (lead with the result, no emoji, caveats only
 *      when material, no dataset speculation) are present verbatim.
 *   3. `conversational` is a registry entry whose output is
 *      behavior-identical to the pre-registry #2705 binary: the legacy
 *      heading and the three Slack-shaping instructions survive, and the
 *      built prompts differ across styles ONLY by their addendum.
 *   4. The `<suggestions>` contract and the cross-source provenance
 *      guidance are style-independent — unchanged across all styles.
 */

import { describe, expect, it } from "bun:test";

import { buildSystemParam } from "@atlas/api/lib/agent";
import {
  ANSWER_STYLE_NAMES,
  DEFAULT_ANSWER_STYLE,
  answerStyleForPresentationMode,
  isAnswerStyle,
  resolveAnswerStyleAddendum,
  type AnswerStyle,
} from "@atlas/api/lib/answer-styles";

/**
 * Extract the prompt string from `buildSystemParam`'s return value.
 *
 * Anthropic-family providers return a SystemModelMessage object whose
 * `content` field holds the prompt. OpenAI / Ollama / Gateway return
 * a bare string. Tests pin the same prompt content across both branches
 * to avoid drift between provider-cached and uncached paths.
 */
function promptText(result: ReturnType<typeof buildSystemParam>): string {
  if (typeof result === "string") return result;
  return typeof result.content === "string" ? result.content : "";
}

/**
 * One unique marker per style — the addendum heading. `conversational`
 * keeps the legacy "Presentation mode" heading deliberately (#2705
 * byte-identity); the other three use the canonical "Answer style" form.
 */
const STYLE_MARKERS: Record<AnswerStyle, string> = {
  "plain-english": "## Answer style — plain English",
  analyst: "## Answer style — analyst",
  executive: "## Answer style — executive",
  conversational: "## Presentation mode — conversational",
};

describe("answer-style registry (#4299)", () => {
  it("registers exactly the four canonical styles", () => {
    expect([...ANSWER_STYLE_NAMES]).toEqual([
      "plain-english",
      "analyst",
      "executive",
      "conversational",
    ]);
  });

  it("every style resolves to a non-empty addendum carrying its own marker and no other style's", () => {
    for (const style of ANSWER_STYLE_NAMES) {
      const addendum = resolveAnswerStyleAddendum(style);
      expect(addendum.length).toBeGreaterThan(0);
      expect(addendum).toContain(STYLE_MARKERS[style]);
      for (const other of ANSWER_STYLE_NAMES) {
        if (other === style) continue;
        expect(addendum).not.toContain(STYLE_MARKERS[other]);
      }
    }
  });

  it("isAnswerStyle accepts every registered name and rejects everything else", () => {
    for (const style of ANSWER_STYLE_NAMES) {
      expect(isAnswerStyle(style)).toBe(true);
    }
    // "developer" is the retired #2705 binary arm, NOT a registry entry.
    expect(isAnswerStyle("developer")).toBe(false);
    expect(isAnswerStyle("")).toBe(false);
    expect(isAnswerStyle("ANALYST")).toBe(false);
    expect(isAnswerStyle(42)).toBe(false);
    expect(isAnswerStyle(undefined)).toBe(false);
  });

  it("maps the legacy chat-plugin presentation-mode signal onto registry styles", () => {
    // Slack's explicit signal keeps the conversational voice.
    expect(answerStyleForPresentationMode("conversational", "analyst")).toBe(
      "conversational",
    );
    // A bridge that opted out of conversational gets the analyst successor
    // of the old addendum-free "developer" view.
    expect(answerStyleForPresentationMode("developer", "conversational")).toBe(
      "analyst",
    );
    // Absent signal → the caller-chosen surface fallback.
    expect(answerStyleForPresentationMode(undefined, "conversational")).toBe(
      "conversational",
    );
    expect(answerStyleForPresentationMode(undefined, "analyst")).toBe("analyst");
  });
});

describe("buildSystemParam — per-style prompt assembly (#4299)", () => {
  it("each style contributes exactly its own addendum to the built system param", () => {
    for (const style of ANSWER_STYLE_NAMES) {
      const prompt = promptText(buildSystemParam("openai", { answerStyle: style }));
      expect(prompt).toContain(STYLE_MARKERS[style]);
      for (const other of ANSWER_STYLE_NAMES) {
        if (other === style) continue;
        expect(prompt).not.toContain(STYLE_MARKERS[other]);
      }
    }
  });

  it("defaults to the analyst style when no answerStyle is supplied (web default)", () => {
    expect(DEFAULT_ANSWER_STYLE).toBe("analyst");
    const prompt = promptText(buildSystemParam("openai"));
    expect(prompt).toContain(STYLE_MARKERS.analyst);
    expect(prompt).not.toContain(STYLE_MARKERS.conversational);
  });

  it("built prompts differ across styles ONLY by their addendum", () => {
    // Swapping one style's addendum for another's inside the built prompt
    // must reproduce the other style's prompt exactly — pins that no other
    // section of the assembly branches on the style.
    const analystPrompt = promptText(
      buildSystemParam("openai", { answerStyle: "analyst" }),
    );
    for (const style of ANSWER_STYLE_NAMES) {
      if (style === "analyst") continue;
      const stylePrompt = promptText(buildSystemParam("openai", { answerStyle: style }));
      expect(
        stylePrompt.replace(
          resolveAnswerStyleAddendum(style),
          resolveAnswerStyleAddendum("analyst"),
        ),
      ).toBe(analystPrompt);
    }
  });

  it("the analyst addendum carries the #4292 editorial rules", () => {
    const prompt = promptText(buildSystemParam("openai", { answerStyle: "analyst" }));
    // Lead with the result — answer-first.
    expect(prompt).toContain("Lead with the result");
    // Length scales with question complexity.
    expect(prompt).toContain("Scale length to the question");
    // No emoji headers.
    expect(prompt).toContain("Never use emoji");
    // Caveats only when material to the answer.
    expect(prompt).toContain("Caveats only when material");
    // No unprompted dataset speculation.
    expect(prompt).toContain("Do not speculate about the dataset");
  });

  it("conversational keeps the #2705 chat-platform contract (no Slack regression)", () => {
    const prompt = promptText(
      buildSystemParam("openai", { answerStyle: "conversational" }),
    );
    // The legacy heading is the canonical pin — the addendum is retained
    // verbatim from the pre-registry constant.
    expect(prompt).toContain("Presentation mode — conversational");
    // Three specific instructions that shape the Slack reply must survive
    // the registry migration. Drop any of these and the dogfood signal
    // that triggered #2705 reappears.
    expect(prompt).toContain("1-2 sentences");
    expect(prompt).toContain("Do NOT include SQL");
    expect(prompt).toContain("Do NOT use markdown tables");
  });

  it("the <suggestions> block contract is unchanged across styles", () => {
    for (const style of ANSWER_STYLE_NAMES) {
      const prompt = promptText(buildSystemParam("openai", { answerStyle: style }));
      expect(prompt).toContain("<suggestions>");
      expect(prompt).toContain("</suggestions>");
    }
  });

  it("the cross-source provenance guidance is unchanged across styles", () => {
    // The provenance rule rides on the source catalog (#3909); supply one so
    // the guidance renders, then pin it per style.
    for (const style of ANSWER_STYLE_NAMES) {
      const prompt = promptText(
        buildSystemParam("openai", {
          answerStyle: style,
          sourceCatalog: "## Source catalog\n\n- prod (Postgres)",
        }),
      );
      expect(prompt).toContain("Report which source(s) you drew from");
    }
  });

  it("composes with the bound dashboard-editor guidance instead of forking from it", () => {
    // #4299 key-file criterion: bound-agent prompt guidance must compose
    // with styles. The bound context swaps the generic suffix; the style
    // addendum still appends on top.
    const prompt = promptText(
      buildSystemParam("openai", {
        boundDashboardContext: { cardSummary: "## Current dashboard state\n\n0 cards" },
        answerStyle: "analyst",
      }),
    );
    expect(prompt).toContain("You are editing a saved dashboard");
    expect(prompt).toContain(STYLE_MARKERS.analyst);
  });

  it("the style addendum survives the Anthropic cache-control wrapping path", () => {
    // Anthropic / Bedrock-Anthropic return a SystemModelMessage so the
    // adapter applies cache control. The addendum must live inside
    // `content`, not get stripped by the wrapping.
    const wrapped = buildSystemParam("anthropic", { answerStyle: "conversational" });
    expect(typeof wrapped).toBe("object");
    if (typeof wrapped === "string") return; // unreachable, narrows TS
    expect(wrapped.role).toBe("system");
    expect(typeof wrapped.content).toBe("string");
    expect(wrapped.content as string).toContain("Presentation mode — conversational");
  });
});
