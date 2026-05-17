"use client";

import Link from "next/link";
import { ArrowRight, LayoutDashboard, AlertCircle } from "lucide-react";
import { getToolResult, isToolComplete } from "../../lib/helpers";
import { Button } from "@/components/ui/button";

/**
 * Render the result of the `createDashboard` tool (#2369).
 *
 * On success the chat surfaces a clear handoff: "Continue editing on the
 * dashboard." The link navigates to `/dashboards/[id]?openChat=true`
 * which the dashboard page reads to auto-open the bound chat drawer so
 * the same conversation resumes in bound mode (per the #2362 PRD's
 * creation-to-bound continuity requirement).
 *
 * On failure (validation or unexpected error) the card renders the
 * sanitized message the tool returned. The error envelope is never
 * raw — see `tools/create-dashboard.ts` for the sanitization rule.
 */

interface CreateDashboardResultOk {
  kind: "ok";
  dashboardId: string;
  title: string;
  description: string | null;
  cardCount: number;
  draft: boolean;
}

interface CreateDashboardResultErr {
  kind: "err";
  error: string;
  validationErrors?: {
    cardIndex: number;
    cardTitle: string;
    error: string;
  }[];
}

type CreateDashboardResult = CreateDashboardResultOk | CreateDashboardResultErr;

function asCreateDashboardResult(value: unknown): CreateDashboardResult | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (
    obj.kind === "ok" &&
    typeof obj.dashboardId === "string" &&
    typeof obj.title === "string"
  ) {
    return value as CreateDashboardResult;
  }
  if (obj.kind === "err" && typeof obj.error === "string") {
    return value as CreateDashboardResult;
  }
  return null;
}

export function CreateDashboardCard({ part }: { part: unknown }) {
  if (!isToolComplete(part)) {
    return (
      <div className="my-2 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
        <LayoutDashboard className="size-3" />
        <span>Creating a dashboard…</span>
      </div>
    );
  }

  const raw = getToolResult(part);
  const result = asCreateDashboardResult(raw);
  if (!result) {
    console.warn("[createDashboard] tool produced no parseable output", raw);
    return (
      <div className="my-2 inline-flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
        <AlertCircle className="mt-0.5 size-3 shrink-0" />
        <span>
          The createDashboard tool returned an unexpected response — ask the
          agent to try again.
        </span>
      </div>
    );
  }

  if (result.kind === "err") {
    return (
      <div className="my-2 flex flex-col gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 size-3 shrink-0" />
          <span>{result.error}</span>
        </div>
        {result.validationErrors && result.validationErrors.length > 0 && (
          <ul className="space-y-0.5 border-t border-red-200/60 pt-1.5 text-[11px] dark:border-red-900/30">
            {result.validationErrors.map((e) => (
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

  const cardLabel = `${result.cardCount} card${result.cardCount === 1 ? "" : "s"}`;

  return (
    <div className="my-2 flex flex-col gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs dark:border-emerald-900/40 dark:bg-emerald-950/20">
      <div className="flex flex-wrap items-center gap-3 text-emerald-800 dark:text-emerald-300">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="size-3.5" />
          <span className="font-medium">{result.title}</span>
          <span className="text-emerald-700/70 dark:text-emerald-400/70">
            · {cardLabel}
            {result.draft && " · staged in your draft"}
          </span>
        </div>
        <Button
          asChild
          size="sm"
          variant="outline"
          className="ml-auto h-7 border-emerald-300 text-xs text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
        >
          <Link
            href={`/dashboards/${result.dashboardId}?openChat=true`}
            aria-label={`Continue editing dashboard ${result.title}`}
          >
            Continue editing
            <ArrowRight className="ml-1 size-3" aria-hidden="true" />
          </Link>
        </Button>
      </div>
      {result.draft && (
        <p className="text-[11px] text-emerald-700/80 dark:text-emerald-400/80">
          The dashboard is yours alone until you publish — cards are visible only
          in your draft.
        </p>
      )}
    </div>
  );
}
