import { navGroups, type NavSubItem } from "@/ui/components/admin/admin-nav";
import type { PaletteGroup, PaletteItem } from "./palette-types";

/**
 * Build palette groups from the canonical `admin-nav` registry. Filtering
 * rules (platform-admin, self-hosted-only, badge counts) match the sidebar
 * exactly — any pathname/label rule that lives in two places will drift.
 *
 * Non-admin roles get `[]` because the palette mounts on chat surfaces
 * too; exposing admin routes there would surface privileged paths and
 * 403 on click.
 */
export function buildAdminPaletteGroups(opts: {
  userRole: "admin" | "member" | "platform_admin" | "viewer" | null;
  /**
   * `null` means the deploy mode is unresolved — still a hostname guess
   * (loading, settings-fetch error, or fetch disabled). Mode-specific items
   * are then hidden in both directions until the mode is server-confirmed
   * (deploy-mode parity contract Rule 2, #3378).
   */
  isSaas: boolean | null;
  badges?: Record<string, number>;
}): PaletteGroup[] {
  const { userRole, isSaas, badges = {} } = opts;

  const canSeeAdminRoutes = userRole === "admin" || userRole === "platform_admin";
  if (!canSeeAdminRoutes) return [];

  return navGroups
    .filter((g) => !g.requiredRole || g.requiredRole === userRole)
    .map((group): PaletteGroup => {
      const items = group.items
        .filter((item) => !item.requiredRole || item.requiredRole === userRole)
        .filter((item) => !item.selfHostedOnly || isSaas === false)
        .filter((item) => !item.saasOnly || isSaas === true)
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
