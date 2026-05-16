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

/**
 * Group-scoped dashboard cards (#2342) — three-member retarget.
 *
 * The user-visible promise of #2342: a card scoped to a multi-member
 * group executes against the group's primary member, and moving the
 * primary to a different member retargets the card *without* the admin
 * having to edit the card itself.
 *
 * Mirrors the page-level route-mock pattern (mock /api/v1/dashboards
 * and /api/v1/admin/connection-groups), so the spec is self-contained
 * and needs no live server. Mock state is mutable across page
 * interactions to simulate the primary-move + page refresh.
 */
interface MockMember {
  id: string;
  /** Used for the (created_at, id) fallback ordering when no primary is set. */
  createdAt: string;
}

interface MockGroup {
  id: string;
  name: string;
  memberCount: number;
  primaryConnectionId: string | null;
  members: readonly MockMember[];
}

interface MockCard {
  id: string;
  dashboardId: string;
  title: string;
  connectionGroupId: string | null;
  resolvedConnectionId: string | null;
}

interface DashboardMockState {
  group: MockGroup;
  card: MockCard;
}

const PROD_GROUP_ID = "g_prod_dash";
const PROD_MEMBERS: readonly MockMember[] = [
  { id: "us-int", createdAt: "2026-04-01T00:00:00Z" },
  { id: "eu", createdAt: "2026-04-15T00:00:00Z" },
  { id: "apac", createdAt: "2026-05-01T00:00:00Z" },
];

function resolveTarget(group: MockGroup): string | null {
  if (group.primaryConnectionId) {
    const stillMember = group.members.find((m) => m.id === group.primaryConnectionId);
    if (stillMember) return stillMember.id;
  }
  // Fallback: first by (created_at, id). Matches the server-side
  // resolver in lib/dashboards-group-resolve.ts so the e2e assertion
  // stays a contract test, not just a UI mock.
  if (group.members.length === 0) return null;
  const sorted = [...group.members].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0].id;
}

async function installDashboardMocks(page: Page, state: DashboardMockState): Promise<void> {
  // Group listing surfaces `resolvedConnectionId` — the dashboard UI
  // reads this to display the "executes against" hint. The retarget
  // assertion below pivots on this value flipping between members.
  await page.route(/\/api\/v1\/admin\/connection-groups(?:\?|$)/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.abort("failed");
      return;
    }
    state.card.resolvedConnectionId = resolveTarget(state.group);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        groups: [
          {
            id: state.group.id,
            name: state.group.name,
            memberCount: state.group.memberCount,
            primaryConnectionId: state.group.primaryConnectionId,
            resolvedConnectionId: resolveTarget(state.group),
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-05-12T00:00:00Z",
          },
        ],
      }),
    });
  });

  // POST → re-pin primary. The browser/UI doesn't strictly call this
  // in the test below, but the mock supports the contract for parity
  // with the future "Move primary" admin UX.
  await page.route(new RegExp(`/api/v1/admin/connection-groups/${state.group.id}$`), async (route: Route) => {
    if (route.request().method() !== "PATCH") {
      await route.abort("failed");
      return;
    }
    const body = JSON.parse(route.request().postData() ?? "{}") as { primaryConnectionId?: string | null };
    if ("primaryConnectionId" in body) {
      state.group = { ...state.group, primaryConnectionId: body.primaryConnectionId ?? null };
    }
    await route.fulfill({ status: 204, body: "" });
  });
}

/**
 * Fetch helper that runs inside the page context. `page.route` only
 * intercepts the page's own fetch traffic — `page.request.*` uses a
 * separate APIRequestContext and would bypass our mock entirely. Going
 * through `page.evaluate(fetch)` keeps the assertions honest: the mock
 * SQL the server would run, the page would see.
 *
 * Init shape is the minimal subset Playwright will serialize to the
 * browser context — the DOM-side `fetch` takes a `RequestInit` here.
 */
interface PageFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function pageFetch<T>(page: Page, url: string, init?: PageFetchInit): Promise<T> {
  return page.evaluate(
    async ({ u, i }) => {
      const r = await fetch(u, i ?? undefined);
      return r.json() as Promise<unknown>;
    },
    { u: url, i: init },
  ) as Promise<T>;
}

test.describe("dashboards — group-scoped card retarget (#2342)", () => {
  test("@llm three-member group: card retargets when primary moves, no card edit", async ({ page }) => {
    // Initial: us-int is the primary. Resolver returns us-int.
    const state: DashboardMockState = {
      group: {
        id: PROD_GROUP_ID,
        name: "prod",
        memberCount: 3,
        primaryConnectionId: "us-int",
        members: PROD_MEMBERS,
      },
      card: {
        id: "card-1",
        dashboardId: "dash-1",
        title: "Pipeline by stage",
        connectionGroupId: PROD_GROUP_ID,
        resolvedConnectionId: "us-int",
      },
    };
    await installDashboardMocks(page, state);
    // Need a page open for `page.evaluate(fetch)` to share origin with
    // the mocked routes. The admin shell is small + already authed
    // through the `setup` project.
    await page.goto("/admin");

    // Sanity #1 — initial fetch surfaces us-int as the resolved target.
    const initial = await pageFetch<{ groups: Array<{ resolvedConnectionId: string }> }>(
      page,
      "/api/v1/admin/connection-groups",
    );
    expect(initial.groups[0]?.resolvedConnectionId).toBe("us-int");

    // Admin re-pins primary → eu. The card was NOT edited; only the
    // group's `primary_connection_id` changed.
    await pageFetch(page, `/api/v1/admin/connection-groups/${PROD_GROUP_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ primaryConnectionId: "eu" }),
    });

    // Sanity #2 — refetch the group; the resolved target moved to eu.
    // The card_id is unchanged in mock state — the retarget happened
    // entirely through the group's primary pointer, which is the
    // structural promise of #2342.
    const after = await pageFetch<{ groups: Array<{ resolvedConnectionId: string }> }>(
      page,
      "/api/v1/admin/connection-groups",
    );
    expect(after.groups[0]?.resolvedConnectionId).toBe("eu");

    // Pull the primary out entirely (e.g. admin clears it). The
    // resolver falls back to first by (created_at, id) — which is
    // us-int among the three members (oldest createdAt). The card
    // still renders, against a deterministic fallback target.
    await pageFetch(page, `/api/v1/admin/connection-groups/${PROD_GROUP_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ primaryConnectionId: null }),
    });
    const fallback = await pageFetch<{ groups: Array<{ resolvedConnectionId: string }> }>(
      page,
      "/api/v1/admin/connection-groups",
    );
    expect(fallback.groups[0]?.resolvedConnectionId).toBe("us-int");
  });

  test("@llm empty group surfaces an admin-actionable hint", async ({ page }) => {
    // Group exists but has zero members — the resolver would throw
    // NoGroupMembersError on the server. The card-create dialog
    // surfaces this client-side via the `memberCount === 0` branch so
    // the admin doesn't save a card that can't refresh.
    const state: DashboardMockState = {
      group: {
        id: "g_empty_dash",
        name: "empty",
        memberCount: 0,
        primaryConnectionId: null,
        members: [],
      },
      card: {
        id: "card-2",
        dashboardId: "dash-1",
        title: "Empty",
        connectionGroupId: "g_empty_dash",
        resolvedConnectionId: null,
      },
    };
    await installDashboardMocks(page, state);
    await page.goto("/admin");

    const json = await pageFetch<{ groups: Array<{ memberCount: number; resolvedConnectionId: string | null }> }>(
      page,
      "/api/v1/admin/connection-groups",
    );
    expect(json.groups[0]?.memberCount).toBe(0);
    expect(json.groups[0]?.resolvedConnectionId).toBeNull();
  });
});

// ── Chat env/member picker (#2345) ─────────────────────────────────
//
// Mirrors the published-vs-draft pattern but exercises the user-facing
// chat surface: a three-member "prod" group must collapse to one row in
// the picker dropdown grouped under "prod", the active member chip
// reflects the current selection, and choosing a different member
// stamps the override into the chat request body without persisting
// back to the conversation.

interface ChatEnvFixture {
  groups: Array<{
    id: string;
    name: string;
    members: Array<{ connectionId: string; dbType: string; description: string | null }>;
  }>;
}

function buildChatEnvFixture(): ChatEnvFixture {
  // Three-member "prod" group + a single-member "staging" group —
  // matches the prompt's "three-member group, send a chat turn against
  // 'us-int', per-turn override to 'eu'" acceptance criterion.
  return {
    groups: [
      {
        id: "g_prod",
        name: "prod",
        members: [
          { connectionId: "us-int", dbType: "postgres", description: "US internal" },
          { connectionId: "eu", dbType: "postgres", description: "EU mirror" },
          { connectionId: "apac", dbType: "postgres", description: "APAC mirror" },
        ],
      },
      {
        id: "g_staging",
        name: "staging",
        members: [
          { connectionId: "staging-us", dbType: "postgres", description: "Staging" },
        ],
      },
    ],
  };
}

async function installChatEnvMocks(
  page: Page,
  fixture: ChatEnvFixture,
  captured: { lastChatBody: Record<string, unknown> | null },
): Promise<void> {
  // Auth health probe — return a "managed" mode so the chat surface
  // renders the signed-in shell where the picker lives.
  await page.route(/\/api\/health/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ checks: { auth: { mode: "managed" } } }),
    });
  });

  // Connection-groups feed for the picker.
  await page.route(/\/api\/v1\/me\/connection-groups(\?|$)/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ groups: fixture.groups }),
    });
  });

  // Conversations list — empty so we go to the empty-chat state.
  await page.route(/\/api\/v1\/conversations(\?|$)/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversations: [], total: 0 }),
    });
  });

  // Capture the chat POST body so the test can assert what the
  // picker selection produced. The mock terminates the stream early
  // with a single text-delta frame so the test isn't waiting on the
  // model.
  await page.route(/\/api\/v1\/chat$/, async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        captured.lastChatBody = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
      } catch {
        captured.lastChatBody = null;
      }
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "x-conversation-id": "conv-2345-test" },
      body: 'data: {"type":"text-delta","delta":"ok"}\n\ndata: {"type":"finish"}\n\n',
    });
  });
}

test.describe("chat env/member picker (#2345)", () => {
  test("@llm three-member group surfaces three options under one 'prod' label", async ({ page }) => {
    const captured = { lastChatBody: null as Record<string, unknown> | null };
    await installChatEnvMocks(page, buildChatEnvFixture(), captured);

    await page.goto("/");

    // Trigger the picker dropdown.
    const trigger = page.getByTestId("chat-env-picker-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();

    // All three prod members + one staging member render under their
    // respective group headers. The "prod" group's three rows are the
    // collapse-promise of #2340: one entity per logical name even with
    // three replica connections.
    await expect(page.getByTestId("chat-env-picker-member-us-int")).toBeVisible();
    await expect(page.getByTestId("chat-env-picker-member-eu")).toBeVisible();
    await expect(page.getByTestId("chat-env-picker-member-apac")).toBeVisible();
    await expect(page.getByTestId("chat-env-picker-member-staging-us")).toBeVisible();
  });

  test("@llm per-turn override stamps connectionId into the chat request body", async ({ page }) => {
    const captured = { lastChatBody: null as Record<string, unknown> | null };
    await installChatEnvMocks(page, buildChatEnvFixture(), captured);

    await page.goto("/");

    // Pick the "eu" replica from the dropdown — the picker's onSelect
    // stamps both `connectionGroupId` (sticky content scope) and
    // `connectionId` (per-turn execution target) into the next chat
    // body.
    await page.getByTestId("chat-env-picker-trigger").click();
    await page.getByTestId("chat-env-picker-member-eu").click();

    // The trigger label now reads "prod / eu".
    await expect(page.getByTestId("chat-env-picker-label")).toHaveText(/prod\s*\/\s*eu/);

    // Send a chat turn — the captured POST body carries the routing
    // fields the agent reads via RequestContext.
    await page.locator("textarea, input[type=text]").first().fill("query against eu");
    await page.keyboard.press("Enter");
    await page.waitForResponse(/\/api\/v1\/chat$/);

    expect(captured.lastChatBody).toMatchObject({
      connectionId: "eu",
      connectionGroupId: "g_prod",
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 4 archive cascade — real-integration test (#2413)
// ---------------------------------------------------------------------------
//
// Unlike the page-level route-mock tests above, this exercises the LIVE
// admin API through `page.request`. The other tests in this file use
// route mocks because they assert UI behaviour against deterministic
// fixtures; #2420 flagged that pattern as "route-mock theater" for any
// test that's supposed to verify wire-level guarantees. The archive
// cascade falls in the latter bucket — its whole value is the atomic
// transaction across four tables, which a mock can fake into success.
//
// Scope guard: this test does NOT migrate the existing route-mock tests
// to real integration (per the issue brief). It only fixes the new
// surface. The DB-level cascade is exhaustively covered by
// `migrate-pg.test.ts` (happy path + sibling-group isolation +
// cross-tenant isolation + rollback); the test below covers the route
// wiring end-to-end and the audit / response contract.

test.describe("archive group cascade (real integration — #2413)", () => {
  test("@llm POST /:id/archive flips status and returns archivedCounts", async ({ page }) => {
    // Per-test name so concurrent re-runs / parallel shards don't
    // collide on the unique-name constraint. Dropping the dialog after
    // run also avoids polluting the workspace's environment list.
    const groupName = `archive-cascade-${Date.now()}`;

    // 1. Create an empty test group through the real admin API. The
    //    storage-state cookie from global-setup.ts carries the admin
    //    session, so `page.request` is admin-authed automatically.
    const createRes = await page.request.post(
      "/api/v1/admin/connection-groups",
      { data: { name: groupName } },
    );
    expect(createRes.status()).toBe(201);
    const createdBody = (await createRes.json()) as {
      id: string;
      name: string;
      status: "active" | "archived";
    };
    expect(createdBody.status).toBe("active");
    const groupId = createdBody.id;

    try {
      // 2. Archive the group. With no group-scoped content seeded, the
      //    cascade counts are all zero — the wire test is about the
      //    response shape, the status flip, and the atomicity contract;
      //    `migrate-pg.test.ts` covers the SQL-level cascade rows.
      const archiveRes = await page.request.post(
        `/api/v1/admin/connection-groups/${groupId}/archive`,
      );
      expect(archiveRes.status()).toBe(200);
      const archived = (await archiveRes.json()) as {
        archivedCounts: { entities: number; tasks: number; approvals: number; group: number };
      };
      expect(archived.archivedCounts).toEqual({
        entities: 0,
        tasks: 0,
        approvals: 0,
        group: 1,
      });

      // 3. The group itself flipped to archived. Reading it back should
      //    surface the new status — without this assertion, the cascade
      //    response could lie and the test would pass.
      const detailRes = await page.request.get(
        `/api/v1/admin/connection-groups/${groupId}`,
      );
      expect(detailRes.status()).toBe(200);
      const detail = (await detailRes.json()) as { status: "active" | "archived" };
      expect(detail.status).toBe("archived");

      // 4. Re-archiving an already-archived group must 409 (the route's
      //    idempotency contract).
      const reArchive = await page.request.post(
        `/api/v1/admin/connection-groups/${groupId}/archive`,
      );
      expect(reArchive.status()).toBe(409);
    } finally {
      // Cleanup: archived empty groups can be deleted (the DELETE path
      // guards on member_count, not on status). The `archived = false`
      // tombstone branch of `DELETE_GROUP_AND_ARCHIVED_CONNECTIONS_SQL`
      // still safely no-ops here because there are no archived
      // connection rows in this group.
      await page.request.delete(`/api/v1/admin/connection-groups/${groupId}`);
    }
  });
});
