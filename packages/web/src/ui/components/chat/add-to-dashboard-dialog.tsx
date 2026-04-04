"use client";

import { useState, useEffect } from "react";
import { z } from "zod";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminFetch } from "../../hooks/use-admin-fetch";
import { useAdminMutation } from "../../hooks/use-admin-mutation";
import type { Dashboard, DashboardChartConfig } from "../../lib/types";
import type { ChartDetectionResult } from "../chart/chart-detection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AddToDashboardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  chartResult: ChartDetectionResult;
  explanation?: string;
}

const CHART_TYPE_LABELS: Record<string, string> = {
  bar: "Bar Chart",
  line: "Line Chart",
  pie: "Pie Chart",
  area: "Area Chart",
  scatter: "Scatter Plot",
  "stacked-bar": "Stacked Bar",
  table: "Table",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddToDashboardDialog({
  open,
  onOpenChange,
  sql,
  columns,
  rows,
  chartResult,
  explanation,
}: AddToDashboardDialogProps) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [selectedDashboardId, setSelectedDashboardId] = useState<string>("");
  const [newDashboardTitle, setNewDashboardTitle] = useState("");
  const [cardTitle, setCardTitle] = useState(explanation ?? "Query result");
  const [chartType, setChartType] = useState<string>("table");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Fetch existing dashboards
  const { data: dashboardData, loading: loadingDashboards } = useAdminFetch<{
    dashboards: Dashboard[];
    total: number;
  }>("/api/v1/dashboards", {
    schema: z.object({
      dashboards: z.array(z.object({
        id: z.string(),
        title: z.string(),
        cardCount: z.number(),
      }).passthrough()),
      total: z.number(),
    }),
  });

  const { mutate: createDashboard, saving: creatingDashboard } = useAdminMutation<Dashboard>();
  const { mutate: addCard, saving: addingCard } = useAdminMutation();

  const saving = creatingDashboard || addingCard;

  // Pre-fill chart type from detection
  useEffect(() => {
    if (open) {
      setCardTitle(explanation ?? "Query result");
      setError(null);
      setSuccess(false);
      if (chartResult.chartable && chartResult.recommendations.length > 0) {
        setChartType(chartResult.recommendations[0].type);
      } else {
        setChartType("table");
      }
      // Default to "new" if no dashboards exist
      if (dashboardData && dashboardData.dashboards.length === 0) {
        setMode("new");
      } else {
        setMode("existing");
      }
    }
  }, [open]); // intentionally reset only on open

  // Build chart config from selected type
  function buildChartConfig(): DashboardChartConfig | null {
    if (chartType === "table" || !chartResult.chartable) return null;

    // Find the recommendation matching the selected type, or use the first one
    const rec = chartResult.recommendations.find((r) => r.type === chartType)
      ?? chartResult.recommendations[0];
    if (!rec) return null;

    return {
      type: chartType as DashboardChartConfig["type"],
      categoryColumn: rec.categoryColumn.header,
      valueColumns: rec.valueColumns.map((c) => c.header),
    };
  }

  async function handleSubmit() {
    setError(null);

    if (!cardTitle.trim()) {
      setError("Card title is required.");
      return;
    }

    let dashboardId: string;

    if (mode === "new") {
      if (!newDashboardTitle.trim()) {
        setError("Dashboard title is required.");
        return;
      }
      const result = await createDashboard({
        path: "/api/v1/dashboards",
        method: "POST",
        body: { title: newDashboardTitle.trim() },
      });
      if (!result.ok) {
        setError(result.error ?? "Failed to create dashboard.");
        return;
      }
      dashboardId = result.data.id;
    } else {
      if (!selectedDashboardId) {
        setError("Select a dashboard.");
        return;
      }
      dashboardId = selectedDashboardId;
    }

    const cardResult = await addCard({
      path: `/api/v1/dashboards/${dashboardId}/cards`,
      method: "POST",
      body: {
        title: cardTitle.trim(),
        sql,
        chartConfig: buildChartConfig(),
        cachedColumns: columns,
        cachedRows: rows,
      },
    });

    if (!cardResult.ok) {
      setError(cardResult.error ?? "Failed to add card.");
      return;
    }

    setSuccess(true);
    setTimeout(() => onOpenChange(false), 1200);
  }

  const dashboards = dashboardData?.dashboards ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to Dashboard</DialogTitle>
          <DialogDescription>
            Save this query result to a dashboard for ongoing monitoring.
          </DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="py-6 text-center text-sm text-green-600 dark:text-green-400">
            Card added successfully!
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            {/* Dashboard selection */}
            <div className="grid gap-2">
              <Label>Dashboard</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMode("existing")}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    mode === "existing"
                      ? "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200"
                      : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                >
                  Existing
                </button>
                <button
                  type="button"
                  onClick={() => setMode("new")}
                  className={`inline-flex items-center gap-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    mode === "new"
                      ? "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200"
                      : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                >
                  <Plus className="size-3" />
                  New
                </button>
              </div>

              {mode === "existing" ? (
                loadingDashboards ? (
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <Loader2 className="size-3 animate-spin" />
                    Loading dashboards...
                  </div>
                ) : dashboards.length === 0 ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    No dashboards yet. Create a new one.
                  </p>
                ) : (
                  <Select value={selectedDashboardId} onValueChange={setSelectedDashboardId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a dashboard" />
                    </SelectTrigger>
                    <SelectContent>
                      {dashboards.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.title} ({d.cardCount} card{d.cardCount !== 1 ? "s" : ""})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              ) : (
                <Input
                  placeholder="Dashboard title"
                  value={newDashboardTitle}
                  onChange={(e) => setNewDashboardTitle(e.target.value)}
                  autoFocus
                />
              )}
            </div>

            {/* Card title */}
            <div className="grid gap-2">
              <Label>Card title</Label>
              <Input
                value={cardTitle}
                onChange={(e) => setCardTitle(e.target.value)}
                placeholder="e.g. Monthly Revenue"
              />
            </div>

            {/* Chart type */}
            {chartResult.chartable && (
              <div className="grid gap-2">
                <Label>Visualization</Label>
                <Select value={chartType} onValueChange={setChartType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="table">Table (no chart)</SelectItem>
                    {chartResult.recommendations.map((rec) => (
                      <SelectItem key={rec.type} value={rec.type}>
                        {CHART_TYPE_LABELS[rec.type] ?? rec.type} — {rec.reason}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
            )}
          </div>
        )}

        {!success && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              Add to Dashboard
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
