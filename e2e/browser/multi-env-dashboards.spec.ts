import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  adminDelete,
  adminGet,
  adminPost,
  createAdminRequestContext,
  requireSeededGroups,
} from "./lib/multi-env-helpers";

/**
 * Real-API e2e — multi-group dashboard card flow (#2443 deferred item).
 *
 * Asserts the post-1.4.4 contract that #2443's manual walkthrough couldn't
 * meaningfully exercise on a single-group env:
 *
 *   1. Card add on a multi-group workspace requires `connectionGroupId`;
 *      the value round-trips to the persisted row.
 *   2. Cards bound to a group survive that group's archive (PR #2440 made
 *      this intentional — cards keep their pointer and the group's archived
 *      state surfaces at view time rather than mass-flipping rows).
 *   3. The cross-org write gate (#2424) returns the documented
 *      `invalid_connection_group` discriminator, not a 5xx FK leak.
 *
 * Companion to the unit coverage in `dashboards.test.ts`; the value of this
 * layer is "everything wired together" — auth + admin route + DB + the
 * archived-state-at-view-time read path are exercised in one sweep.
 */

const TEST_DASHBOARD_TITLE = "rt-multi-env-dashboards";

interface DashboardRow {
  id: string;
  title: string;
}
interface ListDashboardsResp { dashboards: DashboardRow[] }
interface CardRow {
  id: string;
  dashboardId: string;
  title: string;
  connectionGroupId: string | null;
}

test.describe("multi-env dashboards — group-scoped cards + archive read-path", () => {
  test.use({ baseURL: undefined });

  // Sign in once per file (Better Auth's 10/60s sign-in budget would
  // otherwise rate-limit a per-test auth). Shared `request` carries the
  // admin's cookies for every test below.
  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await createAdminRequestContext(playwright);
  });

  test.afterAll(async () => {
    await request?.dispose();
  });

  test.beforeEach(async () => {
    // Clean any stale rows from a previous run — best-effort, never throws.
    const list = await adminGet<ListDashboardsResp>(request, "/api/v1/dashboards");
    for (const d of list.body?.dashboards ?? []) {
      if (d.title === TEST_DASHBOARD_TITLE) {
        await adminDelete(request, `/api/v1/dashboards/${d.id}`);
      }
    }
  });

  test("card-create binds to the picked group and the value round-trips (#2419)", async () => {
    const { prod } = await requireSeededGroups(request);

    const created = await adminPost<DashboardRow>(request, "/api/v1/dashboards", {
      title: TEST_DASHBOARD_TITLE,
    });
    expect(created.status, created.rawText).toBe(201);
    const dashId = created.body!.id;

    try {
      const card = await adminPost<CardRow>(request, `/api/v1/dashboards/${dashId}/cards`, {
        title: "Customers — prod",
        sql: "SELECT COUNT(*) AS c FROM customers",
        connectionGroupId: prod.id,
      });
      expect(card.status, card.rawText).toBe(201);
      expect(card.body?.connectionGroupId, "card must persist its group pointer").toBe(prod.id);
    } finally {
      await adminDelete(request, `/api/v1/dashboards/${dashId}`);
    }
  });

  test("cross-org connectionGroupId rejected with 400 invalid_connection_group (#2424)", async () => {
    await requireSeededGroups(request);

    const created = await adminPost<DashboardRow>(request, "/api/v1/dashboards", {
      title: TEST_DASHBOARD_TITLE,
    });
    expect(created.status).toBe(201);
    const dashId = created.body!.id;

    try {
      const card = await adminPost<{ error: string }>(request, `/api/v1/dashboards/${dashId}/cards`, {
        title: "spoofed",
        sql: "SELECT 1",
        connectionGroupId: "g_does_not_exist_other_org",
      });
      expect(card.status, "cross-org pointer must 400 not 500").toBe(400);
      expect(card.body?.error).toBe("invalid_connection_group");
    } finally {
      await adminDelete(request, `/api/v1/dashboards/${dashId}`);
    }
  });

  test("archive cascade intentionally preserves card pointer for view-time surfacing (PR #2440)", async () => {
    // PR #2440 explicitly skipped `dashboard_cards` from the archive cascade
    // (the read path renders the archived state instead). Assert the
    // post-archive card row still carries its `connectionGroupId` so the
    // dashboards view layer has the signal it needs to render the
    // "environment archived" state. A regression that mass-flipped cards
    // or null'd their pointer would surface here.

    const throwawayName = `rt-arc-${Date.now()}`;
    const group = await adminPost<{ id: string; name: string }>(
      request,
      "/api/v1/admin/connection-groups",
      { name: throwawayName },
    );
    expect(group.status, group.rawText).toBe(201);
    const groupId = group.body!.id;

    const created = await adminPost<DashboardRow>(request, "/api/v1/dashboards", {
      title: TEST_DASHBOARD_TITLE,
    });
    expect(created.status).toBe(201);
    const dashId = created.body!.id;

    let cardId: string | null = null;
    try {
      const card = await adminPost<CardRow>(request, `/api/v1/dashboards/${dashId}/cards`, {
        title: "card-bound-to-archived",
        sql: "SELECT 1",
        connectionGroupId: groupId,
      });
      expect(card.status, card.rawText).toBe(201);
      cardId = card.body!.id;
      expect(card.body?.connectionGroupId).toBe(groupId);

      // Archive the group — the cascade body documents the intentional skip
      // for dashboard_cards. We assert the API call succeeds AND the card
      // row still carries the pointer afterwards.
      const archived = await adminPost<{ archivedCounts?: Record<string, number> }>(
        request,
        `/api/v1/admin/connection-groups/${groupId}/archive`,
        {},
      );
      expect(archived.status, archived.rawText).toBe(200);

      const refetched = await adminGet<DashboardRow & { cards: CardRow[] }>(
        request,
        `/api/v1/dashboards/${dashId}`,
      );
      expect(refetched.status).toBe(200);
      const cards = refetched.body?.cards ?? [];
      const ours = cards.find((c) => c.id === cardId);
      expect(ours, "card must still exist post-archive (PR #2440 contract)").toBeDefined();
      expect(ours?.connectionGroupId, "pointer preserved so view-layer can surface 'archived'")
        .toBe(groupId);
    } finally {
      if (cardId) {
        await adminDelete(request, `/api/v1/dashboards/${dashId}/cards/${cardId}`);
      }
      await adminDelete(request, `/api/v1/dashboards/${dashId}`);
      await adminDelete(request, `/api/v1/admin/connection-groups/${groupId}`);
    }
  });
});
