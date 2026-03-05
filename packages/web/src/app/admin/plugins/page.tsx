"use client";

import { useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HealthBadge } from "@/ui/components/admin/health-badge";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { Puzzle, Loader2 } from "lucide-react";
import { useAdminFetch, useInProgressSet, friendlyError } from "@/ui/hooks/use-admin-fetch";

// ── Types ─────────────────────────────────────────────────────────

interface PluginDescription {
  id: string;
  type: "datasource" | "context" | "interaction" | "action" | "sandbox";
  version: string;
  name: string;
  status: "registered" | "initializing" | "healthy" | "unhealthy" | "teardown";
}

function toHealthStatus(status: PluginDescription["status"]) {
  if (status === "healthy") return "healthy" as const;
  if (status === "registered" || status === "initializing") return "unknown" as const;
  return "down" as const;
}

export default function PluginsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const checking = useInProgressSet();
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { data: plugins, loading, error, refetch } = useAdminFetch<PluginDescription[]>(
    "/api/v1/admin/plugins",
    { transform: (json) => (json as { plugins?: PluginDescription[] }).plugins ?? [] },
  );

  const [localPlugins, setLocalPlugins] = useState<PluginDescription[] | null>(null);
  const displayPlugins = localPlugins ?? plugins ?? [];

  if (plugins && localPlugins !== null && plugins !== localPlugins) {
    setLocalPlugins(null);
  }

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Plugins</h1>
          <p className="text-sm text-muted-foreground">Manage installed plugins</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Plugins" />
      </div>
    );
  }

  async function handleHealthCheck(id: string) {
    checking.start(id);
    setMutationError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/plugins/${encodeURIComponent(id)}/health`, {
        method: "POST",
        credentials,
      });
      if (!res.ok) throw new Error(`Health check failed (HTTP ${res.status})`);
      const data: { healthy: boolean; message?: string; latencyMs?: number; status: string } = await res.json();
      setLocalPlugins((prev) =>
        (prev ?? displayPlugins).map((p) =>
          p.id === id ? { ...p, status: data.healthy ? "healthy" : "unhealthy" } : p,
        ),
      );
    } catch (err) {
      setMutationError(
        `Health check failed for "${id}": ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      checking.stop(id);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Plugins</h1>
        <p className="text-sm text-muted-foreground">Manage installed plugins</p>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {error && <ErrorBanner message={friendlyError(error)} onRetry={refetch} />}
        {mutationError && <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />}

        {loading ? (
          <LoadingState message="Loading plugins..." />
        ) : displayPlugins.length === 0 && !error ? (
          <EmptyState icon={Puzzle} message="No plugins installed" />
        ) : displayPlugins.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {displayPlugins.map((plugin) => (
              <Card key={plugin.id} className="shadow-none">
                <CardHeader className="py-3 pb-1">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    {plugin.name}
                    <Badge variant="outline" className="text-[10px]">
                      {plugin.type}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                      <HealthBadge status={toHealthStatus(plugin.status)} />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={checking.has(plugin.id)}
                      onClick={() => handleHealthCheck(plugin.id)}
                    >
                      {checking.has(plugin.id) ? (
                        <Loader2 className="mr-1 size-3 animate-spin" />
                      ) : null}
                      Health Check
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
