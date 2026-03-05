"use client";

import { useAtlasConfig } from "@/ui/context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HealthBadge } from "@/ui/components/admin/health-badge";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { Cable, Loader2 } from "lucide-react";
import { useAdminFetch, useInProgressSet, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useState } from "react";

// ── Types ─────────────────────────────────────────────────────────

interface ConnectionHealth {
  status: "healthy" | "degraded" | "unhealthy";
  latencyMs: number;
  message?: string;
  checkedAt: string;
}

interface ConnectionMetadata {
  id: string;
  dbType:
    | "postgres"
    | "mysql"
    | "clickhouse"
    | "snowflake"
    | "duckdb"
    | "salesforce";
  description?: string;
  health?: ConnectionHealth;
}

// ── Helpers ───────────────────────────────────────────────────────

function mapHealthStatus(
  status?: ConnectionHealth["status"]
): "healthy" | "degraded" | "down" | "unknown" {
  if (!status) return "unknown";
  if (status === "unhealthy") return "down";
  return status;
}

// ── Page ──────────────────────────────────────────────────────────

export default function ConnectionsPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const testing = useInProgressSet();
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { data: connections, loading, error, refetch } = useAdminFetch<ConnectionMetadata[]>(
    "/api/v1/admin/connections",
    { transform: (json) => (json as { connections?: ConnectionMetadata[] }).connections ?? [] },
  );

  const [localConnections, setLocalConnections] = useState<ConnectionMetadata[] | null>(null);
  const displayConnections = localConnections ?? connections ?? [];

  if (connections && localConnections !== null && connections !== localConnections) {
    setLocalConnections(null);
  }

  // Gate: 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-b px-6 py-4">
          <h1 className="text-2xl font-bold tracking-tight">Connections</h1>
          <p className="text-sm text-muted-foreground">Manage datasource connections</p>
        </div>
        <FeatureGate status={error.status as 401 | 403 | 404} feature="Connections" />
      </div>
    );
  }

  async function testConnection(id: string) {
    testing.start(id);
    setMutationError(null);
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/connections/${encodeURIComponent(id)}/test`,
        { credentials, method: "POST" }
      );
      if (!res.ok) throw new Error(`Test failed (HTTP ${res.status})`);
      const result: ConnectionHealth = await res.json();
      setLocalConnections((prev) =>
        (prev ?? displayConnections).map((c) =>
          c.id === id ? { ...c, health: result } : c
        )
      );
    } catch (err) {
      setMutationError(
        `Connection test failed for "${id}": ${err instanceof Error ? err.message : "Network error"}`
      );
    } finally {
      testing.stop(id);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Connections</h1>
        <p className="text-sm text-muted-foreground">Manage datasource connections</p>
      </div>

      <div className="flex-1 overflow-auto">
        {error && <ErrorBanner message={friendlyError(error)} onRetry={refetch} />}
        {mutationError && <ErrorBanner message={mutationError} onRetry={() => setMutationError(null)} />}

        {loading ? (
          <LoadingState message="Loading connections..." />
        ) : displayConnections.length === 0 && !error ? (
          <div className="p-6">
            <EmptyState icon={Cable} message="No connections configured" />
          </div>
        ) : displayConnections.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead className="w-[100px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayConnections.map((conn) => (
                <TableRow key={conn.id}>
                  <TableCell className="font-mono text-xs">{conn.id}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{conn.dbType}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {conn.description ?? "—"}
                  </TableCell>
                  <TableCell>
                    <HealthBadge status={mapHealthStatus(conn.health?.status)} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {conn.health ? `${conn.health.latencyMs}ms` : "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={testing.has(conn.id)}
                      onClick={() => testConnection(conn.id)}
                    >
                      {testing.has(conn.id) ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        "Test"
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </div>
    </div>
  );
}
