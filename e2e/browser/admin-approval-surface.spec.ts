import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Admin approval rules — surface scoping (#2072) @llm
 *
 * The rule-evaluation behavior (MCP-only rule fires for MCP queries but
 * not chat queries against the same shape) is exercised end-to-end by
 * `ee/src/governance/approval.test.ts` (DB-side filter + acceptance-
 * criteria scenarios) and `packages/api/src/lib/approvals/__tests__/
 * evaluate.test.ts` (pure surface-matching predicate). A true browser-
 * driven "MCP transport queues a request, chat doesn't" path would
 * require a live MCP SDK with DCR-bootstrapping, which we cannot drive
 * headlessly.
 *
 * What this spec covers:
 *   1. The admin sees a Surface column on the rules list.
 *   2. Opening the editor shows the Surface dropdown defaulted to 'any'.
 *   3. Selecting "MCP only" and saving emits a POST whose body includes
 *      `surface: "mcp"` — pinning the wire-layer contract the rule
 *      evaluator's SQL filter relies on.
 *   4. The new row renders with the `mcp` badge so the admin can see at
 *      a glance which rules are surface-scoped.
 *
 * The `@llm` tag opts this spec into the serial worker so the route
 * mocks aren't raced by other specs that also touch admin endpoints.
 */

interface MockApprovalRule {
  id: string;
  orgId: string;
  name: string;
  ruleType: "table" | "column" | "cost";
  pattern: string;
  threshold: number | null;
  enabled: boolean;
  surface: "any" | "chat" | "mcp" | "scheduler" | "slack" | "teams" | "webhook";
  createdAt: string;
  updatedAt: string;
}

function buildFixture(): MockApprovalRule[] {
  return [
    {
      id: "00000000-0000-0000-0000-0000000000a1",
      orgId: "org-1",
      name: "Legacy fires-everywhere rule",
      ruleType: "table",
      pattern: "users",
      threshold: null,
      enabled: true,
      // 'any' is the migration default — preserves the pre-2072 shape.
      surface: "any",
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T10:00:00.000Z",
    },
  ];
}

interface InstalledMocks {
  state: MockApprovalRule[];
  postCalls: Array<{ body: Record<string, unknown> }>;
}

async function installMocks(
  page: Page,
  initial: MockApprovalRule[],
): Promise<InstalledMocks> {
  const state = [...initial];
  const postCalls: Array<{ body: Record<string, unknown> }> = [];

  // GET /admin/approval/rules — list
  await page.route(
    /\/api\/v1\/admin\/approval\/rules(?:\?|$)/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
        postCalls.push({ body });
        const created: MockApprovalRule = {
          id: `00000000-0000-0000-0000-0000000000${(state.length + 1).toString().padStart(2, "b")}`,
          orgId: "org-1",
          name: String(body.name ?? ""),
          ruleType: body.ruleType as "table" | "column" | "cost",
          pattern: typeof body.pattern === "string" ? body.pattern : "",
          threshold: typeof body.threshold === "number" ? body.threshold : null,
          enabled: body.enabled !== false,
          surface: (body.surface as MockApprovalRule["surface"]) ?? "any",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        state.push(created);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ rule: created }),
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
        body: JSON.stringify({ rules: state }),
      });
    },
  );

  // GET /admin/approval/queue — list (empty for this spec)
  await page.route(
    /\/api\/v1\/admin\/approval\/queue(?:\?|$)/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() !== "GET") {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requests: [] }),
      });
    },
  );

  return { state, postCalls };
}

test.describe("Admin approval — surface scoping (#2072) @llm", () => {
  test.describe.configure({ timeout: 45_000 });

  test("Surface column renders in the rules list", async ({ page }) => {
    await installMocks(page, buildFixture());
    await page.goto("/admin/approval");

    await expect(page.locator("h1", { hasText: "Approval Workflows" })).toBeVisible({
      timeout: 15_000,
    });
    // The new column header.
    await expect(page.getByRole("columnheader", { name: "Surface" })).toBeVisible();
    // The seeded `any` rule renders its surface badge — exact 'any'
    // text confirms the lower-case enum value reaches the table cell.
    await expect(page.getByRole("cell", { name: "any" }).first()).toBeVisible();
  });

  test("admin creates an MCP-only rule and the wire body carries surface: 'mcp'", async ({
    page,
  }) => {
    const { postCalls } = await installMocks(page, buildFixture());
    await page.goto("/admin/approval");

    await expect(page.locator("h1", { hasText: "Approval Workflows" })).toBeVisible({
      timeout: 15_000,
    });

    // Open the editor.
    await page.getByRole("button", { name: "Add rule" }).click();

    // Fill the basics.
    await page.getByLabel("Rule Name").fill("MCP-only PII gate");

    // Surface dropdown — pick MCP only.
    await page.getByRole("combobox", { name: "Approval rule surface" }).click();
    await page.getByRole("option", { name: /MCP only/ }).click();

    // Pattern (table rule type is the default — keep it).
    await page.getByLabel("Table Name").fill("customers");

    // Submit.
    await page.getByRole("button", { name: "Create Rule" }).click();

    // The route mock recorded the POST — assert the wire-level contract.
    await expect.poll(() => postCalls.length).toBeGreaterThan(0);
    const lastBody = postCalls[postCalls.length - 1]!.body;
    expect(lastBody).toMatchObject({
      name: "MCP-only PII gate",
      ruleType: "table",
      pattern: "customers",
      surface: "mcp",
    });

    // The new row should render with the mcp badge.
    await expect(page.getByRole("cell", { name: "mcp" })).toBeVisible({ timeout: 5_000 });
  });
});
