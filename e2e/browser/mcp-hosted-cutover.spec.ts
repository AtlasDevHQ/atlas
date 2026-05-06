import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Hosted-MCP brand-hostname cutover (#2068) @llm
 *
 * The hosted MCP endpoint moves from `<region>.api.useatlas.dev/mcp/...`
 * to the canonical `mcp*.useatlas.dev/mcp/...` family. Three contracts
 * drive the cutover; each has unit-test coverage at the call-site level
 * (audience verification, `/.well-known/oauth-protected-resource/...`,
 * the `WWW-Authenticate` resource_metadata pointer, the `bunx
 * @useatlas/mcp init --hosted` default URL). What the unit tests can't
 * pin is the user-visible surface — the connect-new-agent wizard's
 * generated config block, which is what every Settings → AI Agents user
 * pastes into Claude Desktop / Cursor / ChatGPT.
 *
 * If this spec fails the user pastes a stale `api.useatlas.dev/...`
 * URL that still resolves and still works (issuer accepts both
 * audiences for backward compat) but never picks up the brand surface
 * the docs and registry advertise. That's the regression mode #2068
 * is closing.
 *
 * The full DCR + PKCE + `tools/call` cycle through `mcp.useatlas.dev`
 * is exercised at the verifier level by
 * `packages/mcp/src/__tests__/hosted.test.ts` — running it through a
 * browser would require driving Claude Desktop headlessly, which is
 * out of reach here. The cross-region 421 body shape is pinned by the
 * same hosted.test suite. This spec covers the surface the user sees.
 *
 * The `@llm` tag opts this spec into the serial worker
 * (`bun run test:browser:llm`, workers=1). Even though no model calls
 * happen here, the wizard mocks rely on the global storage state being
 * a clean signed-in admin — running concurrently with other specs that
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

  test("Settings → AI Agents wizard never advertises the legacy api.useatlas.dev/mcp regional shape", async ({ page }) => {
    // The wizard's Step 3 displays the agent-config snippet inline.
    // Per #2068, when the resolved API base is one of the canonical
    // SaaS regional `api*.useatlas.dev` hosts, the snippet must point
    // at the brand-mirror `mcp*.useatlas.dev` — not the underlying
    // regional `api.*` infra. The hosted route accepts both audiences
    // (backward compat) but new client configs walk forward only.
    //
    // Driving the SaaS code path from a Playwright run requires
    // bundle-time env injection, which Next.js doesn't expose; the
    // brand-mapping pure function is unit-tested at the call site
    // (`brandedMcpBase` / `brandMcpAudience` / `brandedMcpHost`).
    // What this assertion pins is the no-regression invariant: a
    // future change that re-introduces the legacy
    // `api.useatlas.dev/mcp/...` shape into the user-facing snippet
    // — for any base — fails this spec.
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

    // The wizard renders the URL inline next to the snippet block.
    // Even when the runtime-injected base falls back to the page
    // origin (Playwright's localhost), the brand-mapping code path is
    // a pure function: we assert the snippet body never contains the
    // legacy regional `api.useatlas.dev/mcp/` substring as the
    // primary URL the user pastes. A regression that stops mapping
    // would re-introduce that substring in the snippet block.
    const snippetBlock = dialog.locator("pre, code").first();
    const snippetText = (await snippetBlock.textContent()) ?? "";
    // The snippet must not advertise the legacy `api.useatlas.dev/mcp/...`
    // regional pattern — that's the pre-#2068 URL shape every doc and
    // CLI default has now flipped away from. (`localhost` is allowed
    // because Playwright runs against a local Next.js server; we're
    // pinning the no-regression-to-`api.useatlas.dev` invariant.)
    expect(snippetText).not.toContain("api.useatlas.dev/mcp");
    expect(snippetText).not.toContain("api-eu.useatlas.dev/mcp");
    expect(snippetText).not.toContain("api-apac.useatlas.dev/mcp");
  });

  test("docs link from the wizard points at the brand-hostname guide", async ({ page }) => {
    // Every "How do I paste this in Claude Desktop?" / Cursor / etc.
    // link the wizard renders should walk the user to the canonical
    // hosted-MCP guide (which now leads with mcp.useatlas.dev). A
    // regression here would mean the wizard sends users to a deleted
    // anchor or a stale guide.
    await mockOAuthClientsList(page, []);
    await page.goto("/settings/ai-agents");

    const connectButton = page
      .getByRole("button", { name: /Connect new agent/i })
      .first();
    await connectButton.click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /Claude Desktop/ }).click();
    await dialog.getByRole("button", { name: /Next/ }).click();
    await dialog.getByRole("button", { name: /Next/ }).click();

    // The doc link is rendered as a regular anchor — assert href.
    const docsAnchor = dialog
      .getByRole("link", { name: /paste|guide|doc/i })
      .first();
    await expect(docsAnchor).toHaveAttribute(
      "href",
      /docs\.useatlas\.dev\/guides\/mcp-hosted/,
    );
  });
});
