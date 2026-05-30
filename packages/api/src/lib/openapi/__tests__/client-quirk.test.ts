/**
 * Client ↔ vendor-quirk integration (v0.0.2 slice 6a, #3028). Proves the generic
 * `executeOperation` / `executeOperationPaged` apply a declarative
 * {@link VendorQuirk} through the existing header + query seams — required headers
 * and query param-shaping (Stripe `expand[]`) — with NO per-vendor code branch,
 * and the headline AC: a Stripe-style cursor walk merges across pages using the
 * SAME generic cursor strategy (last-item-id dialect), expand[] shaped on every
 * page, cursor (`starting_after`) advancing by the last returned object's id.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { buildOperationGraph } from "../spec";
import { executeOperation, executeOperationPaged } from "../client";
import { defaultPaginatorRegistry } from "../strategies";
import { STRIPE_DATA_CANDIDATE, NOTION_DATA_CANDIDATE } from "../data-candidates";
import type { OperationGraph } from "../types";

const STRIPE_SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "fixtures", "stripe.excerpt.json"), "utf8"),
);
const stripeGraph: OperationGraph = buildOperationGraph(STRIPE_SPEC);

const NOTION_SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "fixtures", "notion.excerpt.json"), "utf8"),
);
const notionGraph: OperationGraph = buildOperationGraph(NOTION_SPEC);

/** Capture every request URL + headers a stubbed fetch sees. */
function capturingFetch(body: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    calls.push({ url, headers });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe("executeOperation — vendor quirk application", () => {
  it("shapes a bracketArray query param (expand → expand[]) per the quirk", async () => {
    const { fetchImpl, calls } = capturingFetch({ object: "list", data: [], has_more: false });
    await executeOperation(
      stripeGraph,
      "GetCustomers",
      { query: { expand: ["data.subscriptions"], limit: 3 } },
      { kind: "bearer", token: "sk_test_x" },
      { baseUrl: "https://api.stripe.com", fetchImpl, quirk: STRIPE_DATA_CANDIDATE.quirk },
    );
    const url = calls[0].url;
    // The expand array is emitted under expand[] (Stripe form-encoding), limit untouched.
    expect(url).toContain("expand%5B%5D=data.subscriptions"); // expand[]=…
    expect(url).not.toContain("expand=data.subscriptions"); // not the un-bracketed key
    expect(url).toContain("limit=3");
  });

  it("applies a required static header as a non-clobbering default", async () => {
    const { fetchImpl, calls } = capturingFetch({ data: [], has_more: false });
    await executeOperation(
      stripeGraph,
      "GetCustomers",
      {},
      { kind: "bearer", token: "t" },
      {
        baseUrl: "https://api.stripe.com",
        fetchImpl,
        quirk: { requiredHeaders: { "Stripe-Version": "2024-06-20" } },
      },
    );
    expect(calls[0].headers["stripe-version"]).toBe("2024-06-20");
    // Bearer auth still applied alongside the quirk header.
    expect(calls[0].headers["authorization"]).toBe("Bearer t");
  });

  it("is a transparent no-op when no quirk is supplied", async () => {
    const { fetchImpl, calls } = capturingFetch({ data: [], has_more: false });
    await executeOperation(
      stripeGraph,
      "GetCustomers",
      { query: { expand: ["data.x"] } },
      { kind: "bearer", token: "t" },
      { baseUrl: "https://api.stripe.com", fetchImpl },
    );
    // Without a quirk, expand explodes under its plain key (no brackets).
    expect(calls[0].url).toContain("expand=data.x");
    expect(calls[0].url).not.toContain("expand%5B%5D");
  });
});

describe("executeOperationPaged — Stripe cursor walk (headline AC)", () => {
  it("merges pages via starting_after=<last id>, shaping expand[] on every page", async () => {
    const strategy = defaultPaginatorRegistry.resolve(STRIPE_DATA_CANDIDATE.pagination!);

    const PAGES = 3;
    const PAGE_SIZE = 2;
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const href = typeof input === "string" ? input : input.toString();
      calls.push(href);
      const url = new URL(href);
      const after = url.searchParams.get("starting_after");
      // page index derives from the cursor (cus-<page>-<last>) or 0 on first page.
      const pageIndex = after === null ? 0 : Number(after.split("-")[1]) + 1;
      const data = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `cus-${pageIndex}-${i}` }));
      const has_more = pageIndex < PAGES - 1;
      return new Response(JSON.stringify({ object: "list", data, has_more }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const merged = await executeOperationPaged(
      stripeGraph,
      "GetCustomers",
      { query: { expand: ["data.subscriptions"], limit: PAGE_SIZE } },
      { kind: "bearer", token: "sk_test_x" },
      {
        baseUrl: "https://api.stripe.com",
        fetchImpl,
        pagination: strategy,
        quirk: STRIPE_DATA_CANDIDATE.quirk,
        maxPages: 10,
      },
    );

    expect(merged.items).toHaveLength(PAGES * PAGE_SIZE);
    expect(merged.pageCount).toBe(PAGES);
    expect(merged.truncated).toBe(false);
    expect(calls).toHaveLength(PAGES);
    // First page has no cursor; later pages carry starting_after = previous page's last id.
    expect(calls[0]).not.toContain("starting_after");
    expect(calls[1]).toContain("starting_after=cus-0-1"); // last id of page 0
    expect(calls[2]).toContain("starting_after=cus-1-1"); // last id of page 1
    // expand[] shaping applied on every page, including paginated follow-ups.
    for (const c of calls) expect(c).toContain("expand%5B%5D=data.subscriptions");
  });

  it("sends the quirk's required headers on every page of a cursor walk", async () => {
    const strategy = defaultPaginatorRegistry.resolve(STRIPE_DATA_CANDIDATE.pagination!);

    const PAGES = 3;
    const seenHeaders: Record<string, string>[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input.toString();
      const headers: Record<string, string> = {};
      const h = init?.headers as Record<string, string> | undefined;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
      seenHeaders.push(headers);
      const after = new URL(href).searchParams.get("starting_after");
      const pageIndex = after === null ? 0 : Number(after.split("-")[1]) + 1;
      const data = [{ id: `cus-${pageIndex}-0` }];
      return new Response(
        JSON.stringify({ object: "list", data, has_more: pageIndex < PAGES - 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    await executeOperationPaged(
      stripeGraph,
      "GetCustomers",
      { query: { limit: 1 } },
      { kind: "bearer", token: "sk_test_x" },
      {
        baseUrl: "https://api.stripe.com",
        fetchImpl,
        pagination: strategy,
        // A required-header quirk (the Notion #3029 shape) threaded through the walk.
        quirk: { requiredHeaders: { "Stripe-Version": "2024-06-20" } },
        maxPages: 10,
      },
    );

    expect(seenHeaders).toHaveLength(PAGES);
    // The required header is present on the first AND every paginated follow-up,
    // alongside the bearer credential.
    for (const h of seenHeaders) {
      expect(h["stripe-version"]).toBe("2024-06-20");
      expect(h["authorization"]).toBe("Bearer sk_test_x");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Notion — the required-static-header proof (slice 6b headline AC, #3029)
// ─────────────────────────────────────────────────────────────────────

describe("executeOperation — Notion required Notion-Version header (slice 6b, #3029)", () => {
  it("injects Notion-Version from the quirk on a GET, alongside (never clobbering) bearer auth", async () => {
    const { fetchImpl, calls } = capturingFetch({
      object: "list",
      results: [],
      next_cursor: null,
      has_more: false,
    });
    await executeOperation(
      notionGraph,
      "get-users",
      { query: { page_size: 2 } },
      { kind: "bearer", token: "secret_ntn_x" },
      { baseUrl: "https://api.notion.com", fetchImpl, quirk: NOTION_DATA_CANDIDATE.quirk },
    );
    expect(calls[0].headers["notion-version"]).toBe("2025-09-03");
    expect(calls[0].headers["authorization"]).toBe("Bearer secret_ntn_x");
  });

  it("injects Notion-Version on a POST too — it's data, not a GET-only code path", async () => {
    const { fetchImpl, calls } = capturingFetch({
      object: "list",
      results: [],
      next_cursor: null,
      has_more: false,
    });
    // post-search is the operation behind "list pages in my workspace".
    await executeOperation(
      notionGraph,
      "post-search",
      { body: { query: "roadmap" } },
      { kind: "bearer", token: "secret_ntn_x" },
      { baseUrl: "https://api.notion.com", fetchImpl, quirk: NOTION_DATA_CANDIDATE.quirk },
    );
    expect(calls[0].headers["notion-version"]).toBe("2025-09-03");
    expect(calls[0].headers["authorization"]).toBe("Bearer secret_ntn_x");
  });

  it("is ABSENT without the quirk — proving the header is supplied by the quirk, not the graph", async () => {
    const { fetchImpl, calls } = capturingFetch({
      object: "list",
      results: [],
      next_cursor: null,
      has_more: false,
    });
    await executeOperation(
      notionGraph,
      "get-users",
      { query: { page_size: 2 } },
      { kind: "bearer", token: "t" },
      { baseUrl: "https://api.notion.com", fetchImpl },
    );
    // The spec declares Notion-Version as an OPTIONAL header param with a default,
    // but the generic client never auto-sends a param default — so without the
    // candidate's quirk the header would be missing. That gap is exactly what the
    // declarative requiredHeaders descriptor closes.
    expect(calls[0].headers["notion-version"]).toBeUndefined();
  });
});

describe("executeOperationPaged — Notion cursor walk carries Notion-Version on every page", () => {
  it("merges body-cursor pages (next_cursor → start_cursor) with the header on each request", async () => {
    // The candidate's default pagination resolves over the SAME generic registry —
    // a Notion-specific paginator would throw here.
    const strategy = defaultPaginatorRegistry.resolve(NOTION_DATA_CANDIDATE.pagination!);

    const PAGES = 3;
    const PAGE_SIZE = 2;
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input.toString();
      const headers: Record<string, string> = {};
      const h = init?.headers as Record<string, string> | undefined;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
      seen.push({ url: href, headers });

      const after = new URL(href).searchParams.get("start_cursor");
      // page index derives from the cursor (cursor-<n>) or 0 on the first page.
      const pageIndex = after === null ? 0 : Number(after.replace("cursor-", ""));
      const results = Array.from({ length: PAGE_SIZE }, (_, i) => ({
        object: "user",
        id: `u-${pageIndex}-${i}`,
      }));
      const has_more = pageIndex < PAGES - 1;
      const next_cursor = has_more ? `cursor-${pageIndex + 1}` : null;
      return new Response(JSON.stringify({ object: "list", results, next_cursor, has_more }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const merged = await executeOperationPaged(
      notionGraph,
      "get-users",
      { query: { page_size: PAGE_SIZE } },
      { kind: "bearer", token: "secret_ntn_x" },
      {
        baseUrl: "https://api.notion.com",
        fetchImpl,
        pagination: strategy,
        quirk: NOTION_DATA_CANDIDATE.quirk,
        maxPages: 10,
      },
    );

    expect(merged.items).toHaveLength(PAGES * PAGE_SIZE);
    expect(merged.pageCount).toBe(PAGES);
    expect(merged.truncated).toBe(false);
    expect(seen).toHaveLength(PAGES);

    // First page has no cursor; later pages carry start_cursor = previous next_cursor.
    expect(seen[0].url).not.toContain("start_cursor");
    expect(seen[1].url).toContain("start_cursor=cursor-1");
    expect(seen[2].url).toContain("start_cursor=cursor-2");

    // The headline AC: the required header rides EVERY page of the walk, not just
    // the first, alongside the bearer credential.
    for (const { headers } of seen) {
      expect(headers["notion-version"]).toBe("2025-09-03");
      expect(headers["authorization"]).toBe("Bearer secret_ntn_x");
    }
  });
});
