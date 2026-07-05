import { describe, expect, test } from "bun:test";
import { parseSuggestions } from "../helpers";

describe("parseSuggestions", () => {
  test("extracts suggestions and strips the block from text", () => {
    const content = `Here is the answer.\n\n<suggestions>\nWhat is the trend?\nHow does this break down?\nWhich accounts matter most?\n</suggestions>`;
    const result = parseSuggestions(content);
    expect(result.text).toBe("Here is the answer.");
    expect(result.suggestions).toEqual([
      "What is the trend?",
      "How does this break down?",
      "Which accounts matter most?",
    ]);
  });

  test("returns empty suggestions when no block present", () => {
    const content = "Just a normal response.";
    const result = parseSuggestions(content);
    expect(result.text).toBe("Just a normal response.");
    expect(result.suggestions).toEqual([]);
  });

  test("handles extra whitespace inside suggestions block", () => {
    const content = `Answer.\n\n<suggestions>\n  Spaced question?  \n\n  Another one?  \n</suggestions>`;
    const result = parseSuggestions(content);
    expect(result.suggestions).toEqual(["Spaced question?", "Another one?"]);
  });

  test("strips block even when inline with text", () => {
    const content = `Some text before <suggestions>\nQ1?\nQ2?\n</suggestions> and after`;
    const result = parseSuggestions(content);
    expect(result.text).toBe("Some text before  and after");
    expect(result.suggestions).toEqual(["Q1?", "Q2?"]);
  });

  test("strips all blocks when multiple exist and merges suggestions", () => {
    const content = `Answer\n<suggestions>\nQ1?\n</suggestions>\nMore text\n<suggestions>\nQ2?\n</suggestions>`;
    const result = parseSuggestions(content);
    expect(result.text).toBe("Answer\n\nMore text");
    expect(result.suggestions).toEqual(["Q1?", "Q2?"]);
  });

  test("returns empty suggestions for empty content", () => {
    const result = parseSuggestions("");
    expect(result.text).toBe("");
    expect(result.suggestions).toEqual([]);
  });

  test("unclosed suggestions tag is not matched (streaming partial)", () => {
    const content = "Answer\n\n<suggestions>\nQ1?\nQ2?";
    const result = parseSuggestions(content);
    expect(result.text).toBe(content);
    expect(result.suggestions).toEqual([]);
  });

  test("caps suggestions at 5", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Question ${i + 1}?`).join("\n");
    const content = `Answer\n<suggestions>\n${lines}\n</suggestions>`;
    const result = parseSuggestions(content);
    expect(result.suggestions).toHaveLength(5);
    expect(result.suggestions[0]).toBe("Question 1?");
    expect(result.suggestions[4]).toBe("Question 5?");
  });

  test("all-whitespace block yields no suggestions and leaves text untouched", () => {
    const content = "Answer\n<suggestions>   \n\t \n</suggestions>";
    const result = parseSuggestions(content);
    expect(result.text).toBe(content);
    expect(result.suggestions).toEqual([]);
  });

  // CodeQL js/polynomial-redos regression: the old regex
  // /<suggestions>\s*([\s\S]*?)\s*<\/suggestions>/g backtracked quadratically on
  // an unclosed tag followed by a long whitespace run (minutes at this size).
  test("unclosed tag followed by a long whitespace run stays linear", () => {
    const content = "<suggestions>" + "\t".repeat(100_000);
    const start = performance.now();
    const result = parseSuggestions(content);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(result.text).toBe(content);
    expect(result.suggestions).toEqual([]);
  });
});
