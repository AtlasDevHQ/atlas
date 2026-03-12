import { describe, expect, test, mock, beforeEach, spyOn } from "bun:test";

// Mock fetch before importing the module
const mockFetch = mock(() => Promise.resolve(new Response("", { status: 404 })));
globalThis.fetch = mockFetch as unknown as typeof fetch;

const {
  extractTextContent,
  truncate,
  getApiBaseUrl,
  fetchSharedConversation,
} = await import("../../app/shared/lib");

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleConversation = {
  title: "Revenue Analysis",
  surface: "web",
  createdAt: "2026-03-12T00:00:00Z",
  messages: [
    { role: "user", content: "What were our top customers?", createdAt: "2026-03-12T00:00:00Z" },
    { role: "assistant", content: "Here are the results.", createdAt: "2026-03-12T00:00:01Z" },
  ],
};

beforeEach(() => {
  mockFetch.mockReset();
});

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

  describe("fetchSharedConversation", () => {
    test("returns conversation data on success", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(sampleConversation));

      const result = await fetchSharedConversation("valid-token");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.title).toBe("Revenue Analysis");
        expect(result.data.messages).toHaveLength(2);
      }
    });

    test("returns not-found for 404", async () => {
      mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));

      const result = await fetchSharedConversation("missing-token");

      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    test("returns server-error for 500", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce(new Response("", { status: 500 }));

      const result = await fetchSharedConversation("error-token");

      expect(result).toEqual({ ok: false, reason: "server-error" });
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("returns server-error for malformed response shape", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "bad" }));

      const result = await fetchSharedConversation("malformed-token");

      expect(result).toEqual({ ok: false, reason: "server-error" });
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("returns network-error when fetch throws", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      mockFetch.mockRejectedValueOnce(new Error("DNS resolution failed"));

      const result = await fetchSharedConversation("network-fail");

      expect(result).toEqual({ ok: false, reason: "network-error" });
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("encodes token in fetch URL", async () => {
      mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));

      await fetchSharedConversation("tok/en+special");

      const firstCall = mockFetch.mock.calls[0] as unknown as [string, ...unknown[]];
      expect(firstCall[0]).toContain("tok%2Fen%2Bspecial");
    });

    test("does not log for 404 responses", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));

      await fetchSharedConversation("not-found");

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});
