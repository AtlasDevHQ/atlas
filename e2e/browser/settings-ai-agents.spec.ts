import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Settings → AI Agents — connect → revoke → reconnect cycle (issue #2065).
 *
 * Mocks `/api/v1/me/oauth-clients*` at the page level so the spec doesn't
 * have to drive a real DCR-bootstrapping MCP client to seed rows. The
 * actual OAuth flow runs inside the agent process and lands in Better
 * Auth's `oauthClient` table — we don't need to exercise that here. What
 * we care about: the page renders, the wizard opens, and revoke updates
 * the table.
 *
 * No `@llm` tag — no model calls.
 */

interface MockOAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: string;
  updatedAt: string | null;
  disabled: boolean;
  type: string | null;
  lastUsedAt: string | null;
  tokenCount: number;
  // tokenState (#2066) — required wire field. The page schema rejects
  // payloads without it; default the fixture rows to "active" to keep
  // existing assertions on row visibility intact.
  tokenState: "active" | "reconnect_required" | "revoked";
}

function buildFixture(): MockOAuthClient[] {
  return [
    {
      clientId: "claude-desktop",
      clientName: "Claude Desktop",
      redirectUris: ["http://127.0.0.1:6274/callback"],
      createdAt: "2026-04-12T10:00:00.000Z",
      updatedAt: "2026-04-12T10:00:00.000Z",
      disabled: false,
      type: "public",
      lastUsedAt: "2026-05-01T15:30:00.000Z",
      tokenCount: 3,
      tokenState: "active",
    },
    {
      clientId: "cursor-abc123",
      clientName: "Cursor",
      redirectUris: ["http://127.0.0.1:6274/callback"],
      createdAt: "2026-04-15T09:00:00.000Z",
      updatedAt: "2026-04-15T09:00:00.000Z",
      disabled: false,
      type: "public",
      lastUsedAt: null,
      tokenCount: 0,
      tokenState: "active",
    },
  ];
}

interface MockOptions {
  /** When true, the GET response advertises self-hosted (no Connect CTA). */
  selfHosted?: boolean;
  /** Force a 500 on revoke for the given clientId. */
  failRevokeIds?: Set<string>;
}

async function installMocks(
  page: Page,
  initial: MockOAuthClient[],
  opts: MockOptions = {},
): Promise<{ state: Map<string, MockOAuthClient> }> {
  const state = new Map<string, MockOAuthClient>(
    initial.map((c) => [c.clientId, c]),
  );
  const failRevokeIds = opts.failRevokeIds ?? new Set<string>();

  // Revoke handler — narrow path match registered FIRST so the broad list
  // route doesn't shadow it (Playwright evaluates handlers in
  // reverse-registration order, but anchoring the list pattern guards
  // against future relaxation either way).
  await page.route(/\/api\/v1\/me\/oauth-clients\/[^/?]+\/revoke(?:\?|$)/, async (route: Route) => {
    const req = route.request();
    if (req.method() !== "POST") {
      await route.abort("failed");
      return;
    }
    const url = new URL(req.url());
    const segments = url.pathname.split("/");
    // Path: /api/v1/me/oauth-clients/<id>/revoke — id is the second-to-last segment.
    const id = segments[segments.length - 2]!;
    if (failRevokeIds.has(id)) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "internal_error",
          message: "Internal server error",
          requestId: `req_mock_${id}`,
        }),
      });
      return;
    }
    state.delete(id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, tokensRevoked: 4 }),
    });
  });

  await page.route(/\/api\/v1\/me\/oauth-clients(?:\?[^/]*)?$/, async (route: Route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      await route.abort("failed");
      return;
    }
    const clients = [...state.values()].sort(
      (a, b) => (a.createdAt < b.createdAt ? 1 : -1),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        clients,
        deployMode: opts.selfHosted ? "self-hosted" : "saas",
      }),
    });
  });

  return { state };
}

test.describe("Settings → AI Agents", () => {
  test.describe.configure({ timeout: 45_000 });

  test("page loads, table renders the user's connected agents", async ({ page }) => {
    await installMocks(page, buildFixture());
    await page.goto("/settings/ai-agents");

    await expect(
      page.locator("h1", { hasText: "AI Agents" }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByText("Claude Desktop", { exact: true }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Cursor", { exact: true }).first()).toBeVisible();

    // SaaS deployMode → connect CTA visible
    await expect(
      page.getByRole("button", { name: /Connect new agent/i }).first(),
    ).toBeVisible();
  });

  test("empty state shows the issue's onboarding copy when no agents exist", async ({ page }) => {
    await installMocks(page, []);
    await page.goto("/settings/ai-agents");

    await expect(
      page.locator("h1", { hasText: "AI Agents" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/Connect Claude Desktop, Cursor, or any MCP client in 30 seconds/i),
    ).toBeVisible();
  });

  test("self-hosted deploy mode hides the connect CTA + points to admin", async ({ page }) => {
    await installMocks(page, [], { selfHosted: true });
    await page.goto("/settings/ai-agents");

    await expect(
      page.locator("h1", { hasText: "AI Agents" }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("button", { name: /Connect new agent/i }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Self-hosted Atlas/i),
    ).toBeVisible();
  });

  test("connect → revoke → reconnect cycle", async ({ page }) => {
    const { state } = await installMocks(page, buildFixture());
    await page.goto("/settings/ai-agents");

    // ── Connect: open wizard, pick Claude Desktop, walk steps ───────
    const connectButton = page
      .getByRole("button", { name: /Connect new agent/i })
      .first();
    await expect(connectButton).toBeVisible({ timeout: 15_000 });
    await connectButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Connect new agent")).toBeVisible();

    // Step 1: pick Claude Desktop
    await dialog.getByRole("button", { name: /Claude Desktop/ }).click();
    await dialog.getByRole("button", { name: /Next/ }).click();

    // Step 2: scopes section visible
    await expect(dialog.getByText(/will request these scopes/i)).toBeVisible();
    await dialog.getByRole("button", { name: /Next/ }).click();

    // Step 3: config JSON visible + copy button
    await expect(dialog.getByText(/Paste this block/i)).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /Copy config to clipboard/ }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: /Done/ }).click();

    await expect(dialog).toHaveCount(0);

    // ── Revoke: open dialog, confirm, row disappears ────────────────
    const claudeRow = page.locator("article, div", { hasText: "Claude Desktop" }).first();
    await claudeRow.getByRole("button", { name: /Revoke Claude Desktop/ }).click();

    const revokeDialog = page.getByRole("dialog");
    await expect(revokeDialog.getByText(/Revoke agent/)).toBeVisible();
    await revokeDialog.getByRole("button", { name: /Revoke agent/ }).click();

    // Row is gone, server-side state mirrors it.
    await expect(
      page.getByText("Claude Desktop", { exact: true }).first(),
    ).toHaveCount(0, { timeout: 10_000 });
    expect(state.has("claude-desktop")).toBe(false);
    expect(state.has("cursor-abc123")).toBe(true);

    // ── Reconnect: wizard opens cleanly even after a revoke. The user
    // would actually re-register their agent through DCR, but the wizard
    // re-opening to step 1 is the UX guarantee we care about here.
    await page
      .getByRole("button", { name: /Connect new agent/i })
      .first()
      .click();
    const reopenDialog = page.getByRole("dialog");
    await expect(reopenDialog.getByText(/Pick your agent/i)).toBeVisible();
    // No client should be pre-selected — the previous wizard run didn't leak.
    const claudeOption = reopenDialog.getByRole("button", { name: /Claude Desktop/ });
    await expect(claudeOption).toHaveAttribute("aria-pressed", "false");
  });
});
