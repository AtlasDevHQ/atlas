import { describe, expect, test, spyOn } from "bun:test";
import { extractTextContent, truncate, getApiBaseUrl } from "../../app/shared/lib";

// The data fetch moved to `app/shared/[token]/fetch.ts` (#4719) — its behavior
// (no-store, header forwarding, token-hash logging, org-share auth split) is
// covered by the colocated `app/shared/[token]/__tests__/fetch.test.ts`.

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

    test("warns on unrecognized non-null content shapes", () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      extractTextContent(42);
      expect(warnSpy).toHaveBeenCalledWith(
        "[shared-conversation] Unrecognized content shape:",
        "number",
      );
      warnSpy.mockRestore();
    });

    test("does not warn for null or undefined", () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      extractTextContent(null);
      extractTextContent(undefined);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test("filters array entries with text property that is not a string", () => {
      const content = [
        { type: "text", text: 123 },
        { type: "text", text: "valid" },
      ];
      expect(extractTextContent(content)).toBe("valid");
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

    test("returns text unchanged at exactly maxLen", () => {
      expect(truncate("hello", 5)).toBe("hello");
    });

    test("truncates text one char over maxLen", () => {
      const result = truncate("abcdef", 5);
      expect(result).toBe("abcd\u2026");
      expect(result.length).toBe(5);
    });
  });

  describe("getApiBaseUrl", () => {
    function withEnv(
      vars: { public?: string; api?: string },
      fn: () => void,
    ) {
      const origPublic = process.env.NEXT_PUBLIC_ATLAS_API_URL;
      const origApi = process.env.ATLAS_API_URL;
      process.env.NEXT_PUBLIC_ATLAS_API_URL = vars.public ?? "";
      process.env.ATLAS_API_URL = vars.api ?? "";
      try {
        fn();
      } finally {
        process.env.NEXT_PUBLIC_ATLAS_API_URL = origPublic;
        process.env.ATLAS_API_URL = origApi;
      }
    }

    test("strips trailing slashes", () => {
      withEnv({ api: "http://localhost:3001///" }, () => {
        expect(getApiBaseUrl()).toBe("http://localhost:3001");
      });
    });

    test("NEXT_PUBLIC takes priority over ATLAS_API_URL", () => {
      withEnv({ public: "https://public.example.com", api: "https://api.example.com" }, () => {
        expect(getApiBaseUrl()).toBe("https://public.example.com");
      });
    });

    test("falls back to ATLAS_API_URL when NEXT_PUBLIC is empty", () => {
      withEnv({ api: "https://api.example.com" }, () => {
        expect(getApiBaseUrl()).toBe("https://api.example.com");
      });
    });

    test("falls back to localhost when neither env var is set", () => {
      withEnv({}, () => {
        expect(getApiBaseUrl()).toBe("http://localhost:3001");
      });
    });
  });

});
