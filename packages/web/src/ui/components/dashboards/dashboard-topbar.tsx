"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  RefreshCw,
  Eye,
  Pencil,
  Sparkles,
  Plus,
  Trash2,
  Check,
  X,
  Timer,
  Rows3,
  Rows,
  StretchHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Density } from "./grid-constants";

interface DashboardTopBarProps {
  title: string;
  cardCount: number;
  description: string | null;
  onTitleChange: (next: string) => void;
  refreshing: boolean;
  refreshSchedule: string | null;
  onScheduleChange: (v: string) => void;
  onRefreshAll: () => void;
  onSuggest: () => void;
  suggesting: boolean;
  onDelete: () => void;
  shareSlot: React.ReactNode;
  editing: boolean;
  onEditingChange: (next: boolean) => void;
  density: Density;
  onDensityChange: (next: Density) => void;
}

export function DashboardTopBar({
  title,
  cardCount,
  description,
  onTitleChange,
  refreshing,
  refreshSchedule,
  onScheduleChange,
  onRefreshAll,
  onSuggest,
  suggesting,
  onDelete,
  shareSlot,
  editing,
  onEditingChange,
  density,
  onDensityChange,
}: DashboardTopBarProps) {
  const [titleEditing, setTitleEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  // Resync the draft when the canonical title changes (e.g. after a server save
  // resolves) so a subsequent edit starts from the up-to-date value.
  useEffect(() => {
    if (!titleEditing) setDraft(title);
  }, [title, titleEditing]);

  function commitTitle() {
    const next = draft.trim();
    if (next && next !== title) onTitleChange(next);
    setTitleEditing(false);
  }

  function cancelTitle() {
    setDraft(title);
    setTitleEditing(false);
  }

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-background/95 px-4 py-3 backdrop-blur dark:border-zinc-800 sm:px-6">
      <div className="flex min-w-0 flex-col gap-1">
        <Link
          href="/dashboards"
          className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
        >
          <ArrowLeft className="size-3" />
          All dashboards
        </Link>
        <div className="flex min-w-0 items-center gap-2">
          {titleEditing ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") cancelTitle();
                }}
                className="h-8 min-w-[16ch] text-base font-semibold tracking-tight"
                autoFocus
              />
              <Button variant="ghost" size="icon" className="size-7" onClick={commitTitle}>
                <Check className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7" onClick={cancelTitle}>
                <X className="size-4" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setDraft(title); setTitleEditing(true); }}
              className="cursor-pointer truncate text-left text-lg font-semibold tracking-tight text-zinc-900 hover:text-zinc-700 dark:text-zinc-100 dark:hover:text-zinc-300"
              title="Click to edit title"
            >
              {title}
            </button>
          )}
          {cardCount > 0 && (
            <span className="hidden shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400 sm:inline">
              {cardCount} {cardCount === 1 ? "tile" : "tiles"}
            </span>
          )}
        </div>
        {description && !titleEditing && (
          <p
            className="line-clamp-1 max-w-[60ch] text-xs text-zinc-500 dark:text-zinc-400"
            title={description}
          >
            {description}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Mode"
          className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-100/60 p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors",
              !editing
                ? "bg-background text-foreground shadow-sm"
                : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100",
            )}
            onClick={() => onEditingChange(false)}
            aria-pressed={!editing}
          >
            <Eye className="size-3.5" />
            View
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors",
              editing
                ? "bg-background text-foreground shadow-sm"
                : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100",
            )}
            onClick={() => onEditingChange(true)}
            aria-pressed={editing}
          >
            <Pencil className="size-3.5" />
            Edit
          </button>
        </div>

        <div
          role="group"
          aria-label="Density"
          className="hidden items-center rounded-md border border-zinc-200 bg-zinc-100/60 p-0.5 dark:border-zinc-800 dark:bg-zinc-900 md:inline-flex"
        >
          <DensityButton current={density} value="compact" label="Compact" onChange={onDensityChange}>
            <Rows3 className="size-3.5" />
          </DensityButton>
          <DensityButton current={density} value="comfortable" label="Comfortable" onChange={onDensityChange}>
            <Rows className="size-3.5" />
          </DensityButton>
          <DensityButton current={density} value="spacious" label="Spacious" onChange={onDensityChange}>
            <StretchHorizontal className="size-3.5" />
          </DensityButton>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={onSuggest}
          disabled={suggesting || cardCount === 0}
          className="hidden sm:inline-flex"
        >
          <Sparkles className={cn("mr-1.5 size-3.5", suggesting && "animate-pulse")} />
          {suggesting ? "Thinking..." : "Suggest"}
        </Button>

        <Button variant="outline" size="sm" onClick={onRefreshAll} disabled={refreshing || cardCount === 0}>
          <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
          Refresh
        </Button>

        <Select value={refreshSchedule ?? "off"} onValueChange={onScheduleChange}>
          <SelectTrigger
            aria-label="Auto-refresh schedule"
            className="hidden h-8 w-auto gap-1.5 text-xs md:inline-flex"
          >
            <Timer className="size-3.5 text-zinc-500" />
            <SelectValue placeholder="Auto-refresh" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Auto-refresh: Off</SelectItem>
            <SelectItem value="*/15 * * * *">Every 15 min</SelectItem>
            <SelectItem value="0 * * * *">Every hour</SelectItem>
            <SelectItem value="0 */6 * * *">Every 6 hours</SelectItem>
            <SelectItem value="0 0 * * *">Daily</SelectItem>
            <SelectItem value="0 9 * * 1">Weekly (Mon 9am)</SelectItem>
          </SelectContent>
        </Select>

        {shareSlot}

        <Button
          variant="outline"
          size="sm"
          onClick={onDelete}
          className="text-red-600 hover:text-red-700 dark:text-red-400"
        >
          <Trash2 className="mr-1.5 size-3.5" />
          Delete
        </Button>

        {editing && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/">
              <Plus className="mr-1.5 size-3.5" />
              Add from chat
            </Link>
          </Button>
        )}
      </div>

      {editing && (
        <div className="basis-full pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          Editing — drag tiles to rearrange, drag the bottom-right corner to resize. Press{" "}
          <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-900">
            Esc
          </kbd>{" "}
          to exit.
        </div>
      )}
    </div>
  );
}

function DensityButton({
  current,
  value,
  label,
  onChange,
  children,
}: {
  current: Density;
  value: Density;
  label: string;
  onChange: (v: Density) => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={() => onChange(value)}
      className={cn(
        "inline-flex items-center rounded px-2 py-1 transition-colors",
        active
          ? "bg-background text-primary ring-1 ring-zinc-300 dark:ring-zinc-700"
          : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-100",
      )}
    >
      {children}
    </button>
  );
}
