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
 *   2. Clicking the friendly label text toggles via the htmlFor binding.
 *   3. The submit body carries exactly the permissions whose final
 *      state is checked — toggle-then-untoggle drops the perm.
 *   4. Zero-permission submit surfaces the zod .min(1) validation
 *      error and never reaches the wire.
 *
 * Page-level mocking (not real DB rows) — the persistent admin session
 * created by global-setup.ts is itself how this test logs in, and
 * exercising the real /api/v1/admin/roles requires the enterprise
 * license layer, which isn't part of the dev seed. Mocking keeps the
 * spec hermetic.
 *
 * `@llm` tags this spec for the segmentation convention used elsewhere
 * in the suite (e.g. the `test:browser:llm` script). The CI worker
 * count is set globally in playwright.config.ts and does not key on
 * the tag — this is a documentation/grep convention, not an isolation
 * mechanism.
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
  postBodies: Array<Record<string, unknown>>;
}

async function installRolesMocks(page: Page): Promise<InstalledMocks> {
  const state: MockRole[] = [];
  const postBodies: Array<Record<string, unknown>> = [];

  await page.route(
    /\/api\/v1\/admin\/roles(?:\?[^/]*)?$/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
        postBodies.push(body);
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

  return { postBodies };
}

async function openCreateRoleDialog(page: Page) {
  await page.goto("/admin/roles");
  await expect(
    page.getByRole("heading", { name: "Roles", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
  // Substring matching on the accessible name picks the page-level
  // header button only — the empty-state's "Create First Role" doesn't
  // contain "Create Role" as a substring, and the dialog's submit
  // button isn't rendered until the dialog opens. `.first()` is belt-
  // and-suspenders.
  await page.getByRole("button", { name: "Create Role" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Admin roles — Create Role permission checkboxes (#2170) @llm", () => {
  test.describe.configure({ timeout: 45_000 });

  test("permission checkbox toggles on click and persists through submit", async ({
    page,
  }) => {
    const { postBodies } = await installRolesMocks(page);
    const dialog = await openCreateRoleDialog(page);

    await expect(dialog.getByRole("heading", { name: "Create Role" })).toBeVisible();

    await dialog.getByLabel("Name").fill("data-engineer");
    await dialog.getByLabel("Description").fill("Read-only data analyst");

    // The fix added stable `id="perm-<slug>"` to each checkbox. Bracket-
    // id form avoids escaping the `:` in slugs like `admin:audit`.
    const queryCheckbox = dialog.locator('[id="perm-query"]');
    const auditCheckbox = dialog.locator('[id="perm-admin:audit"]');

    await expect(queryCheckbox).toHaveAttribute("data-state", "unchecked");
    await expect(auditCheckbox).toHaveAttribute("data-state", "unchecked");

    // Pre-fix the regression manifested specifically on direct checkbox
    // clicks (the wrapping <label> fired a synthetic re-click on the
    // same button, net-toggling back).
    await queryCheckbox.click();
    await expect(queryCheckbox).toHaveAttribute("data-state", "checked");

    await auditCheckbox.click();
    await expect(auditCheckbox).toHaveAttribute("data-state", "checked");

    // Off→on cycle catches any asymmetry — the original double-fire bug
    // could in principle have flipped one direction but not the other.
    await auditCheckbox.click();
    await expect(auditCheckbox).toHaveAttribute("data-state", "unchecked");
    await auditCheckbox.click();
    await expect(auditCheckbox).toHaveAttribute("data-state", "checked");

    await dialog.getByRole("button", { name: "Create Role" }).click();

    // Dialog hides only on success — once it's gone, the POST has been
    // recorded by the mock route handler.
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    expect(postBodies).toHaveLength(1);
    const body = postBodies[0]!;
    expect(body).toMatchObject({
      name: "data-engineer",
      description: "Read-only data analyst",
    });
    expect(body.permissions).toEqual(
      expect.arrayContaining(["query", "admin:audit"]),
    );
    expect((body.permissions as string[]).length).toBe(2);

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
    const dialog = await openCreateRoleDialog(page);

    const queryCheckbox = dialog.locator('[id="perm-query"]');
    await expect(queryCheckbox).toHaveAttribute("data-state", "unchecked");

    await dialog.getByText("Query data", { exact: true }).click();
    await expect(queryCheckbox).toHaveAttribute("data-state", "checked");
  });

  test("submit with zero permissions surfaces validation and never POSTs", async ({
    page,
  }) => {
    // The schema's `permissions: z.array(z.string()).min(1)` is the
    // last line of defense against empty-permission roles. A future
    // refactor that drops the `.min(1)` rule, or removes the inline
    // FormMessage that surfaces it, must be caught here.
    const { postBodies } = await installRolesMocks(page);
    const dialog = await openCreateRoleDialog(page);

    await dialog.getByLabel("Name").fill("empty-role");
    await dialog.getByRole("button", { name: "Create Role" }).click();

    await expect(
      dialog.getByText(/At least one permission is required/i),
    ).toBeVisible({ timeout: 5_000 });
    expect(postBodies).toHaveLength(0);
    // Dialog stays open on validation failure.
    await expect(dialog).toBeVisible();
  });

  test("toggle-then-untoggle drops the permission from the submit body", async ({
    page,
  }) => {
    // Symmetry case for the off→on→off path: a future single-direction
    // toggle bug (e.g. `add()` without a paired `remove()`) would let
    // the visible checkbox unflag while the form value clung to the
    // perm. Wire-level assertion guards against that drift.
    const { postBodies } = await installRolesMocks(page);
    const dialog = await openCreateRoleDialog(page);

    await dialog.getByLabel("Name").fill("settings-only");

    const queryCheckbox = dialog.locator('[id="perm-query"]');
    const settingsCheckbox = dialog.locator('[id="perm-admin:settings"]');

    await queryCheckbox.click();
    await expect(queryCheckbox).toHaveAttribute("data-state", "checked");
    await queryCheckbox.click();
    await expect(queryCheckbox).toHaveAttribute("data-state", "unchecked");

    await settingsCheckbox.click();
    await expect(settingsCheckbox).toHaveAttribute("data-state", "checked");

    await dialog.getByRole("button", { name: "Create Role" }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    expect(postBodies).toHaveLength(1);
    expect(postBodies[0]!.permissions).toEqual(["admin:settings"]);
  });
});
