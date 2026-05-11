import { describe, expect, test } from "bun:test";
import { suggestModelReplacement } from "../byot-deprecation";

describe("suggestModelReplacement", () => {
  test("accepts a same-family close match", () => {
    const out = suggestModelReplacement(
      "claude-3-opus-20240229",
      "anthropic",
      [
        { id: "claude-opus-4-6", provider: "anthropic" },
        { id: "gpt-4o", provider: "openai" },
      ],
    );
    expect(out).toBe("claude-opus-4-6");
  });

  test("rejects a low-confidence cross-family match", () => {
    const out = suggestModelReplacement(
      "text-davinci-003",
      "openai",
      [
        { id: "gpt-4o", provider: "openai" },
        { id: "gpt-4o-mini", provider: "openai" },
      ],
    );
    expect(out).toBeNull();
  });

  test("returns null when no candidates are supplied", () => {
    const out = suggestModelReplacement("any", "anthropic", []);
    expect(out).toBeNull();
  });

  test("returns null when the saved id normalizes to an empty string", () => {
    const out = suggestModelReplacement("---", "anthropic", [
      { id: "claude-opus-4-6", provider: "anthropic" },
    ]);
    expect(out).toBeNull();
  });

  test("prefers same-provider even when a cross-provider would score closer", () => {
    // Saved: anthropic.claude-opus-4-v1:0 (bedrock-style anthropic ID).
    // Pool has a same-provider close miss + an openai near-miss that's
    // alphabetically closer. The same-provider arm should win.
    const out = suggestModelReplacement(
      "anthropic.claude-opus-4-v1:0",
      "anthropic",
      [
        { id: "anthropic.claude-sonnet-4-v1:0", provider: "anthropic" },
        { id: "openai.somethingweirdandalmostlongenough", provider: "openai" },
      ],
    );
    expect(out).toBe("anthropic.claude-sonnet-4-v1:0");
  });

  test("falls back to cross-provider when no same-provider candidates", () => {
    const out = suggestModelReplacement(
      "claude-opus-4-6",
      "anthropic",
      [
        { id: "claude-opus-4-5", provider: "bedrock" },
      ],
    );
    expect(out).toBe("claude-opus-4-5");
  });

  test("exact match returns itself (corner case)", () => {
    const out = suggestModelReplacement(
      "gpt-4o",
      "openai",
      [{ id: "gpt-4o", provider: "openai" }],
    );
    expect(out).toBe("gpt-4o");
  });
});
