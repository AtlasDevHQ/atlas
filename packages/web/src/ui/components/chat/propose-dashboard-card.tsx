"use client";

import { LayoutDashboard, AlertCircle } from "lucide-react";
import { getToolResult, isToolComplete } from "../../lib/helpers";
import { useDashboardCanvasStore } from "@/lib/stores/dashboard-canvas-store";
import type {
  ProposedDashboardSpec,
  ProposedCardValidationError,
} from "@useatlas/types";
import { Button } from "@/components/ui/button";

interface ProposalResultOk {
  kind: "ok";
  spec: ProposedDashboardSpec;
  validation: { allValid: boolean; errors: ProposedCardValidationError[] };
}

interface ProposalResultErr {
  kind: "err";
  error: string;
}

type ProposalResult = ProposalResultOk | ProposalResultErr;

function asProposalResult(value: unknown): ProposalResult | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.kind === "ok" && typeof obj.spec === "object" && obj.spec !== null) {
    return value as ProposalResult;
  }
  if (obj.kind === "err" && typeof obj.error === "string") {
    return value as ProposalResult;
  }
  return null;
}

export function ProposeDashboardCard({ part }: { part: unknown }) {
  const view = useDashboardCanvasStore((s) => s.view);
  const setSpec = useDashboardCanvasStore((s) => s.setSpec);

  if (!isToolComplete(part)) {
    return (
      <div className="my-2 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
        <LayoutDashboard className="size-3" />
        <span>Drafting a dashboard…</span>
      </div>
    );
  }

  const raw = getToolResult(part);
  const result = asProposalResult(raw);
  if (!result) {
    console.warn("[proposeDashboard] tool produced no parseable output", raw);
    return (
      <div className="my-2 inline-flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
        <AlertCircle className="mt-0.5 size-3 shrink-0" />
        <span>Dashboard proposal returned an unexpected response — try asking the agent to re-emit.</span>
      </div>
    );
  }

  if (result.kind === "err") {
    return (
      <div className="my-2 inline-flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
        <AlertCircle className="mt-0.5 size-3 shrink-0" />
        <span>{result.error}</span>
      </div>
    );
  }

  const { spec, validation } = result;
  const cardCount = spec.cards.length;
  const isOpen = view.kind === "open" && view.spec === spec;
  const errors = validation.errors;

  return (
    <div className="my-2 flex flex-col gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs dark:border-emerald-900/40 dark:bg-emerald-950/20">
      <div className="flex flex-wrap items-center gap-3 text-emerald-800 dark:text-emerald-300">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="size-3.5" />
          <span className="font-medium">{spec.title}</span>
          <span className="text-emerald-700/70 dark:text-emerald-400/70">
            · {cardCount} card{cardCount === 1 ? "" : "s"}
            {errors.length > 0 && ` · ${errors.length} need${errors.length === 1 ? "s" : ""} fixing`}
          </span>
        </div>
        {!isOpen && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 border-emerald-300 text-xs text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
            onClick={() => setSpec(spec)}
          >
            Open in canvas
          </Button>
        )}
      </div>
      {errors.length > 0 && (
        <ul className="space-y-0.5 border-t border-emerald-200/60 pt-1.5 text-[11px] text-red-700 dark:border-emerald-900/30 dark:text-red-400">
          {errors.map((e) => (
            <li key={e.cardIndex} className="flex items-start gap-1.5">
              <AlertCircle className="mt-0.5 size-3 shrink-0" />
              <span>
                <span className="font-medium">{e.cardTitle}:</span> {e.error}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
