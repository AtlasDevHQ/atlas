"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { X, Save, Loader2, AlertCircle, ExternalLink, Code2 } from "lucide-react";
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
  | { kind: "error"; error: string; requestId?: string };

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
  // Every 3rd card is full width, the rest are half.
  return { w: idx % 3 === 0 ? 24 : 12, h: 8 };
}

export function DashboardCanvas({ apiUrl, getHeaders, getCredentials }: DashboardCanvasProps) {
  const view = useDashboardCanvasStore((s) => s.view);
  const close = useDashboardCanvasStore((s) => s.close);
  const dark = useDarkMode();

  // Pin transport accessors in refs so effect deps stay stable across parent
  // re-renders — otherwise every parent render re-fires N preview-card fetches.
  const getHeadersRef = useRef(getHeaders);
  const getCredentialsRef = useRef(getCredentials);
  getHeadersRef.current = getHeaders;
  getCredentialsRef.current = getCredentials;

  const [cardStates, setCardStates] = useState<CardState[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [revealedSql, setRevealedSql] = useState<Set<number>>(new Set());

  const spec = view.kind === "open" ? view.spec : null;
  const version = view.kind === "open" ? view.version : 0;

  useEffect(() => {
    if (!spec) return;
    setSavedId(null);
    setSaveError(null);
    setRevealedSql(new Set());
    setCardStates(spec.cards.map(() => ({ kind: "loading" })));
    let cancelled = false;

    spec.cards.forEach((card, i) => {
      fetch(`${apiUrl}/api/v1/dashboards/preview-card`, {
        method: "POST",
        headers: { ...getHeadersRef.current(), "Content-Type": "application/json" },
        credentials: getCredentialsRef.current(),
        body: JSON.stringify({
          sql: card.sql,
          ...(card.connectionId && { connectionId: card.connectionId }),
        }),
      })
        .then(async (r) => {
          const body = (await r.json().catch(() => ({}))) as {
            columns?: string[];
            rows?: Record<string, unknown>[];
            message?: string;
            requestId?: string;
          };
          if (!r.ok) {
            const err = new Error(body.message || `HTTP ${r.status}`) as Error & { requestId?: string };
            if (body.requestId) err.requestId = body.requestId;
            throw err;
          }
          if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) {
            throw new Error("Preview response was missing columns or rows");
          }
          return { columns: body.columns, rows: body.rows };
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
          const requestId = err instanceof Error && "requestId" in err ? (err as { requestId?: string }).requestId : undefined;
          console.warn(
            `[dashboard-canvas] preview failed for card ${i} ("${spec.cards[i]?.title ?? ""}"):`,
            msg,
            requestId ? `[requestId: ${requestId}]` : "",
          );
          setCardStates((prev) =>
            prev.map((s, idx) =>
              idx === i ? { kind: "error", error: msg, ...(requestId && { requestId }) } : s,
            ),
          );
        });
    });

    return () => {
      cancelled = true;
    };
  }, [spec, version, apiUrl]);

  async function handleSave() {
    if (!spec || saving) return;

    // Gate on every card having a successful preview. Cached rows from failed
    // or in-flight cards would otherwise silently land in the saved dashboard.
    if (cardStates.length !== spec.cards.length) {
      setSaveError("Card preview state is out of sync with the proposed spec. Please wait or reload the canvas.");
      return;
    }
    const errored = cardStates
      .map((s, i) => (s?.kind === "error" ? { i, title: spec.cards[i]?.title ?? `Card ${i + 1}` } : null))
      .filter((x): x is { i: number; title: string } => x !== null);
    if (errored.length > 0) {
      const list = errored.map((e) => `"${e.title}"`).join(", ");
      setSaveError(`${errored.length} card${errored.length === 1 ? "" : "s"} failed to preview and cannot be saved: ${list}. Ask the agent to fix these queries first.`);
      return;
    }
    if (cardStates.some((s) => s?.kind !== "ok")) {
      setSaveError("Some cards are still loading — wait for previews to finish before saving.");
      return;
    }

    setSaving(true);
    setSaveError(null);

    let createdId: string | null = null;
    try {
      const headers = { ...getHeadersRef.current(), "Content-Type": "application/json" };
      const credentials = getCredentialsRef.current();

      const createRes = await fetch(`${apiUrl}/api/v1/dashboards`, {
        method: "POST",
        headers,
        credentials,
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
      createdId = created.id;

      // Parallel card creates — independent POSTs, the dashboard already exists.
      const cardResults = await Promise.allSettled(
        spec.cards.map(async (card, i) => {
          const state = cardStates[i];
          const cached =
            state?.kind === "ok"
              ? { cachedColumns: state.columns, cachedRows: state.rows }
              : {};
          const addRes = await fetch(`${apiUrl}/api/v1/dashboards/${created.id}/cards`, {
            method: "POST",
            headers,
            credentials,
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
            throw new Error(body.message || `Add card ${i + 1} ("${card.title}") failed: HTTP ${addRes.status}`);
          }
        }),
      );

      const cardErrors = cardResults
        .map((r, i) => (r.status === "rejected" ? { i, title: spec.cards[i].title, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) } : null))
        .filter((x): x is { i: number; title: string; reason: string } => x !== null);

      if (cardErrors.length > 0) {
        // Rollback: delete the partial dashboard so we don't leave orphans.
        const summary = cardErrors.map((e) => `"${e.title}"`).join(", ");
        try {
          await fetch(`${apiUrl}/api/v1/dashboards/${created.id}`, {
            method: "DELETE",
            headers,
            credentials,
          });
          createdId = null;
        } catch (rollbackErr) {
          console.warn(
            `[dashboard-canvas] failed to rollback partial dashboard ${created.id}:`,
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          );
        }
        throw new Error(`Failed to save ${cardErrors.length} card${cardErrors.length === 1 ? "" : "s"} (${summary}). Partial dashboard was rolled back.`);
      }

      setSavedId(created.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      // If we still have a createdId here, the try-block exited before our
      // own rollback path — best-effort cleanup so the user isn't left with
      // an empty orphan dashboard.
      if (createdId) {
        try {
          await fetch(`${apiUrl}/api/v1/dashboards/${createdId}`, {
            method: "DELETE",
            headers: { ...getHeadersRef.current() },
            credentials: getCredentialsRef.current(),
          });
        } catch {
          // intentionally ignored: rollback is best-effort; saveError already surfaced.
        }
      }
    } finally {
      setSaving(false);
    }
  }

  function toggleSql(idx: number) {
    setRevealedSql((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  if (view.kind !== "open") return null;

  const previewing = cardStates.some((s) => s.kind === "loading");
  const anyErrored = cardStates.some((s) => s?.kind === "error");

  return (
    <aside
      className="flex h-full w-full max-w-[640px] shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
      aria-label="Dashboard canvas"
    >
      <header className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {view.spec.title}
          </p>
          {view.spec.description && (
            <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
              {view.spec.description}
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
          {view.spec.cards.map((card, i) => {
            const layout = defaultLayout(i, card);
            const state = cardStates[i];
            const sqlOpen = revealedSql.has(i);
            return (
              <div
                key={i}
                className={cn(
                  "flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900",
                )}
                style={{
                  // Layout bounds duplicate the CardLayoutSchema invariants
                  // (w ∈ [3, 24]) — server rejects anything outside this range
                  // before it reaches the canvas; clamp defensively for stale
                  // history payloads. Row unit = 16px to match the grid math
                  // in CardLayoutSchema (h ∈ [4, 200]).
                  gridColumn: `span ${Math.max(3, Math.min(24, layout.w))} / span ${Math.max(3, Math.min(24, layout.w))}`,
                  minHeight: `${Math.max(4, layout.h) * 16}px`,
                }}
              >
                <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
                  <p className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    {card.title}
                  </p>
                  <button
                    type="button"
                    onClick={() => toggleSql(i)}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
                      sqlOpen
                        ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                        : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300",
                    )}
                    aria-pressed={sqlOpen}
                    aria-label={sqlOpen ? `Hide SQL for ${card.title}` : `Show SQL for ${card.title}`}
                  >
                    <Code2 className="size-3" />
                    SQL
                  </button>
                </div>
                {sqlOpen && (
                  <pre
                    className="max-h-40 overflow-auto border-b border-zinc-100 bg-zinc-50 px-3 py-2 text-[11px] leading-snug text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                    aria-label={`SQL for ${card.title}`}
                  >
                    {card.sql}
                  </pre>
                )}
                <div className="min-h-0 flex-1 p-2">
                  {state?.kind === "loading" && (
                    <div className="flex h-full items-center justify-center text-xs text-zinc-400 dark:text-zinc-500">
                      <Loader2 className="mr-2 size-3 animate-spin" /> Running query…
                    </div>
                  )}
                  {state?.kind === "error" && (
                    <div className="flex h-full items-start gap-2 rounded-md bg-red-50 px-2 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
                      <AlertCircle className="mt-0.5 size-3 shrink-0" />
                      <div className="break-words">
                        <p>{state.error}</p>
                        {state.requestId && (
                          <p className="mt-1 font-mono text-[10px] text-red-700/70 dark:text-red-400/70">
                            id: {state.requestId}
                          </p>
                        )}
                      </div>
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
                : anyErrored
                  ? "Some cards failed — fix before saving"
                  : `${view.spec.cards.length} card${view.spec.cards.length === 1 ? "" : "s"} ready`}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={close} disabled={saving}>
                Discard
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || previewing || anyErrored}>
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
