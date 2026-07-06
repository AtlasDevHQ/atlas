/**
 * Tests for the Confluence vendor client (#4377) — driven entirely through an
 * injected fixture `fetchImpl`; NO test touches Atlassian. Covers reconciliation
 * (full crawl with bodies), incremental (metadata pass + changed-body fetch),
 * cursor pagination, 429 → ConnectorRateLimitError, auth failure, space-not-
 * found, and the SSRF guard rejecting a private base URL.
 */

import { describe, expect, it } from "bun:test";
import { EgressBlockedError } from "@atlas/api/lib/openapi/egress-guard";
import {
  createConfluenceVendorClient,
  parseRetryAfter,
} from "@atlas/api/lib/knowledge/confluence/client";

const BASE = "https://acme.atlassian.net/wiki";
const SPACE_ID = "100";

interface FixturePage {
  id: string;
  title: string;
  parentId: string | null;
  modifiedAt: string;
  body: string;
}

const PAGES: FixturePage[] = [
  { id: "1", title: "Engineering", parentId: null, modifiedAt: "2026-07-01T00:00:00.000Z", body: "<p>Root prose here.</p>" },
  { id: "2", title: "Oncall", parentId: "1", modifiedAt: "2026-07-06T09:00:00.000Z", body: "<p>Oncall prose here.</p>" },
];

function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function pageObject(p: FixturePage, withBody: boolean): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    parentId: p.parentId,
    version: { createdAt: p.modifiedAt, number: 1 },
    _links: { webui: `/spaces/ENG/pages/${p.id}`, base: BASE },
    ...(withBody ? { body: { storage: { value: p.body } } } : {}),
  };
}

interface FixtureOptions {
  readonly pages?: FixturePage[];
  readonly spaceResults?: unknown[];
  /** Reject with this status on the FIRST call, then behave normally. */
  readonly failFirst?: { status: number; headers?: Record<string, string> };
  /** Paginate the page list into two responses (cursor-driven). */
  readonly paginate?: boolean;
}

/** Build a fixture fetchImpl + a call log. */
function makeFetch(opts: FixtureOptions = {}) {
  const pages = opts.pages ?? PAGES;
  const calls: string[] = [];
  let failed = false;
  const impl = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input.toString();
    calls.push(raw);
    if (opts.failFirst && !failed) {
      failed = true;
      return new Response("", { status: opts.failFirst.status, headers: opts.failFirst.headers });
    }
    const url = new URL(raw);
    const path = url.pathname;

    if (path.endsWith("/api/v2/spaces")) {
      return jsonResponse({ results: opts.spaceResults ?? [{ id: SPACE_ID, key: "ENG" }] });
    }
    // Single page: /api/v2/pages/{id}
    const singleMatch = path.match(/\/api\/v2\/pages\/([^/]+)$/);
    if (singleMatch) {
      const p = pages.find((x) => x.id === singleMatch[1]);
      if (!p) return jsonResponse({}, 404);
      return jsonResponse(pageObject(p, true));
    }
    // Page list: /api/v2/spaces/{id}/pages
    if (path.endsWith("/pages")) {
      const withBody = url.searchParams.get("body-format") === "storage";
      const cursor = url.searchParams.get("cursor");
      if (opts.paginate) {
        if (cursor === null) {
          return jsonResponse({
            results: [pageObject(pages[0], withBody)],
            _links: {
              base: BASE,
              next: `/wiki/api/v2/spaces/${SPACE_ID}/pages?cursor=CUR&status=current&limit=100${withBody ? "&body-format=storage" : ""}`,
            },
          });
        }
        return jsonResponse({ results: pages.slice(1).map((p) => pageObject(p, withBody)), _links: { base: BASE } });
      }
      return jsonResponse({ results: pages.map((p) => pageObject(p, withBody)), _links: { base: BASE } });
    }
    throw new Error(`fixture: unexpected URL ${raw}`);
  };
  return { impl, calls };
}

function client(over: Partial<Parameters<typeof createConfluenceVendorClient>[0]> = {}, fetchImpl?: typeof fetch) {
  return createConfluenceVendorClient(
    { baseUrl: BASE, email: "bot@acme.com", apiToken: "secret-token", spaceKey: "ENG", collectionSlug: "confluence-eng", ...over },
    fetchImpl ? { fetchImpl } : {},
  );
}

describe("fetchAll (reconciliation)", () => {
  it("crawls the full space with bodies and returns assembled OKF documents", async () => {
    const { impl, calls } = makeFetch();
    const changes = await client({}, impl as unknown as typeof fetch).fetchAll();

    expect(changes.documents.map((d) => d.path).toSorted()).toEqual([
      "confluence-eng/engineering.md",
      "confluence-eng/engineering/oncall.md",
    ]);
    expect(changes.highWaterMark).toBe("2026-07-06T09:00:00.000Z");
    // Bodies came from the enumeration pass — no per-page body fetch.
    expect(calls.some((c) => /\/api\/v2\/pages\/\d+/.test(c))).toBe(false);
    // The oncall doc carries provenance + converted body.
    const oncall = changes.documents.find((d) => d.path.endsWith("oncall.md"));
    expect(oncall?.content).toContain('resource: "https://acme.atlassian.net/wiki/spaces/ENG/pages/2"');
    expect(oncall?.content).toContain("Oncall prose here.");
  });

  it("follows cursor pagination across page-list responses", async () => {
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
    expect(changes.documents.map((d) => d.path)).toEqual(["confluence-eng/engineering/oncall.md"]);
    // High-water mark still reflects the newest page across the whole space.
    expect(changes.highWaterMark).toBe("2026-07-06T09:00:00.000Z");
    // Exactly one per-page body fetch (the changed page).
    expect(calls.filter((c) => /\/api\/v2\/pages\/2(\?|$)/.test(c))).toHaveLength(1);
    expect(calls.some((c) => /\/api\/v2\/pages\/1(\?|$)/.test(c))).toBe(false);
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
      client({ baseUrl: "https://169.254.169.254/wiki" }, impl as unknown as typeof fetch).fetchAll(),
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

  it("silently drops a malformed page (no version) from the ingest set — the good page still syncs", async () => {
    const impl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname.endsWith("/api/v2/spaces")) {
        return jsonResponse({ results: [{ id: SPACE_ID, key: "ENG" }] });
      }
      // One good page + one malformed (missing version) — the malformed one is
      // dropped (logged), never emitted as a document.
      return jsonResponse({
        results: [
          pageObject(PAGES[0], true),
          { id: "999", title: "Broken", parentId: null, _links: { webui: "/x", base: BASE }, body: { storage: { value: "<p>x</p>" } } },
        ],
        _links: { base: BASE },
      });
    };
    const changes = await client({}, impl as unknown as typeof fetch).fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual(["confluence-eng/engineering.md"]);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds and rejects HTTP-date / garbage", () => {
    expect(parseRetryAfter("12")).toBe(12);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });
});
