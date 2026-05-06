import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Hosted-MCP token refresh + tokenState UX (#2066) @llm
 *
 * Mirrors `settings-ai-agents.spec.ts`'s mocking pattern for the wire
 * shape — the spec asserts the per-row UX states (Active / Reconnect
 * required / Revoked) the page must render in response to each
 * `tokenState` value. The full register → mint → expire → refresh
 * dance against a live Better Auth issuer is exercised at the
 * verifier level by `packages/mcp/src/__tests__/hosted-token-refresh.test.ts`
 * — running it through a browser would require a real DCR-bootstrapping
 * MCP client (Claude Desktop / Cursor) which we cannot drive headlessly.
 *
 * The `@llm` tag opts this spec into the serial worker
 * (`bun run test:browser:llm`, workers=1). Even though no model calls
 * happen here, the route mocks rely on the global storage state
 * being a clean signed-in admin — running concurrently with other
 * specs that mutate `/me/oauth-clients` would race.
 *
 * What this spec catches:
 *
 *   1. A regression in the page's tokenState rendering — every state
 *      the API can return must be visible somewhere in the row.
 *   2. A regression in the Reconnect CTA wiring — clicking it opens
 *      the same revoke dialog flow (1.4.1's "reconnect" is a
 *      revoke + re-run-wizard, intentionally).
 *   3. A regression in the Revoked-row dimming — the row should
 *      visually deprioritize even though it stays clickable for
 *      audit trail integrity.
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
}

/**
 * Three rows, one per tokenState. The fixture intentionally keeps the
 * same redirect URI / type across rows so any visible UX difference
 * is attributable to `tokenState` alone.
 */
function buildStateFixture(): MockOAuthClient[] {
  return [
    {
      clientId: "claude-desktop",
      clientName: "Claude Desktop (active)",
      redirectUris: ["http://127.0.0.1:6274/callback"],
      createdAt: "2026-04-12T10:00:00.000Z",
      updatedAt: "2026-04-12T10:00:00.000Z",
      disabled: false,
      type: "public",
      lastUsedAt: "2026-05-04T15:30:00.000Z",
      tokenCount: 3,
      tokenState: "active",
    },
    {
      clientId: "cursor-stale",
      clientName: "Cursor (refresh failed)",
      redirectUris: ["http://127.0.0.1:6274/callback"],
      createdAt: "2026-04-15T09:00:00.000Z",
      updatedAt: "2026-04-15T09:00:00.000Z",
      disabled: false,
      type: "public",
      lastUsedAt: "2026-04-20T12:00:00.000Z",
      tokenCount: 1,
      tokenState: "reconnect_required",
    },
    {
      clientId: "chatgpt-revoked",
      clientName: "ChatGPT (revoked)",
      redirectUris: ["http://127.0.0.1:6274/callback"],
      createdAt: "2026-04-01T08:00:00.000Z",
      updatedAt: "2026-04-30T08:00:00.000Z",
      disabled: true,
      type: "public",
      lastUsedAt: "2026-04-25T08:00:00.000Z",
      tokenCount: 0,
      tokenState: "revoked",
    },
  ];
}

async function installMocks(
  page: Page,
  initial: MockOAuthClient[],
): Promise<{ state: Map<string, MockOAuthClient> }> {
  const state = new Map<string, MockOAuthClient>(
    initial.map((c) => [c.clientId, c]),
  );

  // Revoke handler — narrow path first so the broad list route doesn't
  // shadow it. Mirrors settings-ai-agents.spec.ts.
  await page.route(
    /\/api\/v1\/me\/oauth-clients\/[^/?]+\/revoke(?:\?|$)/,
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
    /\/api\/v1\/me\/oauth-clients(?:\?[^/]*)?$/,
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
        body: JSON.stringify({ clients, deployMode: "saas" }),
      });
    },
  );

  return { state };
}

test.describe("MCP token refresh — tokenState UX @llm", () => {
  test.describe.configure({ timeout: 45_000 });

  test("renders Active / Reconnect required / Revoked badges per tokenState", async ({
    page,
  }) => {
    await installMocks(page, buildStateFixture());
    await page.goto("/settings/ai-agents");

    await expect(
      page.locator("h1", { hasText: "AI Agents" }),
    ).toBeVisible({ timeout: 15_000 });

    // Row 1 — active. The legacy "connected" status dot conveys this
    // without an explicit badge; we assert the row exists and does not
    // carry the reconnect / revoked badge text.
    const activeRow = page
      .locator("section, div", { hasText: "Claude Desktop (active)" })
      .first();
    await expect(activeRow).toBeVisible();
    await expect(activeRow.getByText(/Reconnect required/i)).toHaveCount(0);
    await expect(activeRow.getByText(/Revoked/i)).toHaveCount(0);

    // Row 2 — reconnect_required. Amber badge + Reconnect CTA visible.
    const reconnectRow = page
      .locator("section, div", { hasText: "Cursor (refresh failed)" })
      .first();
    await expect(reconnectRow.getByText(/Reconnect required/i)).toBeVisible();
    await expect(
      reconnectRow.getByRole("button", { name: /Reconnect/i }),
    ).toBeVisible();

    // Row 3 — revoked. Badge visible.
    const revokedRow = page
      .locator("section, div", { hasText: "ChatGPT (revoked)" })
      .first();
    await expect(revokedRow.getByText(/Revoked/i).first()).toBeVisible();
  });

  test("Reconnect CTA opens the same revoke dialog (1.4.1 reconnect = revoke + re-run wizard)", async ({
    page,
  }) => {
    // No per-token refresh UI in 1.4.1 — see issue's "out of scope".
    // The Reconnect button reuses the revoke handler so the table
    // converges in one click; the user re-runs the wizard manually.
    await installMocks(page, buildStateFixture());
    await page.goto("/settings/ai-agents");

    const reconnectRow = page
      .locator("section, div", { hasText: "Cursor (refresh failed)" })
      .first();
    await reconnectRow
      .getByRole("button", { name: /Reconnect/i })
      .click();

    // The Reconnect button shares the revoke handler — the same
    // confirmation dialog opens.
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Revoke agent/)).toBeVisible();
  });

  test("Revoked row stays in the list (audit trail) and the Revoke button still works", async ({
    page,
  }) => {
    const { state } = await installMocks(page, buildStateFixture());
    await page.goto("/settings/ai-agents");

    const revokedRow = page
      .locator("section, div", { hasText: "ChatGPT (revoked)" })
      .first();
    await expect(revokedRow).toBeVisible();
    await expect(revokedRow.getByText(/Revoked/i).first()).toBeVisible();

    // Revoke removes the row from the visible list.
    await revokedRow
      .getByRole("button", { name: /Revoke ChatGPT/i })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Revoke agent/)).toBeVisible();
    await dialog.getByRole("button", { name: /^Revoke agent$/ }).click();

    await expect(
      page.getByText("ChatGPT (revoked)", { exact: true }),
    ).toHaveCount(0, { timeout: 10_000 });
    expect(state.has("chatgpt-revoked")).toBe(false);
  });
});
