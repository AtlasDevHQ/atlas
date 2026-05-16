"use client";

import { useEffect, useRef, useState } from "react";
import {
  Database,
  Puzzle,
  RefreshCw,
  Server,
  Activity,
  Building2,
  CreditCard,
} from "lucide-react";
import { useAtlasConfig } from "@/ui/context";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { StatCard } from "@/ui/components/admin/stat-card";
import { TrialCountdownBanner } from "@/ui/components/admin/trial-countdown-banner";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import {
  FALLBACK_OVERVIEW,
  parseOverview,
  type OverviewData,
} from "./overview-data";

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export default function AdminOverview() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const { deployMode } = useDeployMode();
  const [data, setData] = useState<OverviewData>(FALLBACK_OVERVIEW);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  async function fetchOverview() {
    const fetchOpts: RequestInit = {
      credentials: isCrossOrigin ? "include" : "same-origin",
    };

    try {
      const response = await fetch(`${apiUrl}/api/v1/admin/overview`, fetchOpts);
      if (cancelledRef.current) return;

      if (!response.ok) {
        setData(FALLBACK_OVERVIEW);
        setError(
          response.status === 401 || response.status === 403
            ? "You don't have access to this workspace overview."
            : "Could not reach the API server. Check that your API is running.",
        );
        return;
      }

      const json = await safeJson(response);
      if (cancelledRef.current) return;
      if (!json) {
        setData(FALLBACK_OVERVIEW);
        setError("Overview response was malformed.");
        return;
      }

      setData(parseOverview(json));
      setError(null);
    } catch {
      if (!cancelledRef.current) {
        setData(FALLBACK_OVERVIEW);
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
      setData(FALLBACK_OVERVIEW);
      setError("Refresh failed. Check that your API server is running.");
    } finally {
      setRefreshing(false);
    }
  }

  const ws = data.workspace;
  // Plan tile description: trial vs paid. The TrialCountdownBanner already
  // surfaces a urgency-tiered banner above the tiles for the days-left
  // case, so the tile itself just labels the tier and a static trial-end
  // date when on trial — no countdown duplication.
  const planDescription =
    ws?.trialEndsAt && ws.planTier === "trial"
      ? `Trial ends ${new Date(ws.trialEndsAt).toLocaleDateString()}`
      : ws
        ? "Active plan"
        : "Self-hosted";

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">
            {ws ? `${ws.name} at a glance` : "Your workspace at a glance"}
          </p>
        </div>
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
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3"
        >
          <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}

      {ws?.trialEndsAt && ws.planTier === "trial" && (
        <div className="mb-4">
          <TrialCountdownBanner
            plan={{ tier: "trial", trialEndsAt: ws.trialEndsAt }}
          />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="shadow-none">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="size-4 rounded" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-20" />
                <Skeleton className="mt-1 h-3 w-32" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            {ws && (
              <StatCard
                title="Workspace"
                value={ws.name}
                icon={<Building2 className="size-4" />}
                description={ws.region ? `Region: ${ws.region}` : ws.slug}
              />
            )}
            {ws && (
              <StatCard
                title="Plan"
                value={ws.planDisplayName}
                icon={<CreditCard className="size-4" />}
                description={planDescription}
              />
            )}
            <StatCard
              title="Queries (24h)"
              value={
                data.queriesLast24h !== null
                  ? data.queriesLast24h.toLocaleString()
                  : "—"
              }
              icon={<Activity className="size-4" />}
              description="Audited queries in your workspace"
            />
            <StatCard
              title="Connections"
              value={data.connections}
              icon={<Server className="size-4" />}
              description="Datasource connections you can use"
            />
            <StatCard
              title="Entities"
              value={data.entities}
              icon={<Database className="size-4" />}
              description="Tables & views in your semantic layer"
            />
            {deployMode !== "saas" && (
              <StatCard
                title="Plugins"
                value={data.plugins}
                icon={<Puzzle className="size-4" />}
                description="Installed plugins"
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
