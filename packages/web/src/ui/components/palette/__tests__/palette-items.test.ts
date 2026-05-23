import { describe, expect, test } from "bun:test";
import { buildAdminPaletteGroups } from "../palette-items";
import { navGroups } from "@/ui/components/admin/admin-nav";

describe("buildAdminPaletteGroups", () => {
  test("admin (non-platform) sees every non-platform group", () => {
    const groups = buildAdminPaletteGroups({
      userRole: "admin",
      isSaas: false,
    });
    const headings = groups.map((g) => g.heading);

    // The Platform group requires `platform_admin` — admins must not see it.
    expect(headings).not.toContain("Platform");
    // Every other group from the nav should be present.
    for (const g of navGroups) {
      if (g.requiredRole) continue;
      expect(headings).toContain(g.title);
    }
  });

  test("platform_admin sees the Platform group", () => {
    const groups = buildAdminPaletteGroups({
      userRole: "platform_admin",
      isSaas: false,
    });
    expect(groups.map((g) => g.heading)).toContain("Platform");
  });

  test("SaaS hides self-hosted-only items", () => {
    const saasGroups = buildAdminPaletteGroups({
      userRole: "platform_admin",
      isSaas: true,
    });
    const selfHostedGroups = buildAdminPaletteGroups({
      userRole: "platform_admin",
      isSaas: false,
    });

    // Plugin registry is self-hosted-only — it must vanish under SaaS.
    const saasHrefs = saasGroups.flatMap((g) => g.items.map((i) => i.action));
    const selfHrefs = selfHostedGroups.flatMap((g) => g.items.map((i) => i.action));

    const saasHasRegistry = saasHrefs.some(
      (a) => a.kind === "navigate" && a.href === "/platform/plugin-registry",
    );
    const selfHasRegistry = selfHrefs.some(
      (a) => a.kind === "navigate" && a.href === "/platform/plugin-registry",
    );

    expect(saasHasRegistry).toBe(false);
    expect(selfHasRegistry).toBe(true);
  });

  test("badges from the caller decorate the matching nav item", () => {
    const groups = buildAdminPaletteGroups({
      userRole: "admin",
      isSaas: false,
      badges: { "/admin/semantic/improve": 7 },
    });
    const improve = groups
      .flatMap((g) => g.items)
      .find((i) => i.action.kind === "navigate" && i.action.href === "/admin/semantic/improve");
    expect(improve?.badge).toBe(7);
  });

  test("each palette item carries a stable, unique id", () => {
    const groups = buildAdminPaletteGroups({
      userRole: "platform_admin",
      isSaas: false,
    });
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    // Convention: nav-derived items are namespaced `nav:` so settings items
    // and chat actions can't collide.
    for (const id of ids) expect(id.startsWith("nav:")).toBe(true);
  });

  test("members see no admin groups at all", () => {
    // Codex review on the consolidation PR caught that the prior gate only
    // filtered `requiredRole` groups (Platform), leaving every other admin
    // group visible to non-admins on the chat surface. Members must see
    // an empty admin section so the palette never surfaces a route they'd
    // 403 on click.
    expect(buildAdminPaletteGroups({ userRole: "member", isSaas: false })).toEqual([]);
    expect(buildAdminPaletteGroups({ userRole: "viewer", isSaas: false })).toEqual([]);
    expect(buildAdminPaletteGroups({ userRole: null, isSaas: false })).toEqual([]);
  });
});
