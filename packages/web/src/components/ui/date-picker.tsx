"use client";

import { CalendarIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatLongDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface DatePickerProps {
  value: Date | undefined;
  onChange: (date: Date | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
}

function isValidDate(d: Date | undefined): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const safeValue = isValidDate(value) ? value : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel}
          data-slot="date-picker-trigger"
          className={cn(
            "h-9 w-40 justify-start text-left font-normal",
            !safeValue && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 size-3.5 shrink-0" />
          <span className="truncate">
            {safeValue ? formatLongDate(safeValue) : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          autoFocus
          captionLayout="dropdown"
          mode="single"
          selected={safeValue}
          onSelect={(date) => {
            onChange(date);
            if (date) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
