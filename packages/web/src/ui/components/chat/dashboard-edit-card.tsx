"use client";

/**
 * Dashboard edit card (#4322) — first-class receipt rendering for the bound
 * editor's building + inspection tools.
 *
 * Before this, `addCard` / `updateCard` / `updateLayout` /
 * `updateDashboardMeta` / `getDashboardState` / `getCardDetail` /
 * `screenshotDashboard` fell through `ToolPart`'s default branch to a gray
 * "Tool: addCard" box — no signal to the user what the tool did on the
 * canvas. The bound drawer now renders
 * through the shared turn partitioner (activity → receipt), so these results
 * live inside the receipt; this card gives them a labeled, glanceable line
 * (icon + what the tool did) matching the weight of the other tool cards.
 *
 * The tools' `SAFE`-op envelope is `{ kind: "ok" | "err" | "partial", ... }`
 * (see `lib/tools/bound-dashboard.ts`). We render a compact success/summary
 * line or the sanitized error the tool returned — never a raw stack.
 */

import {
  LayoutDashboard,
  PlusSquare,
  Pencil,
  Move,
  FileText,
  Eye,
  AlertCircle,
  type LucideIcon,
} from "lucide-react";
import { getToolName } from "ai";
import { getToolResult, isToolComplete } from "../../lib/helpers";

interface OkCardResult {
  kind: "ok";
  card?: { id?: string; title?: string; chartType?: string; position?: number };
  dashboard?: { title?: string; cardCount?: number };
  summary?: string;
  cardId?: string;
  updated?: string[];
  results?: { cardId: string; ok: boolean }[];
}

interface ErrCardResult {
  kind: "err";
  error: string;
}

interface PartialCardResult {
  kind: "partial";
  results: { cardId: string; ok: boolean; reason?: string }[];
  failedCount: number;
}

type EditResult = OkCardResult | ErrCardResult | PartialCardResult;

function asEditResult(value: unknown): EditResult | null {
  if (value == null || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "ok" || kind === "err" || kind === "partial") return value as EditResult;
  return null;
}

const TOOL_META: Record<string, { icon: LucideIcon; verb: string; active: string }> = {
  getDashboardState: { icon: LayoutDashboard, verb: "Read the dashboard", active: "Reading the dashboard" },
  getCardDetail: { icon: FileText, verb: "Inspected a card", active: "Inspecting a card" },
  addCard: { icon: PlusSquare, verb: "Added a card", active: "Adding a card" },
  updateCard: { icon: Pencil, verb: "Updated a card", active: "Updating a card" },
  updateLayout: { icon: Move, verb: "Rearranged the layout", active: "Rearranging the layout" },
  updateDashboardMeta: { icon: Pencil, verb: "Updated dashboard details", active: "Updating dashboard details" },
  screenshotDashboard: { icon: Eye, verb: "Looked at the dashboard", active: "Looking at the dashboard" },
};

/** Names this card knows how to render — `tool-part.tsx` routes on this set. */
export const DASHBOARD_EDIT_TOOL_NAMES = new Set(Object.keys(TOOL_META));

/** A short, glanceable description of what a successful edit did. */
function summarize(name: string, result: OkCardResult): string {
  switch (name) {
    case "addCard":
      return result.card?.title ? `“${result.card.title}”` : "New card staged in your draft";
    case "getDashboardState":
      return result.dashboard?.cardCount != null
        ? `${result.dashboard.cardCount} card${result.dashboard.cardCount === 1 ? "" : "s"}`
        : "Current state";
    case "getCardDetail":
      return result.card?.title ? `“${result.card.title}”` : "Card detail";
    case "updateCard":
      return result.updated?.length ? `Changed ${result.updated.join(", ")}` : "Card updated";
    case "updateDashboardMeta":
      return result.updated?.length ? `Changed ${result.updated.join(", ")}` : "Details updated";
    case "updateLayout": {
      const moved = result.results?.filter((r) => r.ok).length ?? 0;
      return moved > 0 ? `${moved} card${moved === 1 ? "" : "s"} moved` : "Layout updated";
    }
    case "screenshotDashboard":
      return "Captured the current view";
    default:
      return "Done";
  }
}

export function DashboardEditCard({ part }: { part: unknown }) {
  let name = "";
  try {
    name = getToolName(part as Parameters<typeof getToolName>[0]);
  } catch {
    // intentionally ignored: unknown tool falls back to the generic label below.
  }
  const meta = TOOL_META[name] ?? {
    icon: LayoutDashboard,
    verb: name || "Dashboard edit",
    active: name || "Editing dashboard",
  };
  const Icon = meta.icon;

  if (!isToolComplete(part)) {
    return (
      <div
        data-testid="dashboard-edit-card"
        data-tool={name}
        className="my-1.5 inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
      >
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{meta.active}…</span>
      </div>
    );
  }

  const result = asEditResult(getToolResult(part));

  if (result && result.kind === "err") {
    return (
      <div
        role="alert"
        data-testid="dashboard-edit-card"
        data-tool={name}
        data-state="err"
        className="my-1.5 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400"
      >
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{result.error}</span>
      </div>
    );
  }

  const isPartial = result?.kind === "partial" && result.failedCount > 0;
  const summary = result?.kind === "ok" ? summarize(name, result) : null;

  return (
    <div
      data-testid="dashboard-edit-card"
      data-tool={name}
      data-state={isPartial ? "partial" : "ok"}
      className="my-1.5 inline-flex max-w-full items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
    >
      <Icon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="font-medium text-zinc-700 dark:text-zinc-200">{meta.verb}</span>
      {summary && <span className="truncate text-zinc-500 dark:text-zinc-400">· {summary}</span>}
      {isPartial && result?.kind === "partial" && (
        <span className="text-amber-600 dark:text-amber-400">· {result.failedCount} failed</span>
      )}
    </div>
  );
}
