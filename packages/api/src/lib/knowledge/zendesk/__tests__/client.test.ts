/**
 * Tests for the Zendesk vendor client (#4396) — driven entirely through an
 * injected fixture `fetchImpl`; NO test touches Zendesk. Covers reconciliation
 * (cursor-paginated list + translations sideload + fallback), incremental (the
 * native start_time feed + per-article translations), draft semantics, the
 * high-water mark, malformed-item coverage flagging, 429 →
 * ConnectorRateLimitError, auth failure, same-origin pagination pinning, and
 * the brand enumeration used at install time.
 */

import { describe, expect, it } from "bun:test";
import {
  createZendeskVendorClient,
  listZendeskBrands,
  parseRetryAfter,
} from "@atlas/api/lib/knowledge/zendesk/client";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";

const BASE = "https://acme.zendesk.com";

interface FixtureTranslation {
  locale?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  updated_at?: string;
  html_url?: string;
}
interface FixtureArticle {
  id?: number;
  title?: string;
  draft?: boolean;
  updated_at?: string;
  html_url?: string;
  translations?: FixtureTranslation[];
}

function tr(overrides: FixtureTranslation = {}): FixtureTranslation {
  return {
    locale: "en-us",
    title: "Getting Started",
    body: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    draft: false,
    updated_at: "2026-07-01T10:00:00Z",
    html_url: `${BASE}/hc/en-us/articles/1-getting-started`,
    ...overrides,
  };
}

const ARTICLES: FixtureArticle[] = [
  { id: 1, draft: false, updated_at: "2026-07-01T10:00:00Z", translations: [tr()] },
  {
    id: 2,
    draft: false,
    updated_at: "2026-07-05T08:00:00Z",
    translations: [
      tr({ title: "Billing FAQ", html_url: `${BASE}/hc/en-us/articles/2-billing-faq`, updated_at: "2026-07-05T08:00:00Z" }),
      tr({ locale: "de", title: "Abrechnung FAQ", html_url: `${BASE}/hc/de/articles/2`, updated_at: "2026-07-04T08:00:00Z" }),
    ],
  },
];

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

/**
 * A fixture Zendesk API. `articles` serves the cursor list (optionally split
 * into two pages); `incremental` serves the start_time feed pages in order;
 * `translationsById` serves per-article translation fetches.
 */
function makeFetch(opts: {
  articles?: FixtureArticle[];
  splitList?: boolean;
  incremental?: Array<{ articles: FixtureArticle[]; next_page?: string | null; end_time?: number }>;
  translationsById?: Record<string, FixtureTranslation[]>;
  failFirst?: { status: number; headers?: Record<string, string> };
  offOriginNext?: boolean;
}): { impl: typeof globalThis.fetch; state: FixtureState } {
  const state: FixtureState = { calls: [], authHeaders: [] };
  const articles = opts.articles ?? ARTICLES;
  let failed = false;
  let incrementalServed = 0;
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

    if (path.endsWith("/api/v2/help_center/incremental/articles.json")) {
      const page = opts.incremental?.[incrementalServed] ?? { articles: [] };
      incrementalServed++;
      return jsonResponse({
        articles: page.articles,
        next_page: page.next_page ?? null,
        end_time: page.end_time,
        count: page.articles.length,
      });
    }
    const translationMatch = path.match(/\/api\/v2\/help_center\/articles\/(\d+)\/translations\.json$/);
    if (translationMatch) {
      const list = opts.translationsById?.[translationMatch[1]] ?? [];
      return jsonResponse({ translations: list, next_page: null });
    }
    if (path.endsWith("/api/v2/help_center/articles.json")) {
      if (opts.splitList) {
        const isSecondPage = url.searchParams.get("page[after]") === "cursor-2";
        const next = opts.offOriginNext
          ? "https://evil.example.com/api/v2/help_center/articles.json?page[after]=cursor-2"
          : `${BASE}/api/v2/help_center/articles.json?include=translations&page[size]=100&page[after]=cursor-2`;
        return jsonResponse({
          articles: isSecondPage ? articles.slice(1) : articles.slice(0, 1),
          meta: { has_more: !isSecondPage },
          links: { next: isSecondPage ? null : next },
        });
      }
      return jsonResponse({ articles, meta: { has_more: false }, links: { next: null } });
    }
    if (path.endsWith("/api/v2/brands.json")) {
      return jsonResponse({
        brands: [
          { id: 10, name: "Acme", subdomain: "acme", has_help_center: true, active: true },
          { id: 11, name: "Beta", subdomain: "acme-beta", has_help_center: true, active: true },
          { id: 12, name: "NoHC", subdomain: "acme-nohc", has_help_center: false, active: true },
          { id: 13, subdomain: "" }, // malformed — skipped
        ],
        meta: { has_more: false },
        links: { next: null },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { impl, state };
}

function client(opts: Parameters<typeof makeFetch>[0] = {}) {
  const { impl, state } = makeFetch(opts);
  const c = createZendeskVendorClient(
    { brandSubdomain: "acme", email: "ops@acme.test", apiToken: "tok", collectionSlug: "zendesk-acme" },
    { fetchImpl: impl },
  );
  return { c, state };
}

describe("fetchAll (reconciliation)", () => {
  it("emits one document per published translation with the max updated_at as the mark", async () => {
    const { c } = client();
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "zendesk-acme/en-us/getting-started-1.md",
      "zendesk-acme/en-us/billing-faq-2.md",
      "zendesk-acme/de/abrechnung-faq-2.md",
    ]);
    expect(changes.highWaterMark).toBe("2026-07-05T08:00:00.000Z");
    expect(changes.coverageIncomplete).toBe(false);
    expect(changes.cursor).toBeNull();
  });

  it("follows cursor pagination across pages", async () => {
    const { c, state } = client({ splitList: true });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(3);
    expect(state.calls.filter((u) => u.includes("/articles.json"))).toHaveLength(2);
  });

  it("refuses an off-origin pagination link rather than forward credentials", async () => {
    const { c } = client({ splitList: true, offOriginNext: true });
    await expect(c.fetchAll()).rejects.toThrow(/pointing off|refusing to follow/i);
  });

  it("fails loud on a stuck cursor that keeps returning empty pages (page bound)", async () => {
    // A same-origin `next` with has_more forever and zero articles never grows
    // the article count — only the page-count bound stops the walk.
    const impl = (async (): Promise<Response> =>
      jsonResponse({
        articles: [],
        meta: { has_more: true },
        links: { next: `${BASE}/api/v2/help_center/articles.json?page[after]=stuck` },
      })) as unknown as typeof globalThis.fetch;
    const c = createZendeskVendorClient(
      { brandSubdomain: "acme", email: "ops@acme.test", apiToken: "tok", collectionSlug: "zendesk-acme" },
      { fetchImpl: impl },
    );
    await expect(c.fetchAll()).rejects.toThrow(/did not terminate/i);
  });

  it("skips draft articles and draft translations (unpublish = absent = archived)", async () => {
    const { c } = client({
      articles: [
        { id: 1, draft: true, updated_at: "2026-07-06T00:00:00Z", translations: [tr()] },
        {
          id: 2,
          draft: false,
          updated_at: "2026-07-02T00:00:00Z",
          translations: [tr({ updated_at: "2026-07-02T00:00:00Z" }), tr({ locale: "fr", draft: true })],
        },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual(["zendesk-acme/en-us/getting-started-2.md"]);
    // The draft article still advances the mark — its change was observed.
    expect(changes.highWaterMark).toBe("2026-07-06T00:00:00.000Z");
  });

  it("falls back to a per-article translations fetch when the sideload is absent", async () => {
    const { c, state } = client({
      articles: [{ id: 7, draft: false, updated_at: "2026-07-01T00:00:00Z" }],
      translationsById: { "7": [tr({ html_url: `${BASE}/hc/en-us/articles/7` })] },
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(state.calls.some((u) => u.includes("/articles/7/translations.json"))).toBe(true);
  });

  it("counts a malformed article/translation and flags coverage incomplete", async () => {
    const { c } = client({
      articles: [
        { title: "no id", updated_at: "2026-07-01T00:00:00Z" }, // malformed article
        {
          id: 2,
          draft: false,
          updated_at: "2026-07-02T00:00:00Z",
          translations: [tr({ updated_at: "2026-07-02T00:00:00Z" }), tr({ locale: undefined })],
        },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("builds a fallback URL for a translation missing html_url", async () => {
    const { c } = client({
      articles: [
        { id: 3, draft: false, updated_at: "2026-07-01T00:00:00Z", translations: [tr({ html_url: undefined })] },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.documents[0].content).toContain(`resource: "${BASE}/hc/en-us/articles/3"`);
  });
});

describe("fetchChanges (incremental)", () => {
  it("walks the start_time feed and fetches translations per changed article", async () => {
    const { c, state } = client({
      incremental: [
        {
          articles: [{ id: 1, draft: false, updated_at: "2026-07-06T10:00:00Z" }],
          next_page: `${BASE}/api/v2/help_center/incremental/articles.json?start_time=1783418400`,
          end_time: 1783418400,
        },
        { articles: [], end_time: 1783418400, next_page: null },
      ],
      translationsById: { "1": [tr({ updated_at: "2026-07-06T10:00:00Z" })] },
    });
    const changes = await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(1);
    expect(changes.highWaterMark).toBe("2026-07-06T10:00:00.000Z");
    const incrementalCalls = state.calls.filter((u) => u.includes("/incremental/articles.json"));
    expect(incrementalCalls).toHaveLength(2);
    // The FIRST request's start_time is `since` in epoch SECONDS — a ms/s
    // regression here would silently sync nothing against real Zendesk.
    expect(incrementalCalls[0]).toContain("start_time=1783296000");
    // The second page's start_time is the first response's end_time.
    expect(incrementalCalls[1]).toContain("start_time=1783418400");
  });

  it("stops on a stuck cursor (end_time did not advance) instead of looping", async () => {
    const { c, state } = client({
      incremental: [
        {
          articles: [{ id: 1, draft: true, updated_at: "2026-07-06T10:00:00Z" }],
          next_page: "next",
          end_time: 1783296000, // equals the request's start_time — no progress
        },
      ],
    });
    await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(state.calls.filter((u) => u.includes("/incremental/articles.json"))).toHaveLength(1);
  });

  it("dedupes an article that appears on multiple feed pages (newest wins)", async () => {
    const { c, state } = client({
      incremental: [
        {
          articles: [{ id: 1, draft: false, updated_at: "2026-07-06T10:00:00Z" }],
          next_page: "next",
          end_time: 1783418400,
        },
        {
          articles: [{ id: 1, draft: false, updated_at: "2026-07-06T11:00:00Z" }],
          next_page: null,
          end_time: 1783422000,
        },
      ],
      translationsById: { "1": [tr({ updated_at: "2026-07-06T11:00:00Z" })] },
    });
    const changes = await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(1);
    expect(state.calls.filter((u) => u.includes("/translations.json"))).toHaveLength(1);
    expect(changes.highWaterMark).toBe("2026-07-06T11:00:00.000Z");
  });

  it("emits nothing for an article that became draft but still advances the mark", async () => {
    const { c, state } = client({
      incremental: [
        { articles: [{ id: 1, draft: true, updated_at: "2026-07-06T10:00:00Z" }], next_page: null, end_time: 1783418400 },
      ],
    });
    const changes = await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(0);
    expect(changes.highWaterMark).toBe("2026-07-06T10:00:00.000Z");
    // No translations fetch for an unpublished article.
    expect(state.calls.some((u) => u.includes("/translations.json"))).toBe(false);
  });

  it("returns an empty quiet cycle when the feed has no changes", async () => {
    const { c } = client({ incremental: [{ articles: [], end_time: 1783418400, next_page: null }] });
    const changes = await c.fetchChanges({ since: "2026-07-06T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(0);
    expect(changes.highWaterMark).toBeNull();
  });

  it("serves a null since as a full crawl (defensive)", async () => {
    const { c, state } = client();
    const changes = await c.fetchChanges({ since: null, cursor: null });
    expect(changes.documents).toHaveLength(3);
    expect(state.calls.some((u) => u.includes("/incremental/"))).toBe(false);
  });
});

describe("authentication", () => {
  it("sends Zendesk token auth: Basic base64('{email}/token:{apiToken}')", async () => {
    const { c, state } = client();
    await c.fetchAll();
    const expected = `Basic ${Buffer.from("ops@acme.test/token:tok").toString("base64")}`;
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

  it("maps a 404 to an actionable subdomain/help-center error", async () => {
    const { c } = client({ failFirst: { status: 404 } });
    await expect(c.fetchAll()).rejects.toThrow(/404/);
  });

  it("never leaks the token in an error message", async () => {
    const { c } = client({ failFirst: { status: 500 } });
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("tok");
  });
});

describe("listZendeskBrands (install-time enumeration + credential check)", () => {
  it("maps brands, normalizes subdomains, and skips malformed entries", async () => {
    const { impl } = makeFetch({});
    const brands = await listZendeskBrands(
      { subdomain: "acme", email: "ops@acme.test", apiToken: "tok" },
      { fetchImpl: impl },
    );
    expect(brands.map((b) => b.subdomain)).toEqual(["acme", "acme-beta", "acme-nohc"]);
    expect(brands.map((b) => b.hasHelpCenter)).toEqual([true, true, false]);
    expect(brands[0]).toMatchObject({ id: "10", name: "Acme", active: true });
  });

  it("propagates an auth failure loudly", async () => {
    const { impl } = makeFetch({ failFirst: { status: 401 } });
    await expect(
      listZendeskBrands({ subdomain: "acme", email: "e@x.test", apiToken: "bad" }, { fetchImpl: impl }),
    ).rejects.toThrow(/rejected the credentials/i);
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
