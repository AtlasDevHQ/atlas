/**
 * Dashboard card render batch (#2267 parameters, #3212 drilldown).
 *
 * This is the seam a drilldown click ultimately drives: setting a parameter
 * re-renders every card with the bound value. Pins that one POST per chart card
 * is issued to `/render`, carries the override map under `parameters` (bound
 * server-side, never interpolated), and that text cards are skipped.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  renderDashboardCard,
  renderDashboardCards,
  type CardRenderContext,
} from "../dashboard-card-render";
import type { DashboardCard } from "@/ui/lib/types";

const CTX: CardRenderContext = {
  apiUrl: "https://api.test",
  dashboardId: "dash-1",
  isCrossOrigin: true,
};

const baseCard: DashboardCard = {
  id: "card-1",
  dashboardId: "dash-1",
  position: 0,
  title: "Revenue by region",
  kind: "chart",
  sql: "SELECT region, SUM(amount) AS revenue FROM orders WHERE region = :region GROUP BY 1",
  chartConfig: {
    type: "bar",
    categoryColumn: "region",
    valueColumns: ["revenue"],
    drilldown: { targetParam: "region" },
  },
  content: null,
  cachedColumns: ["region", "revenue"],
  cachedRows: [{ region: "us", revenue: 100 }],
  cachedAt: "2026-06-04T00:00:00Z",
  connectionGroupId: null,
  layout: { x: 0, y: 0, w: 12, h: 8 },
  createdAt: "2026-06-04T00:00:00Z",
  updatedAt: "2026-06-04T00:00:00Z",
};

const textCard: DashboardCard = {
  ...baseCard,
  id: "card-text",
  kind: "text",
  sql: "",
  chartConfig: null,
  content: "## Section",
};

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const errResponse = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("renderDashboardCard", () => {
  test("POSTs to the card's /render with the override map bound under `parameters`", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okResponse({ columns: ["region", "revenue"], rows: [{ region: "us", revenue: 100 }] });
    }) as unknown as typeof fetch;

    const entry = await renderDashboardCard(baseCard, { region: "us" }, CTX);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.test/api/v1/dashboards/dash-1/cards/card-1/render");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.credentials).toBe("include"); // isCrossOrigin → include
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ parameters: { region: "us" } });
    expect(entry).toEqual({
      cardId: "card-1",
      ok: true,
      columns: ["region", "revenue"],
      rows: [{ region: "us", revenue: 100 }],
      comparison: undefined,
    });
  });

  test("maps a non-OK response to ok:false with the backend message (never throws)", async () => {
    globalThis.fetch = mock(async () =>
      errResponse(409, { error: "approval_required", message: "Approval required." }),
    ) as unknown as typeof fetch;

    const entry = await renderDashboardCard(baseCard, { region: "us" }, CTX);
    expect(entry).toEqual({ cardId: "card-1", ok: false, error: "Approval required." });
  });

  test("maps a network throw to ok:false rather than rejecting", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const entry = await renderDashboardCard(baseCard, { region: "us" }, CTX);
    expect(entry).toEqual({ cardId: "card-1", ok: false, error: "network down" });
  });
});

describe("renderDashboardCards (batch)", () => {
  test("issues exactly one render per chart card with the bound value, and skips text cards", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return okResponse({ columns: ["region", "revenue"], rows: [] });
    }) as unknown as typeof fetch;

    const cardB: DashboardCard = { ...baseCard, id: "card-2" };
    const entries = await renderDashboardCards([baseCard, textCard, cardB], { region: "eu" }, CTX);

    // Text card skipped — only the two chart cards are rendered.
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/api/v1/dashboards/dash-1/cards/card-1/render",
      "https://api.test/api/v1/dashboards/dash-1/cards/card-2/render",
    ]);
    // Every card binds the identical override map.
    for (const call of calls) {
      expect(call.body).toEqual({ parameters: { region: "eu" } });
    }
    expect(entries.map((e) => e.cardId)).toEqual(["card-1", "card-2"]);
    expect(entries.every((e) => e.ok)).toBe(true);
  });

  test("does not fetch at all when every card is a text card", async () => {
    const fetchMock = mock(async () => okResponse({ columns: [], rows: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const entries = await renderDashboardCards([textCard], { region: "us" }, CTX);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });
});
