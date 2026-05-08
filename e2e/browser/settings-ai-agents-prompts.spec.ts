import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Settings → AI Agents — prompts preview block (#2179).
 *
 * Mocks `/api/v1/me/mcp-prompts` so the spec runs without a real
 * semantic-layer scan or canonical-prompts YAML present in the test
 * env. The endpoint is the seam we trust — its tests live in
 * `packages/api/src/api/__tests__/me-mcp-prompts.test.ts`. This file
 * pins the page-level UX:
 *
 *   - Source-grouped preview renders with counts
 *   - "View all" toggles the expanded list
 *   - Closed canonical gate surfaces a banner with the admin link
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
  tokenState: "active" | "reconnect_required" | "revoked";
}

interface MockPromptsBody {
  prompts: Array<{
    name: string;
    description?: string;
    arguments: Array<{ name: string; description: string; required: boolean }>;
    source: "builtin" | "canonical" | "semantic" | "library";
  }>;
  canonicalGate: {
    exposed: boolean;
    toggle: "always" | "never" | "auto";
    reason: "toggle-never" | "no-demo-signal" | null;
  };
}

function fixturePromptsExposed(): MockPromptsBody {
  // Counts here drive the UI assertions below — keep them stable.
  return {
    prompts: [
      // Built-ins
      ...["revenue-trend", "top-by-metric", "compare-periods", "breakdown", "anomaly-detection"].map(
        (name) => ({
          name,
          description: `Built-in: ${name}`,
          arguments: [],
          source: "builtin" as const,
        }),
      ),
      // Canonicals
      ...Array.from({ length: 6 }, (_, i) => ({
        name: `canonical-q-${i + 1}`,
        description: `Canonical question ${i + 1}`,
        arguments: [],
        source: "canonical" as const,
      })),
      // Semantic
      ...Array.from({ length: 4 }, (_, i) => ({
        name: `entity-orders-pattern-${i + 1}`,
        description: `Pattern ${i + 1}`,
        arguments: [],
        source: "semantic" as const,
      })),
      // Library
      ...Array.from({ length: 2 }, (_, i) => ({
        name: `library-lib-${i + 1}`,
        description: `Library ${i + 1}`,
        arguments: [],
        source: "library" as const,
      })),
    ],
    canonicalGate: { exposed: true, toggle: "always", reason: null },
  };
}

function fixturePromptsGated(): MockPromptsBody {
  return {
    prompts: [
      ...["revenue-trend", "top-by-metric", "compare-periods", "breakdown", "anomaly-detection"].map(
        (name) => ({
          name,
          description: `Built-in: ${name}`,
          arguments: [],
          source: "builtin" as const,
        }),
      ),
    ],
    canonicalGate: { exposed: false, toggle: "never", reason: "toggle-never" },
  };
}

function fixtureOauthClients(): MockOAuthClient[] {
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
  ];
}

async function installMocks(
  page: Page,
  promptsBody: MockPromptsBody,
  oauthClients: MockOAuthClient[] = fixtureOauthClients(),
): Promise<void> {
  // Prompts mock — narrowly scoped so it doesn't shadow any other route.
  await page.route(/\/api\/v1\/me\/mcp-prompts(?:\?[^/]*)?$/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(promptsBody),
    });
  });

  // OAuth-clients mock — the page hits this on initial load even if the
  // user only cares about the preview block.
  await page.route(/\/api\/v1\/me\/oauth-clients(?:\?[^/]*)?$/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clients: oauthClients, deployMode: "saas" }),
    });
  });
}

test.describe("Settings → AI Agents — prompts preview", () => {
  test.describe.configure({ timeout: 45_000 });

  test("preview block renders source-grouped counts when canonical is exposed", async ({ page }) => {
    await installMocks(page, fixturePromptsExposed());
    await page.goto("/settings/ai-agents");

    await expect(
      page.locator("h1", { hasText: "AI Agents" }),
    ).toBeVisible({ timeout: 15_000 });

    const preview = page.getByTestId("prompts-preview");
    await expect(preview).toBeVisible({ timeout: 15_000 });
    // Section heading + per-source groups
    await expect(preview.getByText(/Prompts your agent will see/i)).toBeVisible();
    await expect(preview.getByTestId("prompts-preview-source-builtin")).toBeVisible();
    await expect(preview.getByTestId("prompts-preview-source-canonical")).toBeVisible();
    await expect(preview.getByTestId("prompts-preview-source-semantic")).toBeVisible();
    await expect(preview.getByTestId("prompts-preview-source-library")).toBeVisible();

    // Closed gate banner is absent on this fixture.
    await expect(page.getByTestId("canonical-gate-banner")).toHaveCount(0);
  });

  test("'View all' expands beyond the per-source preview limit", async ({ page }) => {
    await installMocks(page, fixturePromptsExposed());
    await page.goto("/settings/ai-agents");

    await expect(page.getByTestId("prompts-preview")).toBeVisible({ timeout: 15_000 });

    // Canonical fixture has 6 entries; collapsed view shows 3 + "+3 more".
    const canonical = page.getByTestId("prompts-preview-source-canonical");
    await expect(canonical.getByText(/^canonical-q-1/)).toBeVisible();
    await expect(canonical.getByText(/^canonical-q-2/)).toBeVisible();
    await expect(canonical.getByText(/^canonical-q-3/)).toBeVisible();
    await expect(canonical.getByText(/^canonical-q-4/)).toHaveCount(0);
    await expect(canonical.getByText(/\+3 more/)).toBeVisible();

    // Click "View all" → entries 4,5,6 visible + "+N more" gone.
    await page.getByTestId("prompts-preview-toggle").click();
    await expect(canonical.getByText(/^canonical-q-4/)).toBeVisible();
    await expect(canonical.getByText(/^canonical-q-5/)).toBeVisible();
    await expect(canonical.getByText(/^canonical-q-6/)).toBeVisible();
    await expect(canonical.getByText(/\+3 more/)).toHaveCount(0);
  });

  test("closed canonical gate surfaces the banner + admin link", async ({ page }) => {
    await installMocks(page, fixturePromptsGated());
    await page.goto("/settings/ai-agents");

    await expect(page.getByTestId("prompts-preview")).toBeVisible({ timeout: 15_000 });

    const banner = page.getByTestId("canonical-gate-banner");
    await expect(banner).toBeVisible();
    await expect(
      banner.getByText(/Canonical eval prompts are turned off/i),
    ).toBeVisible();
    await expect(
      banner.getByRole("link", { name: /Open MCP settings/i }),
    ).toHaveAttribute("href", "/admin/settings/mcp");

    // Canonical group is suppressed when none surface from the API.
    await expect(page.getByTestId("prompts-preview-source-canonical")).toHaveCount(0);
  });
});
