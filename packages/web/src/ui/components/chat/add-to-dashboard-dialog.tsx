"use client";

import { useState, useEffect, useRef } from "react";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAdminFetch } from "../../hooks/use-admin-fetch";
import { useAdminMutation } from "../../hooks/use-admin-mutation";
import { friendlyError } from "../../lib/fetch-error";
import type { Dashboard, DashboardChartConfig, ChartType } from "../../lib/types";
import { CHART_TYPES } from "../../lib/types";
import type { ChartDetectionResult } from "../chart/chart-detection";

/**
 * Wire shape returned by `/api/v1/admin/connection-groups`. Inline here
 * to avoid widening `@useatlas/types` for a single picker — the admin
 * surface owns its own response type. `resolvedConnectionId` is the
 * "executes against" target the dashboard card will use at view time.
 */
interface ConnectionGroup {
  id: string;
  name: string;
  memberCount: number;
  primaryConnectionId: string | null;
  resolvedConnectionId: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max rows to cache in the card — the card re-executes SQL for live data anyway. */
const MAX_CACHED_ROWS = 100;

const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: "Bar Chart",
  line: "Line Chart",
  pie: "Pie Chart",
  area: "Area Chart",
  scatter: "Scatter Plot",
  table: "Table",
};

/** Chart types from detectCharts() that are valid for dashboard storage. */
const STORABLE_CHART_TYPES = new Set<string>(CHART_TYPES);

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
  /** Called after a card is successfully added to a dashboard. */
  onAdded?: (dashboardId: string, cardId: string) => void;
}

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
  onAdded,
}: AddToDashboardDialogProps) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [selectedDashboardId, setSelectedDashboardId] = useState<string>("");
  const [newDashboardTitle, setNewDashboardTitle] = useState("");
  const [cardTitle, setCardTitle] = useState(explanation ?? "Query result");
  const [chartType, setChartType] = useState<string>("table");
  // Empty string = "no group" (renders as workspace default at view time —
  // matches pre-1.4.4 behavior for orgs that haven't onboarded to env
  // groups yet). Non-empty = group id, resolves to its primary member.
  const [connectionGroupId, setConnectionGroupId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const submittingRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Fetch existing dashboards
  const { data: dashboardData, loading: loadingDashboards, error: fetchError } = useAdminFetch<{
    dashboards: Dashboard[];
    total: number;
  }>("/api/v1/dashboards");

  // Fetch connection groups so the user picks an environment per card
  // rather than a single connection. The picker is optional — an empty
  // selection leaves `connectionGroupId` null on the card, which the
  // refresh path resolves to the workspace default.
  const { data: groupsData } = useAdminFetch<{
    groups: ConnectionGroup[];
  }>("/api/v1/admin/connection-groups");

  const { mutate: createDashboard, saving: creatingDashboard } = useAdminMutation<Dashboard>({});
  const { mutate: addCard, saving: addingCard } = useAdminMutation<{ id: string }>({});

  const saving = creatingDashboard || addingCard;

  // Reset state when dialog opens; clean up timeout on unmount
  useEffect(() => {
    if (open) {
      setCardTitle(explanation ?? "Query result");
      setNewDashboardTitle("");
      setSelectedDashboardId("");
      setConnectionGroupId("");
      setError(null);
      setSuccess(false);
      submittingRef.current = false;
      if (chartResult.chartable && chartResult.recommendations.length > 0) {
        const firstType = chartResult.recommendations[0].type;
        setChartType(STORABLE_CHART_TYPES.has(firstType) ? firstType : "table");
      } else {
        setChartType("table");
      }
    }
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [open]); // intentionally reset only on open

  const dashboards = dashboardData?.dashboards ?? [];
  // Auto-switch to "new" mode when we know there are no dashboards
  const effectiveMode = mode === "existing" && !loadingDashboards && !fetchError && dashboards.length === 0 ? "new" : mode;

  // Single-env workspaces must still materialize the binding even
  // though the picker is hidden — otherwise the card silently falls
  // through to `connections.getDefault()` at refresh time instead of
  // scoping to the group's primary member (#2419, PRD #2342).
  const groups = groupsData?.groups ?? [];
  const soleGroup = groups.length === 1 ? groups[0] : null;
  const boundGroupId = soleGroup ? soleGroup.id : connectionGroupId;
  const boundGroup = boundGroupId ? groups.find((g) => g.id === boundGroupId) ?? null : null;

  // Filter chart recommendations to only storable types
  const storableRecommendations = chartResult.chartable
    ? chartResult.recommendations.filter((r) => STORABLE_CHART_TYPES.has(r.type))
    : [];

  function buildChartConfig(): DashboardChartConfig | null {
    if (chartType === "table" || !chartResult.chartable) return null;

    const rec = storableRecommendations.find((r) => r.type === chartType);
    if (!rec) return null;

    return {
      type: chartType as DashboardChartConfig["type"],
      categoryColumn: rec.categoryColumn.header,
      valueColumns: rec.valueColumns.map((c) => c.header),
    };
  }

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;

    try {
      setError(null);

      if (!cardTitle.trim()) {
        setError("Card title is required.");
        return;
      }

      // The picker / auto-bind readouts warn for empty groups, but a
      // warning alone is a silent-failure on submit — the card would
      // be created bound to a group that `resolveCardConnectionId`
      // can't resolve at refresh time. Block here so the user fixes
      // the membership before persisting (CLAUDE.md "Prefer errors
      // over silent fallbacks").
      if (boundGroup && boundGroup.memberCount === 0) {
        setError(`The "${boundGroup.name}" environment has no connections. Add one in Admin → Connection Groups before adding a card.`);
        return;
      }

      let dashboardId: string;
      let createdNewDashboard = false;

      if (effectiveMode === "new") {
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
          setError(friendlyError(result.error));
          return;
        }
        dashboardId = (result.data as Dashboard).id;
        createdNewDashboard = true;
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
          cachedRows: rows.slice(0, MAX_CACHED_ROWS),
          ...(boundGroupId && { connectionGroupId: boundGroupId }),
        },
      });

      if (!cardResult.ok) {
        if (createdNewDashboard) {
          // Dashboard was created but card failed — guide user to retry
          setError(
            `Dashboard "${newDashboardTitle.trim()}" was created, but adding the card failed: ${friendlyError(cardResult.error)}. ` +
            `Select it from "Existing" to retry.`
          );
          setMode("existing");
          setSelectedDashboardId(dashboardId);
        } else {
          setError(friendlyError(cardResult.error));
        }
        return;
      }

      const cardId = cardResult.data?.id;
      if (cardId) {
        onAdded?.(dashboardId, cardId);
      } else {
        console.warn("Dashboard card created but server response did not include card ID — notebook tracking skipped.");
      }

      setSuccess(true);
      timeoutRef.current = setTimeout(() => onOpenChange(false), 1200);
    } finally {
      submittingRef.current = false;
    }
  }

  function renderDashboardSelector() {
    if (effectiveMode === "new") {
      return (
        <Input
          placeholder="Dashboard title"
          value={newDashboardTitle}
          onChange={(e) => setNewDashboardTitle(e.target.value)}
          autoFocus
        />
      );
    }
    if (loadingDashboards) {
      return (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="size-3 animate-spin" />
          Loading dashboards...
        </div>
      );
    }
    if (fetchError) {
      return (
        <p className="text-xs text-red-500 dark:text-red-400">
          Could not load dashboards. Try closing and reopening this dialog.
        </p>
      );
    }
    if (dashboards.length === 0) {
      return (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          No dashboards yet. Create a new one.
        </p>
      );
    }
    return (
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
    );
  }

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
              <ToggleGroup
                type="single"
                size="sm"
                value={effectiveMode}
                onValueChange={(v) => { if (v) setMode(v as "existing" | "new"); }}
              >
                <ToggleGroupItem value="existing">Existing</ToggleGroupItem>
                <ToggleGroupItem value="new">
                  <Plus className="mr-1 size-3" />
                  New
                </ToggleGroupItem>
              </ToggleGroup>

              {renderDashboardSelector()}
            </div>

            {/* Environment (connection group). Multi-group workspaces get
                the picker. Single-group workspaces get an auto-bound
                readout (the binding is materialized via `boundGroupId`
                — no UI choice to make, but the user sees the target).
                Zero-group workspaces render nothing here and fall
                through to the workspace default (pre-1.4.4 path). */}
            {groups.length > 1 && (
              <div className="grid gap-2">
                <Label htmlFor="connection-group">Environment</Label>
                <Select
                  value={connectionGroupId || "__default__"}
                  onValueChange={(v) => setConnectionGroupId(v === "__default__" ? "" : v)}
                >
                  <SelectTrigger id="connection-group">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">Workspace default</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name} ({g.memberCount} connection{g.memberCount !== 1 ? "s" : ""})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {connectionGroupId && (() => {
                  const picked = groups.find((g) => g.id === connectionGroupId);
                  if (!picked) return null;
                  if (picked.memberCount === 0) {
                    return (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        This environment has no connections. Add one in Admin → Connection Groups before the card can refresh.
                      </p>
                    );
                  }
                  const target = picked.resolvedConnectionId;
                  if (!target) return null;
                  const primaryNote = picked.primaryConnectionId
                    ? "primary member"
                    : "first member (no primary pinned)";
                  return (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Executes against <span className="font-medium">{target}</span> ({primaryNote}).
                    </p>
                  );
                })()}
              </div>
            )}
            {soleGroup && (
              soleGroup.memberCount === 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  The <span className="font-medium">{soleGroup.name}</span> environment has no connections. Add one in Admin → Connection Groups before the card can refresh.
                </p>
              ) : (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Card runs against the {soleGroup.primaryConnectionId ? "primary member" : "first member (no primary pinned)"} of the <span className="font-medium">{soleGroup.name}</span> environment.
                </p>
              )
            )}

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
            {storableRecommendations.length > 0 && (
              <div className="grid gap-2">
                <Label>Visualization</Label>
                <Select value={chartType} onValueChange={setChartType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="table">Table (no chart)</SelectItem>
                    {storableRecommendations.map((rec) => (
                      <SelectItem key={rec.type} value={rec.type}>
                        {CHART_TYPE_LABELS[rec.type as ChartType] ?? rec.type} — {rec.reason}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Error */}
            {(error || fetchError) && (
              <p className="text-xs text-red-500 dark:text-red-400">
                {error ?? "Failed to load dashboards."}
              </p>
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
