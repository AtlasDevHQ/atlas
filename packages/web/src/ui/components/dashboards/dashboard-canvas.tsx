"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { X, Save, Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDashboardCanvasStore, type ProposedCard } from "@/lib/stores/dashboard-canvas-store";
import { useDarkMode } from "@/ui/hooks/use-dark-mode";
import { cn } from "@/lib/utils";

const ResultChart = dynamic(
  () => import("@/ui/components/chart/result-chart").then((m) => ({ default: m.ResultChart })),
  {
    ssr: false,
    loading: () => <div className="h-full w-full animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800/50" />,
  },
);

type CardState =
  | { kind: "loading" }
  | { kind: "ok"; columns: string[]; rows: Record<string, unknown>[] }
  | { kind: "error"; error: string };

interface DashboardCanvasProps {
  apiUrl: string;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
}

function toStringRows(columns: string[], rows: Record<string, unknown>[]): string[][] {
  return rows.map((row) => columns.map((col) => (row[col] == null ? "" : String(row[col]))));
}

function defaultLayout(idx: number, card: ProposedCard): { w: number; h: number } {
  if (card.layout) return { w: card.layout.w, h: card.layout.h };
  // Auto: alternate full-width / half-width chart heights
  return { w: idx % 3 === 0 ? 24 : 12, h: 8 };
}

export function DashboardCanvas({ apiUrl, getHeaders, getCredentials }: DashboardCanvasProps) {
  const open = useDashboardCanvasStore((s) => s.open);
  const spec = useDashboardCanvasStore((s) => s.spec);
  const version = useDashboardCanvasStore((s) => s.version);
  const close = useDashboardCanvasStore((s) => s.close);
  const dark = useDarkMode();

  const [cardStates, setCardStates] = useState<CardState[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    if (!spec) return;
    setSavedId(null);
    setSaveError(null);
    setCardStates(spec.cards.map(() => ({ kind: "loading" })));
    let cancelled = false;

    spec.cards.forEach((card, i) => {
      fetch(`${apiUrl}/api/v1/dashboards/preview-card`, {
        method: "POST",
        headers: { ...getHeaders(), "Content-Type": "application/json" },
        credentials: getCredentials(),
        body: JSON.stringify({ sql: card.sql }),
      })
        .then(async (r) => {
          const body = (await r.json().catch(() => ({}))) as {
            columns?: string[];
            rows?: Record<string, unknown>[];
            message?: string;
          };
          if (!r.ok) throw new Error(body.message || `HTTP ${r.status}`);
          return body as { columns: string[]; rows: Record<string, unknown>[] };
        })
        .then((data) => {
          if (cancelled) return;
          setCardStates((prev) =>
            prev.map((s, idx) =>
              idx === i ? { kind: "ok", columns: data.columns, rows: data.rows } : s,
            ),
          );
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setCardStates((prev) =>
            prev.map((s, idx) => (idx === i ? { kind: "error", error: msg } : s)),
          );
        });
    });

    return () => {
      cancelled = true;
    };
  }, [spec, version, apiUrl, getHeaders, getCredentials]);

  async function handleSave() {
    if (!spec || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const createRes = await fetch(`${apiUrl}/api/v1/dashboards`, {
        method: "POST",
        headers: { ...getHeaders(), "Content-Type": "application/json" },
        credentials: getCredentials(),
        body: JSON.stringify({
          title: spec.title,
          description: spec.description ?? null,
        }),
      });
      if (!createRes.ok) {
        const body = (await createRes.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || `Create failed: HTTP ${createRes.status}`);
      }
      const created = (await createRes.json()) as { id: string };

      for (let i = 0; i < spec.cards.length; i++) {
        const card = spec.cards[i];
        const state = cardStates[i];
        const cached =
          state?.kind === "ok"
            ? { cachedColumns: state.columns, cachedRows: state.rows }
            : {};
        const addRes = await fetch(`${apiUrl}/api/v1/dashboards/${created.id}/cards`, {
          method: "POST",
          headers: { ...getHeaders(), "Content-Type": "application/json" },
          credentials: getCredentials(),
          body: JSON.stringify({
            title: card.title,
            sql: card.sql,
            chartConfig: card.chartConfig,
            layout: card.layout ?? null,
            ...cached,
          }),
        });
        if (!addRes.ok) {
          const body = (await addRes.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message || `Add card ${i + 1} failed: HTTP ${addRes.status}`);
        }
      }

      setSavedId(created.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }

  if (!open || !spec) return null;

  const previewing = cardStates.some((s) => s.kind === "loading");

  return (
    <aside
      className="flex h-full w-full max-w-[640px] shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
      aria-label="Dashboard canvas"
    >
      <header className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {spec.title}
          </p>
          {spec.description && (
            <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
              {spec.description}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          className="size-8 text-zinc-500 dark:text-zinc-400"
          aria-label="Close canvas"
        >
          <X className="size-4" />
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-3 p-4">
          {spec.cards.map((card, i) => {
            const layout = defaultLayout(i, card);
            const state = cardStates[i];
            return (
              <div
                key={i}
                className={cn(
                  "flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900",
                )}
                style={{
                  gridColumn: `span ${Math.max(3, Math.min(24, layout.w))} / span ${Math.max(3, Math.min(24, layout.w))}`,
                  minHeight: `${Math.max(4, layout.h) * 16}px`,
                }}
              >
                <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
                  <p className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    {card.title}
                  </p>
                </div>
                <div className="min-h-0 flex-1 p-2">
                  {state?.kind === "loading" && (
                    <div className="flex h-full items-center justify-center text-xs text-zinc-400 dark:text-zinc-500">
                      <Loader2 className="mr-2 size-3 animate-spin" /> Running query…
                    </div>
                  )}
                  {state?.kind === "error" && (
                    <div className="flex h-full items-start gap-2 rounded-md bg-red-50 px-2 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
                      <AlertCircle className="mt-0.5 size-3 shrink-0" />
                      <span className="break-words">{state.error}</span>
                    </div>
                  )}
                  {state?.kind === "ok" && state.rows.length > 0 && (
                    <ResultChart
                      key={`${i}-${version}`}
                      headers={state.columns}
                      rows={toStringRows(state.columns, state.rows)}
                      dark={dark}
                    />
                  )}
                  {state?.kind === "ok" && state.rows.length === 0 && (
                    <div className="flex h-full items-center justify-center text-xs text-zinc-400 dark:text-zinc-500">
                      Query returned no rows
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      <footer className="flex flex-col gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
        {saveError && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
            {saveError}
          </div>
        )}
        {savedId ? (
          <div className="flex items-center justify-between rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
            <span>Saved.</span>
            <Link
              href={`/dashboards/${savedId}`}
              className="inline-flex items-center gap-1 font-medium hover:underline"
            >
              Open <ExternalLink className="size-3" />
            </Link>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {previewing
                ? "Running queries…"
                : `${spec.cards.length} card${spec.cards.length === 1 ? "" : "s"} ready`}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={close} disabled={saving}>
                Discard
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || previewing}>
                {saving ? (
                  <>
                    <Loader2 className="mr-1 size-3 animate-spin" /> Saving
                  </>
                ) : (
                  <>
                    <Save className="mr-1 size-3" /> Save dashboard
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </footer>
    </aside>
  );
}
