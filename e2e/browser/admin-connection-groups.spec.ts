import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Browser e2e for the connection-groups admin surface — happy path:
 * create → assign two connections → rename → delete-empty. Uses page-
 * level route mocks (mirrors `admin-cache.spec.ts` and
 * `admin-sessions.spec.ts`) so the spec is self-contained — the mock
 * state machine recomputes each connection's `groupId` from the
 * assignment map on every GET so refetches reflect prior mutations.
 *
 * Tagged `@llm` to match the milestone's segmentation convention even
 * though no model call is made; CI tier selectors that key on `@llm`
 * still pick this up alongside the other admin-flow e2es.
 */

interface MockGroup {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface MockConnection {
  id: string;
  dbType: string;
  description: string | null;
}

interface MockState {
  groups: Map<string, MockGroup>;
  connections: MockConnection[];
  groupIdByConnection: Map<string, string | null>;
}

function buildState(): MockState {
  return {
    groups: new Map(),
    connections: [
      { id: "us-int", dbType: "postgres", description: "US internal" },
      { id: "eu", dbType: "postgres", description: "EU replica" },
      { id: "apac", dbType: "postgres", description: "APAC replica" },
    ],
    groupIdByConnection: new Map([
      ["us-int", null],
      ["eu", null],
      ["apac", null],
    ]),
  };
}

function serializeGroup(group: MockGroup, state: MockState) {
  let memberCount = 0;
  for (const groupId of state.groupIdByConnection.values()) {
    if (groupId === group.id) memberCount++;
  }
  return { ...group, memberCount };
}

async function installMocks(page: Page, state: MockState): Promise<void> {
  // Catch-all for the list + per-id endpoints. Single handler keeps the
  // state machine in one place; the route-mock pattern aborts unexpected
  // methods so a regression to the wrong verb fails loudly in CI.
  await page.route(/\/api\/v1\/admin\/connection-groups(?:\/.*)?$/, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const pathname = url.pathname;
    const match = pathname.match(/\/connection-groups(?:\/([^/]+))?(\/members)?$/);
    const groupId = match?.[1];
    const isMembers = Boolean(match?.[2]);

    if (!groupId && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          groups: [...state.groups.values()]
            .map((g) => serializeGroup(g, state))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }),
      });
      return;
    }

    if (!groupId && method === "POST") {
      const body = req.postDataJSON() as { name: string };
      const name = String(body.name ?? "").trim();
      const conflict = [...state.groups.values()].some((g) => g.name === name);
      if (conflict) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "conflict", message: "duplicate" }),
        });
        return;
      }
      const id = `g_${name.replace(/\W+/g, "_").toLowerCase()}`;
      const now = new Date().toISOString();
      state.groups.set(id, { id, name, createdAt: now, updatedAt: now });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(serializeGroup(state.groups.get(id)!, state)),
      });
      return;
    }

    if (groupId && isMembers && method === "POST") {
      const body = req.postDataJSON() as { connectionId: string; unassign?: boolean };
      state.groupIdByConnection.set(body.connectionId, body.unassign ? null : groupId);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connectionId: body.connectionId,
          groupId: body.unassign ? null : groupId,
        }),
      });
      return;
    }

    if (groupId && method === "PATCH") {
      const body = req.postDataJSON() as { name: string };
      const existing = state.groups.get(groupId);
      if (!existing) {
        await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
        return;
      }
      existing.name = String(body.name).trim();
      existing.updatedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(serializeGroup(existing, state)),
      });
      return;
    }

    if (groupId && method === "DELETE") {
      const memberCount = [...state.groupIdByConnection.values()].filter(
        (v) => v === groupId,
      ).length;
      if (memberCount > 0) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "conflict", message: "has members" }),
        });
        return;
      }
      state.groups.delete(groupId);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    await route.abort("failed");
  });

  // Connections list — page reads `groupId` per row so the ungrouped
  // pool reflects assignment changes between mutations.
  await page.route(/\/api\/v1\/admin\/connections(?:\?|$)/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connections: state.connections.map((c) => ({
          ...c,
          groupId: state.groupIdByConnection.get(c.id) ?? null,
        })),
      }),
    });
  });
}

test.describe("admin connection groups", () => {
  test("@llm create → assign two → rename → delete empty group", async ({ page }) => {
    const state = buildState();
    await installMocks(page, state);

    await page.goto("/admin/connections/groups");
    await expect(page.getByRole("heading", { name: /Environments/i })).toBeVisible();

    // Empty state — no groups yet.
    await expect(page.getByText(/No environments yet/i)).toBeVisible();

    // Create the first group.
    await page.getByTestId("env-create").click();
    await page.getByTestId("env-create-name").fill("prod");
    await page.getByTestId("env-create-submit").click();
    await expect(page.getByTestId("env-card-g_prod")).toBeVisible();

    // Assign the first connection. The page renders a Radix Select for
    // ungrouped connections — open it and pick the option.
    const card = page.getByTestId("env-card-g_prod");
    await card.getByTestId("env-add-trigger-g_prod").click();
    await page.getByRole("option", { name: "us-int" }).click();
    await expect(page.getByTestId("env-member-g_prod-us-int")).toBeVisible();

    // Assign the second connection.
    await card.getByTestId("env-add-trigger-g_prod").click();
    await page.getByRole("option", { name: "eu" }).click();
    await expect(page.getByTestId("env-member-g_prod-eu")).toBeVisible();

    // Rename "prod" → "production".
    await page.getByTestId("env-rename-g_prod").click();
    const renameInput = page.getByTestId("env-rename-input");
    await renameInput.fill("production");
    await page.getByTestId("env-rename-submit").click();
    await expect(card.getByText("production")).toBeVisible();

    // Delete must be rejected while the group has members — the icon
    // button is disabled by the page when memberCount > 0.
    await expect(page.getByTestId("env-delete-g_prod")).toBeDisabled();

    // Move both members back out before deletion.
    await card.getByRole("button", { name: /Remove us-int/i }).click();
    await expect(page.getByTestId("env-member-g_prod-us-int")).not.toBeVisible();
    await card.getByRole("button", { name: /Remove eu/i }).click();
    await expect(page.getByTestId("env-member-g_prod-eu")).not.toBeVisible();

    // Now the delete is allowed.
    await expect(page.getByTestId("env-delete-g_prod")).toBeEnabled();
    await page.getByTestId("env-delete-g_prod").click();
    await page.getByTestId("env-delete-confirm").click();
    await expect(page.getByTestId("env-card-g_prod")).not.toBeVisible();
    await expect(page.getByText(/No environments yet/i)).toBeVisible();
  });
});
