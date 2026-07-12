"use client";

import { useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { confidenceToPct, pctToConfidence } from "./list-query";

interface ConfidenceFilterProps {
  /** Current lower bound as the API decimal string (0–1), or "" for unset. */
  min: string;
  /** Current upper bound as the API decimal string (0–1), or "" for unset. */
  max: string;
  /** Apply new bounds as API decimal strings ("" clears that side). */
  onApply: (bounds: { min: string; max: string }) => void;
}

/**
 * Confidence min/max range filter for the learned-patterns cockpit.
 *
 * Presents the bounds as percentages (0–100) for readability but stores/applies
 * them as the API's decimal `min_confidence`/`max_confidence` (0–1), so the
 * URL is directly shareable and maps 1:1 onto the route's validated params.
 * Edits are staged in local draft state and committed on Apply — a keystroke
 * doesn't refetch the list on every character.
 */
export function ConfidenceFilter({ min, max, onApply }: ConfidenceFilterProps) {
  const [open, setOpen] = useState(false);
  const [minPct, setMinPct] = useState(() => confidenceToPct(min));
  const [maxPct, setMaxPct] = useState(() => confidenceToPct(max));

  const active = min !== "" || max !== "";
  const label = active
    ? `Confidence ${confidenceToPct(min) || "0"}–${confidenceToPct(max) || "100"}%`
    : "Confidence";

  // Reseed the draft inputs from the applied bounds each time the popover opens,
  // so a cancelled edit never lingers into the next open.
  function handleOpenChange(next: boolean) {
    if (next) {
      setMinPct(confidenceToPct(min));
      setMaxPct(confidenceToPct(max));
    }
    setOpen(next);
  }

  function apply() {
    let min = pctToConfidence(minPct);
    let max = pctToConfidence(maxPct);
    // Forgive an inverted range: if both bounds are set and min > max, swap
    // them. The user who typed 90/50 meant the 50–90 band, so ordering it
    // avoids a doomed `min_confidence > max_confidence` 400 and the nonsensical
    // "90–50%" trigger label.
    if (min !== "" && max !== "" && Number(min) > Number(max)) {
      [min, max] = [max, min];
    }
    onApply({ min, max });
    setOpen(false);
  }

  function clear() {
    setMinPct("");
    setMaxPct("");
    onApply({ min: "", max: "" });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant={active ? "secondary" : "ghost"}>
          <SlidersHorizontal className="mr-1.5 size-3.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Confidence range</p>
          <p className="text-xs text-muted-foreground">
            Filter patterns by confidence (0–100%).
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="confidence-min" className="text-xs">
              Min %
            </Label>
            <Input
              id="confidence-min"
              type="number"
              min={0}
              max={100}
              inputMode="numeric"
              placeholder="0"
              value={minPct}
              onChange={(e) => setMinPct(e.target.value)}
            />
          </div>
          <span className="pb-2 text-muted-foreground">–</span>
          <div className="space-y-1">
            <Label htmlFor="confidence-max" className="text-xs">
              Max %
            </Label>
            <Input
              id="confidence-max"
              type="number"
              min={0}
              max={100}
              inputMode="numeric"
              placeholder="100"
              value={maxPct}
              onChange={(e) => setMaxPct(e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Button
            size="sm"
            variant="ghost"
            onClick={clear}
            disabled={!active && minPct === "" && maxPct === ""}
          >
            <X className="mr-1.5 size-3.5" />
            Clear
          </Button>
          <Button size="sm" onClick={apply}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
