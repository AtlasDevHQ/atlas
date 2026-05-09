import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Admin custom roles — Create Role permission checkboxes (#2170) @llm
 *
 * Regression coverage for the "Create Role" dialog: the permission
 * checkboxes used to be wrapped in a `<label>`, which double-fired
 * `onCheckedChange` (Radix Checkbox is a button — the wrapping label
 * dispatched a synthetic activation click on its labelable descendant,
 * net-toggling back). The fix replaces the wrap with htmlFor/id
 * association.
 *
 * What this spec asserts:
 *   1. Clicking a permission checkbox flips it to data-state="checked"
 *      and a second click flips it back (no double-fire in either
 *      direction).
 *   2. The submitted POST body carries the selected permissions verbatim.
 *   3. The new role row renders after the dialog closes.
 *
 * Page-level mocking (not real DB rows) — the persistent admin session
 * created by global-setup.ts is itself how this test logs in, and
 * exercising the real /api/v1/admin/roles requires the enterprise
 * license layer, which isn't part of the dev seed. Mocking keeps the
 * spec hermetic.
 *
 * The `@llm` tag opts this spec into the serial worker so other admin-
 * surface mocks aren't raced.
 */

interface MockRole {
  id: string;
  orgId: string;
  name: string;
  description: string;
  permissions: string[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

const ALL_PERMISSIONS = [
  "query",
  "query:raw_data",
  "admin:users",
  "admin:connections",
  "admin:settings",
  "admin:audit",
  "admin:roles",
  "admin:semantic",
];

interface InstalledMocks {
  state: MockRole[];
  postCalls: Array<{ body: Record<string, unknown> }>;
}

async function installRolesMocks(page: Page): Promise<InstalledMocks> {
  const state: MockRole[] = [];
  const postCalls: Array<{ body: Record<string, unknown> }> = [];

  await page.route(
    /\/api\/v1\/admin\/roles(?:\?[^/]*)?$/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
        postCalls.push({ body });
        const created: MockRole = {
          id: `role_mock_${state.length + 1}`,
          orgId: "org-1",
          name: String(body.name ?? ""),
          description: typeof body.description === "string" ? body.description : "",
          permissions: Array.isArray(body.permissions)
            ? (body.permissions as string[])
            : [],
          isBuiltin: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        state.push(created);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ role: created }),
        });
        return;
      }
      if (req.method() !== "GET") {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          roles: state,
          permissions: ALL_PERMISSIONS,
          total: state.length,
        }),
      });
    },
  );

  return { state, postCalls };
}

test.describe("Admin roles — Create Role permission checkboxes (#2170) @llm", () => {
  test.describe.configure({ timeout: 45_000 });

  test("permission checkbox toggles on click and persists through submit", async ({
    page,
  }) => {
    const { postCalls } = await installRolesMocks(page);
    await page.goto("/admin/roles");

    await expect(page.locator("h1", { hasText: "Roles" })).toBeVisible({
      timeout: 15_000,
    });

    // Open the dialog. With no custom roles seeded the page renders both
    // a header "Create Role" and an empty-state "Create First Role" —
    // the header button is always present, so anchor on it.
    await page.locator('button:has-text("Create Role")').first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Create Role" })).toBeVisible();

    await dialog.getByLabel("Name").fill("data-engineer");
    await dialog.getByLabel("Description").fill("Read-only data analyst");

    // The checkbox carries `id="perm-<slug>"` — the cleanest, least-
    // ambiguous handle. Pre-fix the regression manifested specifically
    // on direct checkbox clicks (the wrapping <label> fired a synthetic
    // re-click on the same button, net-toggling back).
    const queryCheckbox = dialog.locator("#perm-query");
    const auditCheckbox = dialog.locator("#perm-admin\\:audit");

    await expect(queryCheckbox).toHaveAttribute("data-state", "unchecked");
    await expect(auditCheckbox).toHaveAttribute("data-state", "unchecked");

    await queryCheckbox.click();
    await expect(queryCheckbox).toHaveAttribute("data-state", "checked");

    await auditCheckbox.click();
    await expect(auditCheckbox).toHaveAttribute("data-state", "checked");

    // Click again to verify there's no asymmetry — toggling off must
    // also work in a single click.
    await auditCheckbox.click();
    await expect(auditCheckbox).toHaveAttribute("data-state", "unchecked");
    await auditCheckbox.click();
    await expect(auditCheckbox).toHaveAttribute("data-state", "checked");

    await dialog.getByRole("button", { name: "Create Role" }).click();

    // Wire-level assertion — the POST body must carry the permissions
    // we toggled.
    await expect.poll(() => postCalls.length).toBeGreaterThan(0);
    const lastBody = postCalls[postCalls.length - 1]!.body;
    expect(lastBody).toMatchObject({
      name: "data-engineer",
      description: "Read-only data analyst",
    });
    expect(lastBody.permissions).toEqual(
      expect.arrayContaining(["query", "admin:audit"]),
    );
    expect((lastBody.permissions as string[]).length).toBe(2);

    // Dialog closes and the new row renders.
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect(page.getByRole("cell", { name: "data-engineer" })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("clicking the permission row label toggles the associated checkbox", async ({
    page,
  }) => {
    // The label/htmlFor association replaced a wrapping <label>. This
    // case asserts that clicking the row's friendly text still toggles
    // the checkbox — so users who click on the visible label, not the
    // small checkbox, still get a working toggle.
    await installRolesMocks(page);
    await page.goto("/admin/roles");

    await expect(page.locator("h1", { hasText: "Roles" })).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('button:has-text("Create Role")').first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const queryCheckbox = dialog.locator("#perm-query");
    await expect(queryCheckbox).toHaveAttribute("data-state", "unchecked");

    await dialog.getByText("Query data", { exact: true }).click();
    await expect(queryCheckbox).toHaveAttribute("data-state", "checked");
  });
});
