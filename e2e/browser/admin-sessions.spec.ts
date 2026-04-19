import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Admin sessions — first bucket-2 e2e (issue #1631, follow-up to PR #1628).
 *
 * Exercises the confirm-before-revoke dialog, single + bulk revoke, and
 * the partial-failure banner + failed-row-stays-selected behavior.
 *
 * Design note: the spec mocks `/api/v1/admin/sessions*` at the page level
 * instead of seeding real DB rows. Two reasons.
 *   1. The persistent admin login used by `global-setup.ts` is itself a
 *      session row — a test that revoked the wrong row would log the rest
 *      of the suite out and cascade-fail.
 *   2. Partial-failure coverage needs a deterministic 500 from the server
 *      for a specific session id, which is impossible to force against a
 *      healthy API without plumbing a fault-injection switch.
 *
 * The mocks mutate a local map on DELETE so subsequent GETs see the
 * removals — the UI's `useAdminMutation` invalidates admin-fetch queries
 * on success, so we need the mock to behave like a real server across the
 * invalidation boundary. No `@llm` tag — no model calls.
 */

interface MockSession {
  id: string;
  userId: string;
  userEmail: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string;
  userAgent: string;
}

function buildFixture(): MockSession[] {
  // Keep `updatedAt` strictly descending — the page's default sort is
  // `updatedAt desc`, so row ordering in the DOM matches this array.
  return [
    {
      id: "sess_alice",
      userId: "user_alice",
      userEmail: "alice.e2e@useatlas.dev",
      createdAt: "2026-04-18T09:00:00.000Z",
      updatedAt: "2026-04-19T12:00:00.000Z",
      expiresAt: "2026-04-26T09:00:00.000Z",
      ipAddress: "10.0.0.11",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36",
    },
    {
      id: "sess_bob",
      userId: "user_bob",
      userEmail: "bob.e2e@useatlas.dev",
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-19T11:00:00.000Z",
      expiresAt: "2026-04-26T10:00:00.000Z",
      ipAddress: "10.0.0.12",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/123.0",
    },
    {
      id: "sess_carol",
      userId: "user_carol",
      userEmail: "carol.e2e@useatlas.dev",
      createdAt: "2026-04-18T11:00:00.000Z",
      updatedAt: "2026-04-19T10:00:00.000Z",
      expiresAt: "2026-04-26T11:00:00.000Z",
      ipAddress: "10.0.0.13",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edge/120.0.0.0",
    },
  ];
}

interface MockOptions {
  /** Session ids for which DELETE should return 500 (partial-failure tests). */
  failDeleteIds?: Set<string>;
}

/**
 * Install mocks for the three endpoints the sessions page hits. Returns
 * the mutable session map so the test can assert on remaining state.
 */
async function installSessionMocks(
  page: Page,
  opts: MockOptions = {},
): Promise<Map<string, MockSession>> {
  const state = new Map<string, MockSession>(
    buildFixture().map((s) => [s.id, s]),
  );
  const failDeleteIds = opts.failDeleteIds ?? new Set<string>();

  await page.route(/\/api\/v1\/admin\/sessions\/stats(?:\?|$)/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: state.size,
        active: state.size,
        uniqueUsers: new Set([...state.values()].map((s) => s.userId)).size,
      }),
    });
  });

  await page.route(/\/api\/v1\/admin\/sessions\/[^/?]+(?:\?|$)/, async (route: Route) => {
    const req = route.request();
    if (req.method() !== "DELETE") {
      // Anything that isn't a DELETE to an id path (e.g. a future GET)
      // should fall through to the real network — the mock isn't trying
      // to be exhaustive.
      await route.fallback();
      return;
    }
    const url = new URL(req.url());
    // path is `/api/v1/admin/sessions/<id>` — take the last segment.
    const id = url.pathname.split("/").pop()!;
    if (failDeleteIds.has(id)) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "internal",
          message: "Internal server error",
          requestId: `req_mock_${id}`,
        }),
      });
      return;
    }
    state.delete(id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  // Anchor the list-path regex to end-of-path-or-query so future relaxation
  // of the pattern can't accidentally shadow `/stats` or `/<id>` handlers
  // registered above. Playwright evaluates handlers in reverse-registration
  // order, so without the anchor a broadened match here would silently
  // intercept the more specific routes (code review flagged this as a
  // drift hazard).
  await page.route(/\/api\/v1\/admin\/sessions(?:\?[^/]*)?$/, async (route: Route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      await route.fallback();
      return;
    }
    const sessions = [...state.values()].sort(
      (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions,
        total: sessions.length,
        limit: 50,
        offset: 0,
      }),
    });
  });

  return state;
}

test.describe("Admin sessions revoke flow", () => {
  test.describe.configure({ timeout: 45_000 });

  test("page loads with stats strip and seeded rows", async ({ page }) => {
    const state = await installSessionMocks(page);
    await page.goto("/admin/sessions");

    await expect(
      page.locator("h1", { hasText: "Sessions" }),
    ).toBeVisible({ timeout: 15_000 });

    // Stats strip — three cards rendered from GET /stats
    await expect(page.getByText("Total Sessions", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Active Sessions", { exact: true })).toBeVisible();
    await expect(page.getByText("Unique Users", { exact: true })).toBeVisible();

    // Rows render with seeded emails
    for (const session of state.values()) {
      await expect(page.getByRole("cell", { name: session.userEmail })).toBeVisible({
        timeout: 10_000,
      });
    }
  });

  test("cancel leaves the session intact", async ({ page }) => {
    const state = await installSessionMocks(page);
    await page.goto("/admin/sessions");
    await expect(page.getByRole("cell", { name: "alice.e2e@useatlas.dev" })).toBeVisible({
      timeout: 15_000,
    });

    const aliceRow = page.getByRole("row").filter({ hasText: "alice.e2e@useatlas.dev" });
    await aliceRow.getByRole("button", { name: "Revoke" }).click();

    await expect(
      page.getByRole("alertdialog").getByText("Revoke session?"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    // Row still present, mock state untouched.
    await expect(aliceRow).toBeVisible();
    expect(state.has("sess_alice")).toBe(true);
  });

  test("confirm removes the row from the table", async ({ page }) => {
    const state = await installSessionMocks(page);
    await page.goto("/admin/sessions");
    const aliceRow = page.getByRole("row").filter({ hasText: "alice.e2e@useatlas.dev" });
    await expect(aliceRow).toBeVisible({ timeout: 15_000 });

    await aliceRow.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();

    // The AlertDialog's action button is also labeled "Revoke"; scope the
    // click to the dialog so Playwright doesn't match the row button.
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revoke" })
      .click();

    await expect(aliceRow).toHaveCount(0, { timeout: 10_000 });
    // Other rows remain
    await expect(
      page.getByRole("cell", { name: "bob.e2e@useatlas.dev" }),
    ).toBeVisible();
    expect(state.has("sess_alice")).toBe(false);
    expect(state.has("sess_bob")).toBe(true);
  });

  test("bulk revoke removes every selected row", async ({ page }) => {
    const state = await installSessionMocks(page);
    await page.goto("/admin/sessions");
    await expect(
      page.getByRole("cell", { name: "alice.e2e@useatlas.dev" }),
    ).toBeVisible({ timeout: 15_000 });

    const aliceRow = page.getByRole("row").filter({ hasText: "alice.e2e@useatlas.dev" });
    const bobRow = page.getByRole("row").filter({ hasText: "bob.e2e@useatlas.dev" });
    await aliceRow.getByRole("checkbox", { name: "Select row" }).check();
    await bobRow.getByRole("checkbox", { name: "Select row" }).check();

    const bulkButton = page.getByRole("button", { name: /Revoke 2 selected/ });
    await expect(bulkButton).toBeEnabled();
    await bulkButton.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText(/Revoke 2 session\(s\)\?/)).toBeVisible();
    await dialog.getByRole("button", { name: "Revoke" }).click();

    await expect(aliceRow).toHaveCount(0, { timeout: 10_000 });
    await expect(bobRow).toHaveCount(0);
    // Carol survives
    await expect(
      page.getByRole("cell", { name: "carol.e2e@useatlas.dev" }),
    ).toBeVisible();
    expect(state.has("sess_alice")).toBe(false);
    expect(state.has("sess_bob")).toBe(false);
    expect(state.has("sess_carol")).toBe(true);
  });

  test("bulk revoke partial failure shows banner and keeps failed row selected", async ({
    page,
  }) => {
    const state = await installSessionMocks(page, {
      failDeleteIds: new Set(["sess_alice"]),
    });
    await page.goto("/admin/sessions");
    await expect(
      page.getByRole("cell", { name: "alice.e2e@useatlas.dev" }),
    ).toBeVisible({ timeout: 15_000 });

    const aliceRow = page.getByRole("row").filter({ hasText: "alice.e2e@useatlas.dev" });
    const bobRow = page.getByRole("row").filter({ hasText: "bob.e2e@useatlas.dev" });
    await aliceRow.getByRole("checkbox", { name: "Select row" }).check();
    await bobRow.getByRole("checkbox", { name: "Select row" }).check();

    await page.getByRole("button", { name: /Revoke 2 selected/ }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revoke" })
      .click();

    // Banner shape from `bulkFailureSummary(results, selected, "revocations")`:
    // "1 of 2 revocations failed: ..."
    await expect(page.getByText(/1 of 2 revocations failed:/)).toBeVisible({
      timeout: 10_000,
    });

    // Bob's revoke succeeded; Alice's failed row remains in the table and
    // the bulk header now shows a single-selected count so the operator
    // can retry with one click.
    await expect(bobRow).toHaveCount(0, { timeout: 10_000 });
    await expect(aliceRow).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Revoke 1 selected/ }),
    ).toBeVisible();
    expect(state.has("sess_alice")).toBe(true);
    expect(state.has("sess_bob")).toBe(false);
  });
});
