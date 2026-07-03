/**
 * Render-branch coverage for the catalog card states under
 * `/admin/integrations`. Originally slice 9 of 1.5.3 (#2747) coverage —
 * extended for slice 8 (#2746) to lock in the consolidated lifecycle
 * (legacy-connected branch, BYOT toggle, pillar split).
 *
 * The three orthogonal gates from `resolveInstallStatus`
 * (`@atlas/api/lib/integrations/install-status-machine`) all surface
 * here as distinct visual affordances — never conflated:
 *
 *   - coming_soon       → grey Clock badge + inert "Coming soon" CTA
 *   - upgrade_required  → purple Lock badge + disabled "Upgrade" CTA
 *   - configured_but_downgraded → red "Plan downgrade" badge + warning copy
 *   - accessible / connected   → normal Install / Connect / Manage CTA
 *
 * The 4-row matrix at the bottom is the regression guard the slice 9
 * AC calls out ("don't conflate") — each row proves a *different*
 * `data-testid` survives, so a future refactor that merges the
 * branches breaks the test.
 *
 * Slice 8 (#2746) consolidated the install/disconnect lifecycle onto
 * the catalog card and added per-platform detail surfacing, BYOT
 * inline form, and the Chat/Actions section split. The new props are
 * `entry` + `status` (aggregated /admin/integrations/status payload,
 * nullable) + `onChange` (replaces `onInstalled`; fires for both
 * install and disconnect since the card now owns both).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render as rtlRender, screen, type RenderResult, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider } from "@/ui/context";
import { CatalogCard, CatalogSection } from "../catalog-section";
import type { IntegrationsCatalogEntry } from "@/ui/lib/admin-schemas";
import type { IntegrationStatus } from "@useatlas/types";

// CatalogCard registers `useAdminMutation` for the disconnect path. The
// mutation hook needs both `<AtlasProvider>` (for the API URL + auth
// client) and `<QueryClientProvider>` (TanStack Query's cache). Neither
// dependency fires during these visual-branch tests because no mutation
// is invoked — the providers exist solely so the hooks can mount.
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
  // Fresh QueryClient per render keeps tests order-independent.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <AtlasProvider config={testConfig}>{ui}</AtlasProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<IntegrationsCatalogEntry> = {},
): IntegrationsCatalogEntry {
  return {
    id: "catalog:slack",
    slug: "slack",
    type: "chat",
    installModel: "oauth",
    name: "Slack",
    description: "Connect Slack",
    iconUrl: null,
    minPlan: "starter",
    configSchema: null,
    installed: false,
    installedAt: null,
    installedBy: null,
    installStatus: null,
    upsellOnly: false,
    access: { kind: "accessible" },
    pillar: "chat",
    implementationStatus: "available",
    ...overrides,
  };
}

const noopChange = () => undefined;

// ---------------------------------------------------------------------------
// coming_soon — the slice-9 deliverable
// ---------------------------------------------------------------------------

describe("CatalogCard — coming_soon", () => {
  test("renders the grey Coming soon badge and inert CTA", () => {
    const { container } = render(
      <CatalogCard
        entry={makeEntry({ slug: "discord", implementationStatus: "coming_soon" })}
        status={null}
        onChange={noopChange}
      />,
    );

    const card = container.querySelector('[data-testid="catalog-card-discord"]');
    expect(card?.getAttribute("data-card-state")).toBe("coming-soon");

    const badge = container.querySelector(
      '[data-testid="catalog-card-discord-coming-soon-badge"]',
    );
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("Coming soon");

    const cta = container.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-card-discord-coming-soon-cta"]',
    );
    expect(cta).not.toBeNull();
    expect(cta!.disabled).toBe(true);
  });

  test("coming_soon dominates the upsell gate — no premium lock surfaces", () => {
    // Upgrade-required would normally show the purple Lock + Premium
    // badge. coming_soon outranks the plan gate per
    // `resolveInstallStatus` — the user must read "Atlas hasn't shipped
    // this" first, not "upgrade your plan".
    const { container } = render(
      <CatalogCard
        entry={makeEntry({
          slug: "telegram",
          implementationStatus: "coming_soon",
          upsellOnly: true,
          access: { kind: "upgrade", requiredPlan: "business" },
        })}
        status={null}
        onChange={noopChange}
      />,
    );

    expect(
      container.querySelector('[data-testid="catalog-card-telegram-lock-icon"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="catalog-card-telegram-plan-badge"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="catalog-card-telegram-locked-cta"]'),
    ).toBeNull();
    // The neutral coming-soon affordance is the only one rendered.
    expect(
      container.querySelector('[data-testid="catalog-card-telegram-coming-soon-cta"]'),
    ).not.toBeNull();
  });

  test("coming_soon dominates the install gate — no Manage / Disconnect", () => {
    // A coming_soon row should never appear "installed"; the API guards
    // against this server-side, but the UI also short-circuits ahead of
    // the install branch as defense-in-depth.
    //
    // Asserting via data-testid (not textContent) so a future copy
    // change to "Configure"/"Remove" doesn't silently green-light the
    // regression.
    const { container } = render(
      <CatalogCard
        entry={makeEntry({
          slug: "whatsapp",
          implementationStatus: "coming_soon",
          installed: true,
          installedAt: "2026-05-20T10:00:00.000Z",
          installedBy: "admin",
        })}
        status={null}
        onChange={noopChange}
      />,
    );

    // The two install-branch CTAs have no data-testid in production
    // today, so use aria-label as the regression hook — same robustness
    // as data-testid (won't drift on copy changes) without requiring
    // a production-code attribute add.
    expect(container.querySelector('button[aria-label^="Manage "]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Disconnect "]')).toBeNull();
    expect(
      container.querySelector('[data-testid="catalog-card-whatsapp-coming-soon-cta"]'),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upgrade_required — regression guard (no conflation with coming_soon)
// ---------------------------------------------------------------------------

describe("CatalogCard — upgrade_required (regression guard for #2747)", () => {
  test("renders the purple Lock + Premium badge + Upgrade CTA", () => {
    const { container } = render(
      <CatalogCard
        entry={makeEntry({
          slug: "salesforce",
          access: { kind: "upgrade", requiredPlan: "business" },
          upsellOnly: true,
          minPlan: "business",
        })}
        status={null}
        onChange={noopChange}
      />,
    );

    // `data-card-state` is the dominant gate identifier — assert it
    // here so a future regression that conflates upgrade-required with
    // coming-soon or accessible breaks loud at this assertion (not
    // later via a copy / icon comparison).
    expect(
      container
        .querySelector('[data-testid="catalog-card-salesforce"]')
        ?.getAttribute("data-card-state"),
    ).toBe("upgrade-required");
    expect(
      container.querySelector('[data-testid="catalog-card-salesforce-lock-icon"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="catalog-card-salesforce-plan-badge"]')
        ?.textContent,
    ).toContain("business");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="catalog-card-salesforce-locked-cta"]',
      )?.disabled,
    ).toBe(true);

    // The coming-soon affordance must NOT be rendered when the only
    // failed gate is the plan tier.
    expect(
      container.querySelector('[data-testid="catalog-card-salesforce-coming-soon-cta"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="catalog-card-salesforce-coming-soon-badge"]'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// accessible — happy path (regression guard)
// ---------------------------------------------------------------------------

describe("CatalogCard — accessible (regression guard for #2747)", () => {
  test("plan admits + implementationStatus=available → Connect CTA, no inert affordance", () => {
    const { container } = render(
      <CatalogCard
        entry={makeEntry({ slug: "slack", implementationStatus: "available" })}
        status={null}
        onChange={noopChange}
      />,
    );

    expect(
      container.querySelector('[data-testid="catalog-card-slack"]')?.getAttribute(
        "data-card-state",
      ),
    ).toBe("accessible");
    // OAuth install link to /install endpoint.
    const link = container.querySelector('a[href*="/api/v1/integrations/slack/install"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("Connect");

    expect(
      container.querySelector('[data-testid="catalog-card-slack-coming-soon-cta"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="catalog-card-slack-locked-cta"]'),
    ).toBeNull();
  });

  test("undefined implementationStatus falls back to available (backwards-compat)", () => {
    // Pre-#2741 API responses omit `implementationStatus`. The card must
    // continue to render as accessible — defaulting to coming_soon would
    // lock every previously-working row to inert on an older API.
    const { implementationStatus: _omit, ...rest } = makeEntry();
    const { container } = render(
      <CatalogCard
        entry={rest as IntegrationsCatalogEntry}
        status={null}
        onChange={noopChange}
      />,
    );

    expect(
      container.querySelector('[data-testid="catalog-card-slack-coming-soon-cta"]'),
    ).toBeNull();
    expect(container.querySelector('a[href*="/install"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slice 8 (#2746) — consolidated lifecycle coverage
// ---------------------------------------------------------------------------

describe("CatalogCard — slice 8 lifecycle (#2746)", () => {
  test("form install model renders Install button (catalog-driven)", () => {
    // Email is the prototype form-install row. With no FormInstallModal
    // open initially, the collapsed CompactRow exposes the Install
    // trigger via its catalog-card-{slug}-install data-testid.
    const { container } = render(
      <CatalogCard
        entry={makeEntry({
          id: "catalog:email",
          slug: "email",
          type: "integration",
          installModel: "form",
          pillar: "action",
          name: "Email (SMTP)",
        })}
        status={null}
        onChange={noopChange}
      />,
    );

    expect(
      container.querySelector('[data-testid="catalog-card-email-install"]'),
    ).not.toBeNull();
    // The OAuth Connect link must NOT also render — only one CTA path
    // per card or the user has two valid affordances at once.
    expect(
      container.querySelector('a[href*="/api/v1/integrations/email/install"]'),
    ).toBeNull();
  });

  test("form-shaped static-bot renders the routing-id Install button (#3140)", () => {
    // gchat: form-shaped static-bot. Pre-#3140 this rendered an inert
    // disabled "Connect" ("not yet shipped"); the install spine replaces it
    // with an Install button that opens the routing-identifier modal (the
    // POST is cap-gated server-side). No internal DB is required — the bot is
    // operator-shared, so there's no BYOT path to gate on.
    const { container } = render(
      <CatalogCard
        entry={makeEntry({
          id: "catalog:gchat",
          slug: "gchat",
          installModel: "static-bot",
          configSchema: [{ key: "workspace_id", type: "string", label: "Workspace ID", required: true }],
        })}
        status={null}
        onChange={noopChange}
      />,
    );
    const install = container.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-card-gchat-install"]',
    );
    expect(install).not.toBeNull();
    expect(install!.disabled).toBe(false);
    // No inert/disabled Connect remains for this slug.
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label^="Connect "][disabled]'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slice 8 — legacy-connected render branch + disconnect routing
//
// The card surfaces a Shell + Disconnect for workspaces whose per-platform
// status reports `connected: true` even when `entry.installed: false` (the
// chat_cache-only BYOT install path that pre-dates #2742). These tests are
// the regression guard for `isLegacyConnected` + `resolveDisconnectRoute` —
// the previous bare-boolean `catalogInstalled || slackHasOAuth` couldn't
// express the "webhook is connected but has no disconnect endpoint" case.
// ---------------------------------------------------------------------------

/**
 * Build a full IntegrationStatus fixture with sensible defaults so a test
 * can override one platform's `connected` flag without re-declaring 10
 * shapes. Mirrors the shape from `@useatlas/types`.
 */
function makeStatus(overrides: Partial<IntegrationStatus> = {}): IntegrationStatus {
  const base: IntegrationStatus = {
    slack: {
      connected: false,
      installedAt: null,
      configurable: true,
      teamId: null,
      workspaceName: null,
      installedBy: null,
      hasOAuthInstall: false,
      oauthConfigured: true,
      envConfigured: false,
    },
    teams: {
      connected: false,
      installedAt: null,
      configurable: true,
      tenantId: null,
      tenantName: null,
    },
    discord: {
      connected: false,
      installedAt: null,
      configurable: true,
      guildId: null,
      guildName: null,
    },
    telegram: {
      connected: false,
      installedAt: null,
      configurable: true,
      botId: null,
      botUsername: null,
    },
    gchat: {
      connected: false,
      installedAt: null,
      configurable: true,
      projectId: null,
      serviceAccountEmail: null,
    },
    github: {
      connected: false,
      installedAt: null,
      configurable: true,
      username: null,
    },
    linear: {
      connected: false,
      installedAt: null,
      configurable: true,
      userName: null,
      userEmail: null,
    },
    whatsapp: {
      connected: false,
      installedAt: null,
      configurable: true,
      phoneNumberId: null,
      displayPhone: null,
    },
    email: {
      connected: false,
      installedAt: null,
      configurable: true,
      provider: null,
      senderAddress: null,
    },
    webhooks: { activeCount: 0, configurable: true },
    deliveryChannels: [],
    deployMode: "self-hosted",
    hasInternalDB: true,
  };
  return { ...base, ...overrides };
}

describe("CatalogCard — legacy-connected render branch (#2746)", () => {
  test("status.slack.connected + entry.installed=false → Shell with Disconnect", () => {
    // Pre-#2742 BYOT install: chat_cache row exists, no workspace_plugins
    // row. The catalog flow has to surface this as connected so the admin
    // can disconnect — without it the install becomes uninstallable from
    // the UI.
    const { container } = render(
      <CatalogCard
        entry={makeEntry({ installed: false })}
        status={makeStatus({
          slack: {
            connected: true,
            installedAt: "2026-04-15T12:00:00.000Z",
            configurable: true,
            teamId: "T01234",
            workspaceName: "Acme Workspace",
            installedBy: null,
            hasOAuthInstall: false,
            oauthConfigured: true,
            envConfigured: false,
          },
        })}
        onChange={noopChange}
      />,
    );
    // The Shell renders (not the CompactRow) because `isConnected` is true.
    // We assert on the Disconnect dialog trigger since it's the action
    // path that depends on the legacy branch resolving correctly.
    const disconnect = container.querySelector<HTMLButtonElement>(
      'button[disabled], button',
    );
    const disconnectByText = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "Disconnect");
    expect(disconnect ?? disconnectByText).toBeDefined();
    expect(disconnectByText).toBeDefined();
    // Detail row from status: workspace name surfaces via DetailList.
    expect(container.textContent).toContain("Acme Workspace");
  });

  test("status=null still admits catalog-installed (initial-load resilience)", () => {
    // If the status fetch is in flight (status=null) but the catalog row
    // says installed=true, the card should still render the connected
    // Shell. Detail rows go missing (no status to map from) but Disconnect
    // works through the catalog endpoint regardless.
    const { container } = render(
      <CatalogCard
        entry={makeEntry({ installed: true, installedAt: "2026-04-15T12:00:00.000Z" })}
        status={null}
        onChange={noopChange}
      />,
    );
    const disconnect = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "Disconnect");
    expect(disconnect).toBeDefined();
  });

  test("webhook with activeCount>0 hides Disconnect (no legacy endpoint)", () => {
    // Webhook is the live edge case the bare-boolean routing missed:
    // `isLegacyConnected("webhook", status)` returns true when there are
    // active scheduled tasks, but `/api/v1/admin/integrations/webhook`
    // doesn't exist. The card surfaces the deep-link to scheduled-tasks
    // instead of a 404-bound Disconnect.
    const { container } = render(
      <CatalogCard
        entry={makeEntry({
          id: "catalog:webhook",
          slug: "webhook",
          type: "integration",
          installModel: "form",
          pillar: "action",
          name: "Webhook",
          installed: false,
        })}
        status={makeStatus({ webhooks: { activeCount: 3, configurable: true } })}
        onChange={noopChange}
      />,
    );
    // The connected Shell renders (activeCount > 0 reads as connected for
    // detail-row purposes) but NO Disconnect button surfaces — the
    // `LEGACY_DISCONNECT_SLUGS` gate hides it.
    const disconnect = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "Disconnect");
    expect(disconnect).toBeUndefined();
    // The "Manage scheduled tasks" deep link is the surviving affordance.
    const manageLink = container.querySelector<HTMLAnchorElement>(
      'a[href="/admin/scheduled-tasks"]',
    );
    expect(manageLink).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slice 8 — disconnect routing (catalog vs legacy endpoint selection)
//
// `resolveDisconnectRoute` is the single source of truth for which DELETE
// fires when an admin clicks Disconnect. Wrong route → orphan row, wrong
// store. These tests stub global.fetch and assert the exact URL the click
// reaches.
// ---------------------------------------------------------------------------

describe("CatalogCard — disconnect routing (#2746)", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; method: string }>;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      fetchCalls.push({ url, method });
      return Promise.resolve(
        new Response(JSON.stringify({ message: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  /** Confirm the Disconnect button and click it through the AlertDialog. */
  async function clickDisconnect(container: HTMLElement) {
    const trigger = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "Disconnect");
    expect(trigger).toBeDefined();
    await act(async () => {
      fireEvent.click(trigger!);
    });
    // shadcn AlertDialog portals the confirm button; query the document.
    const confirm = await waitFor(() => {
      const b = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (btn) => btn.textContent?.trim() === "Disconnect" && btn !== trigger,
      );
      if (!b) throw new Error("AlertDialog confirm button not found");
      return b;
    });
    await act(async () => {
      fireEvent.click(confirm);
    });
  }

  test("catalog-installed → DELETE /api/v1/integrations/:slug (catalog endpoint)", async () => {
    const { container } = render(
      <CatalogCard
        entry={makeEntry({ installed: true, installedAt: "2026-04-15T12:00:00.000Z" })}
        status={makeStatus()}
        onChange={noopChange}
      />,
    );
    await clickDisconnect(container);
    await waitFor(() => {
      expect(
        fetchCalls.some(
          (c) => c.method === "DELETE" && c.url.endsWith("/api/v1/integrations/slack"),
        ),
      ).toBe(true);
    });
    // The legacy admin DELETE must NOT have fired.
    expect(
      fetchCalls.some(
        (c) =>
          c.method === "DELETE" &&
          c.url.endsWith("/api/v1/admin/integrations/slack"),
      ),
    ).toBe(false);
  });

  test("legacy BYOT-only connected → DELETE /api/v1/admin/integrations/:slug (legacy endpoint)", async () => {
    // status.slack.connected=true, hasOAuthInstall=false (BYOT only),
    // entry.installed=false → resolveDisconnectRoute returns `legacy`.
    const { container } = render(
      <CatalogCard
        entry={makeEntry({ installed: false })}
        status={makeStatus({
          slack: {
            connected: true,
            installedAt: "2026-04-15T12:00:00.000Z",
            configurable: true,
            teamId: "T01234",
            workspaceName: "Acme",
            installedBy: null,
            hasOAuthInstall: false,
            oauthConfigured: false,
            envConfigured: true,
          },
        })}
        onChange={noopChange}
      />,
    );
    await clickDisconnect(container);
    await waitFor(() => {
      expect(
        fetchCalls.some(
          (c) =>
            c.method === "DELETE" &&
            c.url.endsWith("/api/v1/admin/integrations/slack"),
        ),
      ).toBe(true);
    });
    expect(
      fetchCalls.some(
        (c) => c.method === "DELETE" && c.url.endsWith("/api/v1/integrations/slack"),
      ),
    ).toBe(false);
  });

  test("Slack hasOAuthInstall=true wins over entry.installed=false (catalog endpoint)", async () => {
    // The Slack carve-out: OAuth install lands in workspace_plugins for
    // most slugs, but for Slack the chat_cache row is also load-bearing.
    // hasOAuthInstall=true means "this came from the OAuth flow" → the
    // catalog DELETE runs the two-store teardown.
    const { container } = render(
      <CatalogCard
        entry={makeEntry({ installed: false })}
        status={makeStatus({
          slack: {
            connected: true,
            installedAt: "2026-04-15T12:00:00.000Z",
            configurable: true,
            teamId: "T01234",
            workspaceName: "Acme",
            installedBy: null,
            hasOAuthInstall: true,
            oauthConfigured: true,
            envConfigured: false,
          },
        })}
        onChange={noopChange}
      />,
    );
    await clickDisconnect(container);
    await waitFor(() => {
      expect(
        fetchCalls.some(
          (c) => c.method === "DELETE" && c.url.endsWith("/api/v1/integrations/slack"),
        ),
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Slice 8 — CatalogSection pillar split + status error banner
// ---------------------------------------------------------------------------

describe("CatalogSection — pillar split + status error surface (#2746)", () => {
  const originalFetch = globalThis.fetch;

  /**
   * Stub the catalog GET with the given entries. The status query is
   * handled by props (not refetched here), so this only needs to cover
   * `/api/v1/integrations/catalog`.
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

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  function wireEntry(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
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
      ...overrides,
    };
  }

  test("datasource pillar rows are filtered out entirely", async () => {
    mockCatalog([
      wireEntry({ id: "catalog:slack", slug: "slack", pillar: "chat" }),
      wireEntry({
        id: "catalog:salesforce",
        slug: "salesforce",
        type: "integration",
        pillar: "datasource",
        name: "Salesforce",
      }),
      wireEntry({
        id: "catalog:email",
        slug: "email",
        type: "integration",
        installModel: "form",
        pillar: "action",
        name: "Email",
      }),
    ]);

    const { container } = render(
      <CatalogSection status={null} statusError={null} onChange={noopChange} />,
    );
    await waitFor(() => {
      // Chat section + Action section render; datasource does not.
      expect(container.querySelector('[data-testid="catalog-group-chat"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="catalog-group-action"]')).not.toBeNull();
    });
    // The salesforce card (only datasource entry) must not appear anywhere.
    expect(container.querySelector('[data-testid="catalog-card-salesforce"]')).toBeNull();
  });

  test("statusError surfaces the inline banner with a Retry button", async () => {
    mockCatalog([wireEntry({})]);
    const banner = await renderBannerWithError("Status unavailable");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Connection detail unavailable");
    const retry = Array.from(banner!.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    expect(retry).toBeDefined();
  });

  async function renderBannerWithError(message: string): Promise<HTMLElement | null> {
    const { container } = render(
      <CatalogSection
        status={null}
        statusError={{
          code: "network_error",
          status: 0,
          message,
          requestId: undefined,
          rawBody: null,
        }}
        onChange={noopChange}
      />,
    );
    await waitFor(() => {
      const b = container.querySelector<HTMLElement>(
        '[data-testid="catalog-status-error-banner"]',
      );
      if (!b) throw new Error("banner not rendered");
      return b;
    });
    return container.querySelector<HTMLElement>(
      '[data-testid="catalog-status-error-banner"]',
    );
  }
});

// ---------------------------------------------------------------------------
// Slice 8 — BYOT form submit
// ---------------------------------------------------------------------------

describe("CatalogCard — BYOT form submit (#2746)", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; method: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, method, body });
      return Promise.resolve(
        new Response(JSON.stringify({ message: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("Slack BYOT submit POSTs botToken to /api/v1/admin/integrations/slack/byot", async () => {
    // Configure the card so BYOT is the only path: oauth env not
    // configured + internal DB available + not yet installed.
    const { container } = render(
      <CatalogCard
        entry={makeEntry({ installed: false })}
        status={makeStatus({
          slack: {
            connected: false,
            installedAt: null,
            configurable: false,
            teamId: null,
            workspaceName: null,
            installedBy: null,
            hasOAuthInstall: false,
            oauthConfigured: false,
            envConfigured: false,
          },
        })}
        onChange={noopChange}
      />,
    );

    // CompactRow shows "Add token" — click it to open the BYOT modal (#4203:
    // ByotInstallModal rides FormDialog, so the form renders in a portal).
    const addToken = container.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-card-slack-byot-toggle"]',
    );
    expect(addToken).not.toBeNull();
    await act(async () => {
      fireEvent.click(addToken!);
    });

    // Fill the token field + submit — the modal + its input live in a portal
    // under document.body, so query the document rather than `container`.
    const tokenInput = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>("input#slack-botToken");
      if (!el) throw new Error("token input not rendered");
      return el;
    });
    await act(async () => {
      fireEvent.change(tokenInput, { target: { value: "xoxb-test-token" } });
    });

    const submit = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((b) => b.textContent?.trim() === "Connect");
    expect(submit).toBeDefined();
    await act(async () => {
      fireEvent.click(submit!);
    });

    await waitFor(() => {
      expect(
        fetchCalls.some(
          (c) =>
            c.method === "POST" &&
            c.url.endsWith("/api/v1/admin/integrations/slack/byot") &&
            (c.body as { botToken?: string } | null)?.botToken === "xoxb-test-token",
        ),
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// static-bot routing-identifier install (#3140) — the spine's admin form.
// Form-shaped static-bots (Telegram / Teams / Google Chat / WhatsApp) render
// an Install button that opens StaticBotInstallModal, replacing the inert
// "not yet shipped" disabled Connect. Discord (OAuth-shaped) keeps the inert
// affordance.
// ---------------------------------------------------------------------------

describe("CatalogCard — static-bot form install (#3140)", () => {
  const TELEGRAM_SCHEMA = [
    { key: "chat_id", type: "string", label: "Chat ID", required: true },
    { key: "display_name", type: "string", label: "Display name", required: false },
  ];

  function telegramEntry(
    overrides: Partial<IntegrationsCatalogEntry> = {},
  ): IntegrationsCatalogEntry {
    return makeEntry({
      id: "catalog:telegram",
      slug: "telegram",
      installModel: "static-bot",
      name: "Telegram",
      description: "Connect Telegram",
      minPlan: "starter",
      configSchema: TELEGRAM_SCHEMA,
      implementationStatus: "available",
      ...overrides,
    });
  }

  test("form-shaped static-bot (available) renders an Install button, not the inert Connect", () => {
    const { container } = render(
      <CatalogCard entry={telegramEntry()} status={null} onChange={noopChange} />,
    );

    const install = container.querySelector('[data-testid="catalog-card-telegram-install"]');
    expect(install).not.toBeNull();
    expect((install as HTMLButtonElement).disabled).toBe(false);
    // Not the coming_soon affordance.
    expect(
      container.querySelector('[data-testid="catalog-card-telegram-coming-soon-cta"]'),
    ).toBeNull();
  });

  test("coming_soon still dominates — no Install button until the slug is available", () => {
    const { container } = render(
      <CatalogCard
        entry={telegramEntry({ implementationStatus: "coming_soon" })}
        status={null}
        onChange={noopChange}
      />,
    );

    expect(
      container.querySelector('[data-testid="catalog-card-telegram-install"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="catalog-card-telegram-coming-soon-cta"]'),
    ).not.toBeNull();
  });

  test("Discord (OAuth-shaped static-bot) keeps the inert Connect — no routing-id form", () => {
    const { container } = render(
      <CatalogCard
        entry={telegramEntry({
          id: "catalog:discord",
          slug: "discord",
          name: "Discord",
          configSchema: [{ key: "guild_id", type: "string", label: "Server ID", required: true }],
        })}
        status={null}
        onChange={noopChange}
      />,
    );

    // No typed-form Install affordance for Discord.
    expect(
      container.querySelector('[data-testid="catalog-card-discord-install"]'),
    ).toBeNull();
  });

  test("clicking Install opens the routing-identifier modal with the config_schema fields", async () => {
    const { container } = render(
      <CatalogCard entry={telegramEntry()} status={null} onChange={noopChange} />,
    );

    const install = container.querySelector(
      '[data-testid="catalog-card-telegram-install"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(install);
    });

    // The modal (a portaled dialog) renders the routing-identifier field
    // declared in config_schema.
    expect(await screen.findByText("Install Telegram")).toBeDefined();
    expect(await screen.findByText("Chat ID")).toBeDefined();
  });

  test("submitting the routing id POSTs to /install-form and fires onInstalled on success", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "GET",
      });
      return Promise.resolve(
        new Response(JSON.stringify({ installed: true, platform: "telegram", installId: "i-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    let installed = 0;
    try {
      const { container } = render(
        <CatalogCard entry={telegramEntry()} status={null} onChange={() => { installed += 1; }} />,
      );
      await act(async () => {
        fireEvent.click(
          container.querySelector('[data-testid="catalog-card-telegram-install"]') as HTMLButtonElement,
        );
      });
      // Fill the routing identifier (first input in the portaled dialog = chat_id).
      const chatInput = (await screen.findAllByRole("textbox"))[0] as HTMLInputElement;
      await act(async () => {
        fireEvent.change(chatInput, { target: { value: "-1001234567890" } });
      });
      // The dialog's submit button is labelled "Install" (FormDialog submitLabel).
      const submit = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent?.trim() === "Install" && b.getAttribute("type") === "submit",
      );
      expect(submit).toBeDefined();
      await act(async () => {
        fireEvent.click(submit!);
      });

      await waitFor(() => {
        expect(
          fetchCalls.some(
            (c) => c.method === "POST" && c.url.includes("/api/v1/integrations/telegram/install-form"),
          ),
        ).toBe(true);
      });
      // Success wiring: onInstalled → onChange refetch fired.
      await waitFor(() => expect(installed).toBeGreaterThan(0));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
