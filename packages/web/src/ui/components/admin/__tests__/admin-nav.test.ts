import { describe, expect, test } from "bun:test";
import { navGroups, resolveAdminBreadcrumb } from "../admin-nav";

describe("resolveAdminBreadcrumb", () => {
  test("returns overview kind on the overview", () => {
    expect(resolveAdminBreadcrumb("/admin")).toEqual({ kind: "overview" });
  });

  test("default is exact-match — siblings with a shared prefix don't collapse", () => {
    // Semantic Layer parent + Improve Layer child share `/admin/semantic`.
    // Default-exact means each resolves to its own leaf entry.
    expect(resolveAdminBreadcrumb("/admin/semantic")).toEqual({
      kind: "page",
      section: "Data",
      page: "Semantic Layer",
    });
    expect(resolveAdminBreadcrumb("/admin/semantic/improve")).toEqual({
      kind: "page",
      section: "Data",
      page: "Improve Layer",
    });
  });

  test("#2176 regression — /admin/settings does not opt into prefixMatch", () => {
    // The bug #2176 shipped came from a parent route collapsing its
    // children's breadcrumbs when prefixMatch was enabled accidentally. The
    // MCP child page that used to be the sibling has since been folded
    // into /admin/settings as a section (May 2026 consolidation), so we
    // assert the same invariant in sibling-agnostic form: an arbitrary
    // child path under /admin/settings must NOT resolve to the Settings
    // entry — only the exact path does.
    expect(resolveAdminBreadcrumb("/admin/settings")).toEqual({
      kind: "page",
      section: "Configuration",
      page: "Settings",
    });
    expect(resolveAdminBreadcrumb("/admin/settings/anything-else")).toEqual({
      kind: "overview",
    });
  });

  test("prefixMatch respects segment boundaries — sibling routes sharing a prefix don't collapse", () => {
    // Guards the trailing "/" in `pathname.startsWith(item.href + "/")`. Without
    // it, /admin/users would prefix-match any sibling whose path happens to
    // begin with the same letters. A future refactor that drops the "+ "/""
    // would silently reintroduce a #2176-class regression under a new name.
    expect(resolveAdminBreadcrumb("/admin/usersearch")).toEqual({ kind: "overview" });
    expect(resolveAdminBreadcrumb("/admin/scheduled-tasks-archive")).toEqual({ kind: "overview" });
  });

  test("prefixMatch: true items match nested child routes", () => {
    // /admin/users has prefixMatch:true so the [id] detail page resolves to
    // the Users entry rather than dropping off the sidebar.
    expect(resolveAdminBreadcrumb("/admin/users")).toEqual({
      kind: "page",
      section: "Users & Access",
      page: "Users",
    });
    expect(resolveAdminBreadcrumb("/admin/users/abc-123")).toEqual({
      kind: "page",
      section: "Users & Access",
      page: "Users",
    });
  });

  test("prefixMatch on /admin/scheduled-tasks resolves the /runs subpage", () => {
    expect(resolveAdminBreadcrumb("/admin/scheduled-tasks")).toEqual({
      kind: "page",
      section: "Monitoring",
      page: "Scheduled Tasks",
    });
    expect(resolveAdminBreadcrumb("/admin/scheduled-tasks/runs")).toEqual({
      kind: "page",
      section: "Monitoring",
      page: "Scheduled Tasks",
    });
  });

  test("Company Brain is its own group, and its landing page doesn't swallow its leaves (#5066)", () => {
    // `/admin/brain` is a group LANDING page with a real child under it —
    // one of three sibling-prefix pairs in this file (`/admin/semantic` +
    // `/admin/semantic/improve` and `/platform` + its children are the
    // others), and the second landing-page-with-children after `/platform`.
    // Opting it into prefixMatch (the reflex for "it's a parent") would
    // collapse every future /admin/brain/* surface onto "Overview", which is
    // the #2176 shape one level down. Assert both leaves resolve to
    // themselves. `no prefixMatch item is a strict prefix of a sibling`
    // below generalizes this to all three pairs.
    expect(resolveAdminBreadcrumb("/admin/brain")).toEqual({
      kind: "page",
      section: "Company Brain",
      page: "Overview",
    });
    expect(resolveAdminBreadcrumb("/admin/brain/facts")).toEqual({
      kind: "page",
      section: "Company Brain",
      page: "Facts",
    });
  });

  test("the retired /admin/brain-facts URL is not a nav entry (#5066)", () => {
    // It redirects at the config layer, so it must NOT also resolve here —
    // a leftover entry would put a 308-ing href back in the sidebar and the
    // command palette, both of which build from `navGroups`.
    expect(resolveAdminBreadcrumb("/admin/brain-facts")).toEqual({ kind: "overview" });
    const hrefs = navGroups.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain("/admin/brain-facts");
  });

  test("no prefixMatch item is a strict path prefix of another nav item", () => {
    // The prefix/exact rule lives in a JSDoc sentence on `prefixMatch?`, and
    // nothing in the type stops `{ href: "/admin/brain", prefixMatch: true }`.
    // There are three sibling-prefix pairs in this file now, so guard the rule
    // itself rather than today's paths: the two breadcrumb tests above cover
    // `/admin/semantic` and `/admin/brain` by name and would say nothing about
    // the next split.
    const allHrefs = navGroups.flatMap((g) => g.items.map((i) => i.href));
    // Positive control: the loop below is a pure throw-guard, so if
    // `prefixMatch` were ever dropped from the type — or the scan silently
    // stopped matching — it would degrade to a no-op that passes. Assert the
    // set it inspects is non-empty first.
    expect(navGroups.flatMap((g) => g.items).filter((i) => i.prefixMatch).length).toBeGreaterThan(0);
    for (const group of navGroups) {
      for (const item of group.items) {
        if (!item.prefixMatch) continue;
        const swallowed = allHrefs.filter((h) => h.startsWith(item.href + "/"));
        if (swallowed.length > 0) {
          throw new Error(
            `nav item ${item.href} ("${item.label}") sets prefixMatch and would swallow ` +
              `the breadcrumb of: ${swallowed.join(", ")}. Either drop prefixMatch, or ` +
              `remove the nested entries it is absorbing.`,
          );
        }
      }
    }
  });

  test("no two nav groups share an icon", () => {
    // Splitting Company Brain out of Intelligence (#5066) left two groups
    // holding the `Brain` glyph until Intelligence was re-iconed. Duplicate
    // icons read as one group accidentally rendered twice, and the next split
    // will hit the same fork.
    const icons = navGroups.map((g) => g.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  test("returns overview kind for an unmapped /admin/* path", () => {
    expect(resolveAdminBreadcrumb("/admin/totally-not-a-route")).toEqual({ kind: "overview" });
  });

  test("every nav item resolves to its own group/label round-trip", () => {
    // Belt + suspenders: the resolver and the navGroups list must stay in
    // lockstep — adding a new sidebar item without updating the resolver
    // would silently miss the breadcrumb label.
    for (const group of navGroups) {
      for (const item of group.items) {
        const crumb = resolveAdminBreadcrumb(item.href);
        expect(crumb.kind).toBe("page");
        if (crumb.kind === "page") {
          expect(crumb.section).toBe(group.title);
          expect(crumb.page).toBe(item.label);
        }
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
