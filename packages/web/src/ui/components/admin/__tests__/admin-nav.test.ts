import { describe, expect, test } from "bun:test";
import { navGroups, resolveAdminBreadcrumb } from "../admin-nav";

describe("resolveAdminBreadcrumb", () => {
  test("returns empty crumb on the overview", () => {
    expect(resolveAdminBreadcrumb("/admin")).toEqual({});
  });

  test("matches an exact-mode item without prefix-matching its children", () => {
    // /admin/semantic is exact:true so /admin/semantic/improve must not collapse
    // into the Semantic-Layer entry.
    expect(resolveAdminBreadcrumb("/admin/semantic")).toEqual({
      section: "Data",
      page: "Semantic Layer",
    });
    expect(resolveAdminBreadcrumb("/admin/semantic/improve")).toEqual({
      section: "Data",
      page: "Improve Layer",
    });
  });

  test("matches a prefix-mode item for nested routes", () => {
    expect(resolveAdminBreadcrumb("/admin/audit")).toEqual({
      section: "Monitoring",
      page: "Audit Log",
    });
    expect(resolveAdminBreadcrumb("/admin/audit/123")).toEqual({
      section: "Monitoring",
      page: "Audit Log",
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
    // moved 4 routes (`/platform/users`, `/platform/model-config`,
    // `/platform/plugin-registry`, `/admin/account-security`,
    // `/admin/action-log`) plus the existing 11-entry Platform group;
    // single typo'd entry like `/platform/plugins-registry` would slip
    // past every other test today.
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
