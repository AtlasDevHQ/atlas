import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Admin OAuth Clients — per-client rate limit override (#2071) @llm
 *
 * The agent → 429 → retry path is exercised end-to-end by
 * `packages/api/src/lib/rate-limit/__tests__/middleware.test.ts` (the
 * envelope shape + audit emission) and
 * `packages/api/src/api/__tests__/admin-oauth-clients.test.ts` (the
 * PATCH route + 422 / 404 / audit metadata branches). A browser-driven
 * "agent gets 429 from MCP and retries" path would require a live MCP
 * SDK with DCR-bootstrapping, which we cannot drive headlessly.
 *
 * What this spec covers:
 *   1. The Rate column renders the default (60/min) for clients
 *      without an override and the custom value for clients with one.
 *   2. Opening the edit dialog and saving a value emits a PATCH with
 *      `requestsPerMinute: <int>` and the row reflects the new value.
 *   3. The "Reset to default" path emits `requestsPerMinute: null` and
 *      the row falls back to the default value.
 *
 * The `@llm` tag opts this spec into the serial worker so the route
 * mocks aren't raced by other specs that also touch admin endpoints.
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
  tokenState: "active" | "reconnect_required" | "revoked";
  rateLimitPerMinute: number | null;
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
      lastUsedAt: "2026-05-04T15:30:00.000Z",
      tokenCount: 2,
      tokenState: "active",
      // No override — should render the default.
      rateLimitPerMinute: null,
    },
    {
      clientId: "premium-agent",
      clientName: "Premium Agent",
      redirectUris: ["http://127.0.0.1:7000/callback"],
      createdAt: "2026-04-15T09:00:00.000Z",
      updatedAt: null,
      disabled: false,
      type: "public",
      lastUsedAt: null,
      tokenCount: 0,
      tokenState: "reconnect_required",
      // Already overridden — should render the custom value.
      rateLimitPerMinute: 240,
    },
  ];
}

async function installMocks(
  page: Page,
  initial: MockOAuthClient[],
): Promise<{
  state: Map<string, MockOAuthClient>;
  patchRequests: Array<{ clientId: string; body: { requestsPerMinute: number | null } }>;
}> {
  const state = new Map<string, MockOAuthClient>(
    initial.map((c) => [c.clientId, c]),
  );
  const patchRequests: Array<{
    clientId: string;
    body: { requestsPerMinute: number | null };
  }> = [];

  // PATCH /admin/oauth-clients/:id/rate-limit (#2071) — narrow first.
  await page.route(
    /\/api\/v1\/admin\/oauth-clients\/[^/?]+\/rate-limit(?:\?|$)/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() !== "PATCH") {
        await route.abort("failed");
        return;
      }
      const url = new URL(req.url());
      const segments = url.pathname.split("/");
      const id = segments[segments.length - 2]!;
      const body = JSON.parse(req.postData() ?? "{}") as {
        requestsPerMinute: number | null;
      };
      patchRequests.push({ clientId: id, body });
      const existing = state.get(id);
      if (!existing) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "not_found" }),
        });
        return;
      }
      // Mirror the API: store the new value and echo it back.
      existing.rateLimitPerMinute = body.requestsPerMinute;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          clientId: id,
          rateLimitPerMinute: body.requestsPerMinute,
        }),
      });
    },
  );

  // Revoke handler — kept narrow so the broad list route doesn't shadow it.
  await page.route(
    /\/api\/v1\/admin\/oauth-clients\/[^/?]+\/revoke(?:\?|$)/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() !== "POST") {
        await route.abort("failed");
        return;
      }
      const url = new URL(req.url());
      const segments = url.pathname.split("/");
      const id = segments[segments.length - 2]!;
      state.delete(id);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, tokensRevoked: 4 }),
      });
    },
  );

  await page.route(
    /\/api\/v1\/admin\/oauth-clients(?:\?[^/]*)?$/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() !== "GET") {
        await route.abort("failed");
        return;
      }
      const clients = [...state.values()].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ clients }),
      });
    },
  );

  return { state, patchRequests };
}

test.describe("Admin OAuth Clients — rate limit override @llm", () => {
  test.describe.configure({ timeout: 45_000 });

  test("default + override values render in the Rate column", async ({ page }) => {
    await installMocks(page, buildFixture());
    await page.goto("/admin/oauth-clients");

    await expect(
      page.locator("h1", { hasText: "OAuth clients" }),
    ).toBeVisible({ timeout: 15_000 });

    // Row 1: no override — default 60/min. Scope by the row's stable
    // `data-testid` rather than a "section/div with hasText" wrapper
    // selector — the latter resolves to whichever ancestor contains the
    // text first and breaks every time the layout reshapes (#2183 item 6).
    const defaultRow = page.getByTestId("oauth-client-row-claude-desktop");
    await expect(defaultRow).toBeVisible();
    await expect(defaultRow.getByText(/60\/min/)).toBeVisible();
    await expect(defaultRow.getByText(/override/)).toHaveCount(0);

    // Row 2: explicit override at 240.
    const overrideRow = page.getByTestId("oauth-client-row-premium-agent");
    await expect(overrideRow.getByText(/240\/min/)).toBeVisible();
    await expect(overrideRow.getByText(/override/i).first()).toBeVisible();
  });

  test("Set + Reset round-trip from the dialog", async ({ page }) => {
    const { patchRequests } = await installMocks(page, buildFixture());
    await page.goto("/admin/oauth-clients");

    const claudeRow = page.getByTestId("oauth-client-row-claude-desktop");

    // Open the edit dialog.
    await claudeRow
      .getByRole("button", { name: /Edit rate limit/i })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Set MCP rate limit/)).toBeVisible();

    // Type a value and save.
    const input = dialog.getByLabel(/Requests per minute/i);
    await input.fill("180");
    await dialog.getByRole("button", { name: /^Save$/ }).click();

    // The PATCH must carry the integer body.
    await expect.poll(() => patchRequests.length).toBeGreaterThan(0);
    expect(patchRequests[0]).toEqual({
      clientId: "claude-desktop",
      body: { requestsPerMinute: 180 },
    });

    // Row updates to 180/min override.
    await expect(claudeRow.getByText(/180\/min/)).toBeVisible({
      timeout: 10_000,
    });
    await expect(claudeRow.getByText(/override/i).first()).toBeVisible();

    // Now reset back to default via the dialog's Reset path.
    await claudeRow
      .getByRole("button", { name: /Edit rate limit/i })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /Reset to default/i })
      .click();

    await expect.poll(() => patchRequests.length).toBe(2);
    expect(patchRequests[1]).toEqual({
      clientId: "claude-desktop",
      body: { requestsPerMinute: null },
    });
    await expect(claudeRow.getByText(/60\/min/)).toBeVisible({
      timeout: 10_000,
    });
    await expect(claudeRow.getByText(/override/i)).toHaveCount(0);
  });
});
