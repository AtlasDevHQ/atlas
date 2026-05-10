"use client";

import { LayoutDashboard, AlertCircle } from "lucide-react";
import { getToolResult, isToolComplete } from "../../lib/helpers";
import {
  useDashboardCanvasStore,
  type ProposedDashboardSpec,
} from "@/lib/stores/dashboard-canvas-store";
import { Button } from "@/components/ui/button";

interface ProposalResult {
  spec?: ProposedDashboardSpec;
  validation?: { allValid: boolean; errors?: { cardTitle: string; error: string }[] };
  error?: string;
}

export function ProposeDashboardCard({ part }: { part: unknown }) {
  const open = useDashboardCanvasStore((s) => s.open);
  const setSpec = useDashboardCanvasStore((s) => s.setSpec);

  if (!isToolComplete(part)) {
    return (
      <div className="my-2 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
        <LayoutDashboard className="size-3" />
        <span>Drafting a dashboard…</span>
      </div>
    );
  }

  const result = getToolResult(part) as ProposalResult | null;
  if (!result) return null;

  if (result.error) {
    return (
      <div className="my-2 inline-flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
        <AlertCircle className="mt-0.5 size-3 shrink-0" />
        <span>{result.error}</span>
      </div>
    );
  }

  const spec = result.spec;
  const cardCount = spec?.cards?.length ?? 0;
  const invalidCount = result.validation?.errors?.length ?? 0;

  return (
    <div className="my-2 flex flex-wrap items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs dark:border-emerald-900/40 dark:bg-emerald-950/20">
      <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
        <LayoutDashboard className="size-3.5" />
        <span className="font-medium">{spec?.title ?? "Dashboard"}</span>
        <span className="text-emerald-700/70 dark:text-emerald-400/70">
          · {cardCount} card{cardCount === 1 ? "" : "s"}
          {invalidCount > 0 && ` · ${invalidCount} need fixing`}
        </span>
      </div>
      {!open && spec && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 border-emerald-300 text-xs text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
          onClick={() => setSpec(spec)}
        >
          Open in canvas
        </Button>
      )}
    </div>
  );
}
