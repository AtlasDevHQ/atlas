"use client";

import { useEffect, useState } from "react";
import { Database, Cable, Puzzle } from "lucide-react";
import { useAtlasConfig } from "@/ui/context";
import { StatCard } from "@/ui/components/admin/stat-card";
import { HealthBadge } from "@/ui/components/admin/health-badge";

interface OverviewData {
  connections: number;
  entities: number;
  plugins: number;
  health: "healthy" | "degraded" | "down" | "unknown";
}

const FALLBACK: OverviewData = {
  connections: 0,
  entities: 0,
  plugins: 0,
  health: "unknown",
};

export default function AdminOverview() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [data, setData] = useState<OverviewData>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOpts: RequestInit = {
    credentials: isCrossOrigin ? "include" : "same-origin",
  };

  useEffect(() => {
    let cancelled = false;
    async function fetchOverview() {
      // Fetch both in parallel — use admin overview if available, fall back to health
      const [adminResult, healthResult] = await Promise.allSettled([
        fetch(`${apiUrl}/api/v1/admin/overview`, fetchOpts),
        fetch(`${apiUrl}/api/health`, fetchOpts),
      ]);

      if (cancelled) return;

      if (adminResult.status === "fulfilled" && adminResult.value.ok) {
        const admin = await adminResult.value.json();
        // Admin endpoint doesn't return health — derive it from the health endpoint
        const healthOk = healthResult.status === "fulfilled" && healthResult.value.ok;
        const healthJson = healthOk ? await healthResult.value.json() : null;
        if (!cancelled) {
          setData({
            connections: admin.connections ?? 0,
            entities: admin.entities ?? 0,
            plugins: admin.plugins ?? 0,
            health: healthJson?.status === "ok" ? "healthy" : "degraded",
          });
        }
        return;
      }

      if (healthResult.status === "fulfilled" && healthResult.value.ok) {
        const json = await healthResult.value.json();
        if (!cancelled) {
          setData({
            connections: json?.checks?.datasource?.ok ? 1 : 0,
            entities: FALLBACK.entities,
            plugins: FALLBACK.plugins,
            health: json?.status === "ok" ? "healthy" : "degraded",
          });
        }
        return;
      }

      if (!cancelled) {
        setData({ ...FALLBACK, health: "down" });
        setError("Could not reach the API server. Check that your API is running.");
      }
    }
    fetchOverview().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiUrl]);

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">Monitor your Atlas deployment</p>
        </div>
        <HealthBadge status={data.health} />
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Connections"
          value={loading ? "—" : data.connections}
          icon={<Cable className="size-4" />}
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
