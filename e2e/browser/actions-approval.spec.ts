import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Admin actions approval — covers the Deny-with-reason flow end-to-end.
 *
 * The flow is the single piece of admin UX that writes to the compliance-
 * relevant audit trail on every click, and until #1593 had zero e2e
 * coverage. A regression in the reason-passthrough (e.g. dropping the
 * trimmed reason and substituting a hardcoded default) would silently
 * corrupt the audit log without any existing test catching it.
 *
 * Design note: the spec mocks `/api/v1/actions*` endpoints at the page
 * level rather than seeding real DB rows — mirrors the admin-sessions
 * pattern (see `admin-sessions.spec.ts` for rationale). Two reasons:
 *   1. Seeding a pending action against a real backend requires a
 *      dev-only admin route that doesn't exist today. Adding one just
 *      for e2e would widen the attack surface.
 *   2. Deterministic deny-body assertion is the core of this spec —
 *      intercepting the request lets us pin the exact body shape the
 *      page sends (reason included, not substituted).
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

function buildPendingAction(): MockAction {
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
  };
}

interface InstalledMocks {
  /** Shared mutable state so tests can assert final ordering. */
  state: Map<string, MockAction>;
  /** Reason captured by the deny mock — null until a deny POST arrives. */
  lastDenyReason: { value: string | null };
}

/**
 * Mock the three routes the admin actions page hits.
 *   - GET /api/v1/actions?status=…    → filtered list
 *   - POST /api/v1/actions/:id/approve → 200 { result }
 *   - POST /api/v1/actions/:id/deny    → 200, captures body.reason
 *
 * Non-matching methods on the id path `route.abort` rather than fall
 * through, so an unexpected request is a loud failure in CI.
 */
async function installActionMocks(page: Page): Promise<InstalledMocks> {
  const state = new Map<string, MockAction>();
  state.set("00000000-0000-0000-0000-0000000000aa", buildPendingAction());
  const lastDenyReason: { value: string | null } = { value: null };

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
          return {};
        }
      })();
      lastDenyReason.value =
        typeof body.reason === "string" ? body.reason : "";
      action.status = "denied";
      action.resolved_at = "2026-04-19T12:05:00.000Z";
      action.approved_by = "admin@useatlas.dev";
      action.denial_reason = lastDenyReason.value;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "denied",
          actionId: id,
          reason: lastDenyReason.value,
        }),
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

  return { state, lastDenyReason };
}

test.describe("Admin actions approval @llm", () => {
  test.describe.configure({ timeout: 45_000 });

  test("operator denies a pending action with a reason; row moves to Denied and the reason is sent to the server", async ({
    page,
  }) => {
    const { state, lastDenyReason } = await installActionMocks(page);

    // 1. Navigate to /admin/actions (default status filter is "pending").
    await page.goto("/admin/actions");
    await expect(page.locator("h1", { hasText: "Actions" })).toBeVisible({
      timeout: 15_000,
    });

    // 2. Row renders in the Pending list. The summary is the distinctive
    //    text we scope the row lookup to.
    const pendingRow = page
      .getByRole("row")
      .filter({ hasText: "UPDATE orders SET status='cancelled'" });
    await expect(pendingRow).toBeVisible({ timeout: 10_000 });

    // 3. Open the deny dialog from the row-level "Deny action" button.
    //    Two deny buttons can render (row + expanded detail); scoping to
    //    the row is important for stability.
    const denyRowButton = pendingRow.getByRole("button", {
      name: "Deny action",
    });
    await denyRowButton.click();

    // 4. Dialog appears, fill the reason, confirm.
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Deny action")).toBeVisible({
      timeout: 5_000,
    });
    await dialog.locator("#reason-dialog-reason").fill("Conflicts with policy");
    await dialog.getByRole("button", { name: "Deny" }).click();

    // 5. Assert the server received the reason verbatim — this is the
    //    compliance-sensitive assertion. A regression that substituted
    //    `reason || "Denied by admin"` (the bug #1592 fixed) would fail
    //    this check.
    await expect
      .poll(() => lastDenyReason.value, { timeout: 10_000 })
      .toBe("Conflicts with policy");

    // 6. Row leaves Pending tab.
    await expect(pendingRow).toHaveCount(0, { timeout: 10_000 });

    // 7. Switch to Denied filter — row appears there.
    await page.getByRole("button", { name: "Denied" }).click();
    const deniedRow = page
      .getByRole("row")
      .filter({ hasText: "UPDATE orders SET status='cancelled'" });
    await expect(deniedRow).toBeVisible({ timeout: 10_000 });

    // 8. Audit-log equivalent: server state reflects the actor + reason
    //    on the row. The admin_actions audit table would be written by
    //    the same transaction the route handler uses; asserting on the
    //    mock's captured state exercises the wire contract the page
    //    depends on for the audit trail.
    const finalAction = state.get("00000000-0000-0000-0000-0000000000aa");
    expect(finalAction?.status).toBe("denied");
    expect(finalAction?.approved_by).toBe("admin@useatlas.dev");
    expect(finalAction?.denial_reason).toBe("Conflicts with policy");
  });
});
