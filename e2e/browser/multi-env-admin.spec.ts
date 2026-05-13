import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Browser e2e for the multi-environment semantic-layer admin surface
 * (#2340). Asserts the key user-visible promise of the multi-env work:
 * a 3-member group's entities collapse to one row in `/admin/semantic`
 * and carry an environment badge that names the group (not the
 * underlying connection).
 *
 * Mirrors the page-level route-mock pattern from
 * `admin-connection-groups.spec.ts` and `admin-cache.spec.ts` — the
 * mock state is built up-front and the test exercises the rendered UI
 * against a deterministic fixture, so this spec is self-contained and
 * needs no live server.
 *
 * Tagged `@llm` to match the milestone segmentation convention even
 * though no model call is made; CI tier selectors that key on `@llm`
 * still pick this up alongside the other admin-flow e2es.
 */

interface MockEntity {
  /** Display name and tree label. */
  name: string;
  table: string;
  description: string;
  columnCount: number;
  /**
   * Environment / group label as the API returns it. `g_prod` (a
   * three-member group) and `g_staging` (a single-member group) prove
   * the badge resolves regardless of group size. `null` indicates a
   * legacy un-scoped entity that should render unbadged.
   */
  source: string | null;
  status?: "published" | "draft";
}

function buildFixture(): MockEntity[] {
  // Three "prod" connections (us-int / eu / apac) share the same group.
  // Pre-1.4.4 this would have rendered as three separate "users.yml"
  // rows in the tree; #2340 collapses them to one. Same for "orders".
  return [
    {
      name: "users",
      table: "users",
      description: "Customer accounts shared across regions",
      columnCount: 5,
      source: "g_prod",
    },
    {
      name: "orders",
      table: "orders",
      description: "Order log shared across regions",
      columnCount: 8,
      source: "g_prod",
      status: "draft",
    },
    {
      name: "staging_logs",
      table: "staging_logs",
      description: "Staging-only telemetry",
      columnCount: 3,
      source: "g_staging",
    },
    {
      name: "kpi_terms",
      table: "kpi_terms",
      description: "Org-wide glossary entity (no environment)",
      columnCount: 0,
      source: null,
    },
  ];
}

async function installMocks(page: Page, entities: MockEntity[]): Promise<void> {
  // `/api/v1/admin/semantic/entities` is the page's primary fetch. The
  // server collapses multi-member groups at the DB layer (#2340) so the
  // mock returns one row per logical entity already — same shape as
  // production.
  await page.route(/\/api\/v1\/admin\/semantic\/entities(?:\?|$)/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entities: entities.map((e) => ({
          name: e.name,
          table: e.table,
          description: e.description,
          columnCount: e.columnCount,
          source: e.source ?? "default",
          status: e.status ?? "published",
        })),
      }),
    });
  });

  // Stub the ancillary endpoints the page fetches in parallel. Each one
  // returns an empty result so the page renders the entities tree
  // without spinner / error state.
  for (const path of ["glossary", "metrics", "catalog"]) {
    await page.route(new RegExp(`/api/v1/admin/semantic/${path}(\\?|$)`), async (route: Route) => {
      if (route.request().method() !== "GET") {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ [path]: [] }),
      });
    });
  }

  // Deploy-mode endpoint — the page reads `deployMode === 'saas'` to
  // gate the "Add Entity" button. Returning saas keeps the editor
  // available without changing the badge rendering under test.
  await page.route(/\/api\/v1\/deploy-mode/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ deployMode: "saas" }),
    });
  });
}

test.describe("admin semantic — multi-environment", () => {
  test("@llm multi-member group collapses to one row with environment badge", async ({ page }) => {
    const fixture = buildFixture();
    await installMocks(page, fixture);

    await page.goto("/admin/semantic");

    // The page renders one row per (org, name, group) — three "prod"
    // connections do NOT triplicate the "users" / "orders" rows.
    const tree = page.locator("text=users.yml");
    await expect(tree).toHaveCount(1);
    await expect(page.locator("text=orders.yml")).toHaveCount(1);
    await expect(page.locator("text=staging_logs.yml")).toHaveCount(1);

    // Environment badge surfaces the group label (`prod`, `staging`) —
    // strips the `g_` prefix so the chip reads naturally. The
    // un-scoped glossary entity (`kpi_terms`) renders unbadged.
    const badges = page.getByTestId("entity-env-badge");
    await expect(badges).toHaveCount(3);
    await expect(badges.filter({ hasText: "prod" })).toHaveCount(2);
    await expect(badges.filter({ hasText: "staging" })).toHaveCount(1);

    // Negative assertion — the un-scoped entity is in the tree but
    // carries no badge.
    const kpiRow = page.locator("button", { hasText: "kpi_terms.yml" });
    await expect(kpiRow.getByTestId("entity-env-badge")).toHaveCount(0);
  });

  test("@llm draft accent and environment badge coexist", async ({ page }) => {
    const fixture = buildFixture();
    await installMocks(page, fixture);

    await page.goto("/admin/semantic");

    // The "orders" row carries both signals: drafted status AND a
    // group label. Both pieces of information should reach the admin
    // — the draft accent for the "pending publish" cue and the badge
    // for the "which environment" cue.
    const ordersRow = page.locator("button", { hasText: "orders.yml" });
    await expect(ordersRow.getByTestId("entity-env-badge").filter({ hasText: "prod" })).toBeVisible();
    // The draft accent leaves an aria-label suffix the screen-reader
    // path can read; this assertion guards the accessibility shape.
    await expect(ordersRow).toHaveAttribute("aria-label", /draft.*environment: prod/i);
  });
});
