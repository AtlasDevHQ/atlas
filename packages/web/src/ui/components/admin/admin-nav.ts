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
  /** When true, only highlight on exact pathname match (no prefix matching). */
  exact?: boolean;
  /** When set, only users with this role see this item. */
  requiredRole?: "platform_admin";
  /** When true, this item is hidden in SaaS deploy mode. */
  selfHostedOnly?: boolean;
  /** When set, shows a numeric badge next to the label. */
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
      { href: "/admin/semantic", label: "Semantic Layer", exact: true },
      { href: "/admin/semantic/improve", label: "Improve Layer" },
      { href: "/admin/schema-diff", label: "Schema Diff" },
      { href: "/admin/connections", label: "Connections" },
      { href: "/admin/cache", label: "Cache" },
    ],
  },
  {
    title: "Intelligence",
    icon: Brain,
    items: [
      { href: "/admin/model-config", label: "AI Provider", requiredRole: "platform_admin" },
      { href: "/admin/learned-patterns", label: "Learned Patterns" },
      { href: "/admin/prompts", label: "Prompt Library" },
      { href: "/admin/starter-prompts", label: "Starter Prompts" },
      { href: "/admin/actions", label: "Actions" },
    ],
  },
  {
    title: "Users & Access",
    icon: Users,
    items: [
      { href: "/admin/users", label: "Users" },
      { href: "/admin/organizations", label: "Organizations", requiredRole: "platform_admin" },
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
      { href: "/admin/security", label: "MFA & Sessions" },
      { href: "/admin/sso", label: "SSO" },
      { href: "/admin/scim", label: "SCIM" },
      { href: "/admin/ip-allowlist", label: "IP Allowlist" },
      { href: "/admin/abuse", label: "Abuse Prevention", requiredRole: "platform_admin" },
      { href: "/admin/approval", label: "Approval Workflows" },
      { href: "/admin/compliance", label: "PII Compliance" },
    ],
  },
  {
    title: "Monitoring",
    icon: BarChart3,
    items: [
      { href: "/admin/audit", label: "Audit Log" },
      { href: "/admin/admin-actions", label: "Admin Action Log" },
      { href: "/admin/token-usage", label: "Token Usage" },
      { href: "/admin/usage", label: "Usage" },
      { href: "/admin/scheduled-tasks", label: "Scheduled Tasks" },
    ],
  },
  {
    title: "Configuration",
    icon: Settings,
    items: [
      { href: "/admin/plugins", label: "Plugins", selfHostedOnly: true },
      { href: "/admin/integrations", label: "Integrations" },
      { href: "/admin/email-provider", label: "Email Provider" },
      { href: "/admin/billing", label: "Billing" },
      { href: "/admin/branding", label: "Branding" },
      { href: "/admin/custom-domain", label: "Custom Domain" },
      { href: "/admin/sandbox", label: "Sandbox" },
      { href: "/admin/residency", label: "Data Residency" },
      { href: "/admin/settings", label: "Settings", exact: true },
      { href: "/admin/settings/mcp", label: "MCP" },
    ],
  },
  {
    title: "Platform",
    icon: Globe,
    requiredRole: "platform_admin",
    items: [
      { href: "/admin/platform", label: "Overview", exact: true },
      { href: "/admin/platform/actions", label: "Action Log" },
      { href: "/admin/platform/security", label: "Security Adoption" },
      { href: "/admin/platform/sla", label: "SLA Monitoring" },
      { href: "/admin/platform/backups", label: "Backups" },
      { href: "/admin/platform/residency", label: "Data Residency" },
      { href: "/admin/platform/domains", label: "Custom Domains" },
      { href: "/admin/platform/settings", label: "Settings" },
      { href: "/admin/platform/plugins", label: "Plugin Catalog", selfHostedOnly: true },
    ],
  },
];

export interface AdminBreadcrumb {
  /** Section name (matches a NavGroup.title) — `undefined` on the `/admin` overview. */
  section?: string;
  /** Page label (matches a NavSubItem.label) — `undefined` when only a section is active. */
  page?: string;
}

/**
 * Resolve the active section + page labels for a `/admin/*` pathname using the
 * shared `navGroups` registry. Used by the top-bar breadcrumb so both sidebar
 * and breadcrumb derive labels from a single source of truth.
 */
export function resolveAdminBreadcrumb(pathname: string): AdminBreadcrumb {
  if (pathname === "/admin") return {};

  for (const group of navGroups) {
    for (const item of group.items) {
      const matches = item.exact
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(item.href + "/");
      if (matches) return { section: group.title, page: item.label };
    }
  }

  return {};
}
