import { describe, expect, test } from "bun:test";
import { navGroups, resolveAdminBreadcrumb } from "../admin-nav";

describe("resolveAdminBreadcrumb", () => {
  test("returns empty crumb on the overview", () => {
    expect(resolveAdminBreadcrumb("/admin")).toEqual({});
  });

  test("default is exact-match — siblings with a shared prefix don't collapse", () => {
    // Semantic Layer parent + Improve Layer child share `/admin/semantic`.
    // Default-exact means each resolves to its own leaf entry.
    expect(resolveAdminBreadcrumb("/admin/semantic")).toEqual({
      section: "Data",
      page: "Semantic Layer",
    });
    expect(resolveAdminBreadcrumb("/admin/semantic/improve")).toEqual({
      section: "Data",
      page: "Improve Layer",
    });
  });

  test("#2176 regression — /admin/settings does not collapse /admin/settings/mcp", () => {
    // /admin/settings and /admin/settings/mcp are sibling leaves; if the
    // parent ever opts into prefixMatch this test fails — that's exactly
    // the bug #2176 shipped.
    expect(resolveAdminBreadcrumb("/admin/settings")).toEqual({
      section: "Configuration",
      page: "Settings",
    });
    expect(resolveAdminBreadcrumb("/admin/settings/mcp")).toEqual({
      section: "Configuration",
      page: "MCP",
    });
  });

  test("prefixMatch respects segment boundaries — sibling routes sharing a prefix don't collapse", () => {
    // Guards the trailing "/" in `pathname.startsWith(item.href + "/")`. Without
    // it, /admin/users would prefix-match any sibling whose path happens to
    // begin with the same letters. A future refactor that drops the "+ "/""
    // would silently reintroduce a #2176-class regression under a new name.
    expect(resolveAdminBreadcrumb("/admin/usersearch")).toEqual({});
    expect(resolveAdminBreadcrumb("/admin/scheduled-tasks-archive")).toEqual({});
  });

  test("prefixMatch: true items match nested child routes", () => {
    // /admin/users has prefixMatch:true so the [id] detail page resolves to
    // the Users entry rather than dropping off the sidebar.
    expect(resolveAdminBreadcrumb("/admin/users")).toEqual({
      section: "Users & Access",
      page: "Users",
    });
    expect(resolveAdminBreadcrumb("/admin/users/abc-123")).toEqual({
      section: "Users & Access",
      page: "Users",
    });
  });

  test("prefixMatch on /admin/scheduled-tasks resolves the /runs subpage", () => {
    expect(resolveAdminBreadcrumb("/admin/scheduled-tasks")).toEqual({
      section: "Monitoring",
      page: "Scheduled Tasks",
    });
    expect(resolveAdminBreadcrumb("/admin/scheduled-tasks/runs")).toEqual({
      section: "Monitoring",
      page: "Scheduled Tasks",
    });
  });

  test("returns empty crumb for an unmapped /admin/* path", () => {
    expect(resolveAdminBreadcrumb("/admin/totally-not-a-route")).toEqual({});
  });

  test("every nav item resolves to its own group/label round-trip", () => {
    // Belt + suspenders: the resolver and the navGroups list must stay in
    // lockstep — adding a new sidebar item without updating the resolver
    // would silently miss the breadcrumb label.
    for (const group of navGroups) {
      for (const item of group.items) {
        const crumb = resolveAdminBreadcrumb(item.href);
        expect(crumb.section).toBe(group.title);
        expect(crumb.page).toBe(item.label);
      }
    }
  });

  test("every nav href has a matching page.tsx on disk (#2305 + #2306)", async () => {
    // Guards against typo'd sidebar entries — a 404 in production from
    // a sidebar link is invisible to CI without this check. PR3 + PR4
    // moved 4 routes (`/platform/users`, `/platform/plugin-registry`,
    // `/admin/account-security`, `/admin/action-log`) plus the existing
    // 11-entry Platform group; single typo'd entry like
    // `/platform/plugins-registry` would slip past every other test
    // today. (#2305 also moved `/admin/model-config` → `/platform/`
    // but that move was reverted — BYOT is workspace-scoped and now
    // lives inline on /admin/billing plus the dedicated /admin/model-config.)
    const fs = await import("node:fs");
    const path = await import("node:path");
    const appDir = path.resolve(__dirname, "../../../../app");
    for (const group of navGroups) {
      for (const item of group.items) {
        const pagePath = path.join(appDir, item.href.replace(/^\//, ""), "page.tsx");
        // Use existsSync + the assertion message so a failure points at
        // the exact href + label rather than just "expected true".
        const exists = fs.existsSync(pagePath);
        if (!exists) {
          throw new Error(
            `nav href ${item.href} (${item.label}, group "${group.title}") has no page.tsx at ${pagePath}`,
          );
        }
        expect(exists).toBe(true);
      }
    }
  });
});
