import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Admin actions approval — covers the Deny-with-reason flow end-to-end.
 *
 * The Deny-with-reason path is the single piece of admin UX that writes
 * to the compliance-relevant audit trail on every click. A regression in
 * the reason-passthrough (e.g. dropping the trimmed reason and
 * substituting a hardcoded default like "Denied by admin") would silently
 * corrupt the audit log without any existing test catching it.
 *
 * Design note: the spec mocks `/api/v1/actions*` endpoints at the page
 * level rather than seeding real DB rows — mirrors the admin-sessions
 * pattern (see `admin-sessions.spec.ts` for rationale). Two reasons:
 *   1. Seeding a pending action against a real backend requires a
 *      dev-only admin route that doesn't exist today. Adding one just
 *      for e2e would widen the attack surface.
 *   2. Deterministic deny-body + partial-failure assertions are the core
 *      of this spec — intercepting the request lets us pin the exact
 *      body shape the page sends (reason included, not substituted) and
 *      force a single row's deny to fail on demand.
 *
 * Tagged `@llm` for suite segmentation even though no model calls are
 * made — keeps the spec alongside `starter-prompts-moderation.spec.ts`
 * (the sibling compliance-sensitive moderation spec) per project
 * convention.
 */

interface MockAction {
  id: string;
  requested_at: string;
  resolved_at: string | null;
  executed_at: string | null;
  requested_by: string | null;
  approved_by: string | null;
  auth_mode: string;
  action_type: string;
  target: string;
  summary: string;
  payload: Record<string, unknown>;
  status: string;
  result: unknown;
  error: string | null;
  rollback_info: unknown;
  conversation_id: string | null;
  request_id: string | null;
  denial_reason?: string;
}

function buildPendingAction(overrides: Partial<MockAction> = {}): MockAction {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    requested_at: "2026-04-19T12:00:00.000Z",
    resolved_at: null,
    executed_at: null,
    requested_by: "agent",
    approved_by: null,
    auth_mode: "simple-key",
    action_type: "sql_write",
    target: "orders",
    summary: "UPDATE orders SET status='cancelled' WHERE id = 42",
    payload: { sql: "UPDATE orders SET status='cancelled' WHERE id = 42" },
    status: "pending",
    result: null,
    error: null,
    rollback_info: null,
    conversation_id: null,
    request_id: null,
    ...overrides,
  };
}

interface InstalledMocks {
  /** Shared mutable state so tests can assert final ordering. */
  state: Map<string, MockAction>;
  /** Reasons captured by the deny mock, in request-order. */
  denyCalls: Array<{ id: string; reason: string }>;
}

interface MockOptions {
  /** Action fixtures to preload. Defaults to a single pending action. */
  fixtures?: MockAction[];
  /** Ids for which POST …/deny should return 500 (partial-failure tests). */
  failDenyIds?: Set<string>;
}

/**
 * Mock the routes the admin actions page hits.
 *   - GET  /api/v1/actions?status=…    → filtered list
 *   - POST /api/v1/actions/:id/approve → 200 { result }
 *   - POST /api/v1/actions/:id/deny    → 200, captures body.reason
 *
 * Non-matching methods on the id path `route.abort` rather than fall
 * through, so an unexpected request is a loud failure in CI.
 */
async function installActionMocks(
  page: Page,
  opts: MockOptions = {},
): Promise<InstalledMocks> {
  const state = new Map<string, MockAction>();
  const fixtures = opts.fixtures ?? [buildPendingAction()];
  for (const f of fixtures) state.set(f.id, f);
  const failDenyIds = opts.failDenyIds ?? new Set<string>();
  const denyCalls: Array<{ id: string; reason: string }> = [];

  await page.route(/\/api\/v1\/actions\/[^/?]+\/(approve|deny|rollback)(?:\?|$)/, async (route: Route) => {
    const req = route.request();
    if (req.method() !== "POST") {
      await route.abort("failed");
      return;
    }
    const url = new URL(req.url());
    const parts = url.pathname.split("/");
    const endpoint = parts.pop()!;
    const id = parts.pop()!;
    const action = state.get(id);
    if (!action) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "not_found", requestId: `req_${id}` }),
      });
      return;
    }
    if (endpoint === "deny") {
      const body = (() => {
        try {
          return JSON.parse(req.postData() ?? "{}") as { reason?: string };
        } catch {
          // intentionally ignored: malformed post body is treated as empty —
          // the reason-extraction path still runs and the assertion downstream
          // fails loudly rather than silently passing.
          return {};
        }
      })();
      const reason = typeof body.reason === "string" ? body.reason : "";
      denyCalls.push({ id, reason });
      if (failDenyIds.has(id)) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: "internal",
            message: "Internal server error",
            requestId: `req_${id}`,
          }),
        });
        return;
      }
      action.status = "denied";
      action.resolved_at = "2026-04-19T12:05:00.000Z";
      action.approved_by = "admin@useatlas.dev";
      action.denial_reason = reason;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "denied", actionId: id, reason }),
      });
      return;
    }
    if (endpoint === "approve") {
      action.status = "executed";
      action.resolved_at = "2026-04-19T12:05:00.000Z";
      action.executed_at = "2026-04-19T12:05:00.000Z";
      action.approved_by = "admin@useatlas.dev";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "executed",
          actionId: id,
          result: { ok: true },
        }),
      });
      return;
    }
    await route.abort("failed");
  });

  await page.route(/\/api\/v1\/actions(?:\?[^/]*)?$/, async (route: Route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      await route.abort("failed");
      return;
    }
    const url = new URL(req.url());
    const status = url.searchParams.get("status");
    const actions = [...state.values()]
      .filter((a) => {
        if (!status || status === "all") return true;
        return a.status === status;
      })
      .sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ actions }),
    });
  });

  return { state, denyCalls };
}

test.describe("Admin actions approval @llm", () => {
  test.describe.configure({ timeout: 45_000 });

  test("operator denies a pending action with a reason; row moves to Denied and the reason is sent to the server", async ({
    page,
  }) => {
    const { state, denyCalls } = await installActionMocks(page);

    await page.goto("/admin/actions");
    await expect(page.locator("h1", { hasText: "Actions" })).toBeVisible({
      timeout: 15_000,
    });

    // Row renders in the Pending list. The summary is the distinctive
    // text we scope the row lookup to.
    const pendingRow = page
      .getByRole("row")
      .filter({ hasText: "UPDATE orders SET status='cancelled'" });
    await expect(pendingRow).toBeVisible({ timeout: 10_000 });

    // Two deny buttons can render (row-level + expanded detail); scoping
    // to the row is important for stability.
    const denyRowButton = pendingRow.getByRole("button", {
      name: "Deny action",
    });
    await denyRowButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Deny action")).toBeVisible({
      timeout: 5_000,
    });
    await dialog.locator("#reason-dialog-reason").fill("Conflicts with policy");
    await dialog.getByRole("button", { name: "Deny" }).click();

    // Compliance-sensitive assertion: the server received the reason
    // verbatim. A regression that substituted a hardcoded default (the
    // class of bug that predates this spec) would fail this check.
    await expect
      .poll(() => denyCalls.at(-1)?.reason, { timeout: 10_000 })
      .toBe("Conflicts with policy");

    await expect(pendingRow).toHaveCount(0, { timeout: 10_000 });

    await page.getByRole("button", { name: "Denied" }).click();
    const deniedRow = page
      .getByRole("row")
      .filter({ hasText: "UPDATE orders SET status='cancelled'" });
    await expect(deniedRow).toBeVisible({ timeout: 10_000 });

    // Audit-log equivalent: server state reflects the actor + reason
    // on the row. The admin_actions audit table would be written by the
    // same transaction the route handler uses; asserting on the mock's
    // captured state exercises the wire contract the page depends on
    // for the audit trail.
    const finalAction = state.get("00000000-0000-0000-0000-0000000000aa");
    expect(finalAction?.status).toBe("denied");
    expect(finalAction?.approved_by).toBe("admin@useatlas.dev");
    expect(finalAction?.denial_reason).toBe("Conflicts with policy");
  });

  test("bulk-deny partial failure: successful rows clear, failed row stays selected with its reason preserved", async ({
    page,
  }) => {
    // Three pending rows, one configured to 500 on deny. Exercises the
    // `summarizeBulkResult` → selection-narrowing path end-to-end:
    // the two successful ids drop out of the selection, the one failed
    // id stays selected so a retry click targets exactly that row.
    // A reorder regression in the index pairing (compliance-sensitive)
    // would narrow to the wrong row and this test would fail.
    const { state, denyCalls } = await installActionMocks(page, {
      fixtures: [
        buildPendingAction({
          id: "00000000-0000-0000-0000-000000000001",
          summary: "bulk-target-1",
          payload: { sql: "bulk-target-1" },
          requested_at: "2026-04-19T12:00:01.000Z",
        }),
        buildPendingAction({
          id: "00000000-0000-0000-0000-000000000002",
          summary: "bulk-target-2",
          payload: { sql: "bulk-target-2" },
          requested_at: "2026-04-19T12:00:02.000Z",
        }),
        buildPendingAction({
          id: "00000000-0000-0000-0000-000000000003",
          summary: "bulk-target-3",
          payload: { sql: "bulk-target-3" },
          requested_at: "2026-04-19T12:00:03.000Z",
        }),
      ],
      failDenyIds: new Set(["00000000-0000-0000-0000-000000000002"]),
    });

    await page.goto("/admin/actions");
    await expect(page.locator("h1", { hasText: "Actions" })).toBeVisible({
      timeout: 15_000,
    });

    // Select all three rows via the header "Select all pending actions"
    // checkbox — exercises the exact same selection path operators use.
    await page.getByRole("checkbox", { name: "Select all pending actions" }).check();

    await page.getByRole("button", { name: "Deny selected" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Deny 3 actions")).toBeVisible({
      timeout: 5_000,
    });
    await dialog.locator("#reason-dialog-reason").fill("Policy review");
    await dialog.getByRole("button", { name: "Deny 3" }).click();

    // Bulk failure summary renders inside the dialog. Format from
    // bulkFailureSummary: "1 of 3 denials failed: 1× Internal server error (ID: req_…)".
    await expect(
      dialog.getByText(/1 of 3 denials failed:/),
    ).toBeVisible({ timeout: 10_000 });

    // All three deny requests fired with the same reason (server received
    // "Policy review" verbatim for every row — no substitution).
    expect(denyCalls.length).toBe(3);
    for (const call of denyCalls) expect(call.reason).toBe("Policy review");

    // Server state: two rows denied, one untouched (still pending).
    expect(state.get("00000000-0000-0000-0000-000000000001")?.status).toBe(
      "denied",
    );
    expect(state.get("00000000-0000-0000-0000-000000000002")?.status).toBe(
      "pending",
    );
    expect(state.get("00000000-0000-0000-0000-000000000003")?.status).toBe(
      "denied",
    );

    // Close the dialog to see the filtered row list. The failed row stays
    // pending and stays selected — the operator can retry with one click.
    await dialog.getByRole("button", { name: "Cancel" }).click();

    const remainingPending = page
      .getByRole("row")
      .filter({ hasText: "bulk-target-2" });
    await expect(remainingPending).toBeVisible({ timeout: 10_000 });

    // Selection narrowed to the failed row — the Deny-selected button
    // should now say "1 selected" worth.
    await expect(page.getByText(/^1 selected$/)).toBeVisible();
  });
});
