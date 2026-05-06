import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Hosted-MCP brand-hostname cutover (#2068) @llm
 *
 * The hosted MCP endpoint moves from `<region>.api.useatlas.dev/mcp/...`
 * to the canonical `mcp*.useatlas.dev/mcp/...` family. The audience-
 * verification, protected-resource doc, `WWW-Authenticate`
 * resource_metadata pointer, and `bunx @useatlas/mcp init --hosted`
 * default URL all flip in one branch and are pinned at the unit level:
 *
 *   - `packages/api/src/lib/auth/__tests__/oauth-config.test.ts` —
 *     `resolveOAuthValidAudiences` synthesises the brand mirror and
 *     keeps the regional fallback (symmetric in either direction).
 *   - `packages/api/src/api/__tests__/well-known.test.ts` —
 *     protected-resource doc advertises the brand surface.
 *   - `packages/mcp/src/__tests__/hosted.test.ts` — verifier accepts
 *     both audiences, WWW-Authenticate points at the brand,
 *     cross-region 421 body returns the brand URL.
 *   - `plugins/mcp/__tests__/init/hosted.test.ts` — CLI default flipped
 *     to `mcp.useatlas.dev`, ATLAS_PUBLIC_API_URL override path intact.
 *
 * The browser-visible surface that those unit tests can't reach is the
 * connect-new-agent wizard's docs link — every "how do I paste this
 * in Claude Desktop / Cursor / Continue / ChatGPT" anchor must keep
 * resolving to the canonical hosted-MCP guide (which leads with the
 * brand surface post-#2068). A wizard that links to a 404'd anchor
 * silently breaks every onboarding click without a unit-test signal.
 *
 * What is NOT testable from a Playwright run: the snippet's URL string
 * itself, because Next.js inlines `process.env.NEXT_PUBLIC_*` at bundle
 * time. Under Playwright `apiBase` always falls back to
 * `window.location.origin` (`http://localhost:3000`) and the brand-
 * mapping pure function returns null for that host. Asserting on the
 * snippet body would be a tautology — the function under test never
 * runs in the SaaS code path during Playwright. Unit tests at
 * `connect-wizard.tsx`'s call site cover that path.
 *
 * The `@llm` tag opts this spec into the serial worker
 * (`bun run test:browser:llm`, workers=1). No model calls, but the
 * wizard mocks rely on the global storage state being a clean
 * signed-in admin — running concurrently with other specs that
 * mutate `/me/oauth-clients` would race.
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

async function mockOAuthClientsList(page: Page, clients: MockOAuthClient[]) {
  await page.route(/\/api\/v1\/me\/oauth-clients(?:\?|$)/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clients, deployMode: "saas" }),
    });
  });
}

test.describe("Hosted MCP — brand hostname cutover (#2068)", () => {
  test.describe.configure({ timeout: 45_000 });

  test("Settings → AI Agents wizard's docs link resolves to the canonical hosted-MCP guide", async ({ page }) => {
    // Every "How do I paste this in Claude Desktop?" / Cursor / etc.
    // link the wizard renders should walk the user to the canonical
    // hosted-MCP guide (which leads with mcp.useatlas.dev post-#2068).
    // A regression here — the wizard sending users to a deleted anchor,
    // a stale guide, or an unrelated doc — silently breaks onboarding
    // without a unit-test signal.
    await mockOAuthClientsList(page, []);
    await page.goto("/settings/ai-agents");

    await expect(
      page.locator("h1", { hasText: "AI Agents" }),
    ).toBeVisible({ timeout: 15_000 });

    const connectButton = page
      .getByRole("button", { name: /Connect new agent/i })
      .first();
    await expect(connectButton).toBeVisible({ timeout: 15_000 });
    await connectButton.click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /Claude Desktop/ }).click();
    await dialog.getByRole("button", { name: /Next/ }).click();
    // Step 2 → Step 3
    await dialog.getByRole("button", { name: /Next/ }).click();

    const docsAnchor = dialog
      .getByRole("link", { name: /paste|guide|doc/i })
      .first();
    await expect(docsAnchor).toHaveAttribute(
      "href",
      /docs\.useatlas\.dev\/guides\/mcp-hosted/,
    );
  });
});
