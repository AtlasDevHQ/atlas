/**
 * Tests for the GitBook vendor client (#4393) — driven entirely through an
 * injected fixture `fetchImpl`; NO test touches GitBook. Covers reconciliation
 * (full crawl), incremental (updatedAt-filtered body fetch), tree walk with
 * group/link filtering, the doc-cap over the full set, 429 →
 * ConnectorRateLimitError, auth failure, and space verification.
 */

import { describe, expect, it } from "bun:test";
import {
  createGitbookVendorClient,
  verifyGitbookAccess,
  parseRetryAfter,
} from "@atlas/api/lib/knowledge/gitbook/client";

const SPACE_ID = "space-123";

interface FixturePage {
  id: string;
  title: string;
  path: string;
  updatedAt: string;
  markdown: string;
}

const PAGES: FixturePage[] = [
  { id: "p1", title: "Intro", path: "intro", updatedAt: "2026-07-01T00:00:00.000Z", markdown: "# Intro\n\nWelcome to the documentation site." },
  { id: "p2", title: "Setup", path: "guides/setup", updatedAt: "2026-07-06T09:00:00.000Z", markdown: "Install the software by following these steps." },
];

function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A content tree: a top-level group holding both doc pages + one external link. */
function contentTree(pages: FixturePage[]): unknown {
  return {
    pages: [
      {
        id: "grp",
        title: "Guides",
        type: "group",
        path: "guides",
        pages: pages.map((p) => ({
          id: p.id,
          title: p.title,
          type: "document",
          path: p.path,
          updatedAt: p.updatedAt,
          urls: { app: `https://acme.gitbook.io/docs/${p.path}` },
        })),
      },
      { id: "ext", title: "External", type: "link", path: "ext", urls: { app: "https://example.com" } },
    ],
  };
}

interface FixtureOptions {
  readonly pages?: FixturePage[];
  readonly failFirst?: { status: number; headers?: Record<string, string> };
  readonly spaceMissing?: boolean;
}

function makeFetch(opts: FixtureOptions = {}) {
  const pages = opts.pages ?? PAGES;
  const calls: string[] = [];
  let failed = false;
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(raw);
    if (opts.failFirst && !failed) {
      failed = true;
      return new Response("", { status: opts.failFirst.status, headers: opts.failFirst.headers });
    }
    const url = new URL(raw);
    const path = url.pathname;

    // Single-page markdown: /v1/spaces/{id}/content/page/{pageId}
    const pageMatch = path.match(/\/content\/page\/([^/]+)$/);
    if (pageMatch) {
      const p = pages.find((x) => x.id === pageMatch[1]);
      return jsonResponse({ markdown: p?.markdown ?? "" });
    }
    // Content tree: /v1/spaces/{id}/content
    if (path.endsWith(`/spaces/${SPACE_ID}/content`)) {
      return jsonResponse(contentTree(pages));
    }
    // Space: /v1/spaces/{id}
    if (path.endsWith(`/spaces/${SPACE_ID}`)) {
      return opts.spaceMissing ? jsonResponse({}) : jsonResponse({ id: SPACE_ID, title: "Docs" });
    }
    return new Response("not found", { status: 404 });
  };
  return { impl, calls };
}

function client(opts: FixtureOptions = {}, maxDocs?: number) {
  const { impl, calls } = makeFetch(opts);
  const c = createGitbookVendorClient(
    { spaceId: SPACE_ID, apiToken: "tok", collectionSlug: "gitbook-docs" },
    { fetchImpl: impl as unknown as typeof globalThis.fetch, ...(maxDocs !== undefined ? { maxDocs } : {}) },
  );
  return { c, calls };
}

/** Build a client over a bespoke raw fetch impl (for coverage/error-mapping cases). */
function rawClient(impl: (input: string | URL | Request) => Promise<Response>) {
  return createGitbookVendorClient(
    { spaceId: SPACE_ID, apiToken: "tok", collectionSlug: "gitbook-docs" },
    { fetchImpl: impl as unknown as typeof globalThis.fetch },
  );
}

/** A raw fetch impl serving a fixed content tree + a per-page body responder. */
function treeFetch(tree: unknown, pageBody: (pageId: string) => Response) {
  return async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname;
    const pageMatch = path.match(/\/content\/page\/([^/]+)$/);
    if (pageMatch) return pageBody(pageMatch[1]);
    if (path.endsWith(`/spaces/${SPACE_ID}/content`)) return jsonResponse(tree);
    return new Response("not found", { status: 404 });
  };
}

describe("GitbookVendorClient.fetchAll (reconciliation)", () => {
  it("enumerates every document page, skips group/link nodes, and returns docs + high-water mark", async () => {
    const { c } = client();
    const result = await c.fetchAll();
    expect(result.documents).toHaveLength(2);
    expect(result.coverageIncomplete).toBe(false);
    // Newest page's updatedAt.
    expect(result.highWaterMark).toBe("2026-07-06T09:00:00.000Z");
    const paths = result.documents.map((d) => d.path).toSorted();
    expect(paths).toEqual(["gitbook-docs/guides/setup.md", "gitbook-docs/intro.md"]);
  });

  it("stamps the atlas provenance block on each document", async () => {
    const { c } = client();
    const result = await c.fetchAll();
    expect(result.documents.every((d) => d.content.includes('connector: "gitbook"'))).toBe(true);
  });

  it("throws an actionable, real-numbered error when the full set exceeds the doc cap", async () => {
    const { c } = client({}, 1);
    await expect(c.fetchAll()).rejects.toThrow(/has 2 pages, over the 1-document limit/);
  });
});

describe("GitbookVendorClient.fetchChanges (incremental)", () => {
  it("fetches bodies only for pages modified at-or-after `since`", async () => {
    const { c, calls } = client();
    const result = await c.fetchChanges({ since: "2026-07-05T00:00:00.000Z", cursor: null });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].path).toBe("gitbook-docs/guides/setup.md");
    // High-water mark still reflects the newest across ALL enumerated pages.
    expect(result.highWaterMark).toBe("2026-07-06T09:00:00.000Z");
    // Only the changed page's markdown was fetched (p2), not p1's.
    expect(calls.some((u) => u.includes("/content/page/p2"))).toBe(true);
    expect(calls.some((u) => u.includes("/content/page/p1"))).toBe(false);
  });

  it("includes a page whose updatedAt exactly equals `since` (>= boundary)", async () => {
    // The high-water-mark contract re-emits the boundary page (overlap window),
    // never silently drops it.
    const { c } = client();
    const result = await c.fetchChanges({ since: "2026-07-06T09:00:00.000Z", cursor: null });
    expect(result.documents.map((d) => d.path)).toEqual(["gitbook-docs/guides/setup.md"]);
  });

  it("normalizes an offset-format updatedAt to a canonical instant for the filter + high-water mark", async () => {
    // `2026-07-06T11:00:00+02:00` === `09:00:00Z`; a raw-string compare would
    // order it wrong, so `toIsoInstant` must canonicalize it.
    const tree = {
      pages: [
        {
          id: "off",
          title: "Offset",
          type: "document",
          path: "offset",
          updatedAt: "2026-07-06T11:00:00+02:00",
          urls: { app: "https://acme.gitbook.io/docs/offset" },
        },
      ],
    };
    const c = rawClient(treeFetch(tree, () => jsonResponse({ markdown: "Body content long enough here." })));
    const result = await c.fetchAll();
    expect(result.highWaterMark).toBe("2026-07-06T09:00:00.000Z");
    // A `since` just after the normalized instant excludes it (proves canonicalization).
    const inc = await c.fetchChanges({ since: "2026-07-06T09:00:00.001Z", cursor: null });
    expect(inc.documents).toHaveLength(0);
  });
});

describe("GitbookVendorClient coverage flagging (never archive a live page)", () => {
  it("flags coverageIncomplete and emits only the good page when a document node is malformed", async () => {
    const tree = {
      pages: [
        {
          id: "good",
          title: "Good",
          type: "document",
          path: "good",
          updatedAt: "2026-07-06T09:00:00.000Z",
          urls: { app: "https://acme.gitbook.io/docs/good" },
        },
        // A DOCUMENT node missing updatedAt — counted malformed, coverage flagged.
        { id: "bad", title: "Bad", type: "document", path: "bad", urls: { app: "https://x/bad" } },
      ],
    };
    const c = rawClient(treeFetch(tree, () => jsonResponse({ markdown: "Good page body, long enough here." })));
    const result = await c.fetchAll();
    expect(result.documents.map((d) => d.path)).toEqual(["gitbook-docs/good.md"]);
    expect(result.coverageIncomplete).toBe(true);
  });

  it("throws (rather than silently dropping) when a page body has no markdown field", async () => {
    // A 200 body with an absent/non-string markdown is an anomalous vendor
    // response — coercing to "" would look like an empty page and, on
    // reconciliation, archive a live document. It must abort the fetch instead.
    const tree = {
      pages: [
        {
          id: "p",
          title: "P",
          type: "document",
          path: "p",
          updatedAt: "2026-07-06T09:00:00.000Z",
          urls: { app: "https://acme.gitbook.io/docs/p" },
        },
      ],
    };
    const c = rawClient(treeFetch(tree, () => jsonResponse({})));
    await expect(c.fetchAll()).rejects.toThrow(/no markdown field/i);
  });
});

describe("GitbookVendorClient error mapping", () => {
  it("maps a 429 to ConnectorRateLimitError with the parsed Retry-After", async () => {
    const { c } = client({ failFirst: { status: 429, headers: { "retry-after": "12" } } });
    try {
      await c.fetchAll();
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { name?: string }).name).toBe("ConnectorRateLimitError");
      expect((err as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(12);
    }
  });

  it("maps a 401 to an actionable credential error", async () => {
    const { c } = client({ failFirst: { status: 401 } });
    await expect(c.fetchAll()).rejects.toThrow(/rejected the credentials \(401\)/i);
  });

  it("maps a 404 to an actionable space-not-found error", async () => {
    const { c } = client({ failFirst: { status: 404 } });
    await expect(c.fetchAll()).rejects.toThrow(/returned 404/i);
  });

  it("wraps a non-JSON body in a host-redacted error carrying the cause (never the token)", async () => {
    const c = rawClient(async () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }));
    try {
      await c.fetchAll();
      throw new Error("expected throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/non-JSON response/i);
      expect(message).toContain("api.gitbook.com");
      expect(message).not.toContain("tok"); // the bearer token is never surfaced
      expect((err as { cause?: unknown }).cause).toBeDefined();
    }
  });

  it("wraps a transport failure in a host-redacted error carrying the cause", async () => {
    const c = rawClient(async () => {
      throw new TypeError("network down");
    });
    try {
      await c.fetchAll();
      throw new Error("expected throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/request to api\.gitbook\.com failed/i);
      expect((err as { cause?: unknown }).cause).toBeDefined();
    }
  });
});

describe("verifyGitbookAccess", () => {
  it("resolves when the space is visible", async () => {
    const { impl } = makeFetch();
    await expect(
      verifyGitbookAccess(
        { spaceId: SPACE_ID, apiToken: "tok", collectionSlug: "c" },
        { fetchImpl: impl as unknown as typeof globalThis.fetch },
      ),
    ).resolves.toBeUndefined();
  });

  it("throws a not-found error when the space object has no id", async () => {
    const { impl } = makeFetch({ spaceMissing: true });
    await expect(
      verifyGitbookAccess(
        { spaceId: SPACE_ID, apiToken: "tok", collectionSlug: "c" },
        { fetchImpl: impl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow(/was not found or is not visible/i);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds and rejects an HTTP-date", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
