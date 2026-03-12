"use client";

import { useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Database,
  Shield,
  MessageSquare,
  Zap,
  BookOpen,
  Package,
  Check,
} from "lucide-react";

type PluginType =
  | "datasource"
  | "sandbox"
  | "interaction"
  | "action"
  | "context";

interface Plugin {
  name: string;
  href: string;
  type: PluginType;
  package: string;
  description: string;
}

const plugins: Plugin[] = [
  // Datasources
  {
    name: "BigQuery",
    href: "/plugins/datasources/bigquery",
    type: "datasource",
    package: "@useatlas/bigquery",
    description:
      "Google Cloud data warehouse via REST API with service account and ADC authentication.",
  },
  {
    name: "ClickHouse",
    href: "/plugins/datasources/clickhouse",
    type: "datasource",
    package: "@useatlas/clickhouse",
    description:
      "Column-oriented analytics database via HTTP transport with readonly enforcement.",
  },
  {
    name: "DuckDB",
    href: "/plugins/datasources/duckdb",
    type: "datasource",
    package: "@useatlas/duckdb",
    description:
      "Embedded analytics engine — file-based or in-memory, zero network overhead.",
  },
  {
    name: "MySQL",
    href: "/plugins/datasources/mysql",
    type: "datasource",
    package: "@useatlas/mysql",
    description:
      "MySQL and MariaDB via connection pool with read-only session enforcement.",
  },
  {
    name: "Snowflake",
    href: "/plugins/datasources/snowflake",
    type: "datasource",
    package: "@useatlas/snowflake",
    description:
      "Snowflake Data Cloud via SDK connection pool with warehouse and role configuration.",
  },
  {
    name: "Salesforce",
    href: "/plugins/datasources/salesforce",
    type: "datasource",
    package: "@useatlas/salesforce",
    description:
      "Salesforce CRM via SOQL — query Salesforce objects like database tables.",
  },
  // Sandboxes
  {
    name: "Vercel Sandbox",
    href: "/plugins/sandboxes/vercel-sandbox",
    type: "sandbox",
    package: "@useatlas/vercel-sandbox",
    description:
      "Firecracker microVM isolation on Vercel — highest security tier (priority 100).",
  },
  {
    name: "E2B",
    href: "/plugins/sandboxes/e2b",
    type: "sandbox",
    package: "@useatlas/e2b",
    description:
      "Cloud-hosted Firecracker microVM — ephemeral sandbox with network and filesystem isolation.",
  },
  {
    name: "Daytona",
    href: "/plugins/sandboxes/daytona",
    type: "sandbox",
    package: "@useatlas/daytona",
    description:
      "Managed cloud sandbox with ephemeral workspaces and full Linux environments.",
  },
  {
    name: "nsjail",
    href: "/plugins/sandboxes/nsjail",
    type: "sandbox",
    package: "@useatlas/nsjail",
    description:
      "Linux namespace sandbox — no network, read-only mounts, zero host access.",
  },
  {
    name: "Sidecar",
    href: "/plugins/sandboxes/sidecar",
    type: "sandbox",
    package: "@useatlas/sidecar",
    description:
      "HTTP-isolated container sidecar for Railway and similar platforms.",
  },
  // Interactions
  {
    name: "MCP",
    href: "/plugins/interactions/mcp",
    type: "interaction",
    package: "@useatlas/mcp",
    description:
      "Model Context Protocol server — expose Atlas tools to Claude Desktop, Cursor, etc. Monorepo-only (not yet published to npm).",
  },
  {
    name: "Slack",
    href: "/plugins/interactions/slack",
    type: "interaction",
    package: "@useatlas/slack",
    description:
      "Slack bot integration with slash commands, threaded conversations, and OAuth.",
  },
  // Actions
  {
    name: "Email",
    href: "/plugins/actions/email",
    type: "action",
    package: "@useatlas/email",
    description:
      "Send email reports via Resend with approval-gated delivery controls.",
  },
  {
    name: "JIRA",
    href: "/plugins/actions/jira",
    type: "action",
    package: "@useatlas/jira",
    description:
      "Create JIRA tickets from agent findings with customizable project and issue types.",
  },
  // Context
  {
    name: "YAML Context",
    href: "/plugins/context/yaml-context",
    type: "context",
    package: "@useatlas/yaml-context",
    description:
      "Inject semantic layer knowledge (entities, glossary, metrics) into the agent prompt.",
  },
];

const typeConfig: Record<
  PluginType,
  { label: string; color: string; bgColor: string; icon: LucideIcon }
> = {
  datasource: {
    label: "Datasource",
    color: "text-blue-700 dark:text-blue-400",
    bgColor: "bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800",
    icon: Database,
  },
  sandbox: {
    label: "Sandbox",
    color: "text-purple-700 dark:text-purple-400",
    bgColor:
      "bg-purple-50 dark:bg-purple-950/50 border-purple-200 dark:border-purple-800",
    icon: Shield,
  },
  interaction: {
    label: "Interaction",
    color: "text-green-700 dark:text-green-400",
    bgColor:
      "bg-green-50 dark:bg-green-950/50 border-green-200 dark:border-green-800",
    icon: MessageSquare,
  },
  action: {
    label: "Action",
    color: "text-orange-700 dark:text-orange-400",
    bgColor:
      "bg-orange-50 dark:bg-orange-950/50 border-orange-200 dark:border-orange-800",
    icon: Zap,
  },
  context: {
    label: "Context",
    color: "text-teal-700 dark:text-teal-400",
    bgColor: "bg-teal-50 dark:bg-teal-950/50 border-teal-200 dark:border-teal-800",
    icon: BookOpen,
  },
};

const filterTabs: { key: PluginType | "all"; label: string; count: number }[] =
  [
    { key: "all", label: "All", count: plugins.length },
    {
      key: "datasource",
      label: "Datasources",
      count: plugins.filter((p) => p.type === "datasource").length,
    },
    {
      key: "sandbox",
      label: "Sandboxes",
      count: plugins.filter((p) => p.type === "sandbox").length,
    },
    {
      key: "interaction",
      label: "Interactions",
      count: plugins.filter((p) => p.type === "interaction").length,
    },
    {
      key: "action",
      label: "Actions",
      count: plugins.filter((p) => p.type === "action").length,
    },
    {
      key: "context",
      label: "Context",
      count: plugins.filter((p) => p.type === "context").length,
    },
  ];

function TypeBadge({ type }: { type: PluginType }) {
  const config = typeConfig[type];
  const Icon = config.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${config.bgColor} ${config.color}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {config.label}
    </span>
  );
}

function PluginCard({ plugin }: { plugin: Plugin }) {
  return (
    <Link
      href={plugin.href}
      className="group flex flex-col rounded-lg border border-fd-border bg-fd-card p-4 transition-colors hover:border-fd-primary/50 hover:bg-fd-accent/50"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-semibold text-fd-foreground group-hover:text-fd-primary">
          {plugin.name}
        </h3>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:border-green-800 dark:bg-green-950/50 dark:text-green-400">
          <Check className="h-2.5 w-2.5" aria-hidden="true" />
          Official
        </span>
      </div>
      <TypeBadge type={plugin.type} />
      <p className="mt-2 flex-1 text-sm text-fd-muted-foreground">
        {plugin.description}
      </p>
      <div className="mt-3 flex items-center gap-1.5 text-fd-muted-foreground">
        <Package className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <code className="text-xs">{plugin.package}</code>
      </div>
    </Link>
  );
}

export function PluginDirectory() {
  const [filter, setFilter] = useState<PluginType | "all">("all");

  const filtered =
    filter === "all" ? plugins : plugins.filter((p) => p.type === filter);

  return (
    <div>
      {/* Filter tabs */}
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filter by plugin type">
        {filterTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            aria-pressed={filter === tab.key}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === tab.key
                ? "border-fd-primary bg-fd-primary text-fd-primary-foreground"
                : "border-fd-border bg-fd-background text-fd-muted-foreground hover:border-fd-foreground/20 hover:text-fd-foreground"
            }`}
          >
            {tab.label}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                filter === tab.key
                  ? "bg-fd-primary-foreground/20 text-fd-primary-foreground"
                  : "bg-fd-muted text-fd-muted-foreground"
              }`}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Plugin grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((plugin) => (
          <PluginCard key={plugin.package} plugin={plugin} />
        ))}
      </div>
    </div>
  );
}
