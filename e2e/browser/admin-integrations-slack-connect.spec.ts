/**
 * Browser e2e for the Slack Connect happy path (#2654, slice 6 of 1.5.2).
 *
 * Validates the UI wiring across the OAuth callback redirect, not the
 * full Slack roundtrip — slice 5's route tests already cover the install
 * handler. Here we:
 *
 *   1. Mock `/api/v1/admin/integrations/status` so the page renders
 *      Slack as configurable-but-not-connected before the click. After
 *      the simulated callback the mock flips to "connected" so the
 *      Connected-state metadata renders.
 *   2. Click the Slack Connect button to confirm the navigation target
 *      is the `/api/v1/integrations/slack/install` endpoint (intercept
 *      the request — don't follow it offsite to slack.com).
 *   3. Navigate the page directly to `/admin/integrations?installed=slack`
 *      to simulate the API callback's 302. Assert the green success
 *      toast fires with the team name and the Slack card switches to
 *      Connected with the install metadata visible.
 *
 * No `@llm` tag — pure DOM assertions, no model calls.
 *
 * Mock scope deliberately narrow: only `/api/v1/admin/integrations/status`
 * is mocked. Other admin reads pass through (the page also hits
 * `/api/v1/mode` etc. via shared admin chrome) — falling back to the real
 * dev server keeps the test honest about page composition.
 */

import { test, expect, type Page, type Route } from "@playwright/test";

// The `window` reference is evaluated inside the browser via
// `page.waitForFunction` — declare it here so the file type-checks under
// the Node-targeted e2e tsconfig.
declare const window: { location: { search: string } };

interface SlackStatusFixture {
  connected: boolean;
  workspaceName: string | null;
  installedBy: string | null;
}

/** Default IntegrationStatus shape with one connected/disconnected fixture for Slack. */
function buildStatus(slack: SlackStatusFixture) {
  return {
    slack: {
      connected: slack.connected,
      teamId: slack.connected ? "T01TESTTEAM" : null,
      workspaceName: slack.workspaceName,
      installedAt: slack.connected ? "2026-05-20T12:00:00.000Z" : null,
      installedBy: slack.installedBy,
      hasOAuthInstall: slack.connected,
      oauthConfigured: true,
      envConfigured: false,
      configurable: true,
    },
    teams: {
      connected: false,
      tenantId: null,
      tenantName: null,
      installedAt: null,
      configurable: false,
    },
    discord: {
      connected: false,
      guildId: null,
      guildName: null,
      installedAt: null,
      configurable: false,
    },
    telegram: {
      connected: false,
      botId: null,
      botUsername: null,
      installedAt: null,
      configurable: false,
    },
    gchat: {
      connected: false,
      projectId: null,
      serviceAccountEmail: null,
      installedAt: null,
      configurable: false,
    },
    github: {
      connected: false,
      username: null,
      installedAt: null,
      configurable: false,
    },
    linear: {
      connected: false,
      userName: null,
      userEmail: null,
      installedAt: null,
      configurable: false,
    },
    whatsapp: {
      connected: false,
      phoneNumberId: null,
      displayPhone: null,
      installedAt: null,
      configurable: false,
    },
    email: {
      connected: false,
      provider: null,
      senderAddress: null,
      installedAt: null,
      configurable: false,
    },
    webhooks: { activeCount: 0, configurable: false },
    deliveryChannels: ["email", "webhook"],
    deployMode: "self-hosted",
    hasInternalDB: true,
  };
}

/**
 * Wire up the /admin/integrations status mock. Returns a setter so the
 * test can flip Slack from disconnected to connected mid-flow — the
 * useAdminFetch invalidation on the toast effect refetches and sees the
 * new state.
 */
async function installStatusMock(page: Page): Promise<(slack: SlackStatusFixture) => void> {
  let current: SlackStatusFixture = {
    connected: false,
    workspaceName: null,
    installedBy: null,
  };

  await page.route(/\/api\/v1\/admin\/integrations\/status(?:\?|$)/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildStatus(current)),
    });
  });

  return (next) => {
    current = next;
  };
}

test.describe("Admin Console — Slack Connect happy path", () => {
  test("clicking Connect points at the install endpoint, then the callback redirect lands on a connected card + success toast", async ({ page }) => {
    const setSlack = await installStatusMock(page);

    // ── 1. Land on /admin/integrations with Slack disconnected. ────────
    await page.goto("/admin/integrations");
    await expect(page.locator("h1", { hasText: "Integrations" })).toBeVisible({ timeout: 15_000 });

    // The Slack Connect button is rendered inside the legacy admin
    // chrome (slice 6 wires the click through the existing anchor — we
    // don't introduce a new test id, instead we anchor on the row that
    // contains "Slack" and the visible Connect text).
    const slackConnect = page
      .locator("div", { hasText: "Slack" })
      .getByRole("link", { name: /Connect/ })
      .first();
    await expect(slackConnect).toBeVisible({ timeout: 10_000 });

    // The href must point at the install endpoint. We never follow it
    // offsite — Playwright intercepts the request and aborts so the
    // Slack OAuth dance doesn't actually run.
    const href = await slackConnect.getAttribute("href");
    expect(href ?? "").toContain("/api/v1/integrations/slack/install");

    // Block the install endpoint so a stray click can't actually
    // round-trip to Slack during the test. (We don't click the link —
    // we navigate manually to the callback below — but the route guard
    // keeps the test deterministic if a future change wires a fetch.)
    await page.route(/\/api\/v1\/integrations\/slack\/install$/, (route) => route.abort("blockedbyclient"));

    // ── 2. Flip the status mock to "connected" and navigate to the
    //       admin page with the callback's `?installed=slack` query
    //       param. This simulates the 302 from the API callback handler.
    setSlack({
      connected: true,
      workspaceName: "TestTeam",
      installedBy: "admin@useatlas.dev",
    });
    await page.goto("/admin/integrations?installed=slack");

    // ── 3. Green success toast names the workspace. sonner renders a
    //       <li> with the title inside; matching on the visible text is
    //       robust to icon/role changes.
    await expect(page.getByText("Slack connected to TestTeam")).toBeVisible({ timeout: 10_000 });

    // ── 4. The Connected state replaces the Connect button with a
    //       Reconnect link + a disabled Disconnect button (slice 6
    //       placeholder for #2655). Both must be visible.
    await expect(
      page.locator("a", { hasText: "Reconnect" }),
    ).toBeVisible({ timeout: 5_000 });

    const disconnectButton = page.getByRole("button", { name: "Disconnect" });
    await expect(disconnectButton).toBeVisible();
    await expect(disconnectButton).toBeDisabled();

    // ── 5. The "Connected by … on …" metadata renders inside the
    //       Slack card. The label "Connected" is paired with a value
    //       that includes the formatted timestamp and the installer.
    await expect(page.getByText(/admin@useatlas\.dev/)).toBeVisible();

    // ── 6. The query param has been stripped via router.replace so a
    //       refresh wouldn't re-fire the toast.
    await page.waitForFunction(
      () => !window.location.search.includes("installed="),
      undefined,
      { timeout: 5_000 },
    );
  });
});
