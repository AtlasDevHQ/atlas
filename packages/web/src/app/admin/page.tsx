"use client";

import { useEffect, useRef, useState } from "react";
import {
  Database,
  Cable,
  Puzzle,
  RefreshCw,
  Server,
  BrainCircuit,
  Clock,
  Shield,
} from "lucide-react";
import { useAtlasConfig } from "@/ui/context";
import { StatCard } from "@/ui/components/admin/stat-card";
import { HealthBadge } from "@/ui/components/admin/health-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type ComponentStatus = "healthy" | "degraded" | "down" | "disabled";

interface ComponentHealth {
  status: ComponentStatus;
  latencyMs?: number;
  lastCheckedAt: string;
  message?: string;
  model?: string;
  backend?: string;
}

interface HealthComponents {
  datasource: ComponentHealth;
  internalDb: ComponentHealth;
  provider: ComponentHealth;
  scheduler: ComponentHealth;
  sandbox: ComponentHealth;
}

interface OverviewData {
  connections: number;
  entities: number;
  plugins: number;
  health: "healthy" | "degraded" | "down" | "unknown";
  components: HealthComponents | null;
}

const FALLBACK: OverviewData = {
  connections: 0,
  entities: 0,
  plugins: 0,
  health: "unknown",
  components: null,
};

const COMPONENT_META: Record<
  keyof HealthComponents,
  { label: string; icon: typeof Database }
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

function mapOverallStatus(
  apiStatus: string | undefined,
): OverviewData["health"] {
  if (apiStatus === "ok") return "healthy";
  if (apiStatus === "degraded") return "degraded";
  if (apiStatus === "error") return "down";
  return "unknown";
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
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

export default function AdminOverview() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [data, setData] = useState<OverviewData>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  async function fetchOverview() {
    const fetchOpts: RequestInit = {
      credentials: isCrossOrigin ? "include" : "same-origin",
    };

    try {
      const [adminResult, healthResult] = await Promise.allSettled([
        fetch(`${apiUrl}/api/v1/admin/overview`, fetchOpts),
        fetch(`${apiUrl}/api/health`, fetchOpts),
      ]);

      if (cancelledRef.current) return;

      const healthOk =
        healthResult.status === "fulfilled" && healthResult.value.ok;
      const healthJson = healthOk
        ? await safeJson(healthResult.value)
        : null;
      const components: HealthComponents | null =
        (healthJson?.components as HealthComponents) ?? null;

      if (cancelledRef.current) return;

      if (adminResult.status === "fulfilled" && adminResult.value.ok) {
        const admin = await safeJson(adminResult.value);
        if (cancelledRef.current) return;
        if (admin) {
          setData({
            connections: (admin.connections as number) ?? 0,
            entities: (admin.entities as number) ?? 0,
            plugins: (admin.plugins as number) ?? 0,
            health: mapOverallStatus(healthJson?.status as string),
            components,
          });
          setError(null);
          return;
        }
      }

      if (healthOk) {
        setData({
          connections:
            (healthJson?.checks as Record<string, Record<string, unknown>>)
              ?.datasource?.status === "ok"
              ? 1
              : 0,
          entities: FALLBACK.entities,
          plugins: FALLBACK.plugins,
          health: mapOverallStatus(healthJson?.status as string),
          components,
        });
        setError(null);
        return;
      }

      setData({ ...FALLBACK, health: "down" });
      setError(
        "Could not reach the API server. Check that your API is running.",
      );
    } catch {
      if (!cancelledRef.current) {
        setData({ ...FALLBACK, health: "down" });
        setError(
          "Could not reach the API server. Check that your API is running.",
        );
      }
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    fetchOverview().finally(() => {
      if (!cancelledRef.current) setLoading(false);
    });
    return () => {
      cancelledRef.current = true;
    };
  }, [apiUrl, isCrossOrigin]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await fetchOverview();
    } catch {
      setData({ ...FALLBACK, health: "down" });
      setError("Refresh failed. Check that your API server is running.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Monitor your Atlas deployment
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              className={`mr-1.5 size-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <HealthBadge status={data.health} />
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {data.components && (
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Component Health
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {(
              Object.keys(COMPONENT_META) as Array<keyof HealthComponents>
            ).map((key) => {
              const components = data.components!;
              return (
                <ComponentCard
                  key={key}
                  name={key}
                  component={components[key]}
                />
              );
            })}
          </div>
        </div>
      )}

      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        Resources
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Connections"
          value={loading ? "—" : data.connections}
          icon={<Server className="size-4" />}
          description="Active datasource connections"
        />
        <StatCard
          title="Entities"
          value={loading ? "—" : data.entities}
          icon={<Database className="size-4" />}
          description="Tables & views in semantic layer"
        />
        <StatCard
          title="Plugins"
          value={loading ? "—" : data.plugins}
          icon={<Puzzle className="size-4" />}
          description="Installed plugins"
        />
      </div>
    </div>
  );
}
