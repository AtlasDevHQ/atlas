import { navGroups, type NavSubItem } from "@/ui/components/admin/admin-nav";
import type { PaletteGroup, PaletteItem } from "./palette-types";

/**
 * Build palette groups from the canonical `admin-nav` registry so adding a
 * sidebar entry automatically surfaces it in Cmd+K. Filtering (platform-admin
 * gating, self-hosted-only, badge counts) is applied here in the same shape
 * the sidebar uses — keeping one source of truth (#2176 lesson: any
 * pathname/label rule that lives in two places will drift).
 */
export function buildAdminPaletteGroups(opts: {
  userRole: "admin" | "member" | "platform_admin" | "viewer" | null;
  isSaas: boolean;
  badges?: Record<string, number>;
}): PaletteGroup[] {
  const { userRole, isSaas, badges = {} } = opts;

  return navGroups
    .filter((g) => !g.requiredRole || g.requiredRole === userRole)
    .map((group): PaletteGroup => {
      const items = group.items
        .filter((item) => !item.requiredRole || item.requiredRole === userRole)
        .filter((item) => !item.selfHostedOnly || !isSaas)
        .map((item): PaletteItem => navItemToPaletteItem(item, group.title, badges));
      return { heading: group.title, items };
    })
    .filter((g) => g.items.length > 0);
}

function navItemToPaletteItem(
  item: NavSubItem,
  groupTitle: string,
  badges: Record<string, number>,
): PaletteItem {
  const badge = badges[item.href];
  return {
    id: `nav:${item.href}`,
    title: item.label,
    hint: groupTitle,
    keywords: [groupTitle, item.href.replace(/^\/admin\//, "").replace(/\//g, " ")],
    action: { kind: "navigate", href: item.href },
    badge: badge && badge > 0 ? badge : undefined,
  };
}
