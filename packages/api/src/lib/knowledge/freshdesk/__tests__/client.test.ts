/**
 * Tests for the Freshdesk vendor client (#4401) — driven entirely through an
 * injected fixture `fetchImpl`; NO test touches Freshdesk. Covers the delta-less
 * category tree-walk (categories→folders→subfolders→articles), the incremental
 * since-filter over `updated_at`, the status=2 published filter, the high-water
 * mark, per-language `{language_code}` translation fetches (distinct documents),
 * the `articles_count` completeness check, malformed-item coverage flagging,
 * 429 → ConnectorRateLimitError, auth/not-found failures, the ingest cap, and
 * the category enumeration used at install time.
 */

import { describe, expect, it } from "bun:test";
import {
  createFreshdeskVendorClient,
  listFreshdeskCategories,
  parseRetryAfter,
  FreshdeskAuthError,
  FreshdeskNotFoundError,
} from "@atlas/api/lib/knowledge/freshdesk/client";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";

const SUB = "acme";
const CAT = "80000001";

interface FixtureArticle {
  id?: string | number;
  title?: string;
  description?: string | null;
  status?: number;
  updated_at?: string;
  language?: string;
  url?: string;
}

function art(overrides: FixtureArticle = {}): FixtureArticle {
  return {
    id: "9001",
    title: "Getting Started",
    description: "<p>Welcome to the product. Follow the setup guide to begin.</p>",
    status: 2,
    updated_at: "2026-07-01T10:00:00Z",
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

interface FixtureFolder {
  id: string;
  sub_folders_count?: number;
  articles_count?: number;
}

/**
 * A fixture Freshdesk Solutions API. One category with folders → (optional
 * subfolders) → articles; translations keyed by `${articleId}/${lang}`.
 */
function makeFetch(opts: {
  category?: { id?: string; name?: string } | null;
  settings?: { primary_language?: string; supported_languages?: string[] } | null;
  settingsStatus?: number;
  folders?: FixtureFolder[];
  subfolders?: Record<string, FixtureFolder[]>;
  articlesByFolder?: Record<string, FixtureArticle[]>;
  translations?: Record<string, FixtureArticle>;
  splitFolder?: string;
  failFirst?: { status: number; headers?: Record<string, string> };
}): { impl: typeof globalThis.fetch; state: FixtureState } {
  const state: FixtureState = { calls: [], authHeaders: [] };
  let failed = false;
  const category = opts.category === undefined ? { id: CAT, name: "Support" } : opts.category;
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
    const page = url.searchParams.get("page") ?? "1";

    if (path === "/api/v2/settings/helpdesk") {
      if (opts.settingsStatus && opts.settingsStatus !== 200) {
        return new Response("", { status: opts.settingsStatus });
      }
      return jsonResponse(opts.settings ?? { primary_language: "en", supported_languages: [] });
    }
    if (path === `/api/v2/solutions/categories/${CAT}`) {
      if (category === null) return new Response("", { status: 404 });
      return jsonResponse(category);
    }
    if (path === "/api/v2/solutions/categories") {
      return jsonResponse([{ id: CAT, name: "Support" }]);
    }
    const folderMatch = path.match(/^\/api\/v2\/solutions\/categories\/[^/]+\/folders$/);
    if (folderMatch) {
      return jsonResponse(opts.folders ?? [{ id: "700", articles_count: 0 }]);
    }
    const subMatch = path.match(/^\/api\/v2\/solutions\/folders\/([^/]+)\/subfolders$/);
    if (subMatch) {
      return jsonResponse(opts.subfolders?.[subMatch[1]] ?? []);
    }
    const artListMatch = path.match(/^\/api\/v2\/solutions\/folders\/([^/]+)\/articles$/);
    if (artListMatch) {
      const folderId = artListMatch[1];
      const all = opts.articlesByFolder?.[folderId] ?? [];
      if (opts.splitFolder === folderId) {
        // Emulate two pages: page 1 returns 100 (a full page) so the walk asks
        // for page 2; page 2 returns the remainder.
        if (page === "1") return jsonResponse(padPage(all.slice(0, 1)));
        return jsonResponse(all.slice(1));
      }
      return jsonResponse(all);
    }
    const translationMatch = path.match(/^\/api\/v2\/solutions\/articles\/([^/]+)\/([^/]+)$/);
    if (translationMatch) {
      const key = `${translationMatch[1]}/${translationMatch[2]}`;
      const t = opts.translations?.[key];
      if (t === undefined) return new Response("", { status: 404 });
      return jsonResponse(t);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { impl, state };
}

/** Pad a page to exactly PER_PAGE (100) rows so the pager fetches the next page. */
function padPage(head: FixtureArticle[]): FixtureArticle[] {
  const filler: FixtureArticle[] = [];
  for (let i = 0; i < 100 - head.length; i++) {
    filler.push(art({ id: `pad-${i}`, status: 1 })); // drafts — never emitted
  }
  return [...head, ...filler];
}

function client(opts: Parameters<typeof makeFetch>[0] = {}, maxDocs?: number) {
  const { impl, state } = makeFetch(opts);
  const c = createFreshdeskVendorClient(
    { subdomain: SUB, categoryId: CAT, categoryName: "Support", apiKey: "fd-secret", collectionSlug: "freshdesk-support" },
    { fetchImpl: impl, ...(maxDocs !== undefined ? { maxDocs } : {}) },
  );
  return { c, state };
}

describe("fetchAll (reconciliation)", () => {
  it("walks the category tree and emits one document per published article", async () => {
    const { c } = client({
      folders: [{ id: "700", articles_count: 2 }],
      articlesByFolder: {
        "700": [
          art({ id: "9001", updated_at: "2026-07-01T10:00:00Z" }),
          art({ id: "9002", title: "Billing", updated_at: "2026-07-05T08:00:00Z" }),
        ],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "freshdesk-support/en/getting-started-9001.md",
      "freshdesk-support/en/billing-9002.md",
    ]);
    expect(changes.highWaterMark).toBe("2026-07-05T08:00:00.000Z");
    expect(changes.coverageIncomplete).toBe(false);
    expect(changes.cursor).toBeNull();
  });

  it("skips draft (status !== 2) articles but still advances the mark", async () => {
    const { c } = client({
      folders: [{ id: "700", articles_count: 2 }],
      articlesByFolder: {
        "700": [
          art({ id: "9001", status: 1, updated_at: "2026-07-06T00:00:00Z" }), // draft
          art({ id: "9002", title: "Live", status: 2, updated_at: "2026-07-02T00:00:00Z" }),
        ],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual(["freshdesk-support/en/live-9002.md"]);
    // The draft still advances the mark — its change was observed.
    expect(changes.highWaterMark).toBe("2026-07-06T00:00:00.000Z");
  });

  it("descends into subfolders (sub_folders_count > 0)", async () => {
    const { c } = client({
      folders: [{ id: "700", sub_folders_count: 1, articles_count: 1 }],
      subfolders: { "700": [{ id: "701", articles_count: 1 }] },
      articlesByFolder: {
        "700": [art({ id: "9001" })],
        "701": [art({ id: "9002", title: "Nested" })],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path).sort()).toEqual([
      "freshdesk-support/en/getting-started-9001.md",
      "freshdesk-support/en/nested-9002.md",
    ]);
  });

  it("flags coverageIncomplete when a folder lists fewer than its articles_count", async () => {
    const { c } = client({
      folders: [{ id: "700", articles_count: 5 }], // claims 5…
      articlesByFolder: { "700": [art({ id: "9001" })] }, // …lists 1
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("counts a published article with no body and flags coverage incomplete", async () => {
    const { c } = client({
      folders: [{ id: "700", articles_count: 2 }],
      articlesByFolder: {
        "700": [art({ id: "9001", description: null }), art({ id: "9002", title: "Ok" })],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("counts a malformed article (no id/updated_at) and flags coverage incomplete", async () => {
    const { c } = client({
      folders: [{ id: "700", articles_count: 2 }],
      articlesByFolder: {
        "700": [{ title: "no id", status: 2, description: "<p>text</p>" }, art({ id: "9002" })],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
  });

  it("follows page pagination within a folder", async () => {
    const { c, state } = client({
      folders: [{ id: "700", articles_count: 2 }],
      splitFolder: "700",
      articlesByFolder: {
        "700": [art({ id: "9001" }), art({ id: "9002", title: "Two" })],
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "freshdesk-support/en/getting-started-9001.md",
      "freshdesk-support/en/two-9002.md",
    ]);
    expect(state.calls.filter((u) => /\/folders\/700\/articles/.test(u))).toHaveLength(2);
  });

  it("rejects a published set over the ingest cap", async () => {
    const { c } = client(
      {
        folders: [{ id: "700", articles_count: 3 }],
        articlesByFolder: {
          "700": [art({ id: "9001" }), art({ id: "9002" }), art({ id: "9003" })],
        },
      },
      2,
    );
    await expect(c.fetchAll()).rejects.toThrow(/over the 2-document limit/i);
  });
});

describe("multi-language translations", () => {
  it("emits a distinct document per published translation via the {language_code} segment", async () => {
    const { c, state } = client({
      settings: { primary_language: "en", supported_languages: ["fr"] },
      folders: [{ id: "700", articles_count: 1 }],
      articlesByFolder: { "700": [art({ id: "9001", language: "en" })] },
      translations: {
        "9001/fr": art({ id: "9001", title: "Pour commencer", language: "fr", status: 2, updated_at: "2026-07-03T00:00:00Z" }),
      },
    });
    const changes = await c.fetchAll();
    expect(changes.documents.map((d) => d.path)).toEqual([
      "freshdesk-support/en/getting-started-9001.md",
      "freshdesk-support/fr/pour-commencer-9001.md",
    ]);
    // The translation was fetched via the language path segment.
    expect(state.calls.some((u) => /\/solutions\/articles\/9001\/fr$/.test(u))).toBe(true);
  });

  it("skips a missing translation (404) without failing the sync", async () => {
    const { c } = client({
      settings: { primary_language: "en", supported_languages: ["fr", "de"] },
      folders: [{ id: "700", articles_count: 1 }],
      articlesByFolder: { "700": [art({ id: "9001" })] },
      translations: {}, // no translations exist → 404 each
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(false);
  });

  it("makes no translation requests for a single-language account", async () => {
    const { c, state } = client({
      settings: { primary_language: "en", supported_languages: [] },
      folders: [{ id: "700", articles_count: 1 }],
      articlesByFolder: { "700": [art({ id: "9001" })] },
    });
    await c.fetchAll();
    expect(state.calls.some((u) => /\/solutions\/articles\//.test(u))).toBe(false);
  });

  it("falls back to primary-only when /settings/helpdesk is forbidden (403)", async () => {
    const { c, state } = client({
      settingsStatus: 403,
      folders: [{ id: "700", articles_count: 1 }],
      articlesByFolder: { "700": [art({ id: "9001" })] },
    });
    const changes = await c.fetchAll();
    expect(changes.documents).toHaveLength(1);
    expect(state.calls.some((u) => /\/solutions\/articles\//.test(u))).toBe(false);
  });

  it("throws (never swallows) a real 401 on /settings/helpdesk — only 403/404 are tolerated", async () => {
    const { c } = client({
      settingsStatus: 401,
      folders: [{ id: "700", articles_count: 1 }],
      articlesByFolder: { "700": [art({ id: "9001" })] },
    });
    await expect(c.fetchAll()).rejects.toBeInstanceOf(FreshdeskAuthError);
  });

  it("counts a present translation with an unparseable updated_at (not conflated with 404-absent)", async () => {
    const { c } = client({
      settings: { primary_language: "en", supported_languages: ["fr"] },
      folders: [{ id: "700", articles_count: 1 }],
      articlesByFolder: { "700": [art({ id: "9001" })] },
      // Present translation body but no orderable timestamp → malformed, not absent.
      translations: { "9001/fr": { id: "9001", title: "Cassé", status: 2, description: "<p>x</p>" } },
    });
    const changes = await c.fetchAll();
    // Only the primary is emitted; the malformed translation is counted, not
    // silently dropped, so coverage is held incomplete.
    expect(changes.documents.map((d) => d.path)).toEqual([
      "freshdesk-support/en/getting-started-9001.md",
    ]);
    expect(changes.coverageIncomplete).toBe(true);
  });
});

describe("fetchChanges (incremental)", () => {
  it("emits only articles edited at-or-after since, with the observed max as the mark", async () => {
    const { c } = client({
      folders: [{ id: "700", articles_count: 2 }],
      articlesByFolder: {
        "700": [
          art({ id: "9001", updated_at: "2026-07-01T00:00:00Z" }), // before since
          art({ id: "9002", title: "New", updated_at: "2026-07-08T00:00:00Z" }), // after since
        ],
      },
    });
    const changes = await c.fetchChanges({ since: "2026-07-05T00:00:00.000Z", cursor: null });
    expect(changes.documents.map((d) => d.path)).toEqual(["freshdesk-support/en/new-9002.md"]);
    expect(changes.highWaterMark).toBe("2026-07-08T00:00:00.000Z");
  });

  it("re-emits an article edited exactly at since (>= is inclusive)", async () => {
    const since = "2026-07-05T00:00:00.000Z";
    const { c } = client({
      folders: [{ id: "700", articles_count: 1 }],
      articlesByFolder: { "700": [art({ id: "9005", title: "Edge", updated_at: since })] },
    });
    const changes = await c.fetchChanges({ since, cursor: null });
    expect(changes.documents.map((d) => d.path)).toEqual(["freshdesk-support/en/edge-9005.md"]);
  });

  it("serves a null since as a full crawl (defensive)", async () => {
    const { c } = client({
      folders: [{ id: "700", articles_count: 2 }],
      articlesByFolder: { "700": [art({ id: "9001" }), art({ id: "9002", title: "Two" })] },
    });
    const changes = await c.fetchChanges({ since: null, cursor: null });
    expect(changes.documents).toHaveLength(2);
  });

  it("re-emits a fresh translation of a stale primary (translations change independently)", async () => {
    const since = "2026-07-05T00:00:00.000Z";
    const { c } = client({
      settings: { primary_language: "en", supported_languages: ["fr"] },
      folders: [{ id: "700", articles_count: 1 }],
      articlesByFolder: {
        // Primary edited BEFORE since — must not re-emit.
        "700": [art({ id: "9001", language: "en", updated_at: "2026-07-01T00:00:00Z" })],
      },
      translations: {
        // Translation edited AFTER since — must re-emit even though its primary is stale.
        "9001/fr": art({ id: "9001", title: "À jour", language: "fr", status: 2, updated_at: "2026-07-09T00:00:00Z" }),
      },
    });
    const changes = await c.fetchChanges({ since, cursor: null });
    expect(changes.documents.map((d) => d.path)).toEqual(["freshdesk-support/fr/a-jour-9001.md"]);
    expect(changes.highWaterMark).toBe("2026-07-09T00:00:00.000Z");
  });
});

describe("authentication", () => {
  it("sends Freshdesk API-key Basic auth (key as username, X as password)", async () => {
    const { c, state } = client({
      folders: [{ id: "700", articles_count: 1 }],
      articlesByFolder: { "700": [art()] },
    });
    await c.fetchAll();
    const expected = `Basic ${Buffer.from("fd-secret:X").toString("base64")}`;
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
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FreshdeskAuthError);
    expect((err as Error).message).toMatch(/rejected the credentials \(401\)/i);
  });

  it("maps a missing category to a not-found error", async () => {
    const { c } = client({ category: null });
    await expect(c.fetchAll()).rejects.toBeInstanceOf(FreshdeskNotFoundError);
  });

  it("never leaks the API key in an error message", async () => {
    const { c } = client({ failFirst: { status: 500 } });
    const err = await c.fetchAll().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("fd-secret");
  });
});

describe("listFreshdeskCategories (install-time enumeration + credential check)", () => {
  it("maps categories and skips malformed entries", async () => {
    const { impl } = makeFetch({});
    // Override the categories endpoint via a custom fetch.
    const custom = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw);
      if (url.pathname === "/api/v2/solutions/categories") {
        return jsonResponse([
          { id: 1, name: "Support" },
          { id: 2, name: "Internal" },
          { name: "no id" }, // malformed — skipped
        ]);
      }
      return impl(input as never, init);
    }) as unknown as typeof globalThis.fetch;
    const categories = await listFreshdeskCategories({ subdomain: SUB, apiKey: "key" }, { fetchImpl: custom });
    expect(categories.map((c) => c.id)).toEqual(["1", "2"]);
    expect(categories[0]).toMatchObject({ id: "1", name: "Support" });
  });

  it("propagates an auth failure loudly", async () => {
    const { impl } = makeFetch({ failFirst: { status: 401 } });
    await expect(
      listFreshdeskCategories({ subdomain: SUB, apiKey: "bad" }, { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(FreshdeskAuthError);
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
