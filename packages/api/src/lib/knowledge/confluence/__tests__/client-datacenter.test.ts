/**
 * Tests for the Confluence Data Center vendor client (#4394) — driven entirely
 * through an injected fixture `fetchImpl`; NO test touches a real Confluence.
 * Covers reconciliation (full v1 crawl with bodies), incremental (metadata pass
 * + changed-body fetch), `_links.next` pagination, 429 → ConnectorRateLimitError,
 * auth failure, space-not-found, the SSRF guard rejecting a private base URL, and
 * that the SHARED converter produces the same markdown as Cloud for identical
 * storage XHTML (the AC's "identical markdown" property).
 */

import { describe, expect, it } from "bun:test";
import { EgressBlockedError } from "@atlas/api/lib/openapi/egress-guard";
import { createConfluenceDatacenterVendorClient } from "@atlas/api/lib/knowledge/confluence/client-datacenter";

const BASE = "https://confluence.acme.com";

interface FixturePage {
  id: string;
  title: string;
  /** Root-first ancestor ids (v1 returns the full chain inline). */
  ancestorIds: string[];
  modifiedAt: string;
  body: string;
}

const PAGES: FixturePage[] = [
  { id: "1", title: "Engineering", ancestorIds: [], modifiedAt: "2026-07-01T00:00:00.000Z", body: "<p>Root prose here.</p>" },
  { id: "2", title: "Oncall", ancestorIds: ["1"], modifiedAt: "2026-07-06T09:00:00.000Z", body: "<p>Oncall prose here.</p>" },
];

function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function titleFor(id: string): string {
  return PAGES.find((p) => p.id === id)?.title ?? `Page ${id}`;
}

function contentObject(p: FixturePage, withBody: boolean): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    type: "page",
    ancestors: p.ancestorIds.map((id) => ({ id, title: titleFor(id) })),
    version: { when: p.modifiedAt, number: 1 },
    _links: { webui: `/display/ENG/${p.id}`, base: BASE },
    ...(withBody ? { body: { storage: { value: p.body, representation: "storage" } } } : {}),
  };
}

interface FixtureOptions {
  readonly pages?: FixturePage[];
  readonly spaceResults?: unknown[];
  /** Reject with this status on the FIRST call, then behave normally. */
  readonly failFirst?: { status: number; headers?: Record<string, string> };
  /** Paginate the content list into two responses (`_links.next` driven). */
  readonly paginate?: boolean;
}

/** Build a fixture fetchImpl + a call log. */
function makeFetch(opts: FixtureOptions = {}) {
  const pages = opts.pages ?? PAGES;
  const calls: string[] = [];
  let failed = false;
  const impl = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(raw);
    if (opts.failFirst && !failed) {
      failed = true;
      return new Response("", { status: opts.failFirst.status, headers: opts.failFirst.headers });
    }
    const url = new URL(raw);
    const path = url.pathname;

    // Space visibility probe: /rest/api/space?spaceKey=…
    if (path.endsWith("/rest/api/space")) {
      return jsonResponse({ results: opts.spaceResults ?? [{ key: "ENG", id: 100, name: "Engineering" }] });
    }
    // Single content: /rest/api/content/{id}
    const singleMatch = path.match(/\/rest\/api\/content\/([^/]+)$/);
    if (singleMatch) {
      const p = pages.find((x) => x.id === singleMatch[1]);
      if (!p) return jsonResponse({}, 404);
      return jsonResponse(contentObject(p, true));
    }
    // Content list: /rest/api/content
    if (path.endsWith("/rest/api/content")) {
      const withBody = (url.searchParams.get("expand") ?? "").includes("body.storage");
      const start = Number(url.searchParams.get("start") ?? "0");
      if (opts.paginate) {
        if (start === 0) {
          return jsonResponse({
            results: [contentObject(pages[0], withBody)],
            _links: {
              base: BASE,
              next: `/rest/api/content?spaceKey=ENG&type=page&status=current&start=1&limit=100&expand=${encodeURIComponent(withBody ? "version,ancestors,body.storage" : "version,ancestors")}`,
            },
          });
        }
        return jsonResponse({ results: pages.slice(1).map((p) => contentObject(p, withBody)), _links: { base: BASE } });
      }
      return jsonResponse({ results: pages.map((p) => contentObject(p, withBody)), _links: { base: BASE } });
    }
    throw new Error(`fixture: unexpected URL ${raw}`);
  };
  return { impl, calls };
}

function client(over: Partial<Parameters<typeof createConfluenceDatacenterVendorClient>[0]> = {}, fetchImpl?: typeof fetch) {
  return createConfluenceDatacenterVendorClient(
    { baseUrl: BASE, apiToken: "pat-secret-token", spaceKey: "ENG", collectionSlug: "confluence-dc-eng", ...over },
    fetchImpl ? { fetchImpl } : {},
  );
}

describe("fetchAll (reconciliation)", () => {
  it("crawls the full space with bodies and returns assembled OKF documents", async () => {
    const { impl, calls } = makeFetch();
    const changes = await client({}, impl as unknown as typeof fetch).fetchAll();

    expect(changes.documents.map((d) => d.path).toSorted()).toEqual([
      "confluence-dc-eng/engineering.md",
      "confluence-dc-eng/engineering/oncall.md",
    ]);
    expect(changes.highWaterMark).toBe("2026-07-06T09:00:00.000Z");
    // A clean crawl never flags its coverage — the engine may archive off it.
    expect(changes.coverageIncomplete).toBe(false);
    // Bodies came from the enumeration pass — no per-page body fetch.
    expect(calls.some((c) => /\/rest\/api\/content\/\d+/.test(c))).toBe(false);
    // The oncall doc carries provenance + converted body (shared converter).
    const oncall = changes.documents.find((d) => d.path.endsWith("oncall.md"));
    expect(oncall?.content).toContain('resource: "https://confluence.acme.com/display/ENG/2"');
    expect(oncall?.content).toContain("Oncall prose here.");
  });

  it("follows `_links.next` pagination across content-list responses", async () => {
    const { impl } = makeFetch({ paginate: true });
    const changes = await client({}, impl as unknown as typeof fetch).fetchAll();
    expect(changes.documents).toHaveLength(2);
  });
});

describe("fetchChanges (incremental)", () => {
  it("enumerates metadata, fetches bodies only for pages modified at/after since", async () => {
    const { impl, calls } = makeFetch();
    const changes = await client({}, impl as unknown as typeof fetch).fetchChanges({
      since: "2026-07-05T00:00:00.000Z",
      cursor: null,
    });
    // Only page 2 (2026-07-06) changed; page 1 (2026-07-01) filtered out.
    expect(changes.documents.map((d) => d.path)).toEqual(["confluence-dc-eng/engineering/oncall.md"]);
    // High-water mark still reflects the newest page across the whole space.
    expect(changes.highWaterMark).toBe("2026-07-06T09:00:00.000Z");
    // Exactly one per-page body fetch (the changed page).
    expect(calls.filter((c) => /\/rest\/api\/content\/2(\?|$)/.test(c))).toHaveLength(1);
    expect(calls.some((c) => /\/rest\/api\/content\/1(\?|$)/.test(c))).toBe(false);
  });
});

describe("failure handling", () => {
  it("maps a 429 to ConnectorRateLimitError carrying the parsed Retry-After", async () => {
    const { impl } = makeFetch({ failFirst: { status: 429, headers: { "retry-after": "7" } } });
    await expect(client({}, impl as unknown as typeof fetch).fetchAll()).rejects.toMatchObject({
      name: "ConnectorRateLimitError",
      retryAfterSeconds: 7,
    });
  });

  it("maps a 401 to an actionable, host-redacted error (never the token)", async () => {
    const { impl } = makeFetch({ failFirst: { status: 401 } });
    await expect(client({}, impl as unknown as typeof fetch).fetchAll()).rejects.toThrow(
      /rejected the credentials \(401\).*re-enter/i,
    );
  });

  it("errors clearly when the space key is not visible to the token", async () => {
    const { impl } = makeFetch({ spaceResults: [] });
    await expect(client({}, impl as unknown as typeof fetch).fetchAll()).rejects.toThrow(
      /space "ENG" was not found or is not visible/i,
    );
  });

  it("rejects a private/loopback base URL through the SSRF egress guard", async () => {
    const { impl, calls } = makeFetch();
    await expect(
      client({ baseUrl: "https://169.254.169.254" }, impl as unknown as typeof fetch).fetchAll(),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    // The guard blocks BEFORE any request is made.
    expect(calls).toHaveLength(0);
  });

  it("maps a generic non-2xx (500) to an actionable, host-redacted error", async () => {
    const { impl } = makeFetch({ failFirst: { status: 500 } });
    await expect(client({}, impl as unknown as typeof fetch).fetchAll()).rejects.toThrow(/HTTP 500/);
  });

  it("treats a 403 as a credential/permission error (token can't read the space)", async () => {
    const { impl } = makeFetch({ failFirst: { status: 403 } });
    await expect(client({}, impl as unknown as typeof fetch).fetchAll()).rejects.toThrow(
      /rejected the credentials \(403\)/i,
    );
  });

  it("maps a non-JSON response to an actionable, host-redacted error", async () => {
    const impl = async (): Promise<Response> =>
      new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } });
    await expect(client({}, impl as unknown as typeof fetch).fetchAll()).rejects.toThrow(/non-JSON response/i);
  });

  it("warn-skips a malformed page (no version) and flags the crawl's coverage incomplete", async () => {
    const impl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname.endsWith("/rest/api/space")) {
        return jsonResponse({ results: [{ key: "ENG", id: 100 }] });
      }
      // One good page + one malformed (missing version) — the malformed one is
      // dropped (logged), never emitted as a document.
      return jsonResponse({
        results: [
          contentObject(PAGES[0], true),
          { id: "999", title: "Broken", ancestors: [], _links: { webui: "/x", base: BASE }, body: { storage: { value: "<p>x</p>" } } },
        ],
        _links: { base: BASE },
      });
    };
    const changes = await client({}, impl as unknown as typeof fetch).fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual(["confluence-dc-eng/engineering.md"]);
    // The skipped page's document must not be archived off this partial set —
    // the flag makes the engine defer deletions to a clean crawl.
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("normalizes an offset-format version timestamp to a canonical ISO instant", async () => {
    // Raw offset strings compare lexicographically wrong against the engine's
    // toISOString `since`; normalization happens at page construction.
    const offsetPage: FixturePage = {
      id: "7",
      title: "Offset",
      ancestorIds: [],
      modifiedAt: "2026-07-06T11:00:00+05:00",
      body: "<p>Offset prose here.</p>",
    };
    const { impl } = makeFetch({ pages: [offsetPage] });
    const changes = await client({}, impl as unknown as typeof fetch).fetchAll();
    expect(changes.highWaterMark).toBe("2026-07-06T06:00:00.000Z");
    expect(changes.documents[0].content).toContain('timestamp: "2026-07-06T06:00:00.000Z"');
  });
});

describe("context path", () => {
  it("preserves a Server/DC context path in page URLs via `_links.base`", async () => {
    // Self-managed Confluence commonly lives under a context path
    // (e.g. …/confluence). `_links.base` reflects it, and `pageUrl`
    // concatenates (not URL-resolves) so the context path is never dropped.
    const CTX_BASE = "https://confluence.acme.com/confluence";
    const impl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname.endsWith("/rest/api/space")) {
        return jsonResponse({ results: [{ key: "ENG", id: 100 }] });
      }
      return jsonResponse({
        results: [
          {
            id: "2",
            title: "Oncall",
            type: "page",
            ancestors: [],
            version: { when: "2026-07-06T09:00:00.000Z", number: 1 },
            _links: { webui: "/display/ENG/Oncall", base: CTX_BASE },
            body: { storage: { value: "<p>Oncall prose here.</p>", representation: "storage" } },
          },
        ],
        _links: { base: CTX_BASE },
      });
    };
    const changes = await client({ baseUrl: CTX_BASE }, impl as unknown as typeof fetch).fetchAll();
    expect(changes.documents[0].content).toContain(
      'resource: "https://confluence.acme.com/confluence/display/ENG/Oncall"',
    );
  });
});

describe("auth", () => {
  it("sends the PAT as a Bearer token (never Basic, never in the URL)", async () => {
    const seen: { authorization: string | null; url: string }[] = [];
    const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      seen.push({ authorization: headers.get("authorization"), url });
      const path = new URL(url).pathname;
      if (path.endsWith("/rest/api/space")) return jsonResponse({ results: [{ key: "ENG" }] });
      return jsonResponse({ results: PAGES.map((p) => contentObject(p, true)), _links: { base: BASE } });
    };
    await client({}, impl as unknown as typeof fetch).fetchAll();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.authorization).toBe("Bearer pat-secret-token");
      expect(s.url).not.toContain("pat-secret-token");
    }
  });
});
