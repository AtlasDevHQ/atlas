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
  /** Milliseconds to sleep before fulfilling DELETE (disabled-button test). */
  deleteDelayMs?: number;
}

/**
 * Install mocks for the three endpoints the sessions page hits. Returns
 * the mutable session map so the test can assert on remaining state.
 *
 * Scope limits deliberately kept narrow:
 *  - The list handler returns the full fixture regardless of `?search=`,
 *    `?limit=`, or `?offset=`. This spec never exercises search or
 *    pagination; a future spec that does should either extend this mock
 *    or build a new one that honors the query string.
 *  - Non-DELETE on the id path and non-GET on the list path `route.abort`
 *    rather than `route.fallback()` — falling back would hit the real
 *    network in CI, which could mask a regression that starts issuing
 *    unexpected requests by silently succeeding against a real admin API.
 */
async function installSessionMocks(
  page: Page,
  opts: MockOptions = {},
): Promise<Map<string, MockSession>> {
  const state = new Map<string, MockSession>(
    buildFixture().map((s) => [s.id, s]),
  );
  const failDeleteIds = opts.failDeleteIds ?? new Set<string>();
  const deleteDelayMs = opts.deleteDelayMs ?? 0;

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
      // Abort (not fallback) so an unexpected method is a loud failure
      // in CI, not a silent real-network passthrough.
      await route.abort("failed");
      return;
    }
    const url = new URL(req.url());
    // path is `/api/v1/admin/sessions/<id>` — take the last segment.
    const id = url.pathname.split("/").pop()!;
    if (deleteDelayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, deleteDelayMs));
    }
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
      await route.abort("failed");
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

  test("row Revoke button is disabled while the mutation is in flight", async ({ page }) => {
    // Delay the DELETE response so the disabled state is observable
    // between the dialog closing and the refetch removing the row.
    // The page wires `disabled={revoking}` to `isMutating(sessionId)` —
    // a regression in the `useAdminMutation` per-item tracking would
    // otherwise go silent.
    await installSessionMocks(page, { deleteDelayMs: 800 });
    await page.goto("/admin/sessions");
    const aliceRow = page.getByRole("row").filter({ hasText: "alice.e2e@useatlas.dev" });
    await expect(aliceRow).toBeVisible({ timeout: 15_000 });

    const rowRevoke = aliceRow.getByRole("button", { name: "Revoke" });
    await expect(rowRevoke).toBeEnabled();
    await rowRevoke.click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revoke" })
      .click();

    // Dialog closes immediately; row is still visible during the 800ms
    // mock delay. Button should flip to disabled until the DELETE
    // resolves and the refetch removes the row.
    await expect(rowRevoke).toBeDisabled({ timeout: 2_000 });
    await expect(aliceRow).toHaveCount(0, { timeout: 5_000 });
  });

  test("single-row revoke failure renders the error banner", async ({ page }) => {
    // The `revokeError` banner path (page.tsx: `revokeError && !bulkError`)
    // was not covered by the bulk tests. A 500 on the single-row revoke
    // must populate the hook's `error` slot and render `<ErrorBanner />`
    // with the friendlyError message — regressions to either the
    // `!bulkError` guard or the hook's error wiring would go silent
    // otherwise.
    const state = await installSessionMocks(page, {
      failDeleteIds: new Set(["sess_alice"]),
    });
    await page.goto("/admin/sessions");
    const aliceRow = page.getByRole("row").filter({ hasText: "alice.e2e@useatlas.dev" });
    await expect(aliceRow).toBeVisible({ timeout: 15_000 });

    await aliceRow.getByRole("button", { name: "Revoke" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revoke" })
      .click();

    // friendlyError passes the server message through verbatim for
    // non-mapped statuses (500 is not 401/403/404/503) and appends the
    // request id. Assert on the banner's role + the server message so
    // the test doesn't over-pin the exact formatting.
    const banner = page.getByRole("alert").filter({ hasText: /Internal server error/ });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(/Request ID: req_mock_sess_alice/);

    // Row survives — failure must not remove it from the table.
    await expect(aliceRow).toBeVisible();
    expect(state.has("sess_alice")).toBe(true);
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
