/**
 * Tests for the Help Scout Docs vendor client (#4398) — driven entirely through
 * an injected fixture `fetchImpl`; NO test touches Help Scout. Covers
 * reconciliation (collections → paginated bodyless article list → per-article
 * body fetch), incremental (`sort=updatedAt` watermark with per-collection
 * early-stop; ONE body fetch per changed article), the high-water mark, a
 * deleted-mid-sweep article flagging coverage incomplete, 429 →
 * ConnectorRateLimitError, auth failure, key redaction, Basic auth, and the
 * site enumeration used at install time.
 */

import { describe, expect, it } from "bun:test";
import {
  createHelpScoutVendorClient,
  listHelpScoutSites,
  parseRetryAfter,
} from "@atlas/api/lib/knowledge/helpscout/client";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import { HelpScoutAuthError } from "@atlas/api/lib/knowledge/helpscout/client";

interface RefLite {
  id?: string;
  updatedAt?: string;
  status?: string;
}
interface BodyLite {
  name?: string;
  text?: string | null;
  status?: string;
  updatedAt?: string;
  publicUrl?: string;
}

function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface FixtureState {
  calls: string[];
  authHeaders: Array<string | null>;
}

interface FixtureOpts {
  sites?: Array<{ id?: string | number; title?: string; subDomain?: string }>;
  collections?: Array<{ id?: string | number; slug?: string; name?: string }>;
  /** collectionId → article refs (newest-first, as `sort=updatedAt desc` returns). */
  articlesByCollection?: Record<string, RefLite[]>;
  /** collectionId → explicit pages of refs (overrides articlesByCollection). */
  pagesByCollection?: Record<string, RefLite[][]>;
  /** articleId → full body; a missing id 404s the body fetch. */
  bodies?: Record<string, BodyLite>;
  splitArticles?: boolean;
  failFirst?: { status: number; headers?: Record<string, string> };
}

const DEFAULT_COLLECTIONS = [{ id: "col-1", slug: "onboarding" }];
const DEFAULT_REFS: Record<string, RefLite[]> = {
  "col-1": [
    { id: "a1", updatedAt: "2026-07-05T08:00:00Z" },
    { id: "a2", updatedAt: "2026-07-01T10:00:00Z" },
  ],
};
const DEFAULT_BODIES: Record<string, BodyLite> = {
  a1: {
    name: "Getting Started",
    text: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    status: "published",
    updatedAt: "2026-07-05T08:00:00Z",
    publicUrl: "https://acme.helpscoutdocs.com/article/a1",
  },
  a2: {
    name: "Billing FAQ",
    text: "<p>Answers to common billing questions and how to update a card.</p>",
    status: "published",
    updatedAt: "2026-07-01T10:00:00Z",
    publicUrl: "https://acme.helpscoutdocs.com/article/a2",
  },
};

function makeFetch(opts: FixtureOpts = {}): { impl: typeof globalThis.fetch; state: FixtureState } {
  const state: FixtureState = { calls: [], authHeaders: [] };
  const sites = opts.sites ?? [{ id: "site-1", title: "Acme Docs", subDomain: "acme" }];
  const collections = opts.collections ?? DEFAULT_COLLECTIONS;
  const refs = opts.articlesByCollection ?? DEFAULT_REFS;
  const bodies = opts.bodies ?? DEFAULT_BODIES;
  let failed = false;

  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    state.calls.push(raw);
    state.authHeaders.push(new Headers(init?.headers).get("authorization"));
    if (opts.failFirst && !failed) {
      failed = true;
      return new Response("", { status: opts.failFirst.status, headers: opts.failFirst.headers });
    }
    const url = new URL(raw);
    const path = url.pathname;

    const single = path.match(/\/v1\/articles\/([^/]+)$/);
    if (single) {
      const body = bodies[decodeURIComponent(single[1])];
      if (body === undefined) return new Response("not found", { status: 404 });
      return jsonResponse({ article: { id: single[1], ...body } });
    }
    const listArticles = path.match(/\/v1\/collections\/([^/]+)\/articles$/);
    if (listArticles) {
      const collectionId = decodeURIComponent(listArticles[1]);
      const page = Number(url.searchParams.get("page") ?? "1");
      const explicitPages = opts.pagesByCollection?.[collectionId];
      if (explicitPages !== undefined) {
        return jsonResponse({
          articles: { page, pages: explicitPages.length, items: explicitPages[page - 1] ?? [] },
        });
      }
      const all = refs[collectionId] ?? [];
      if (opts.splitArticles) {
        const items = page === 1 ? all.slice(0, 1) : all.slice(1);
        return jsonResponse({ articles: { page, pages: 2, items } });
      }
      return jsonResponse({ articles: { page: 1, pages: 1, items: all } });
    }
    if (path.endsWith("/v1/collections")) {
      return jsonResponse({ collections: { page: 1, pages: 1, items: collections } });
    }
    if (path.endsWith("/v1/sites")) {
      return jsonResponse({ sites: { page: 1, pages: 1, items: sites } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { impl, state };
}

function client(opts: FixtureOpts = {}) {
  const { impl, state } = makeFetch(opts);
  const c = createHelpScoutVendorClient(
    { siteId: "site-1", apiKey: "sk-secret-xyz", collectionSlug: "helpscout-acme" },
    { fetchImpl: impl },
  );
  return { c, state };
}

describe("fetchAll (reconciliation)", () => {
  it("emits one document per published article with the max updatedAt as the mark", async () => {
    const { c } = client();
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "helpscout-acme/onboarding/getting-started-a1.md",
      "helpscout-acme/onboarding/billing-faq-a2.md",
    ]);
    expect(changes.highWaterMark).toBe("2026-07-05T08:00:00.000Z");
    expect(changes.coverageIncomplete).toBe(false);
    expect(changes.cursor).toBeNull();
  });

  it("fetches exactly one body per article (bodyless list)", async () => {
    const { c, state } = client();
    await c.fetchAll();
    const bodyCalls = state.calls.filter((u) => /\/v1\/articles\/[^/]+$/.test(new URL(u).pathname));
    expect(bodyCalls).toHaveLength(2);
  });

  it("follows page pagination within a collection's article list", async () => {
    const { c, state } = client({ splitArticles: true });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(2);
    const listCalls = state.calls.filter((u) => /\/articles$/.test(new URL(u).pathname));
    expect(listCalls).toHaveLength(2);
  });

  it("filters the list to published and sorts by updatedAt desc", async () => {
    const { c, state } = client();
    await c.fetchAll();
    const listCall = state.calls.find((u) => /\/articles$/.test(new URL(u).pathname))!;
    const q = new URL(listCall).searchParams;
    expect(q.get("status")).toBe("published");
    expect(q.get("sort")).toBe("updatedAt");
    expect(q.get("order")).toBe("desc");
    expect(q.get("pageSize")).toBe("100");
  });

  it("skips an article that unpublished between list and body fetch (never emitted)", async () => {
    const { c } = client({
      bodies: { ...DEFAULT_BODIES, a2: { ...DEFAULT_BODIES.a2, status: "notpublished" } },
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "helpscout-acme/onboarding/getting-started-a1.md",
    ]);
    // Not a coverage hole — a clean 200 that we deliberately dropped.
    expect(changes.coverageIncomplete).toBe(false);
  });

  it("flags coverage incomplete when a listed article 404s on body fetch (deleted mid-sweep)", async () => {
    const bodies = { ...DEFAULT_BODIES };
    delete (bodies as Record<string, BodyLite>).a2;
    const { c } = client({ bodies });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });
});

describe("fetchChanges (incremental)", () => {
  it("takes only articles newer than `since` and stops the collection at the mark", async () => {
    const { c, state } = client();
    // since is between a2 (07-01) and a1 (07-05): only a1 changed.
    const changes = await c.fetchChanges({ since: "2026-07-03T00:00:00.000Z", cursor: null });
    expect(changes.documents.map((d) => d.path)).toEqual([
      "helpscout-acme/onboarding/getting-started-a1.md",
    ]);
    expect(changes.highWaterMark).toBe("2026-07-05T08:00:00.000Z");
    // ONE body fetch — only the changed article, never a full sweep.
    const bodyCalls = state.calls.filter((u) => /\/v1\/articles\/[^/]+$/.test(new URL(u).pathname));
    expect(bodyCalls).toHaveLength(1);
    expect(bodyCalls[0]).toContain("/v1/articles/a1");
  });

  it("stops at the mark WITHIN page 1 and never requests page 2 (early-stop)", async () => {
    // page 1 = [n1 (07-05, changed), n2 (07-02, at/older than the mark)];
    // page 2 = [n3 (07-01)]. `since` = 07-03 → the walk must break on n2 and
    // never fetch page 2 (the load-bearing incremental efficiency guarantee).
    const bodies = {
      n1: { ...DEFAULT_BODIES.a1, updatedAt: "2026-07-05T08:00:00Z" },
    };
    const { c, state } = client({
      pagesByCollection: {
        "col-1": [
          [
            { id: "n1", updatedAt: "2026-07-05T08:00:00Z" },
            { id: "n2", updatedAt: "2026-07-02T00:00:00Z" },
          ],
          [{ id: "n3", updatedAt: "2026-07-01T00:00:00Z" }],
        ],
      },
      bodies,
    });
    const changes = await c.fetchChanges({ since: "2026-07-03T00:00:00.000Z", cursor: null });
    expect(changes.documents.map((d) => d.path)).toEqual([
      "helpscout-acme/onboarding/getting-started-n1.md",
    ]);
    // Exactly ONE article-list page request — page 2 was never asked for.
    const listCalls = state.calls.filter((u) => /\/articles$/.test(new URL(u).pathname));
    expect(listCalls).toHaveLength(1);
    // …and exactly one body fetch (only the changed article).
    const bodyCalls = state.calls.filter((u) => /\/v1\/articles\/[^/]+$/.test(new URL(u).pathname));
    expect(bodyCalls).toHaveLength(1);
  });

  it("flags coverage incomplete when a listed ref is missing its id/timestamp", async () => {
    const { c } = client({
      articlesByCollection: {
        "col-1": [
          { id: "a1", updatedAt: "2026-07-05T08:00:00Z" },
          { id: "malformed" }, // no updatedAt → skipped + counted
        ],
      },
    });
    // since below both → the well-formed ref is a change; the malformed one is
    // skipped (never a silent drop) and flags coverage so the engine holds
    // subtractive archiving (governs "deletes via reconcile").
    const changes = await c.fetchChanges({ since: "2026-07-01T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("emits nothing when no article is newer than the mark", async () => {
    const { c, state } = client();
    const changes = await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(0);
    // No body fetch at all — every ref was at/older than the mark.
    const bodyCalls = state.calls.filter((u) => /\/v1\/articles\/[^/]+$/.test(new URL(u).pathname));
    expect(bodyCalls).toHaveLength(0);
  });

  it("throws on an unparseable since instant (defensive)", async () => {
    const { c } = client();
    await expect(c.fetchChanges({ since: "not-a-date", cursor: null })).rejects.toThrow(
      /unparseable since/i,
    );
  });

  it("serves a null since as a full crawl (defensive)", async () => {
    const { c } = client();
    const changes = await c.fetchChanges({ since: null, cursor: null });
    expect(changes.documents).toHaveLength(2);
  });
});

describe("authentication", () => {
  it("sends Help Scout Basic auth: base64('{apiKey}:X')", async () => {
    const { c, state } = client();
    await c.fetchAll();
    const expected = `Basic ${Buffer.from("sk-secret-xyz:X").toString("base64")}`;
    expect(state.authHeaders.length).toBeGreaterThan(0);
    for (const header of state.authHeaders) expect(header).toBe(expected);
  });
});

describe("vendor failure mapping", () => {
  it("throws ConnectorRateLimitError with the parsed Retry-After on a 429", async () => {
    const { c } = client({ failFirst: { status: 429, headers: { "retry-after": "37" } } });
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConnectorRateLimitError);
    expect((err as ConnectorRateLimitError).retryAfterSeconds).toBe(37);
  });

  it("maps a 401 to an actionable, host-redacted credentials error", async () => {
    const { c } = client({ failFirst: { status: 401 } });
    await expect(c.fetchAll()).rejects.toThrow(/rejected the credentials \(401\)/i);
  });

  it("never leaks the API key in an error message", async () => {
    const { c } = client({ failFirst: { status: 500 } });
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("sk-secret-xyz");
  });
});

describe("listHelpScoutSites (install-time enumeration + credential check)", () => {
  it("maps sites, normalizes the subdomain, and skips entries missing an id", async () => {
    const { impl } = makeFetch({
      sites: [
        { id: "s1", title: "Acme", subDomain: "Acme" },
        { id: 2, title: "Beta", subDomain: "" },
        { title: "NoId" }, // malformed — skipped
      ],
    });
    const sites = await listHelpScoutSites({ apiKey: "key" }, { fetchImpl: impl });
    expect(sites.map((s) => s.id)).toEqual(["s1", "2"]);
    expect(sites.map((s) => s.subdomain)).toEqual(["acme", null]);
    expect(sites[0]).toMatchObject({ name: "Acme" });
  });

  it("propagates an auth failure loudly", async () => {
    const { impl } = makeFetch({ failFirst: { status: 401 } });
    const err = await listHelpScoutSites({ apiKey: "bad" }, { fetchImpl: impl }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HelpScoutAuthError);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds and rejects HTTP-dates/garbage", () => {
    expect(parseRetryAfter("42")).toBe(42);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
