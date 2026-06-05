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

/** Colour intent of a delta chip — independent of the arrow direction. */
export type DeltaTone = "positive" | "negative" | "neutral";

/**
 * Map a delta direction to a colour tone (#3207). For a normal
 * higher-is-better metric an INCREASE is positive (green) and a decrease
 * negative (red). When `inverse` is set — a lower-is-better metric like churn,
 * latency, or cost — the mapping flips: a DECREASE is the good outcome. `flat`
 * is always neutral. The direction arrow always tracks the real change; only
 * the tone responds to `inverse`.
 */
export function deltaTone(direction: KpiDelta["direction"], inverse = false): DeltaTone {
  if (direction === "flat") return "neutral";
  const improved = inverse ? direction === "down" : direction === "up";
  return improved ? "positive" : "negative";
}

/**
 * Where a KPI's headline value sits relative to its goal threshold (#3208).
 * A KPI card shows ONE target, so this reads the first threshold only.
 */
export type KpiTargetStatus = "above" | "below" | "at";

/**
 * Resolve a KPI card's single goal threshold against the headline value.
 * Returns `null` when there's no value or no usable (finite) threshold, so a
 * card with no threshold renders exactly as before (#3208 back-compat).
 */
export function kpiTargetStatus(
  value: number | null,
  thresholdValue: number | undefined,
): KpiTargetStatus | null {
  // Guard BOTH operands for finiteness — the sole call site feeds a value from
  // `extractKpiNumber` (already finite-or-null), but as an exported helper this
  // must be correct for any caller: `kpiTargetStatus(NaN, 100)` is undeterminable,
  // not "at".
  if (
    value === null ||
    !Number.isFinite(value) ||
    thresholdValue === undefined ||
    !Number.isFinite(thresholdValue)
  ) {
    return null;
  }
  if (value > thresholdValue) return "above";
  if (value < thresholdValue) return "below";
  return "at";
}

/**
 * Colour tone for a KPI target callout (#3208). For a normal higher-is-better
 * metric, ABOVE target is the good outcome (green) and below is bad (red).
 * `inverse` (lower-is-better — cost, churn, latency) flips it: BELOW target is
 * good. `at` target is always neutral. Mirrors {@link deltaTone}'s `inverse`
 * handling so the target callout and the delta chip agree on direction.
 */
export function kpiTargetTone(status: KpiTargetStatus, inverse = false): DeltaTone {
  if (status === "at") return "neutral";
  const good = inverse ? status === "below" : status === "above";
  return good ? "positive" : "negative";
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

/** True when a card is a KPI card that produces a comparison delta — either a
 *  hand-written `comparisonSql` (#3137) or an automatic period-over-period
 *  comparison (#3207). A text card (`chartConfig: null`) or a non-KPI chart
 *  card is never a match. The dashboard page uses this to decide which cards
 *  need a comparison fetched at view time. */
export function hasKpiComparison(card: Pick<DashboardCard, "chartConfig">): boolean {
  if (card.chartConfig?.type !== "kpi") return false;
  const kpi = card.chartConfig.kpi;
  return !!kpi && (!!kpi.comparisonSql || kpi.autoComparison === true);
}

/** The fetch-affecting comparison config of a KPI card — what the `/render`
 *  endpoint actually runs. The client-only `inverse` (colour) is excluded: it
 *  changes how the delta is painted, not what's fetched, so toggling it must NOT
 *  refetch.
 *
 *  For `autoComparison` the prior-period query IS the card's OWN `sql` (run
 *  against the shifted window), so the primary SQL is part of the key — editing
 *  it must move the signature and re-fetch, or the delta would keep comparing
 *  against the stale prior-period result. For a hand-written `comparisonSql` the
 *  query is captured directly. */
function comparisonKey(card: Pick<DashboardCard, "chartConfig" | "sql">): unknown {
  const kpi = card.chartConfig?.kpi;
  return {
    sql: kpi?.comparisonSql ?? "",
    autoSql: kpi?.autoComparison ? card.sql : "",
    params: kpi?.comparisonDateParams ?? null,
  };
}

/**
 * Stable signature of a dashboard's KPI-comparison set — one `[id, key]` tuple
 * per KPI card that produces a comparison delta. The dashboard page keys its
 * default-comparison fetch effect on this so it re-runs ONLY when a KPI card's
 * comparison config (or, for auto cards, its primary SQL) is added, removed, or
 * edited — an unrelated refetch (a stage change, a layout save) leaves the
 * signature unchanged and doesn't re-fire every comparison query.
 *
 * Sorted by id and JSON-serialized so the signature is order-INDEPENDENT (a
 * card reorder must not refetch) and collision-safe: SQL can legally contain
 * the `:`/`|` characters a naive delimiter-join would conflate.
 */
export function kpiComparisonSignature(
  cards: Array<Pick<DashboardCard, "id" | "chartConfig" | "sql">>,
): string {
  return JSON.stringify(
    cards
      .filter(hasKpiComparison)
      .map((c) => [c.id, comparisonKey(c)] as const)
      .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId)),
  );
}

/**
 * Pure geometry for the sparkline (#3207): project a numeric series onto a
 * `W × H` viewBox, returning the polyline `points` string. Y is inverted so
 * larger values sit higher, with `pad`px of head/foot room.
 *
 * Returns `null` when there's no line to draw (fewer than two FINITE points —
 * a single-row scorecard, or a series of nulls/NaNs). A FLAT series (every
 * value equal) is centred vertically rather than pinned to the bottom edge,
 * which is what the naive `(v - min) / (max - min || 1)` produced.
 */
export function sparklineGeometry(values: number[], w = 100, h = 28): string | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return null;
  const pad = 2;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  const step = w / (finite.length - 1);
  return finite
    .map((v, i) => {
      const x = i * step;
      // Flat series → centre line (t = 0.5); otherwise normalize into [0, 1].
      const t = span === 0 ? 0.5 : (v - min) / span;
      const y = h - pad - t * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Stroke colour of the sparkline by delta tone — muted so it reads as
 *  decoration, not a second metric. Falls back to a neutral slate. */
const SPARKLINE_TONE: Record<DeltaTone, string> = {
  positive: "text-emerald-500/70 dark:text-emerald-400/70",
  negative: "text-red-500/70 dark:text-red-400/70",
  neutral: "text-zinc-400/80 dark:text-zinc-500/80",
};

/** Inline SVG sparkline — a single polyline over the series, tinted by delta
 *  tone. Decorative (`aria-hidden`); the headline number carries the value.
 *  `preserveAspectRatio="none"` stretches the line to fill the card width, so a
 *  non-scaling stroke keeps the line weight constant (and we avoid point
 *  markers, which the non-uniform scale would distort into ellipses). Renders
 *  nothing when {@link sparklineGeometry} has no line to draw. */
function Sparkline({ values, tone = "neutral", className }: { values: number[]; tone?: DeltaTone; className?: string }) {
  const W = 100;
  const H = 28;
  const points = sparklineGeometry(values, W, H);
  if (!points) return null;
  return (
    <svg
      data-testid="kpi-sparkline"
      aria-hidden="true"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("h-7 w-full", SPARKLINE_TONE[tone], className)}
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Delta-chip text colour by tone (#3207). */
const TONE_STYLES: Record<DeltaTone, string> = {
  positive: "text-emerald-600 dark:text-emerald-400",
  negative: "text-red-600 dark:text-red-400",
  neutral: "text-zinc-500 dark:text-zinc-400",
};

/** Default headline colour — used when a KPI card has no goal threshold (#3208). */
const KPI_VALUE_DEFAULT = "text-zinc-900 dark:text-zinc-50";

/**
 * Headline-number colour by target tone (#3208). A positive/negative tone tints
 * the big number green/red; `neutral` (value sits AT the target) keeps the
 * default headline colour so an on-target metric reads normally.
 */
const TARGET_VALUE_STYLES: Record<DeltaTone, string> = {
  positive: "text-emerald-600 dark:text-emerald-400",
  negative: "text-red-600 dark:text-red-400",
  neutral: KPI_VALUE_DEFAULT,
};

/** Verdict word for the target callout by status (#3208). `above`/`below` map
 *  to themselves; only `at` is reworded. A lookup (vs. a nested ternary) matches
 *  the `TONE_STYLES` / `DELTA_ICON` maps in this file. */
const TARGET_STATUS_LABEL: Record<KpiTargetStatus, string> = {
  above: "above",
  below: "below",
  at: "on target",
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
  const inverse = config?.kpi?.inverse ?? false;
  const tone: DeltaTone = delta ? deltaTone(delta.direction, inverse) : "neutral";

  // #3208 — goal line / target. A KPI card shows ONE target (the first
  // threshold); when present, it colours the headline number above/below target
  // and renders a target callout. Absent → the number keeps its default colour
  // and no callout shows (back-compat). The `inverse` flag flips which side is
  // "good", exactly as it does for the delta chip.
  const target = config?.thresholds?.[0];
  const targetStatus = target ? kpiTargetStatus(value, target.value) : null;
  const targetTone: DeltaTone | null = targetStatus ? kpiTargetTone(targetStatus, inverse) : null;
  const valueClass = targetTone ? TARGET_VALUE_STYLES[targetTone] : KPI_VALUE_DEFAULT;

  // Sparkline series: the value column across every row, in order. The geometry
  // helper (below) hides it when there's no trend (a single-row scorecard).
  const series = rows
    .map((r) => extractKpiNumber(columns, [r], valueColumn))
    .filter((n): n is number => n !== null);

  const DeltaIcon = delta ? DELTA_ICON[delta.direction] : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-2 px-1 py-1">
      <div
        data-testid="kpi-value"
        data-target-status={targetStatus ?? undefined}
        data-target-tone={targetTone ?? undefined}
        className={cn(
          "text-3xl font-semibold leading-none tracking-tight tabular-nums",
          valueClass,
        )}
        title={value === null ? undefined : String(value)}
      >
        {formatKpiValue(value, valueFormat)}
      </div>

      {target && (
        <div
          data-testid="kpi-target"
          data-target-status={targetStatus ?? undefined}
          className="flex flex-wrap items-baseline gap-x-1.5 text-xs"
        >
          <span className="text-zinc-500 dark:text-zinc-400">
            {target.label?.trim() ? target.label.trim() : "Target"}:{" "}
            <span className="tabular-nums">{formatKpiValue(target.value, valueFormat)}</span>
          </span>
          {targetStatus && targetTone && (
            <span className={cn("font-medium", TONE_STYLES[targetTone])}>
              {TARGET_STATUS_LABEL[targetStatus]}
            </span>
          )}
        </div>
      )}

      {delta && DeltaIcon && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            data-testid="kpi-delta"
            data-direction={delta.direction}
            data-tone={tone}
            className={cn(
              "inline-flex items-center gap-0.5 text-sm font-medium tabular-nums",
              TONE_STYLES[tone],
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

      <Sparkline values={series} tone={tone} />
    </div>
  );
}
