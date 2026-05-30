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
import { STRIPE_DATA_CANDIDATE } from "../data-candidates";
import type { OperationGraph } from "../types";

const STRIPE_SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "fixtures", "stripe.excerpt.json"), "utf8"),
);
const stripeGraph: OperationGraph = buildOperationGraph(STRIPE_SPEC);

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
});
