import { describe, expect, test } from "bun:test";
import { extractTextContent, truncate, getApiBaseUrl } from "../../app/shared/lib";

describe("shared/lib utilities", () => {
  describe("extractTextContent", () => {
    test("returns string content as-is", () => {
      expect(extractTextContent("hello")).toBe("hello");
    });

    test("extracts text parts from AI SDK array format", () => {
      const content = [
        { type: "text", text: "first" },
        { type: "tool-call", toolName: "executeSQL" },
        { type: "text", text: "second" },
      ];
      expect(extractTextContent(content)).toBe("first second");
    });

    test("returns empty string for null/undefined/number", () => {
      expect(extractTextContent(null)).toBe("");
      expect(extractTextContent(undefined)).toBe("");
      expect(extractTextContent(42)).toBe("");
    });

    test("returns empty string for array with no text parts", () => {
      expect(extractTextContent([{ type: "tool-call" }])).toBe("");
    });
  });

  describe("truncate", () => {
    test("returns short text unchanged", () => {
      expect(truncate("hello", 10)).toBe("hello");
    });

    test("truncates long text with ellipsis", () => {
      const result = truncate("A".repeat(100), 60);
      expect(result.length).toBe(60);
      expect(result).toEndWith("\u2026");
    });

    test("collapses whitespace", () => {
      expect(truncate("hello   world\n\tfoo", 100)).toBe("hello world foo");
    });
  });

  describe("getApiBaseUrl", () => {
    test("strips trailing slashes", () => {
      const original = process.env.ATLAS_API_URL;
      process.env.ATLAS_API_URL = "http://localhost:3001///";
      process.env.NEXT_PUBLIC_ATLAS_API_URL = "";
      try {
        expect(getApiBaseUrl()).toBe("http://localhost:3001");
      } finally {
        process.env.ATLAS_API_URL = original;
      }
    });
  });
});
