import { describe, expect, mock, test } from "bun:test";

mock.module("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error("NEXT_REDIRECT") as Error & { url: string };
    err.url = url;
    throw err;
  },
}));

const ActionLogRedirect = (await import("../../app/admin/action-log/page")).default;
const TokenUsageRedirect = (await import("../../app/admin/token-usage/page")).default;
const McpRedirect = (await import("../../app/admin/settings/mcp/page")).default;

async function captureRedirect(
  fn: (args: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<unknown>,
  params: Record<string, string | string[] | undefined>,
): Promise<string | undefined> {
  try {
    await fn({ searchParams: Promise.resolve(params) });
  } catch (err) {
    return (err as { url?: string }).url;
  }
  return undefined;
}

describe("admin redirects forward query params", () => {
  test("/admin/action-log → /admin/audit?tab=actions with filters preserved", async () => {
    const url = await captureRedirect(ActionLogRedirect, {
      actor: "alice@example.com",
      actionType: "settings.update",
      from: "2026-01-01",
      page: "3",
    });
    expect(url).toBeDefined();
    const parsed = new URL(`http://x${url}`);
    // Tab is the only param we set ourselves; the rest come from the legacy URL.
    expect(parsed.pathname).toBe("/admin/audit");
    expect(parsed.searchParams.get("tab")).toBe("actions");
    expect(parsed.searchParams.get("actor")).toBe("alice@example.com");
    expect(parsed.searchParams.get("actionType")).toBe("settings.update");
    expect(parsed.searchParams.get("from")).toBe("2026-01-01");
    expect(parsed.searchParams.get("page")).toBe("3");
  });

  test("/admin/action-log ignores a stale ?tab= and uses the canonical 'actions' value", async () => {
    // If a user hand-edits ?tab=log on the legacy URL, the consolidated
    // page must still land on the actions tab — otherwise the legacy URL
    // could route into a tab that didn't exist on the original page.
    const url = await captureRedirect(ActionLogRedirect, { tab: "log", actor: "alice" });
    const parsed = new URL(`http://x${url}`);
    expect(parsed.searchParams.getAll("tab")).toEqual(["actions"]);
    expect(parsed.searchParams.get("actor")).toBe("alice");
  });

  test("/admin/token-usage → /admin/usage?tab=tokens with date range preserved", async () => {
    const url = await captureRedirect(TokenUsageRedirect, {
      from: "2026-01-01",
      to: "2026-01-31",
    });
    const parsed = new URL(`http://x${url}`);
    expect(parsed.pathname).toBe("/admin/usage");
    expect(parsed.searchParams.get("tab")).toBe("tokens");
    expect(parsed.searchParams.get("from")).toBe("2026-01-01");
    expect(parsed.searchParams.get("to")).toBe("2026-01-31");
  });

  test("redirect handles array searchParam values (Next allows string | string[])", async () => {
    const url = await captureRedirect(ActionLogRedirect, {
      actor: ["alice", "bob"],
    });
    const parsed = new URL(`http://x${url}`);
    // Both values flatten into repeated `actor=` params.
    expect(parsed.searchParams.getAll("actor")).toEqual(["alice", "bob"]);
  });

  test("/admin/settings/mcp → /admin/settings#setting-ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS", async () => {
    // No legacy params to forward — the MCP page never had any. Just
    // verify the anchor format the consolidated settings page expects.
    const url = await captureRedirect(McpRedirect, {});
    expect(url).toBe("/admin/settings#setting-ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS");
  });
});
