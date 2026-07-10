/**
 * Tests for the Front vendor client (#4400) — driven entirely through an
 * injected fixture `fetchImpl`; NO test touches Front. Covers the delta-less
 * full crawl (per-locale article lists + cursor pagination), the incremental
 * since-filter over `last_edited`, published/draft/archived filtering, the
 * high-water mark, the html_content fallback fetch, malformed-item coverage
 * flagging, 429 → ConnectorRateLimitError, auth/not-found failures, same-origin
 * pagination pinning, the ingest cap, and the KB enumeration used at install
 * time.
 */

import { describe, expect, it } from "bun:test";
import {
  createFrontVendorClient,
  listFrontKnowledgeBases,
  normalizeFrontTimestamp,
  parseRetryAfter,
  FrontAuthError,
  FrontNotFoundError,
} from "@atlas/api/lib/knowledge/front/client";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";

const BASE = "https://api2.frontapp.com";
const KB = "kb_1";

interface FixtureArticle {
  id?: string | number;
  name?: string;
  status?: string;
  html_content?: string | null;
  last_edited?: string | number;
  locale?: string;
  url?: string;
}

function art(overrides: FixtureArticle = {}): FixtureArticle {
  return {
    id: "art_1",
    name: "Getting Started",
    status: "published",
    html_content: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    last_edited: "2026-07-01T10:00:00Z",
    ...overrides,
  };
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

/**
 * A fixture Front API. `kb.locales` drives the per-locale walk; `articlesByLocale`
 * is keyed by the `?locale=` value (`""` for a default-locale walk).
 */
function makeFetch(opts: {
  kb?: { id?: string; name?: string; locales?: string[] } | null;
  articlesByLocale?: Record<string, FixtureArticle[]>;
  splitLocale?: string;
  offOriginNext?: boolean;
  articleById?: Record<string, FixtureArticle>;
  knowledgeBases?: Array<{ id?: string; name?: string }>;
  failFirst?: { status: number; headers?: Record<string, string> };
  stuck?: boolean;
}): { impl: typeof globalThis.fetch; state: FixtureState } {
  const state: FixtureState = { calls: [], authHeaders: [] };
  let failed = false;
  const kb = opts.kb === undefined ? { id: KB, name: "Support", locales: ["en", "fr"] } : opts.kb;
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
    const locale = url.searchParams.get("locale") ?? "";

    if (path === "/knowledge_bases") {
      return jsonResponse({
        _results: opts.knowledgeBases ?? [{ id: KB, name: "Support" }],
        _pagination: { next: null },
      });
    }
    const singleMatch = path.match(/^\/knowledge_bases\/[^/]+\/articles\/([^/]+)$/);
    if (singleMatch) {
      const article = opts.articleById?.[singleMatch[1]] ?? {};
      return jsonResponse(article);
    }
    if (path === `/knowledge_bases/${KB}/articles`) {
      if (opts.stuck) {
        return jsonResponse({
          _results: [],
          _pagination: { next: `${BASE}/knowledge_bases/${KB}/articles?page=stuck` },
        });
      }
      const all = opts.articlesByLocale?.[locale] ?? [];
      if (opts.splitLocale === locale) {
        const isSecond = url.searchParams.get("page") === "2";
        const next = opts.offOriginNext
          ? "https://evil.example.com/knowledge_bases/kb_1/articles?page=2"
          : `${BASE}/knowledge_bases/${KB}/articles?locale=${locale}&page=2`;
        return jsonResponse({
          _results: isSecond ? all.slice(1) : all.slice(0, 1),
          _pagination: { next: isSecond ? null : next },
        });
      }
      return jsonResponse({ _results: all, _pagination: { next: null } });
    }
    if (path === `/knowledge_bases/${KB}`) {
      if (kb === null) return new Response("", { status: 404 });
      return jsonResponse(kb);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { impl, state };
}

function client(opts: Parameters<typeof makeFetch>[0] = {}, maxDocs?: number) {
  const { impl, state } = makeFetch(opts);
  const c = createFrontVendorClient(
    { knowledgeBaseId: KB, apiToken: "tok", collectionSlug: "front-support" },
    { fetchImpl: impl, ...(maxDocs !== undefined ? { maxDocs } : {}) },
  );
  return { c, state };
}

describe("fetchAll (reconciliation)", () => {
  it("emits one document per published locale variant with the max last_edited as the mark", async () => {
    const { c } = client({
      articlesByLocale: {
        en: [art({ last_edited: "2026-07-01T10:00:00Z" })],
        fr: [art({ name: "Pour commencer", locale: "fr", last_edited: "2026-07-05T08:00:00Z" })],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "front-support/en/getting-started-art_1.md",
      "front-support/fr/pour-commencer-art_1.md",
    ]);
    expect(changes.highWaterMark).toBe("2026-07-05T08:00:00.000Z");
    expect(changes.coverageIncomplete).toBe(false);
    expect(changes.cursor).toBeNull();
  });

  it("follows cursor pagination across pages within a locale", async () => {
    const { c, state } = client({
      kb: { id: KB, locales: ["en"] },
      splitLocale: "en",
      articlesByLocale: {
        en: [art({ id: "art_1" }), art({ id: "art_2", name: "Billing" })],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(2);
    expect(state.calls.filter((u) => u.includes("/articles?"))).toHaveLength(2);
  });

  it("refuses an off-origin pagination link rather than forward credentials", async () => {
    const { c } = client({
      kb: { id: KB, locales: ["en"] },
      splitLocale: "en",
      offOriginNext: true,
      articlesByLocale: { en: [art({ id: "art_1" }), art({ id: "art_2" })] },
    });
    await expect(c.fetchAll()).rejects.toThrow(/pointing off|refusing to follow/i);
  });

  it("fails loud on a stuck cursor that keeps returning empty pages (page bound)", async () => {
    const { c } = client({ kb: { id: KB, locales: ["en"] }, stuck: true });
    await expect(c.fetchAll()).rejects.toThrow(/did not terminate/i);
  });

  it("skips draft and archived articles (unpublish/archive = absent = archived)", async () => {
    const { c } = client({
      kb: { id: KB, locales: ["en"] },
      articlesByLocale: {
        en: [
          art({ id: "art_1", status: "draft", last_edited: "2026-07-06T00:00:00Z" }),
          art({ id: "art_2", status: "archived", last_edited: "2026-07-04T00:00:00Z" }),
          art({ id: "art_3", status: "published", last_edited: "2026-07-02T00:00:00Z" }),
        ],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual(["front-support/en/getting-started-art_3.md"]);
    // The draft/archived articles still advance the mark — their change was observed.
    expect(changes.highWaterMark).toBe("2026-07-06T00:00:00.000Z");
  });

  it("falls back to a per-article fetch when the list omits html_content", async () => {
    const { c, state } = client({
      kb: { id: KB, locales: ["en"] },
      articlesByLocale: { en: [art({ id: "art_7", html_content: null })] },
      articleById: { art_7: art({ id: "art_7", html_content: "<p>Fetched body text here.</p>" }) },
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(state.calls.some((u) => u.includes("/articles/art_7"))).toBe(true);
  });

  it("counts a published article with no resolvable body and flags coverage incomplete", async () => {
    const { c } = client({
      kb: { id: KB, locales: ["en"] },
      articlesByLocale: { en: [art({ id: "art_9", html_content: null }), art({ id: "art_1" })] },
      articleById: { art_9: { id: "art_9" } }, // fallback also has no html_content
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("counts a malformed article (no id/last_edited) and flags coverage incomplete", async () => {
    const { c } = client({
      kb: { id: KB, locales: ["en"] },
      articlesByLocale: {
        en: [{ name: "no id", status: "published", html_content: "<p>text</p>" }, art({ id: "art_1" })],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("serves a KB with no declared locales as a single default-locale walk", async () => {
    const { c, state } = client({
      kb: { id: KB, locales: [] },
      articlesByLocale: { "": [art({ id: "art_1" })] },
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "front-support/default/getting-started-art_1.md",
    ]);
    // No ?locale= param on the default walk.
    expect(state.calls.some((u) => /\/articles\?locale=/.test(u))).toBe(false);
  });

  it("rejects a published set over the ingest cap before fetching bodies", async () => {
    const { c } = client(
      {
        kb: { id: KB, locales: ["en"] },
        articlesByLocale: {
          en: [art({ id: "art_1" }), art({ id: "art_2" }), art({ id: "art_3" })],
        },
      },
      2,
    );
    await expect(c.fetchAll()).rejects.toThrow(/over the 2-document limit/i);
  });
});

describe("fetchChanges (incremental)", () => {
  it("emits only articles edited at-or-after since, with the observed max as the mark", async () => {
    const { c } = client({
      kb: { id: KB, locales: ["en"] },
      articlesByLocale: {
        en: [
          art({ id: "art_1", last_edited: "2026-07-01T00:00:00Z" }), // before since
          art({ id: "art_2", name: "New", last_edited: "2026-07-08T00:00:00Z" }), // after since
        ],
      },
    });
    const changes = await c.fetchChanges({ since: "2026-07-05T00:00:00.000Z", cursor: null });
    expect(changes.documents.map((d) => d.path)).toEqual(["front-support/en/new-art_2.md"]);
    // The mark is the max observed edit across the whole crawl (not just emitted).
    expect(changes.highWaterMark).toBe("2026-07-08T00:00:00.000Z");
  });

  it("re-emits an article edited exactly at the high-water mark (>= is inclusive)", async () => {
    const since = "2026-07-05T00:00:00.000Z";
    const { c } = client({
      kb: { id: KB, locales: ["en"] },
      articlesByLocale: { en: [art({ id: "art_5", name: "Edge", last_edited: since })] },
    });
    const changes = await c.fetchChanges({ since, cursor: null });
    // A regression to `>` would silently drop an article touched at the mark.
    expect(changes.documents.map((d) => d.path)).toEqual(["front-support/en/edge-art_5.md"]);
  });

  it("serves a null since as a full crawl (defensive)", async () => {
    const { c } = client({
      kb: { id: KB, locales: ["en"] },
      articlesByLocale: { en: [art({ id: "art_1" }), art({ id: "art_2", name: "Two" })] },
    });
    const changes = await c.fetchChanges({ since: null, cursor: null });
    expect(changes.documents).toHaveLength(2);
  });
});

describe("authentication", () => {
  it("sends Front Bearer auth", async () => {
    const { c, state } = client({ kb: { id: KB, locales: ["en"] }, articlesByLocale: { en: [art()] } });
    await c.fetchAll();
    expect(state.authHeaders.length).toBeGreaterThan(0);
    for (const header of state.authHeaders) expect(header).toBe("Bearer tok");
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
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FrontAuthError);
    expect((err as Error).message).toMatch(/rejected the credentials \(401\)/i);
  });

  it("maps a missing KB to a not-found error", async () => {
    const { c } = client({ kb: null });
    await expect(c.fetchAll()).rejects.toBeInstanceOf(FrontNotFoundError);
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

describe("listFrontKnowledgeBases (install-time enumeration + credential check)", () => {
  it("maps knowledge bases and skips malformed entries", async () => {
    const { impl } = makeFetch({
      knowledgeBases: [
        { id: "kb_1", name: "Support" },
        { id: "kb_2", name: "Internal" },
        { name: "no id" }, // malformed — skipped
      ],
    });
    const bases = await listFrontKnowledgeBases({ apiToken: "tok" }, { fetchImpl: impl });
    expect(bases.map((b) => b.id)).toEqual(["kb_1", "kb_2"]);
    expect(bases[0]).toMatchObject({ id: "kb_1", name: "Support" });
  });

  it("propagates an auth failure loudly", async () => {
    const { impl } = makeFetch({ failFirst: { status: 401 } });
    await expect(
      listFrontKnowledgeBases({ apiToken: "bad" }, { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(FrontAuthError);
  });
});

describe("normalizeFrontTimestamp", () => {
  it("normalizes Unix epoch seconds and ISO strings, rejecting garbage", () => {
    expect(normalizeFrontTimestamp(1783296000)).toBe("2026-07-06T00:00:00.000Z");
    expect(normalizeFrontTimestamp("2026-07-01T10:00:00Z")).toBe("2026-07-01T10:00:00.000Z");
    expect(normalizeFrontTimestamp("not-a-date")).toBeNull();
    expect(normalizeFrontTimestamp(null)).toBeNull();
    expect(normalizeFrontTimestamp(undefined)).toBeNull();
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
