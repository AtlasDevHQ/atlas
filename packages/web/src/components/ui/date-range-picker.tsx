"use client";

import { CalendarIcon } from "lucide-react";
import * as React from "react";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatLongDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export type { DateRange };

export interface DateRangePickerProps {
  value: DateRange | undefined;
  onChange: (range: DateRange | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  numberOfMonths?: number;
  "aria-label"?: string;
}

function renderRangeLabel(range: DateRange | undefined, placeholder: string) {
  if (!range || (!range.from && !range.to)) return placeholder;
  if (range.from && range.to) {
    return `${formatLongDate(range.from)} – ${formatLongDate(range.to)}`;
  }
  return formatLongDate(range.from ?? range.to);
}

/**
 * Swap from/to when the user picks an inverted range. Makes `to >= from` a
 * postcondition of the component without changing the prop type — callers
 * never see {from: dec31, to: jan1}.
 *
 * Exported for unit testing; not part of the component's stable API.
 */
export function normalizeRange(range: DateRange | undefined): DateRange | undefined {
  if (!range?.from || !range?.to) return range;
  if (range.from.getTime() > range.to.getTime()) {
    return { from: range.to, to: range.from };
  }
  return range;
}

export function DateRangePicker({
  value,
  onChange,
  placeholder = "Pick a date range",
  disabled,
  className,
  id,
  numberOfMonths = 2,
  "aria-label": ariaLabel,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  const hasValue = Boolean(value?.from || value?.to);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel}
          data-slot="date-range-picker-trigger"
          className={cn(
            "h-9 w-[260px] justify-start text-left font-normal",
            !hasValue && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 size-3.5 shrink-0" />
          <span className="truncate">{renderRangeLabel(value, placeholder)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          autoFocus
          captionLayout="dropdown"
          mode="range"
          selected={value}
          onSelect={(range) => {
            const normalized = normalizeRange(range);
            onChange(normalized);
            if (normalized?.from && normalized?.to) setOpen(false);
          }}
          numberOfMonths={numberOfMonths}
        />
      </PopoverContent>
    </Popover>
  );
}
