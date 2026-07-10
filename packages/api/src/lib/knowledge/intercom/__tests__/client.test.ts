/**
 * Tests for the Intercom vendor client (#4399) — driven entirely through an
 * injected fixture `fetchImpl`; NO test touches Intercom. Covers the
 * reconciliation-diff posture (full `starting_after` walk for both cadences),
 * the incremental `updated_at`-vs-high-water-mark client diff, multi-locale
 * (each published `translated_content` entry a distinct document), the
 * publish-guard (draft article/locale filtered out), epoch-seconds
 * normalization, the doc cap over the full set, cursor pagination, 429 →
 * ConnectorRateLimitError, auth failure, and install-time verification.
 */

import { describe, expect, it } from "bun:test";
import {
  createIntercomVendorClient,
  verifyIntercomAccess,
  epochSecondsToIso,
  parseRetryAfter,
  IntercomAuthError,
} from "@atlas/api/lib/knowledge/intercom/client";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";

/** 2026-07-01T10:00:00Z / 2026-07-05T08:00:00Z in epoch seconds. */
const T_JUL1 = 1782900000;
const T_JUL5 = 1783238400;

interface FixtureContent {
  title?: string;
  body?: string;
  state?: string;
  updated_at?: number;
  url?: string;
}
interface FixtureArticle {
  id?: number | string;
  title?: string;
  body?: string;
  state?: string;
  updated_at?: number;
  url?: string;
  default_locale?: string;
  translated_content?: Record<string, unknown> | null;
}

function content(overrides: FixtureContent = {}): FixtureContent {
  return {
    title: "Getting Started",
    body: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    state: "published",
    updated_at: T_JUL1,
    url: `https://help.acme.com/en/articles/1-getting-started`,
    ...overrides,
  };
}

const ARTICLES: FixtureArticle[] = [
  {
    id: 1,
    state: "published",
    updated_at: T_JUL1,
    default_locale: "en",
    translated_content: { type: "translated_content", en: content() },
  },
  {
    id: 2,
    state: "published",
    updated_at: T_JUL5,
    default_locale: "en",
    translated_content: {
      type: "translated_content",
      en: content({ title: "Billing FAQ", updated_at: T_JUL5, url: "https://help.acme.com/en/articles/2-billing-faq" }),
      fr: content({ title: "Facturation FAQ", updated_at: T_JUL5, url: "https://help.acme.com/fr/articles/2" }),
    },
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
 * A fixture Intercom API. `articles` serves the `/articles` cursor list
 * (optionally split into two pages via `starting_after`); `/me` serves the
 * verification probe.
 */
function makeFetch(opts: {
  articles?: FixtureArticle[];
  splitList?: boolean;
  failFirst?: { status: number; headers?: Record<string, string> };
  me?: unknown;
}): { impl: typeof globalThis.fetch; state: FixtureState } {
  const state: FixtureState = { calls: [], authHeaders: [] };
  const articles = opts.articles ?? ARTICLES;
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
    if (url.pathname === "/me") {
      return jsonResponse(opts.me ?? { type: "admin", id: "admin-1" });
    }
    if (url.pathname === "/articles") {
      if (opts.splitList) {
        const isSecondPage = url.searchParams.get("starting_after") === "cursor-2";
        return jsonResponse({
          type: "list",
          data: isSecondPage ? articles.slice(1) : articles.slice(0, 1),
          pages: { type: "pages", next: isSecondPage ? null : { starting_after: "cursor-2" } },
        });
      }
      return jsonResponse({ type: "list", data: articles, pages: { type: "pages", next: null } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { impl, state };
}

function client(opts: Parameters<typeof makeFetch>[0] = {}, maxDocs?: number) {
  const { impl, state } = makeFetch(opts);
  const c = createIntercomVendorClient(
    { apiToken: "tok", collectionSlug: "intercom-docs" },
    { fetchImpl: impl, ...(maxDocs !== undefined ? { maxDocs } : {}) },
  );
  return { c, state };
}

describe("epochSecondsToIso", () => {
  it("converts unix seconds (number or numeric string) to a canonical ISO instant", () => {
    expect(epochSecondsToIso(T_JUL1)).toBe("2026-07-01T10:00:00.000Z");
    expect(epochSecondsToIso(String(T_JUL1))).toBe("2026-07-01T10:00:00.000Z");
  });
  it("returns null for a non-numeric / absent value (never a bogus instant)", () => {
    expect(epochSecondsToIso(undefined)).toBeNull();
    expect(epochSecondsToIso("not-a-number")).toBeNull();
    expect(epochSecondsToIso(null)).toBeNull();
  });
});

describe("fetchAll (reconciliation)", () => {
  it("emits one document per published locale with the max updated_at as the mark", async () => {
    const { c } = client();
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "intercom-docs/en/getting-started-1.md",
      "intercom-docs/en/billing-faq-2.md",
      "intercom-docs/fr/facturation-faq-2.md",
    ]);
    expect(changes.highWaterMark).toBe("2026-07-05T08:00:00.000Z");
    expect(changes.coverageIncomplete).toBe(false);
    expect(changes.cursor).toBeNull();
  });

  it("stamps the atlas provenance block (connector + article id + locale) on each document", async () => {
    const { c } = client();
    const changes = await c.fetchAll();
    expect(changes.documents.every((d) => d.content.includes('connector: "intercom"'))).toBe(true);
    const fr = changes.documents.find((d) => d.path.includes("/fr/"));
    expect(fr?.content).toContain('locale: "fr"');
    expect(fr?.content).toContain('article_id: "2"');
  });

  it("follows starting_after cursor pagination across pages", async () => {
    const { c, state } = client({ splitList: true });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(3);
    expect(state.calls.filter((u) => u.includes("/articles"))).toHaveLength(2);
    expect(state.calls.some((u) => u.includes("starting_after=cursor-2"))).toBe(true);
  });

  it("skips draft articles and draft locales (unpublish = absent = archived), still advancing the mark", async () => {
    const { c } = client({
      articles: [
        // A fully-draft article — no published locale, but its timestamp is newest.
        {
          id: 1,
          state: "draft",
          updated_at: 1783324800, // 2026-07-06T08:00:00Z
          translated_content: { type: "translated_content", en: content({ state: "draft", updated_at: 1783324800 }) },
        },
        // A published article with one published + one draft locale.
        {
          id: 2,
          state: "published",
          updated_at: T_JUL1,
          translated_content: {
            type: "translated_content",
            en: content({ updated_at: T_JUL1 }),
            de: content({ state: "draft", updated_at: T_JUL1 }),
          },
        },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual(["intercom-docs/en/getting-started-2.md"]);
    // The draft article still advances the mark — its change was observed.
    expect(changes.highWaterMark).toBe("2026-07-06T08:00:00.000Z");
  });

  it("synthesizes one locale from the top-level fields when translated_content is absent", async () => {
    const { c } = client({
      articles: [
        { id: 7, state: "published", updated_at: T_JUL1, default_locale: "en", body: "<p>Only the top-level body exists here.</p>", title: "Top Level", url: "https://help.acme.com/en/articles/7" },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual(["intercom-docs/en/top-level-7.md"]);
  });

  it("counts a malformed article (no id) and flags coverage incomplete", async () => {
    const { c } = client({
      articles: [
        { title: "no id", state: "published", updated_at: T_JUL1 }, // malformed article
        { id: 2, state: "published", updated_at: T_JUL1, translated_content: { type: "translated_content", en: content({ updated_at: T_JUL1 }) } },
      ],
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("throws an actionable, real-numbered error when the full set exceeds the doc cap", async () => {
    const { c } = client({}, 1);
    await expect(c.fetchAll()).rejects.toThrow(/has 3 published article translations, over the 1-document limit/);
  });

  it("fails loud on a stuck cursor that never terminates (page bound)", async () => {
    const impl = (async (): Promise<Response> =>
      jsonResponse({ type: "list", data: [], pages: { next: { starting_after: "stuck" } } })) as unknown as typeof globalThis.fetch;
    const c = createIntercomVendorClient(
      { apiToken: "tok", collectionSlug: "intercom-docs" },
      { fetchImpl: impl },
    );
    await expect(c.fetchAll()).rejects.toThrow(/did not terminate/i);
  });
});

describe("fetchChanges (incremental reconciliation-diff)", () => {
  it("emits only articles changed at-or-after `since`, keeping the mark across ALL articles", async () => {
    const { c } = client();
    const changes = await c.fetchChanges({ since: "2026-07-05T00:00:00.000Z", cursor: null });
    // Article 1 (Jul 1) is filtered out; article 2 (Jul 5, two locales) stays.
    expect(changes.documents.map((d) => d.path)).toEqual([
      "intercom-docs/en/billing-faq-2.md",
      "intercom-docs/fr/facturation-faq-2.md",
    ]);
    // High-water mark still reflects the newest across ALL enumerated articles.
    expect(changes.highWaterMark).toBe("2026-07-05T08:00:00.000Z");
  });

  it("includes an article whose effective updatedAt exactly equals `since` (>= boundary)", async () => {
    const { c } = client();
    const changes = await c.fetchChanges({ since: "2026-07-05T08:00:00.000Z", cursor: null });
    expect(changes.documents.map((d) => d.path)).toEqual([
      "intercom-docs/en/billing-faq-2.md",
      "intercom-docs/fr/facturation-faq-2.md",
    ]);
  });

  it("serves a null since as a full crawl (defensive)", async () => {
    const { c } = client();
    const changes = await c.fetchChanges({ since: null, cursor: null });
    expect(changes.documents).toHaveLength(3);
  });

  it("does not apply the doc cap on an incremental cycle (cap is a full-set check)", async () => {
    const { c } = client({}, 1);
    const changes = await c.fetchChanges({ since: "2026-07-05T00:00:00.000Z", cursor: null });
    expect(changes.documents).toHaveLength(2);
  });
});

describe("authentication", () => {
  it("sends Bearer token auth on every request", async () => {
    const { c, state } = client();
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

  it("maps a 401 to a typed, host-redacted IntercomAuthError", async () => {
    const { c } = client({ failFirst: { status: 401 } });
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IntercomAuthError);
    expect((err as Error).message).toMatch(/rejected the credentials \(401\)/i);
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

  it("wraps a non-JSON body in a host-redacted error carrying the cause (never the token)", async () => {
    const impl = (async (): Promise<Response> =>
      new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof globalThis.fetch;
    const c = createIntercomVendorClient({ apiToken: "tok", collectionSlug: "c" }, { fetchImpl: impl });
    try {
      await c.fetchAll();
      throw new Error("expected throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/non-JSON response/i);
      expect(message).toContain("api.intercom.io");
      expect(message).not.toContain("tok");
      expect((err as { cause?: unknown }).cause).toBeDefined();
    }
  });
});

describe("verifyIntercomAccess", () => {
  it("resolves when /me returns an identity", async () => {
    const { impl } = makeFetch({});
    await expect(
      verifyIntercomAccess({ apiToken: "tok", collectionSlug: "c" }, { fetchImpl: impl }),
    ).resolves.toBeUndefined();
  });

  it("throws a typed auth error when /me is 401", async () => {
    const { impl } = makeFetch({ failFirst: { status: 401 } });
    await expect(
      verifyIntercomAccess({ apiToken: "bad", collectionSlug: "c" }, { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(IntercomAuthError);
  });

  it("throws when /me returns a hollow body with no identity", async () => {
    const { impl } = makeFetch({ me: {} });
    await expect(
      verifyIntercomAccess({ apiToken: "tok", collectionSlug: "c" }, { fetchImpl: impl }),
    ).rejects.toThrow(/did not return a recognizable identity/i);
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
