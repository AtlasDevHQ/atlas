"use client";

/**
 * Dashboard parameter bar (#2267 — parameters slice).
 *
 * Renders a control per declared parameter above the grid. Changing a control
 * commits an OVERRIDE into the URL (nuqs `dparams`, so a shared/bookmarked link
 * reproduces the view) and notifies the page, which re-renders every card with
 * the new values (bound server-side, never interpolated). An empty override map
 * means "use the parameter defaults" — the page shows the cached snapshot.
 *
 * Commit cadence: date pickers commit on select; text/number commit on blur or
 * Enter (so we refetch on change, not on every keystroke).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseAsString, useQueryState } from "nuqs";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import type { DashboardParameter } from "@/ui/lib/types";

export type ParameterValues = Record<string, string | number | null>;

interface DashboardParameterBarProps {
  parameters: DashboardParameter[];
  /**
   * Called with the committed override map whenever a parameter changes (and
   * once on mount with whatever the URL carried). An empty object means
   * "use defaults".
   */
  onChange: (overrides: ParameterValues) => void;
  /** True while card renders triggered by a change are in flight. */
  loading?: boolean;
}

/** Parse the URL-encoded override map defensively (drop anything unusable). */
function parseOverrides(raw: string | null): ParameterValues {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ParameterValues;
    }
  } catch {
    // Malformed URL state — fall back to defaults rather than throwing.
  }
  return {};
}

/** Local `YYYY-MM-DD` formatting (matches the server's ISO date bind shape). */
function toIsoDate(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromIsoDate(s: string | number | null | undefined): Date | undefined {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function DashboardParameterBar({ parameters, onChange, loading }: DashboardParameterBarProps) {
  const [raw, setRaw] = useQueryState("dparams", parseAsString);
  const overrides = useMemo(() => parseOverrides(raw), [raw]);

  // Notify the page whenever the committed override map changes (incl. mount).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const serialized = JSON.stringify(overrides);
  useEffect(() => {
    onChangeRef.current(parseOverrides(serialized === "{}" ? null : serialized));
  }, [serialized]);

  const commit = useCallback(
    (next: ParameterValues) => {
      // Drop null/empty entries so the URL stays clean and "no overrides"
      // serialises to nothing.
      const cleaned: ParameterValues = {};
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === "") continue;
        cleaned[k] = v;
      }
      void setRaw(Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned));
    },
    [setRaw],
  );

  const setValue = useCallback(
    (key: string, value: string | number | null) => commit({ ...overrides, [key]: value }),
    [commit, overrides],
  );

  const hasOverrides = Object.keys(overrides).length > 0;
  if (parameters.length === 0) return null;

  return (
    <div className="mx-4 mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2.5 sm:mx-6 dark:border-zinc-800 dark:bg-zinc-900/40">
      {parameters.map((param) => (
        <div key={param.key} className="flex flex-col gap-1">
          <Label htmlFor={`param-${param.key}`} className="text-xs text-zinc-500 dark:text-zinc-400">
            {param.label}
          </Label>
          <ParameterControl
            param={param}
            value={overrides[param.key] ?? null}
            onCommit={(v) => setValue(param.key, v)}
            disabled={loading}
          />
        </div>
      ))}

      {hasOverrides && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 text-xs text-zinc-500"
          onClick={() => commit({})}
          disabled={loading}
        >
          <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />
          Reset
        </Button>
      )}
      {loading && (
        <span className="h-9 self-end text-xs leading-9 text-zinc-400" role="status">
          Updating…
        </span>
      )}
    </div>
  );
}

function ParameterControl({
  param,
  value,
  onCommit,
  disabled,
}: {
  param: DashboardParameter;
  value: string | number | null;
  onCommit: (value: string | number | null) => void;
  disabled?: boolean;
}) {
  // Local mirror for free-text / number inputs so we commit on blur/Enter,
  // not on every keystroke. Date pickers commit immediately on select.
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);

  if (param.type === "date") {
    return (
      <DatePicker
        id={`param-${param.key}`}
        value={fromIsoDate(value)}
        onChange={(d) => onCommit(d ? toIsoDate(d) : null)}
        disabled={disabled}
        placeholder={param.label}
        aria-label={param.label}
      />
    );
  }

  const commitDraft = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onCommit(null);
      return;
    }
    onCommit(param.type === "number" ? Number(trimmed) : trimmed);
  };

  return (
    <Input
      id={`param-${param.key}`}
      type={param.type === "number" ? "number" : "text"}
      value={draft}
      placeholder={param.label}
      aria-label={param.label}
      disabled={disabled}
      className="h-9 w-40"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitDraft}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
    />
  );
}
