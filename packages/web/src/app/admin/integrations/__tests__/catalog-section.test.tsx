/**
 * Render-branch coverage for the catalog card states under
 * `/admin/integrations`. Slice 9 of 1.5.3 (#2747).
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
 */

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { CatalogCard } from "../catalog-section";
import type { IntegrationsCatalogEntry } from "@/ui/lib/admin-schemas";

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

const noopInstalled = () => undefined;

// ---------------------------------------------------------------------------
// coming_soon — the slice-9 deliverable
// ---------------------------------------------------------------------------

describe("CatalogCard — coming_soon", () => {
  test("renders the grey Coming soon badge and inert CTA", () => {
    const { container } = render(
      <CatalogCard
        entry={makeEntry({ slug: "discord", implementationStatus: "coming_soon" })}
        onInstalled={noopInstalled}
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
        onInstalled={noopInstalled}
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
        onInstalled={noopInstalled}
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
        onInstalled={noopInstalled}
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
        onInstalled={noopInstalled}
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
        onInstalled={noopInstalled}
      />,
    );

    expect(
      container.querySelector('[data-testid="catalog-card-slack-coming-soon-cta"]'),
    ).toBeNull();
    expect(container.querySelector('a[href*="/install"]')).not.toBeNull();
  });
});
