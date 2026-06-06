/**
 * Render-branch coverage for the Salesforce provider block on
 * `/admin/connections` — slice 7 of 1.5.3 (#2745).
 *
 * Three orthogonal branches the block must keep distinct:
 *
 *   1. Disconnected → CompactRow with an OAuth Connect link (NOT a URL
 *      form CTA — Salesforce ships only the OAuth path).
 *   2. Connected + status:'ok' → Shell with Instance URL / Org ID /
 *      "Refresh token: Live" / install date detail rows, plus a
 *      Disconnect action that hits `DELETE /api/v1/integrations/salesforce`.
 *   3. Connected + status:'reconnect_needed' → Shell with destructive
 *      "Reconnect needed" badge + Reconnect (primary) + Disconnect
 *      (ghost) actions.
 *
 * Each branch is asserted via stable `data-testid` hooks so a future
 * refactor that conflates them breaks loud at the assertion (rather
 * than silently rendering the wrong CTA against production).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider } from "@/ui/context";
import { SalesforceProviderBlock } from "../salesforce-block";

// Catalog row whose `slug === "salesforce"` is the entire contract
// between the route and this component. Other rows are filtered out
// client-side by the `.find(... slug === "salesforce")` lookup.
const SALESFORCE_ROW_DEFAULTS = {
  id: "catalog:salesforce",
  slug: "salesforce",
  type: "integration" as const,
  installModel: "oauth" as const,
  name: "Salesforce",
  description: "CRM objects via SOQL",
  iconUrl: null,
  minPlan: "starter",
  configSchema: null,
  installed: false,
  installedAt: null as string | null,
  installedBy: null as string | null,
  installStatus: null as string | null,
  upsellOnly: false,
  accessible: true,
  upgradeRequired: null as string | null,
  pillar: "datasource" as const,
  implementationStatus: "available" as const,
  installConfig: null as Record<string, unknown> | null,
};

function salesforceRow(
  overrides: Partial<typeof SALESFORCE_ROW_DEFAULTS> = {},
): Record<string, unknown> {
  return { ...SALESFORCE_ROW_DEFAULTS, ...overrides };
}

const testConfig = {
  apiUrl: "http://localhost:3001",
  isCrossOrigin: false,
  authClient: {
    getToken: async () => null,
    getOrgId: () => null,
    onAuthChange: () => () => undefined,
  },
};

function render(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <AtlasProvider config={testConfig}>{ui}</AtlasProvider>
    </QueryClientProvider>,
  );
}

/**
 * Connected datasources render as a {@link CollapsibleRow} — a one-line summary
 * that reveals its detail sheet + action footer only when expanded. Clicks the
 * row's toggle so the detail rows / Reconnect / Disconnect assertions can run.
 */
async function expandSalesforceRow(container: HTMLElement): Promise<void> {
  const toggle = await waitFor(() => {
    const el = container.querySelector<HTMLButtonElement>(
      '[data-testid="salesforce-row"] button',
    );
    if (!el) throw new Error("salesforce row toggle not rendered yet");
    return el;
  });
  fireEvent.click(toggle);
}

describe("SalesforceProviderBlock", () => {
  const originalFetch = globalThis.fetch;

  /**
   * Stub the catalog GET with a single row (or none). Mirrors the
   * pattern used in catalog-section.test.tsx so the test surface stays
   * familiar.
   */
  function mockCatalog(entries: ReadonlyArray<Record<string, unknown>>) {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v1/integrations/catalog")) {
        return Promise.resolve(
          new Response(JSON.stringify({ catalog: entries }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("disconnected → renders OAuth Connect link, not a URL-form CTA", async () => {
    mockCatalog([salesforceRow({ installed: false })]);
    const { container } = render(
      <SalesforceProviderBlock demoReadOnly={false} onChange={() => undefined} />,
    );

    // The Connect anchor points at the OAuth install endpoint —
    // anchor-with-href is the regression guard against a future refactor
    // that wires Salesforce into the generic URL-form dialog.
    const link = await waitFor(() => {
      const el = container.querySelector<HTMLAnchorElement>(
        'a[data-testid="salesforce-connect"], a[href*="/api/v1/integrations/salesforce/install"]',
      );
      if (!el) throw new Error("Connect link not rendered yet");
      return el;
    });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toContain(
      "/api/v1/integrations/salesforce/install",
    );
    expect(link.textContent).toContain("Connect");

    // Defensive: the page-wide URL-form dialog (which lives in
    // ConnectionFormDialog under page.tsx) is never opened from this
    // block. Asserting the absence of an open <dialog> rules out a
    // future regression where the block accidentally renders one.
    expect(container.querySelector('button[aria-label="Add connection"]')).toBeNull();
  });

  test("disconnected + demoReadOnly → Connect button is disabled", async () => {
    mockCatalog([salesforceRow({ installed: false })]);
    const { container } = render(
      <SalesforceProviderBlock demoReadOnly={true} onChange={() => undefined} />,
    );

    const btn = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>(
        'button[disabled]',
      );
      if (!el || !el.textContent?.includes("Connect")) {
        throw new Error("disabled Connect button not rendered yet");
      }
      return el;
    });
    expect(btn.disabled).toBe(true);
  });

  test("connected + status:'ok' → Shell renders Instance URL / Org ID / Live", async () => {
    mockCatalog([
      salesforceRow({
        installed: true,
        installedAt: "2026-05-20T10:00:00.000Z",
        installedBy: "admin@example.com",
        installStatus: "ok",
        installConfig: {
          instance_url: "https://na139.my.salesforce.com",
          org_id: "00DAB000000ZmU8",
          scopes: "api refresh_token offline_access",
          status: "ok",
        },
      }),
    ]);

    const { container, findByText } = render(
      <SalesforceProviderBlock demoReadOnly={false} onChange={() => undefined} />,
    );

    // Connected Salesforce renders as a collapsed row whose meta line carries
    // the post-OAuth tenant host. Expand it to reveal the detail sheet (Org ID
    // / Refresh token) and the Disconnect action.
    await findByText("https://na139.my.salesforce.com");
    await expandSalesforceRow(container);
    await findByText("00DAB000000ZmU8");

    // "Refresh token: Live" — the freshness pill maps installStatus='ok'
    // to a primary-color "Live" label inside the DetailRow.
    expect(container.textContent).toContain("Refresh token");
    expect(container.textContent).toContain("Live");

    // The Disconnect button is rendered as a routine "outline" CTA (no
    // Reconnect competing for primary attention).
    expect(
      container.querySelector('button[data-testid="salesforce-disconnect"]'),
    ).not.toBeNull();
    // Reconnect badge / primary CTA must NOT appear in the healthy state.
    expect(
      container.querySelector('[data-testid="salesforce-reconnect-badge"]'),
    ).toBeNull();
  });

  test("connected + status:'reconnect_needed' → Reconnect leads, Disconnect recedes", async () => {
    mockCatalog([
      salesforceRow({
        installed: true,
        installedAt: "2026-05-20T10:00:00.000Z",
        installedBy: "admin@example.com",
        installStatus: "reconnect_needed",
        installConfig: {
          instance_url: "https://na139.my.salesforce.com",
          org_id: "00DAB000000ZmU8",
          status: "reconnect_needed",
        },
      }),
    ]);

    const { container } = render(
      <SalesforceProviderBlock demoReadOnly={false} onChange={() => undefined} />,
    );

    // Reconnect-needed badge surfaces on the collapsed row's title.
    await waitFor(() => {
      const badge = container.querySelector(
        '[data-testid="salesforce-reconnect-badge"]',
      );
      if (!badge) throw new Error("reconnect badge not rendered yet");
      return badge;
    });

    // Expand the row to reveal its action footer (Reconnect / Disconnect).
    await expandSalesforceRow(container);

    // Reconnect link is rendered as the primary CTA (same href as
    // Connect — the OAuth callback upserts the install row in place).
    const reconnect = container.querySelector<HTMLAnchorElement>(
      '[data-testid="salesforce-reconnect"]',
    );
    expect(reconnect).not.toBeNull();
    expect(reconnect!.getAttribute("href")).toContain(
      "/api/v1/integrations/salesforce/install",
    );

    // Disconnect button is still available; just recedes to a ghost
    // variant beside Reconnect.
    expect(
      container.querySelector('button[data-testid="salesforce-disconnect"]'),
    ).not.toBeNull();
  });

  test("upsell branch → renders locked Upgrade CTA, hides OAuth Connect link", async () => {
    // The wire row carries the pre-#2701 fields the schema transforms
    // into `access.kind === "upgrade"`. `accessible: false` /
    // `upgradeRequired: "business"` is the canonical "below-plan"
    // shape returned by the API for a workspace whose plan tier
    // doesn't include Salesforce.
    mockCatalog([
      salesforceRow({
        installed: false,
        upsellOnly: true,
        accessible: false,
        upgradeRequired: "business",
        minPlan: "business",
      }),
    ]);

    const { container } = render(
      <SalesforceProviderBlock demoReadOnly={false} onChange={() => undefined} />,
    );

    // Locked CTA renders with the same `data-testid` shape the
    // `CatalogCard` upsell branch uses (`salesforce-locked-cta`) so a
    // future refactor that conflates the two paths stays consistent.
    const lockedBtn = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>(
        'button[data-testid="salesforce-locked-cta"]',
      );
      if (!el) throw new Error("locked Upgrade CTA not rendered yet");
      return el;
    });
    expect(lockedBtn.disabled).toBe(true);
    expect(lockedBtn.textContent).toContain("Upgrade");

    // The OAuth Connect anchor MUST NOT render under upsell — otherwise
    // a click here would start OAuth only to be rejected server-side
    // with `plan_upgrade_required`, the exact UX the PR review (P2)
    // called out as broken.
    expect(
      container.querySelector('a[href*="/api/v1/integrations/salesforce/install"]'),
    ).toBeNull();
    expect(
      container.querySelector('a[data-testid="salesforce-connect"]'),
    ).toBeNull();

    // Plan badge surfaces the required tier so the admin knows why
    // they're locked out.
    const badge = container.querySelector(
      '[data-testid="salesforce-plan-badge"]',
    );
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("business");
  });

  test("coming_soon → inert Coming soon CTA, no Connect link", async () => {
    mockCatalog([
      salesforceRow({ implementationStatus: "coming_soon" }),
    ]);
    const { container } = render(
      <SalesforceProviderBlock demoReadOnly={false} onChange={() => undefined} />,
    );

    await waitFor(() => {
      const btn = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent?.includes("Coming soon"));
      if (!btn) throw new Error("Coming soon CTA not rendered yet");
      return btn;
    });
    // OAuth Connect link must not be rendered when the row is gated by
    // coming_soon — otherwise the admin could initiate an OAuth flow
    // against an unshipped install handler.
    expect(
      container.querySelector('a[href*="/api/v1/integrations/salesforce/install"]'),
    ).toBeNull();
  });

  test("salesforce row absent from catalog → renders nothing", async () => {
    mockCatalog([
      // Some other catalog row, no salesforce entry. The catalog seeder
      // ensures `salesforce` exists today, but the deploy posture
      // (catalog enabled column = false / seeder hasn't run) can hide
      // it. Render-nothing is safer than rendering a broken Connect.
      {
        id: "catalog:slack",
        slug: "slack",
        type: "chat",
        installModel: "oauth",
        name: "Slack",
        description: null,
        iconUrl: null,
        minPlan: "starter",
        configSchema: null,
        installed: false,
        installedAt: null,
        installedBy: null,
        installStatus: null,
        upsellOnly: false,
        accessible: true,
        upgradeRequired: null,
        pillar: "chat",
        implementationStatus: "available",
        installConfig: null,
      },
    ]);
    const { container } = render(
      <SalesforceProviderBlock demoReadOnly={false} onChange={() => undefined} />,
    );

    // Catalog fetch resolves and finds no salesforce row → component
    // returns null. Wait for the fetch to settle by waiting for any
    // microtask flush.
    await waitFor(() => {
      // The loading skeleton renders a "Salesforce" CompactRow with
      // "Loading…" — after the fetch settles, the absent-row branch
      // must clean it up entirely.
      const loading = container.textContent ?? "";
      if (loading.includes("Loading")) throw new Error("still loading");
    });
    expect(container.querySelector('a[href*="salesforce/install"]')).toBeNull();
    expect(container.querySelector('[data-testid="salesforce-connect"]')).toBeNull();
  });
});
