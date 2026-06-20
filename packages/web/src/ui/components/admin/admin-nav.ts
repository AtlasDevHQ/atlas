import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Brain,
  Database,
  Globe,
  Settings,
  Shield,
  Users,
} from "lucide-react";

export interface NavSubItem {
  href: string;
  label: string;
  /** Opt-in: match `pathname.startsWith(href + "/")` so a nested route highlights its parent (e.g. `/admin/users` covers `/admin/users/[id]`). Default is exact-match — siblings sharing a prefix don't collapse into the parent. */
  prefixMatch?: boolean;
  requiredRole?: "platform_admin";
  selfHostedOnly?: boolean;
  /**
   * Hide on self-hosted deploys. Mirror of `selfHostedOnly` for items
   * that depend on a SaaS-only Tag — e.g. `/platform/crm-outbox`
   * queries the `crm_outbox` table that is only populated when the EE
   * `SaasCrm` layer is bound. The API still returns 404 on self-hosted
   * via the no-op layer; this just keeps the nav link from advertising
   * a dead page.
   */
  saasOnly?: boolean;
  badge?: number;
}

export interface NavGroup {
  title: string;
  icon: LucideIcon;
  items: NavSubItem[];
  requiredRole?: "platform_admin";
}

export const navGroups: NavGroup[] = [
  {
    title: "Data",
    icon: Database,
    items: [
      { href: "/admin/semantic", label: "Semantic Layer" },
      { href: "/admin/semantic/improve", label: "Improve Layer" },
      // One entry covers both raw connections and environment groupings —
      // the page hosts a `?groupBy=type|environment` toggle and the legacy
      // `/admin/connections/groups` URL server-side-redirects in.
      { href: "/admin/connections", label: "Connections" },
      { href: "/admin/cache", label: "Cache" },
    ],
  },
  {
    title: "Intelligence",
    icon: Brain,
    items: [
      { href: "/admin/model-config", label: "AI Provider" },
      { href: "/admin/learned-patterns", label: "Learned Patterns" },
      { href: "/admin/prompts", label: "Prompt Library" },
      { href: "/admin/starter-prompts", label: "Starter Prompts" },
      { href: "/admin/actions", label: "Actions" },
      { href: "/admin/proactive-chat", label: "Proactive Chat" },
      { href: "/admin/session-memory", label: "Session Memory" },
    ],
  },
  {
    title: "Users & Access",
    icon: Users,
    items: [
      { href: "/admin/users", label: "Users", prefixMatch: true },
      { href: "/admin/roles", label: "Roles" },
      { href: "/admin/sessions", label: "Sessions" },
      { href: "/admin/api-keys", label: "API Keys" },
      { href: "/admin/oauth-clients", label: "OAuth Clients" },
    ],
  },
  {
    title: "Security",
    icon: Shield,
    items: [
      { href: "/admin/account-security", label: "My Security" },
      { href: "/admin/sso", label: "SSO" },
      { href: "/admin/scim", label: "SCIM" },
      { href: "/admin/ip-allowlist", label: "IP Allowlist" },
      { href: "/admin/approval", label: "Approval Workflows" },
      { href: "/admin/mcp-action-policy", label: "MCP Action Policy" },
      { href: "/admin/compliance", label: "PII Compliance" },
    ],
  },
  {
    title: "Monitoring",
    icon: BarChart3,
    items: [
      { href: "/admin/audit", label: "Audit" },
      { href: "/admin/usage", label: "Usage" },
      { href: "/admin/scheduled-tasks", label: "Scheduled Tasks", prefixMatch: true },
    ],
  },
  {
    title: "Configuration",
    icon: Settings,
    items: [
      { href: "/admin/integrations", label: "Integrations" },
      { href: "/admin/email-provider", label: "Email Provider" },
      { href: "/admin/billing", label: "Billing" },
      { href: "/admin/branding", label: "Branding" },
      { href: "/admin/custom-domain", label: "Custom Domain" },
      { href: "/admin/sandbox", label: "Sandbox" },
      { href: "/admin/residency", label: "Data Residency" },
      // Moved out of Monitoring to break the "Scheduled Tasks" /
      // "Scheduler Tasks" label collision. This page lists system-only
      // jobs (e.g. BYOT catalog refresh), not user-created automations
      // — Configuration is where it belongs.
      { href: "/admin/scheduler/tasks", label: "Background Jobs" },
      { href: "/admin/settings", label: "Settings" },
    ],
  },
  {
    title: "Platform",
    icon: Globe,
    requiredRole: "platform_admin",
    items: [
      { href: "/platform", label: "Overview" },
      { href: "/platform/organizations", label: "Organizations" },
      { href: "/platform/actions", label: "Action Log" },
      { href: "/platform/security", label: "Security Adoption" },
      { href: "/platform/abuse", label: "Abuse Prevention" },
      { href: "/platform/sla", label: "SLA Monitoring" },
      { href: "/platform/backups", label: "Backups" },
      { href: "/platform/crm-outbox", label: "CRM Outbox", saasOnly: true },
      { href: "/platform/operator-integrations", label: "Operator Integrations" },
      { href: "/platform/residency", label: "Data Residency" },
      { href: "/platform/domains", label: "Custom Domains" },
      { href: "/platform/settings", label: "Settings" },
      { href: "/platform/users", label: "Users (All Tenants)" },
      { href: "/platform/plugins", label: "Plugin Catalog", selfHostedOnly: true },
      { href: "/platform/plugin-registry", label: "Plugin Registry", selfHostedOnly: true },
    ],
  },
];

/**
 * Discriminated union over the two legal breadcrumb states the resolver
 * produces. The previous `{ section?: string; page?: string }` interface
 * allowed `{ page: "X" }` (illegal) — encoding the invariant in the type
 * lets `switch (b.kind)` prove exhaustiveness in consumers. Add a
 * `section`-only variant if a future group-landing page needs one.
 */
export type AdminBreadcrumb =
  | { kind: "overview" }
  | { kind: "page"; section: string; page: string };

/**
 * Single source of truth for nav-item matching. Sidebar active-state and
 * breadcrumb resolution must agree on every pathname — duplicating this rule
 * across two sites is the failure mode that caused #2176.
 */
export function matchesNavItem(item: NavSubItem, pathname: string): boolean {
  if (item.prefixMatch) {
    return pathname === item.href || pathname.startsWith(item.href + "/");
  }
  return pathname === item.href;
}

/** Resolves a pathname to its sidebar section + page label via `matchesNavItem`. */
export function resolveAdminBreadcrumb(pathname: string): AdminBreadcrumb {
  if (pathname === "/admin") return { kind: "overview" };

  for (const group of navGroups) {
    for (const item of group.items) {
      if (matchesNavItem(item, pathname)) {
        return { kind: "page", section: group.title, page: item.label };
      }
    }
  }

  return { kind: "overview" };
}
