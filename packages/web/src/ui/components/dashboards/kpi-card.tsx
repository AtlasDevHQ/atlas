"use client";

import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DashboardCard, DashboardKpiValueFormat, KpiComparisonResult } from "@/ui/lib/types";

// ---------------------------------------------------------------------------
// KPI / scorecard card (#3137).
//
// A compact tile: a big formatted number, an optional delta chip (▲/▼ + %)
// computed against a comparison query, and an optional sparkline when the
// primary query returns a trend rather than a single row. The comparison
// number is delivered by the `/render` endpoint (which runs `comparisonSql`
// through the same SQL guard) and extracted here with the SAME logic as the
// headline value, so the two can't diverge.
// ---------------------------------------------------------------------------

/**
 * Pull a single finite number out of a query result. Reads the LAST row (so a
 * trend query's most-recent point is the headline), preferring `preferredColumn`
 * and falling back to the first column that holds a finite number. `pg`'s
 * `numeric`/`bigint` columns arrive as strings, so coerce via `Number`. Returns
 * `null` when no usable number is present.
 */
export function extractKpiNumber(
  columns: string[],
  rows: Record<string, unknown>[],
  preferredColumn?: string,
): number | null {
  if (rows.length === 0) return null;
  const row = rows[rows.length - 1];

  const coerce = (raw: unknown): number | null => {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  if (preferredColumn && preferredColumn in row) {
    const preferred = coerce(row[preferredColumn]);
    if (preferred !== null) return preferred;
  }
  for (const col of columns) {
    const n = coerce(row[col]);
    if (n !== null) return n;
  }
  return null;
}

export type KpiDelta = { pct: number; direction: "up" | "down" | "flat" };

/**
 * Percent change from `prior` to `current`. Returns `null` when there's nothing
 * to show: either value missing (no comparison data), or a divide-by-zero
 * (`prior === 0` while `current !== 0` — no finite percentage exists). Equal
 * values (including 0 → 0) report `flat`. A negative prior uses its magnitude
 * so the sign reflects direction of change, not the sign of the base.
 */
export function computeKpiDelta(current: number | null, prior: number | null): KpiDelta | null {
  if (current === null || prior === null) return null;
  if (current === prior) return { pct: 0, direction: "flat" };
  if (prior === 0) return null; // divide-by-zero — no finite percentage
  const pct = ((current - prior) / Math.abs(prior)) * 100;
  if (!Number.isFinite(pct)) return null;
  return { pct, direction: current > prior ? "up" : "down" };
}

/** Render `seconds` as a compact two-unit duration (`1h 1m`, `3m 4s`, `45s`). */
function formatDuration(seconds: number): string {
  const total = Math.round(Math.abs(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h < 24) return min ? `${h}h ${min}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}

const COMPACT_NUMBER = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const COMPACT_CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const PERCENT_NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * Format the KPI headline number per its `valueFormat`. `null`/non-finite →
 * an em-dash placeholder. `percent` treats the value as a ready-to-display
 * figure (SQL returns `12.3` → `12.3%`, not `0.123`).
 */
export function formatKpiValue(value: number | null, format?: DashboardKpiValueFormat): string {
  if (value === null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "currency":
      return COMPACT_CURRENCY.format(value);
    case "percent":
      return `${PERCENT_NUMBER.format(value)}%`;
    case "duration":
      return formatDuration(value);
    case "number":
    default:
      return COMPACT_NUMBER.format(value);
  }
}

/** True when a card is a KPI card that declares a comparison query (#3137).
 *  A text card (`chartConfig: null`) or a non-KPI chart card is never a match. */
export function hasKpiComparison(card: Pick<DashboardCard, "chartConfig">): boolean {
  return card.chartConfig?.type === "kpi" && !!card.chartConfig?.kpi?.comparisonSql;
}

/**
 * Stable signature of a dashboard's KPI-comparison set — one `[id, sql]` tuple
 * per KPI card that has a comparison query. The dashboard page keys its
 * default-comparison fetch effect on this so it re-runs ONLY when a KPI card's
 * comparison query is added, removed, or edited — an unrelated refetch (a stage
 * change, a layout save) leaves the signature unchanged and doesn't re-fire
 * every comparison query.
 *
 * Sorted by id and JSON-serialized so the signature is order-INDEPENDENT (a
 * card reorder must not refetch) and collision-safe: SQL can legally contain
 * the `:`/`|` characters a naive delimiter-join would conflate.
 */
export function kpiComparisonSignature(
  cards: Array<Pick<DashboardCard, "id" | "chartConfig">>,
): string {
  return JSON.stringify(
    cards
      .filter(hasKpiComparison)
      .map((c) => [c.id, c.chartConfig?.kpi?.comparisonSql ?? ""] as const)
      .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId)),
  );
}

/** Inline SVG sparkline — a single polyline over the series, normalized to the
 *  viewBox. Decorative (`aria-hidden`); the headline number carries the value. */
function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const W = 100;
  const H = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const points = values
    .map((v, i) => {
      const x = i * step;
      // Invert Y so larger values sit higher; pad 2px top/bottom.
      const y = H - 2 - ((v - min) / span) * (H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      data-testid="kpi-sparkline"
      aria-hidden="true"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("h-7 w-full text-emerald-500/70 dark:text-emerald-400/70", className)}
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const DELTA_STYLES: Record<KpiDelta["direction"], string> = {
  up: "text-emerald-600 dark:text-emerald-400",
  down: "text-red-600 dark:text-red-400",
  flat: "text-zinc-500 dark:text-zinc-400",
};

const DELTA_ICON: Record<KpiDelta["direction"], typeof ArrowUp> = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
};

/**
 * The slice of a card a KPI tile actually reads. A structural subset of
 * `DashboardCard` so both the admin tile (full `DashboardCard`) and the shared
 * public view (`SharedCard`) can render the same component.
 */
export type KpiCardData = Pick<DashboardCard, "chartConfig" | "cachedColumns" | "cachedRows">;

export interface KpiCardProps {
  card: KpiCardData;
  /** Comparison query result from `/render`; `null`/undefined → no delta chip. */
  comparison?: KpiComparisonResult | null;
}

/**
 * Renders a KPI card body (no tile chrome — the surrounding tile owns the
 * header/footer). Reuses {@link extractKpiNumber} for both the headline value
 * (from the card's cached/rendered rows) and the comparison value.
 */
export function KpiCard({ card, comparison }: KpiCardProps) {
  const config = card.chartConfig;
  const valueColumn = config?.valueColumns?.[0];
  const columns = card.cachedColumns ?? [];
  const rows = (card.cachedRows ?? []) as Record<string, unknown>[];

  const value = extractKpiNumber(columns, rows, valueColumn);
  const priorValue = comparison ? extractKpiNumber(comparison.columns, comparison.rows, valueColumn) : null;
  const delta = computeKpiDelta(value, priorValue);

  const valueFormat = config?.kpi?.valueFormat;
  const comparisonLabel = config?.kpi?.comparisonLabel;

  // Sparkline series: the value column across every row, in order. Only shown
  // when the primary query returns a trend (≥2 finite points).
  const series = rows
    .map((r) => extractKpiNumber(columns, [r], valueColumn))
    .filter((n): n is number => n !== null);
  const showSparkline = series.length >= 2;

  const DeltaIcon = delta ? DELTA_ICON[delta.direction] : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-2 px-1 py-1">
      <div
        data-testid="kpi-value"
        className="text-3xl font-semibold leading-none tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50"
        title={value === null ? undefined : String(value)}
      >
        {formatKpiValue(value, valueFormat)}
      </div>

      {delta && DeltaIcon && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            data-testid="kpi-delta"
            data-direction={delta.direction}
            className={cn(
              "inline-flex items-center gap-0.5 text-sm font-medium tabular-nums",
              DELTA_STYLES[delta.direction],
            )}
            aria-label={`${delta.direction === "up" ? "Up" : delta.direction === "down" ? "Down" : "No change"} ${PERCENT_NUMBER.format(Math.abs(delta.pct))} percent`}
          >
            <DeltaIcon className="size-3.5 shrink-0" aria-hidden />
            {PERCENT_NUMBER.format(Math.abs(delta.pct))}%
          </span>
          {comparisonLabel && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{comparisonLabel}</span>
          )}
        </div>
      )}

      {showSparkline && <Sparkline values={series} />}
    </div>
  );
}
