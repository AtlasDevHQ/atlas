/**
 * Notion Knowledge Sync Connector — vendor client, HTTP seam, markdown
 * normalizer, and document builder (#4378). Every network call is a doubled
 * `fetch`; NO test reaches Notion (AC). The engine integration
 * (incremental/reconcile/backoff/archive) is already covered by
 * `connector-sync.test.ts` with a fixture connector — these tests own the
 * Notion-specific enumeration, content, and normalization logic.
 */

import { describe, expect, it } from "bun:test";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import {
  NotionHttpClient,
  NOTION_API_VERSION,
  NOTION_MIN_REQUEST_INTERVAL_MS,
} from "@atlas/api/lib/knowledge/notion/http";
import { normalizeNotionMarkdown } from "@atlas/api/lib/knowledge/notion/markdown";
import {
  notionArchivePath,
  renderNotionOkfDocument,
  slugifyTitle,
} from "@atlas/api/lib/knowledge/notion/document";
import { NotionVendorClient } from "@atlas/api/lib/knowledge/notion/client";

// ── A doubled Notion API ──────────────────────────────────────────────────────

interface FakeNotionState {
  /** Page objects returned by `POST /search` (filter object=page), in order. */
  readonly searchPages?: Array<Record<string, unknown>>;
  /** Data-source rows returned by `POST /search` (filter object=data_source). */
  readonly dataSources?: Array<Record<string, unknown>>;
  /** `POST /data_sources/:id/query` → page objects. */
  readonly dataSourcePages?: Record<string, Array<Record<string, unknown>>>;
  /** `GET /databases/:id` → `{ data_sources: [...] }`. */
  readonly databases?: Record<string, Record<string, unknown>>;
  /** `GET /blocks/:id/children` → block list. */
  readonly blocks?: Record<string, Array<Record<string, unknown>>>;
  /** `GET /pages/:id/markdown` → response, "throw" (endpoint failure → block-walk
   *  fallback), or "throw-429" (rate limit on the content path). */
  readonly markdown?: Record<
    string,
    { markdown?: string; truncated?: boolean; unknown_block_ids?: string[] } | "throw" | "throw-429"
  >;
  /** Number of leading requests that answer 429 before succeeding. */
  rateLimit?: number;
}

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Wrap a bare fetch fn as Bun's `fetch` type (adds the unused `preconnect`). */
function asFetch(
  fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(fn, { preconnect: async () => {} }) as typeof globalThis.fetch;
}

function makeFakeNotion(state: FakeNotionState) {
  const calls: RecordedCall[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status });

  const fetchImpl = asFetch(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, headers, body });

    if (state.rateLimit && state.rateLimit > 0) {
      state.rateLimit--;
      return new Response(JSON.stringify({ object: "error", code: "rate_limited" }), {
        status: 429,
        headers: { "Retry-After": "7" },
      });
    }

    if (path === "/search") {
      const value = body?.filter?.value;
      const results = value === "data_source" ? state.dataSources ?? [] : state.searchPages ?? [];
      return json({ object: "list", results, has_more: false, next_cursor: null });
    }
    const dsQuery = path.match(/^\/data_sources\/([^/]+)\/query$/);
    if (dsQuery) {
      return json({
        object: "list",
        results: state.dataSourcePages?.[dsQuery[1]] ?? [],
        has_more: false,
        next_cursor: null,
      });
    }
    const db = path.match(/^\/databases\/([^/]+)$/);
    if (db) return json(state.databases?.[db[1]] ?? { data_sources: [] });

    const blocks = path.match(/^\/blocks\/([^/]+)\/children$/);
    if (blocks) {
      return json({
        object: "list",
        results: state.blocks?.[blocks[1]] ?? [],
        has_more: false,
        next_cursor: null,
      });
    }
    const md = path.match(/^\/pages\/([^/]+)\/markdown$/);
    if (md) {
      const entry = state.markdown?.[md[1]];
      if (entry === "throw-429") {
        return new Response(JSON.stringify({ object: "error", code: "rate_limited" }), {
          status: 429,
          headers: { "Retry-After": "3" },
        });
      }
      if (entry === "throw" || entry === undefined) {
        return json({ object: "error", code: "object_not_found", message: "not served" }, 400);
      }
      return json({ object: "page_markdown", id: md[1], markdown: "", ...entry });
    }
    return json({ object: "error", code: "not_found" }, 404);
  });

  return { fetchImpl, calls };
}

/** A minimal page object as `POST /search` returns one. */
function pageObject(opts: {
  id: string;
  title: string;
  lastEditedTime: string;
  url?: string;
  archived?: boolean;
}): Record<string, unknown> {
  return {
    object: "page",
    id: opts.id,
    last_edited_time: opts.lastEditedTime,
    url: opts.url ?? `https://www.notion.so/${opts.id.replace(/-/g, "")}`,
    archived: opts.archived ?? false,
    properties: {
      Name: { type: "title", title: [{ plain_text: opts.title }] },
    },
  };
}

function client(state: FakeNotionState, maxDocs = 1000): { vendor: NotionVendorClient; calls: RecordedCall[] } {
  const { fetchImpl, calls } = makeFakeNotion(state);
  const http = new NotionHttpClient({
    token: "ntn_secret-token",
    fetchImpl,
    now: () => 0, // frozen clock — the throttle never actually waits in these tests
    sleep: async () => {},
  });
  return { vendor: new NotionVendorClient({ http, maxDocs }), calls };
}

// ── HTTP seam ─────────────────────────────────────────────────────────────────

describe("NotionHttpClient", () => {
  it("pins the recorded Notion-Version header and sends the bearer token on every call", async () => {
    const { fetchImpl, calls } = makeFakeNotion({ searchPages: [] });
    const http = new NotionHttpClient({ token: "ntn_abc", fetchImpl, now: () => 0, sleep: async () => {} });
    await http.post("/search", { filter: { property: "object", value: "page" } });
    expect(NOTION_API_VERSION).toBe("2026-03-11");
    expect(calls[0].headers["Notion-Version"]).toBe("2026-03-11");
    expect(calls[0].headers.Authorization).toBe("Bearer ntn_abc");
  });

  it("throttles request starts by the documented ~3 req/s interval", async () => {
    const { fetchImpl } = makeFakeNotion({ searchPages: [] });
    const sleeps: number[] = [];
    let clock = 0;
    const http = new NotionHttpClient({
      token: "ntn_abc",
      fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await http.get("/blocks/a/children");
    await http.get("/blocks/b/children");
    await http.get("/blocks/c/children");
    // First call never waits; the next two are spaced by the interval.
    expect(sleeps).toEqual([NOTION_MIN_REQUEST_INTERVAL_MS, NOTION_MIN_REQUEST_INTERVAL_MS]);
  });

  it("maps 429 to ConnectorRateLimitError carrying the parsed Retry-After", async () => {
    const { fetchImpl } = makeFakeNotion({ rateLimit: 1 });
    const http = new NotionHttpClient({ token: "ntn_abc", fetchImpl, now: () => 0, sleep: async () => {} });
    const err = await http.get("/search").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorRateLimitError);
    expect((err as ConnectorRateLimitError).retryAfterSeconds).toBe(7);
  });

  it("surfaces Notion's error code/message but never the token on a non-2xx", async () => {
    const fetchImpl = asFetch(async () =>
      new Response(JSON.stringify({ code: "unauthorized", message: "API token is invalid." }), {
        status: 401,
      }),
    );
    const http = new NotionHttpClient({ token: "ntn_super-secret", fetchImpl, now: () => 0, sleep: async () => {} });
    const err = (await http.get("/pages/x/markdown").catch((e) => e)) as Error;
    expect(err.message).toContain("unauthorized");
    expect(err.message).toContain("API token is invalid");
    expect(err.message).not.toContain("ntn_super-secret");
  });

  it("rejects a blank token at construction", () => {
    expect(() => new NotionHttpClient({ token: "   " })).toThrow(/non-empty integration token/);
  });
});

// ── Markdown normalizer (goldens) ──────────────────────────────────────────────

describe("normalizeNotionMarkdown", () => {
  const ctx = { pageUrl: "https://www.notion.so/deadbeef" };

  it("downgrades a callout fence to a blockquote", () => {
    const out = normalizeNotionMarkdown("```callout\n💡 Heads up\nBe careful\n```", ctx);
    expect(out).toBe("> 💡 Heads up\n> Be careful\n");
  });

  it("leaves a real code fence untouched (never rewrites its body)", () => {
    const src = "```ts\nconst x = 1;\n<column>\n```";
    expect(normalizeNotionMarkdown(src, ctx)).toBe("```ts\nconst x = 1;\n<column>\n```\n");
  });

  it("strips column tags and flattens columns vertically", () => {
    const src = "<columns>\n<column>\nLeft\n</column>\n<column>\nRight\n</column>\n</columns>";
    expect(normalizeNotionMarkdown(src, ctx)).toBe("Left\n\nRight\n");
  });

  it("unwraps details and turns the summary into a bold lead line", () => {
    const src = "<details>\n<summary>More info</summary>\nHidden body\n</details>";
    expect(normalizeNotionMarkdown(src, ctx)).toBe("**More info**\nHidden body\n");
  });

  it("replaces an expiring S3 image with a link to the stable page", () => {
    const src =
      "![diagram](https://prod-files-secure.s3.us-west-2.amazonaws.com/x?X-Amz-Signature=abc)";
    expect(normalizeNotionMarkdown(src, ctx)).toBe(
      "[diagram — view in Notion](https://www.notion.so/deadbeef)\n",
    );
  });

  it("replaces an expiring media LINK (non-image) too, and leaves a normal link alone", () => {
    const expiring = "[attachment](https://file.notion.so/f/secret.pdf?X-Amz-Expires=3600)";
    expect(normalizeNotionMarkdown(expiring, ctx)).toBe(
      "[attachment](https://www.notion.so/deadbeef)\n",
    );
    const normal = "[docs](https://example.com/guide)";
    expect(normalizeNotionMarkdown(normal, ctx)).toBe("[docs](https://example.com/guide)\n");
  });
});

// ── Document builder ───────────────────────────────────────────────────────────

describe("notion document builder", () => {
  const idA = "11111111-2222-3333-4444-555555555555";
  const idB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("derives a readable, deterministic, collision-free path", () => {
    expect(slugifyTitle("On-Call Runbook!")).toBe("on-call-runbook");
    const p = notionArchivePath(idA, "On-Call Runbook");
    expect(p).toBe("on-call-runbook-11111111222233334444555555555555.md");
    // Same-titled distinct pages never collide (id token disambiguates).
    expect(notionArchivePath(idA, "Same")).not.toBe(notionArchivePath(idB, "Same"));
    // Deterministic.
    expect(notionArchivePath(idA, "Same")).toBe(notionArchivePath(idA, "Same"));
  });

  it("falls back to `untitled` for an empty/punctuation title", () => {
    expect(slugifyTitle("")).toBe("untitled");
    expect(slugifyTitle("!!!")).toBe("untitled");
  });

  it("renders conformant OKF frontmatter with atlas provenance, and no sync-time churn", () => {
    const doc = renderNotionOkfDocument({
      id: idA,
      title: "Runbook",
      lastEditedTime: "2026-07-01T00:00:00.000Z",
      url: "https://www.notion.so/runbook",
      body: "Body text",
    });
    expect(doc).toContain("type: Document");
    expect(doc).toContain('title: "Runbook"');
    expect(doc).toContain('resource: "https://www.notion.so/runbook"');
    expect(doc).toContain('timestamp: "2026-07-01T00:00:00.000Z"');
    expect(doc).toContain("atlas:");
    expect(doc).toContain("connector: notion");
    expect(doc).toContain(`page_id: "${idA}"`);
    // Body is a pure function of the page version — no per-sync timestamp that
    // would flip the change comparison and force needless re-review.
    expect(doc).not.toContain("synced_at");
    expect(doc.endsWith("Body text\n")).toBe(true);
  });

  it("keeps frontmatter valid YAML when the title/URL contain colons and quotes", () => {
    const doc = renderNotionOkfDocument({
      id: idA,
      title: 'Q3: "Revenue" — plan',
      lastEditedTime: "2026-07-01T00:00:00.000Z",
      url: 'https://www.notion.so/x?q="a:b"',
      body: "b",
    });
    // JSON-encoded scalars keep the colon/quote from breaking the YAML block.
    expect(doc).toContain('title: "Q3: \\"Revenue\\" — plan"');
    expect(doc).toContain('resource: "https://www.notion.so/x?q=\\"a:b\\""');
  });
});

// ── Vendor client: enumeration + content ───────────────────────────────────────

describe("NotionVendorClient.fetchAll (reconciliation)", () => {
  it("unions search with descent — an inheritance-only child page is found", async () => {
    const parent = pageObject({ id: "parent-id", title: "Parent", lastEditedTime: "2026-07-01T00:00:00.000Z" });
    const { vendor } = client({
      // Search returns ONLY the parent (the child is invisible to search).
      searchPages: [parent],
      blocks: {
        "parent-id": [
          {
            object: "block",
            id: "child-id",
            type: "child_page",
            last_edited_time: "2026-07-02T00:00:00.000Z",
            has_children: false,
            child_page: { title: "Child Runbook" },
          },
        ],
        "child-id": [],
      },
      markdown: {
        "parent-id": { markdown: "Parent body" },
        "child-id": { markdown: "Child body" },
      },
    });
    const changes = await vendor.fetchAll();
    const paths = changes.documents.map((d) => d.path).sort();
    expect(paths.some((p) => p.startsWith("parent-"))).toBe(true);
    expect(paths.some((p) => p.startsWith("child-runbook-"))).toBe(true);
    // High-water mark is the newest last_edited_time across the full set.
    expect(changes.highWaterMark).toBe("2026-07-02T00:00:00.000Z");
  });

  it("skips archived/trashed pages", async () => {
    const { vendor } = client({
      searchPages: [
        pageObject({ id: "live", title: "Live", lastEditedTime: "2026-07-01T00:00:00.000Z" }),
        pageObject({ id: "gone", title: "Gone", lastEditedTime: "2026-07-01T00:00:00.000Z", archived: true }),
      ],
      blocks: { live: [] },
      markdown: { live: { markdown: "hi" } },
    });
    const changes = await vendor.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.documents[0].path).toContain("live-");
  });

  it("throws (never truncates) when the shared set exceeds the doc cap", async () => {
    const { vendor } = client(
      {
        searchPages: [
          pageObject({ id: "a", title: "A", lastEditedTime: "2026-07-01T00:00:00.000Z" }),
          pageObject({ id: "b", title: "B", lastEditedTime: "2026-07-01T00:00:00.000Z" }),
        ],
        blocks: { a: [], b: [] },
      },
      1, // maxDocs
    );
    await expect(vendor.fetchAll()).rejects.toThrow(/over the 1-document limit/);
  });

  it("normalizes content and stamps provenance in the built document", async () => {
    const { vendor } = client({
      searchPages: [pageObject({ id: "p", title: "Doc", lastEditedTime: "2026-07-01T00:00:00.000Z" })],
      blocks: { p: [] },
      markdown: { p: { markdown: "```callout\nNote\n```" } },
    });
    const changes = await vendor.fetchAll();
    expect(changes.documents[0].content).toContain("> Note");
    expect(changes.documents[0].content).toContain("connector: notion");
  });

  it("enumerates pages of a shared database via the data-source query path", async () => {
    const { vendor } = client({
      searchPages: [], // no loose pages — everything lives in the database
      dataSources: [{ object: "data_source", id: "ds-1" }],
      dataSourcePages: {
        "ds-1": [pageObject({ id: "row-1", title: "DB Row", lastEditedTime: "2026-07-03T00:00:00.000Z" })],
      },
      blocks: { "row-1": [] },
      markdown: { "row-1": { markdown: "row body" } },
    });
    const changes = await vendor.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.documents[0].path).toContain("db-row-");
  });

  it("descends a child_database block into its data source's pages", async () => {
    const { vendor } = client({
      searchPages: [pageObject({ id: "parent", title: "Parent", lastEditedTime: "2026-07-01T00:00:00.000Z" })],
      blocks: {
        parent: [{ object: "block", id: "db-1", type: "child_database", has_children: false, child_database: { title: "Tasks" } }],
        "row-x": [],
      },
      databases: { "db-1": { object: "database", id: "db-1", data_sources: [{ id: "ds-x" }] } },
      dataSourcePages: {
        "ds-x": [pageObject({ id: "row-x", title: "Task One", lastEditedTime: "2026-07-04T00:00:00.000Z" })],
      },
      markdown: { parent: { markdown: "p" }, "row-x": { markdown: "task" } },
    });
    const changes = await vendor.fetchAll();
    const paths = changes.documents.map((d) => d.path);
    expect(paths.some((p) => p.startsWith("task-one-"))).toBe(true);
  });

  it("de-duplicates a page reachable via BOTH search and descent (one document)", async () => {
    const dupId = "dupdupdup-1111-2222-3333-444444444444";
    const { vendor } = client({
      // Same page id appears in search AND as a child_page under itself's parent.
      searchPages: [
        pageObject({ id: "root", title: "Root", lastEditedTime: "2026-07-01T00:00:00.000Z" }),
        pageObject({ id: dupId, title: "Dup", lastEditedTime: "2026-07-01T00:00:00.000Z" }),
      ],
      blocks: {
        root: [{ object: "block", id: dupId, type: "child_page", has_children: false, last_edited_time: "2026-07-01T00:00:00.000Z", child_page: { title: "Dup" } }],
        [dupId]: [],
      },
      markdown: { root: { markdown: "r" }, [dupId]: { markdown: "d" } },
    });
    const changes = await vendor.fetchAll();
    const dupPaths = changes.documents.filter((d) => d.path.startsWith("dup-"));
    expect(dupPaths).toHaveLength(1);
  });

  it("throws when the vendor reports more pages but omits the next cursor (never a partial set)", async () => {
    const { fetchImpl } = makeFakeNotion({});
    // Override: a search response that claims has_more but returns no cursor.
    const badFetch = asFetch(async (input) => {
      const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
      if (path === "/search") {
        return new Response(
          JSON.stringify({ object: "list", results: [], has_more: true, next_cursor: null }),
          { status: 200 },
        );
      }
      return fetchImpl(input);
    });
    const http = new NotionHttpClient({ token: "ntn_x", fetchImpl: badFetch, now: () => 0, sleep: async () => {} });
    const vendor = new NotionVendorClient({ http, maxDocs: 1000 });
    await expect(vendor.fetchAll()).rejects.toThrow(/incomplete/i);
  });
});

describe("NotionVendorClient.fetchChanges (incremental)", () => {
  it("collects pages at/after `since` and stops at the first older one", async () => {
    const { vendor, calls } = client({
      // Sorted descending by last_edited_time (as the client requests).
      searchPages: [
        pageObject({ id: "new", title: "New", lastEditedTime: "2026-07-05T00:00:00.000Z" }),
        pageObject({ id: "old", title: "Old", lastEditedTime: "2026-07-01T00:00:00.000Z" }),
      ],
      markdown: { new: { markdown: "fresh" } },
    });
    const changes = await vendor.fetchChanges({ since: "2026-07-03T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(1);
    expect(changes.documents[0].path).toContain("new-");
    // Never fetched content for the older page (walk stopped).
    expect(calls.some((c) => c.path === "/pages/old/markdown")).toBe(false);
    // Incremental does NOT descend block trees (that's reconciliation's job).
    expect(calls.some((c) => c.path.endsWith("/children"))).toBe(false);
  });
});

describe("NotionVendorClient content edge cases", () => {
  it("completes a truncated page by re-fetching its unknown_block_ids", async () => {
    const { vendor } = client({
      searchPages: [pageObject({ id: "big", title: "Big", lastEditedTime: "2026-07-01T00:00:00.000Z" })],
      blocks: { big: [] },
      markdown: {
        big: { markdown: "part one", truncated: true, unknown_block_ids: ["sub"] },
        sub: { markdown: "part two", truncated: false },
      },
    });
    const changes = await vendor.fetchAll();
    expect(changes.documents[0].content).toContain("part one");
    expect(changes.documents[0].content).toContain("part two");
  });

  it("falls back to a block-walk render when the markdown endpoint cannot serve a page", async () => {
    const { vendor } = client({
      searchPages: [pageObject({ id: "hard", title: "Hard", lastEditedTime: "2026-07-01T00:00:00.000Z" })],
      blocks: {
        hard: [
          { object: "block", id: "b1", type: "heading_1", has_children: false, heading_1: { rich_text: [{ plain_text: "Title" }] } },
          { object: "block", id: "b2", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "Prose here" }] } },
        ],
      },
      markdown: { hard: "throw" },
    });
    const changes = await vendor.fetchAll();
    expect(changes.documents[0].content).toContain("# Title");
    expect(changes.documents[0].content).toContain("Prose here");
  });

  it("propagates a 429 during enumeration (the engine owns the backoff)", async () => {
    const { vendor } = client({ searchPages: [], rateLimit: 1 });
    await expect(vendor.fetchAll()).rejects.toBeInstanceOf(ConnectorRateLimitError);
  });

  it("propagates a 429 from the CONTENT path (never swallowed into a fallback)", async () => {
    const { vendor } = client({
      searchPages: [pageObject({ id: "p", title: "P", lastEditedTime: "2026-07-01T00:00:00.000Z" })],
      blocks: { p: [] },
      markdown: { p: "throw-429" },
    });
    await expect(vendor.fetchAll()).rejects.toBeInstanceOf(ConnectorRateLimitError);
  });
});
