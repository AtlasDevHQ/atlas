"use client";

import { type ComponentType, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* ────────────────────────────────────────────────────────────────────────
 *  Section chrome shared by the three connection categories (Databases /
 *  REST APIs / Apps & CRM). Keeps the eyebrow heading, the count line, the
 *  demo-gated "+ Add" button, and the per-section empty hint consistent.
 * ──────────────────────────────────────────────────────────────────────── */

/** Tooltip shown on a disabled "+ Add" while a demo connection holds the
 *  workspace in read-only published mode. */
export const DEMO_ADD_TOOLTIP =
  "Delete the demo connection or switch to developer mode to add a new one";

/** Compose a "N connected · M live" line, omitting the live clause when it
 *  isn't meaningful (REST/Salesforce don't report a health-rollup). */
export function countLine(connected: number, live?: number): string {
  if (live === undefined) return `${connected} connected`;
  return `${connected} connected · ${live} live`;
}

export function SectionHeader({
  title,
  count,
  action,
}: {
  title: string;
  /** The count line (use {@link countLine}); omitted while loading. */
  count?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
        {count != null && (
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground/80">{count}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/** The "+ Add …" button. Disabled + tooltip-wrapped while a demo is read-only. */
export function AddDatasourceButton({
  label,
  onClick,
  demoReadOnly,
  demoTooltip,
  testId,
}: {
  label: string;
  onClick: () => void;
  demoReadOnly: boolean;
  demoTooltip: string;
  testId?: string;
}) {
  if (demoReadOnly) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>
              <Button size="sm" variant="outline" disabled>
                <Plus className="mr-1.5 size-3.5" />
                {label}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{demoTooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return (
    <Button size="sm" variant="outline" onClick={onClick} data-testid={testId}>
      <Plus className="mr-1.5 size-3.5" />
      {label}
    </Button>
  );
}

/** Slim per-section empty state: an icon, a line of copy, and an add CTA. */
export function SectionEmpty({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card/20 px-6 py-8 text-center">
      <span className="grid size-9 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
