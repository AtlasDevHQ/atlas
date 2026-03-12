import { describe, expect, test, mock, beforeEach } from "bun:test";

// Must mock fetch BEFORE the dynamic import — the page module captures fetch at evaluation time
const mockFetch = mock(() => Promise.resolve(new Response("", { status: 404 })));
globalThis.fetch = mockFetch as typeof fetch;

// Import generateMetadata from the page module
const { generateMetadata } = await import("../../app/shared/[token]/page");

function makeParams(token: string): Promise<{ token: string }> {
  return Promise.resolve({ token });
}

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
    { role: "user", content: "What were our top 10 customers by revenue last quarter?", createdAt: "2026-03-12T00:00:00Z" },
    { role: "assistant", content: "I'll analyze the revenue data for last quarter. Let me query the database to find the top 10 customers ranked by total revenue.", createdAt: "2026-03-12T00:00:01Z" },
    { role: "user", content: "Can you break that down by month?", createdAt: "2026-03-12T00:00:02Z" },
    { role: "assistant", content: "Sure, here's the monthly breakdown.", createdAt: "2026-03-12T00:00:03Z" },
  ],
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe("shared page generateMetadata", () => {
  test("returns fallback metadata when conversation not found", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));

    const meta = await generateMetadata({ params: makeParams("bad-token") });

    expect(meta.title).toContain("Atlas");
    expect(meta.openGraph).toBeDefined();
    expect(meta.openGraph!.title).toContain("Atlas");
    expect(meta.openGraph!.type).toBe("article");
    expect(meta.openGraph!.siteName).toBe("Atlas");
    expect(meta.twitter).toBeDefined();
    expect(meta.twitter!.card).toBe("summary");
  });

  test("returns fallback metadata when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const meta = await generateMetadata({ params: makeParams("bad-token") });

    expect(meta.title).toContain("Atlas");
    expect(meta.openGraph!.siteName).toBe("Atlas");
  });

  test("uses first user message as og:title", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(sampleConversation));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect(meta.title).toBe("Atlas: What were our top 10 customers by revenue last quarter?");
    expect(meta.openGraph!.title).toBe(meta.title);
    expect(meta.twitter!.title).toBe(meta.title);
  });

  test("uses first assistant message as og:description", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(sampleConversation));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect(meta.description).toContain("analyze the revenue data");
    expect(meta.openGraph!.description).toBe(meta.description);
    expect(meta.twitter!.description).toBe(meta.description);
  });

  test("truncates long user messages to ~60 chars", async () => {
    const longMsg = "A".repeat(100);
    const convo = {
      ...sampleConversation,
      messages: [
        { role: "user", content: longMsg, createdAt: "2026-03-12T00:00:00Z" },
        { role: "assistant", content: "ok", createdAt: "2026-03-12T00:00:01Z" },
      ],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(convo));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    // "Atlas: " is 7 chars, so the truncated user text is at most 60 chars
    const userPart = (meta.title as string).replace("Atlas: ", "");
    expect(userPart.length).toBeLessThanOrEqual(60);
    expect(userPart).toEndWith("\u2026");
  });

  test("truncates long assistant messages to ~160 chars", async () => {
    const longReply = "B".repeat(300);
    const convo = {
      ...sampleConversation,
      messages: [
        { role: "user", content: "question", createdAt: "2026-03-12T00:00:00Z" },
        { role: "assistant", content: longReply, createdAt: "2026-03-12T00:00:01Z" },
      ],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(convo));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect((meta.description as string).length).toBeLessThanOrEqual(160);
    expect(meta.description).toEndWith("\u2026");
  });

  test("falls back to conversation title when no user messages", async () => {
    const convo = {
      ...sampleConversation,
      messages: [
        { role: "assistant", content: "hello", createdAt: "2026-03-12T00:00:00Z" },
      ],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(convo));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect(meta.title).toBe("Atlas: Revenue Analysis");
  });

  test("handles AI SDK array content format", async () => {
    const convo = {
      ...sampleConversation,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Show me sales data" }],
          createdAt: "2026-03-12T00:00:00Z",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here are the sales results." },
            { type: "tool-call", toolName: "executeSQL" },
          ],
          createdAt: "2026-03-12T00:00:01Z",
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(convo));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect(meta.title).toBe("Atlas: Show me sales data");
    expect(meta.description).toBe("Here are the sales results.");
  });

  test("sets required OG fields", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(sampleConversation));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect(meta.openGraph!.type).toBe("article");
    expect(meta.openGraph!.siteName).toBe("Atlas");
    expect(meta.twitter!.card).toBe("summary");
  });

  test("falls back to default title when no user messages and null title", async () => {
    const convo = {
      ...sampleConversation,
      title: null,
      messages: [
        { role: "assistant", content: "hello", createdAt: "2026-03-12T00:00:00Z" },
      ],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(convo));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect(meta.title).toBe("Atlas \u2014 Shared Conversation");
  });

  test("falls back to default description when assistant content is only tool calls", async () => {
    const convo = {
      ...sampleConversation,
      messages: [
        { role: "user", content: "run the query", createdAt: "2026-03-12T00:00:00Z" },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolName: "executeSQL" }],
          createdAt: "2026-03-12T00:00:01Z",
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(convo));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect(meta.description).toBe("A shared conversation from Atlas, the text-to-SQL data analyst.");
  });

  test("handles null or non-string content gracefully", async () => {
    const convo = {
      ...sampleConversation,
      title: null,
      messages: [
        { role: "user", content: null, createdAt: "2026-03-12T00:00:00Z" },
        { role: "assistant", content: 42, createdAt: "2026-03-12T00:00:01Z" },
      ],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(convo));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect(meta.title).toBe("Atlas \u2014 Shared Conversation");
    expect(meta.description).toBe("A shared conversation from Atlas, the text-to-SQL data analyst.");
  });

  test("returns fallback when API returns malformed JSON shape", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "internal_error" }));

    const meta = await generateMetadata({ params: makeParams("valid-token") });

    expect(meta.title).toContain("Atlas");
    expect(meta.openGraph!.siteName).toBe("Atlas");
  });

  test("encodes token in fetch URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));

    await generateMetadata({ params: makeParams("tok/en+special") });

    const fetchUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(fetchUrl).toContain("tok%2Fen%2Bspecial");
  });
});
