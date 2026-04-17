import { test, expect, type Page } from "@playwright/test";

/**
 * Signup connect page — two-card redesign (#1432, followups #1450/#1452).
 *
 * Exercises the page in isolation by intercepting backend calls with
 * Playwright routing, so these tests don't depend on session state, seed
 * data, or LLM provider availability.
 */

// Uses the default authenticated storage state — the proxy in managed mode
// redirects unauthenticated users off /signup sub-routes to /login, so we
// rely on the admin session from global setup. All backend calls that the
// page actually makes are mocked below, so no test data is created.

const PATH = "/signup/connect";

function mockHealth(page: Page, status: "ok" | "down" | "unavailable") {
  return page.route("**/api/health", async (route) => {
    if (status === "unavailable") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "healthy",
        checks: { datasource: { status, latencyMs: 1 } },
      }),
    });
  });
}

async function mockOnboarding(
  page: Page,
  config: {
    testConnection?: { status: number; body: unknown };
    complete?: { status: number; body: unknown };
    useDemo?: { status: number; body: unknown };
  },
) {
  if (config.testConnection) {
    await page.route("**/api/v1/onboarding/test-connection", async (route) => {
      await route.fulfill({
        status: config.testConnection!.status,
        contentType: "application/json",
        body: JSON.stringify(config.testConnection!.body),
      });
    });
  }
  if (config.complete) {
    await page.route("**/api/v1/onboarding/complete", async (route) => {
      await route.fulfill({
        status: config.complete!.status,
        contentType: "application/json",
        body: JSON.stringify(config.complete!.body),
      });
    });
  }
  if (config.useDemo) {
    await page.route("**/api/v1/onboarding/use-demo", async (route) => {
      await route.fulfill({
        status: config.useDemo!.status,
        contentType: "application/json",
        body: JSON.stringify(config.useDemo!.body),
      });
    });
  }
}

test.describe("Signup connect — demo availability", () => {
  test("renders both cards when health reports datasource ok", async ({ page }) => {
    await mockHealth(page, "ok");
    await page.goto(PATH);

    await expect(page.getByRole("heading", { name: "Get started with your data" })).toBeVisible();
    await expect(page.getByText("Connect your database", { exact: true })).toBeVisible();
    await expect(page.getByText("Explore demo data", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Use SaaS CRM demo dataset/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Use Cybersecurity demo dataset/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Use E-commerce demo dataset/ })).toBeVisible();
  });

  test("hides demo card when datasource reports down", async ({ page }) => {
    await mockHealth(page, "down");
    await page.goto(PATH);

    await expect(page.getByText("Connect your database", { exact: true })).toBeVisible();
    await expect(page.getByText("Explore demo data", { exact: true })).toBeHidden();
  });

  test("shows retry affordance when health check fails", async ({ page }) => {
    await mockHealth(page, "unavailable");
    await page.goto(PATH);

    await expect(page.getByText("Explore demo data", { exact: true })).toBeVisible();
    await expect(page.getByText(/Couldn.t check demo availability/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Retry/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Use SaaS CRM demo dataset/ })).toBeHidden();
  });
});

test.describe("Signup connect — error isolation", () => {
  // Scope alert queries to <main> — Next.js dev tools inject a root-level
  // role="alert" indicator for build errors/warnings that would otherwise be
  // counted alongside the app's alerts.
  test("demo failure produces exactly one alert on the demo card", async ({ page }) => {
    await mockHealth(page, "ok");
    await mockOnboarding(page, {
      useDemo: { status: 500, body: { error: "boom", message: "demo setup failed" } },
    });
    await page.goto(PATH);

    const main = page.getByRole("main");

    // Before: no alerts
    await expect(main.getByRole("alert")).toHaveCount(0);

    await page.getByRole("button", { name: /Use SaaS CRM demo dataset/ }).click();

    // After: exactly one alert, carrying the demo error
    const alert = main.getByRole("alert");
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText("demo setup failed");
  });

  test("test-connection failure produces exactly one alert on the connect card", async ({ page }) => {
    await mockHealth(page, "ok");
    await mockOnboarding(page, {
      testConnection: { status: 400, body: { error: "boom", message: "connection refused" } },
    });
    await page.goto(PATH);

    const main = page.getByRole("main");
    await expect(main.getByRole("alert")).toHaveCount(0);

    await page.getByLabel("Connection URL").fill("postgresql://u:p@h:5432/db");
    await page.getByRole("button", { name: "Test connection" }).click();

    const alert = main.getByRole("alert");
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText("connection refused");
  });

  test("success pill disappears when Continue fails — they never coexist", async ({ page }) => {
    await mockHealth(page, "ok");
    await mockOnboarding(page, {
      testConnection: {
        status: 200,
        body: { status: "healthy", latencyMs: 12, dbType: "postgres", maskedUrl: "..." },
      },
      complete: { status: 500, body: { error: "boom", message: "save failed" } },
    });
    await page.goto(PATH);

    const main = page.getByRole("main");

    await page.getByLabel("Connection URL").fill("postgresql://u:p@h:5432/db");
    await page.getByRole("button", { name: "Test connection" }).click();

    // Success status pill appears
    await expect(main.getByRole("status")).toContainText(/Connected to PostgreSQL in 12ms/);

    await page.getByRole("button", { name: "Continue" }).click();

    // Error alert appears and the success pill is gone — never both
    await expect(main.getByRole("alert")).toContainText("save failed");
    await expect(main.getByRole("status")).toHaveCount(0);
  });
});
