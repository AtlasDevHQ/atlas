"use client";

import {
  BrainCircuit,
  Cable,
  Clock,
  Database,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { HealthBadge } from "@/ui/components/admin/health-badge";

export type ComponentStatus = "healthy" | "degraded" | "down" | "disabled";

export interface ComponentHealth {
  status: ComponentStatus;
  latencyMs?: number;
  lastCheckedAt: string;
  message?: string;
  model?: string;
  backend?: string;
}

export interface HealthComponents {
  datasource: ComponentHealth;
  internalDb: ComponentHealth;
  provider: ComponentHealth;
  scheduler: ComponentHealth;
  sandbox: ComponentHealth;
}

const COMPONENT_META: Record<
  keyof HealthComponents,
  { label: string; icon: LucideIcon }
> = {
  datasource: { label: "Datasource", icon: Cable },
  internalDb: { label: "Internal DB", icon: Database },
  provider: { label: "LLM Provider", icon: BrainCircuit },
  scheduler: { label: "Scheduler", icon: Clock },
  sandbox: { label: "Sandbox", icon: Shield },
};

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "unknown";
  const diff = Date.now() - date.getTime();
  if (diff < 1000) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function ComponentCard({
  name,
  component,
}: {
  name: keyof HealthComponents;
  component: ComponentHealth;
}) {
  const meta = COMPONENT_META[name];
  const Icon = meta.icon;

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="size-4" />
          {meta.label}
        </CardTitle>
        <HealthBadge
          status={component.status === "disabled" ? "unknown" : component.status}
          label={component.status === "disabled" ? "Disabled" : undefined}
        />
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {component.latencyMs !== undefined && (
            <p className="text-lg font-semibold tabular-nums">
              {component.latencyMs}ms
            </p>
          )}
          {component.model && (
            <p className="text-xs text-muted-foreground">
              Model: {component.model}
            </p>
          )}
          {component.backend && (
            <p className="text-xs text-muted-foreground">
              Backend: {component.backend}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Checked {formatRelativeTime(component.lastCheckedAt)}
          </p>
          {component.message && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {component.message}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function ComponentHealthTiles({
  components,
  loading,
}: {
  components: HealthComponents | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Skeleton className="h-7 w-16" />
                <Skeleton className="h-3 w-20" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!components) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {(Object.keys(COMPONENT_META) as Array<keyof HealthComponents>).map(
        (key) => (
          <ComponentCard key={key} name={key} component={components[key]} />
        ),
      )}
    </div>
  );
}
