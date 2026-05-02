import { test, expect, type Page } from "@playwright/test";

/**
 * Setup wizard — 4-step semantic-layer onboarding (#1875, 1.3.0 design pass).
 *
 * Mocks the wizard's three POST endpoints + the admin connections list so the
 * tests don't depend on seeded data, profilable databases, or filesystem
 * permissions on the semantic/ directory.
 */

const PATH = "/wizard";

interface ConnectionFixture {
  id: string;
  dbType: string;
  description?: string;
  health?: { status: string; latencyMs: number; checkedAt: string };
}

const HEALTHY = {
  status: "healthy",
  latencyMs: 1,
  checkedAt: new Date().toISOString(),
};

async function mockConnections(page: Page, connections: ConnectionFixture[]) {
  await page.route("**/api/v1/admin/connections", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connections }),
    });
  });
}

async function mockProfile(
  page: Page,
  config:
    | { ok: true; tables: Array<{ name: string; type: string }> }
    | { ok: false; status: number; body: unknown },
) {
  await page.route("**/api/v1/wizard/profile", async (route) => {
    if (config.ok) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connectionId: "default",
          dbType: "postgres",
          schema: "public",
          tables: config.tables,
        }),
      });
    } else {
      await route.fulfill({
        status: config.status,
        contentType: "application/json",
        body: JSON.stringify(config.body),
      });
    }
  });
}

async function mockGenerate(
  page: Page,
  config:
    | { ok: true; entities: unknown[] }
    | { ok: false; status: number; body: unknown },
) {
  await page.route("**/api/v1/wizard/generate", async (route) => {
    if (config.ok) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entities: config.entities }),
      });
    } else {
      await route.fulfill({
        status: config.status,
        contentType: "application/json",
        body: JSON.stringify(config.body),
      });
    }
  });
}

async function mockSave(
  page: Page,
  config: { ok: true } | { ok: false; status: number; body: unknown },
) {
  await page.route("**/api/v1/wizard/save", async (route) => {
    if (config.ok) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    } else {
      await route.fulfill({
        status: config.status,
        contentType: "application/json",
        body: JSON.stringify(config.body),
      });
    }
  });
}

const ENTITY_FIXTURE = {
  tableName: "accounts",
  rowCount: 80,
  columnCount: 7,
  yaml: "name: Accounts\ntype: fact_table\ntable: accounts",
  profile: {
    columns: [
      {
        name: "id",
        type: "integer",
        nullable: false,
        isPrimaryKey: true,
        isForeignKey: false,
        isEnumLike: false,
        sampleValues: ["1", "2", "3"],
      },
    ],
    foreignKeys: [],
    inferredForeignKeys: [],
    flags: { possiblyAbandoned: false, possiblyDenormalized: false },
    notes: [],
  },
};

test.describe("Wizard — datasource step", () => {
  test("renders demo card when __demo__ connection is present", async ({ page }) => {
    await mockConnections(page, [
      {
        id: "__demo__",
        dbType: "postgres",
        description: "Demo dataset",
        health: HEALTHY,
      },
      { id: "default", dbType: "postgres", health: HEALTHY },
    ]);
    await page.goto(PATH);

    await expect(page.getByRole("heading", { name: "Set up your semantic layer" })).toBeVisible();
    await expect(page.getByText("Use the demo dataset")).toBeVisible();
    await expect(page.getByText("Recommended")).toBeVisible();
    await expect(page.getByText("default")).toBeVisible();
  });

  test("filters internal and test-fixture connection ids", async ({ page }) => {
    await mockConnections(page, [
      { id: "default", dbType: "postgres", health: HEALTHY },
      { id: "_internal", dbType: "postgres", health: HEALTHY },
      { id: "draft_test", dbType: "postgres", health: HEALTHY },
    ]);
    await page.goto(PATH);

    await expect(page.getByText("default", { exact: true })).toBeVisible();
    await expect(page.getByText("_internal")).toBeHidden();
    await expect(page.getByText("draft_test")).toBeHidden();
  });

  test("renders empty state when no connections are configured", async ({ page }) => {
    await mockConnections(page, []);
    await page.goto(PATH);

    await expect(page.getByRole("heading", { name: "Connect Atlas to your data" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a connection" })).toBeVisible();
  });

  test("Continue is disabled until a connection is selected", async ({ page }) => {
    await mockConnections(page, [{ id: "default", dbType: "postgres", health: HEALTHY }]);
    await page.goto(PATH);

    const cont = page.getByRole("button", { name: /Continue/ });
    await expect(cont).toBeDisabled();
    await page.getByRole("button", { name: /default/ }).click();
    await expect(cont).toBeEnabled();
  });
});

test.describe("Wizard — tables step", () => {
  test("loads + displays tables and lets user proceed", async ({ page }) => {
    await mockConnections(page, [{ id: "default", dbType: "postgres", health: HEALTHY }]);
    await mockProfile(page, {
      ok: true,
      tables: [
        { name: "accounts", type: "table" },
        { name: "companies", type: "table" },
      ],
    });
    await page.goto(`${PATH}?step=2&connectionId=default`);

    await expect(page.getByRole("heading", { name: "Choose tables" })).toBeVisible();
    await expect(page.getByText("accounts")).toBeVisible();
    await expect(page.getByText("companies")).toBeVisible();
    await expect(page.getByRole("button", { name: /Profile 2 tables/ })).toBeEnabled();
  });

  test("does not leak filesystem paths from a 500 with a path-bearing message", async ({ page }) => {
    await mockConnections(page, [{ id: "default", dbType: "postgres", health: HEALTHY }]);
    await mockProfile(page, {
      ok: false,
      status: 500,
      body: {
        error: "internal_error",
        message: "Failed to list tables: EACCES: permission denied, mkdir '/srv/atlas/secret.json'",
        requestId: "req-abc",
      },
    });
    await page.goto(`${PATH}?step=2&connectionId=default`);

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/semantic layer directory/i);
    await expect(alert).not.toContainText("/srv/atlas/secret.json");
    await expect(alert).toContainText("req-abc");
  });

  test("not-found error from server forwards a clean message and offers recovery", async ({ page }) => {
    await mockConnections(page, [{ id: "default", dbType: "postgres", health: HEALTHY }]);
    await mockProfile(page, {
      ok: false,
      status: 404,
      body: { error: "not_found", message: 'Connection "default" not found.' },
    });
    await page.goto(`${PATH}?step=2&connectionId=default`);

    await expect(page.getByRole("alert")).toContainText(/not found/i);
    await expect(page.getByRole("button", { name: /Pick another connection/ })).toBeVisible();
  });
});

test.describe("Wizard — review and save", () => {
  test("happy path lands on the Done step with starter prompts", async ({ page }) => {
    await mockConnections(page, [{ id: "default", dbType: "postgres", health: HEALTHY }]);
    await mockGenerate(page, { ok: true, entities: [ENTITY_FIXTURE] });
    await mockSave(page, { ok: true });

    await page.goto(`${PATH}?step=3&connectionId=default`);
    await expect(page.getByRole("heading", { name: "Review the semantic layer" })).toBeVisible();
    await expect(page.getByText("accounts")).toBeVisible();

    await page.getByRole("button", { name: /Save semantic layer/ }).click();

    await expect(page.getByRole("heading", { name: /You're ready to query/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Atlas" })).toBeVisible();
  });

  test("save failure shows actionable copy without leaking the path", async ({ page }) => {
    await mockConnections(page, [{ id: "default", dbType: "postgres", health: HEALTHY }]);
    await mockGenerate(page, { ok: true, entities: [ENTITY_FIXTURE] });
    await mockSave(page, {
      ok: false,
      status: 500,
      body: {
        error: "internal_error",
        message: "Failed to save entities: EACCES: permission denied, mkdir '/srv/atlas/semantic/.orgs'",
        requestId: "req-save-1",
      },
    });

    await page.goto(`${PATH}?step=3&connectionId=default`);
    await page.getByRole("button", { name: /Save semantic layer/ }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText(/semantic layer directory/i);
    await expect(alert).not.toContainText("/srv/atlas/semantic/.orgs");
    await expect(alert).toContainText("req-save-1");
    // User stays on Review so they can edit and retry.
    await expect(page.getByRole("heading", { name: "Review the semantic layer" })).toBeVisible();
  });
});

test.describe("Wizard — chrome", () => {
  test("Skip for now is rendered while in-flight and hidden on Done", async ({ page }) => {
    await mockConnections(page, [{ id: "default", dbType: "postgres", health: HEALTHY }]);
    await page.goto(PATH);
    await expect(page.getByRole("link", { name: "Skip for now" })).toBeVisible();

    await page.goto(`${PATH}?step=4`);
    await expect(page.getByRole("link", { name: "Skip for now" })).toBeHidden();
  });
});
