"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TourStep } from "./types";

interface TourOverlayProps {
  /** Whether the tour is currently visible. */
  active: boolean;
  /** The current step to display. */
  step: TourStep;
  /** Current step index (0-based). */
  stepIndex: number;
  /** Total number of steps. */
  totalSteps: number;
  /** Called when the user clicks "Next" or "Done". */
  onNext: () => void;
  /** Called when the user clicks "Back". */
  onPrev: () => void;
  /** Called when the user clicks "Skip" or the X button. */
  onSkip: () => void;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Full-screen backdrop overlay with a highlighted cutout around the target
 * element and a floating tooltip card.
 */
export function TourOverlay({
  active,
  step,
  stepIndex,
  totalSteps,
  onNext,
  onPrev,
  onSkip,
}: TourOverlayProps) {
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [mounted, setMounted] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Mount portal after hydration
  useEffect(() => {
    setMounted(true);
  }, []);

  // Find and track the target element
  useEffect(() => {
    if (!active || !step.targetSelector) {
      setTargetRect(null);
      return;
    }

    function updateRect() {
      const el = document.querySelector(step.targetSelector!);
      if (el) {
        const rect = el.getBoundingClientRect();
        setTargetRect({
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        });
      } else {
        setTargetRect(null);
      }
    }

    updateRect();

    // Re-measure on scroll/resize
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);

    return () => {
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [active, step.targetSelector]);

  // Handle Escape key
  useEffect(() => {
    if (!active) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onSkip();
      if (e.key === "ArrowRight") onNext();
      if (e.key === "ArrowLeft") onPrev();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active, onSkip, onNext, onPrev]);

  if (!active || !mounted) return null;

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === totalSteps - 1;

  // Calculate tooltip position
  const tooltipStyle = calculateTooltipPosition(targetRect, step.side);

  const overlay = (
    <div
      className="fixed inset-0 z-[9999]"
      role="dialog"
      aria-modal="true"
      aria-label={`Guided tour: step ${stepIndex + 1} of ${totalSteps}`}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity duration-200"
        onClick={onSkip}
        aria-hidden="true"
      />

      {/* Highlight cutout — renders a transparent box over the target */}
      {targetRect && (
        <div
          className="absolute rounded-lg ring-4 ring-primary/50 transition-all duration-300 ease-in-out"
          style={{
            top: targetRect.top - 4,
            left: targetRect.left - 4,
            width: targetRect.width + 8,
            height: targetRect.height + 8,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
            backgroundColor: "transparent",
            zIndex: 1,
            pointerEvents: "none",
          }}
          aria-hidden="true"
        />
      )}

      {/* Tooltip card */}
      <div
        ref={tooltipRef}
        className={cn(
          "absolute z-10 w-[calc(100vw-2rem)] max-w-sm rounded-lg border border-zinc-200 bg-white p-4 shadow-xl transition-all duration-300 ease-in-out dark:border-zinc-700 dark:bg-zinc-900",
          // On mobile, center the card
          !targetRect && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
        )}
        style={targetRect ? tooltipStyle : undefined}
        role="tooltip"
      >
        {/* Close button */}
        <button
          onClick={onSkip}
          className="absolute right-2 top-2 rounded-md p-1 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
          aria-label="Close tour"
        >
          <X className="size-4" />
        </button>

        {/* Step content */}
        <div className="pr-6">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {step.title}
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {step.description}
          </p>
        </div>

        {/* Footer: step indicator + navigation */}
        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            {stepIndex + 1} of {totalSteps}
          </span>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onPrev}
                className="text-xs"
              >
                <ChevronLeft className="size-3" />
                Back
              </Button>
            )}
            {!isFirst && !isLast && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onSkip}
                className="text-xs text-zinc-400 dark:text-zinc-500"
              >
                Skip
              </Button>
            )}
            {isFirst && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onSkip}
                className="text-xs text-zinc-400 dark:text-zinc-500"
              >
                Skip tour
              </Button>
            )}
            <Button size="sm" onClick={onNext} className="text-xs">
              {isLast ? "Done" : "Next"}
              {!isLast && <ChevronRight className="size-3" />}
            </Button>
          </div>
        </div>

        {/* Step dots */}
        <div className="mt-3 flex justify-center gap-1.5">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={cn(
                "size-1.5 rounded-full transition-colors",
                i === stepIndex
                  ? "bg-primary"
                  : "bg-zinc-300 dark:bg-zinc-600",
              )}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

/**
 * Calculate tooltip position based on the target element rect and preferred side.
 * Falls back to centered positioning when the target is too close to an edge.
 */
function calculateTooltipPosition(
  rect: TargetRect | null,
  side: TourStep["side"],
): React.CSSProperties {
  if (!rect) {
    return {
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
    };
  }

  const GAP = 12;
  const TOOLTIP_WIDTH = 384; // max-w-sm
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 768;

  // Center horizontally relative to target by default
  let left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
  let top: number;

  switch (side) {
    case "bottom":
      top = rect.top + rect.height + GAP;
      break;
    case "top":
      top = rect.top - GAP;
      // Will be adjusted with transform
      break;
    case "left":
      left = rect.left - TOOLTIP_WIDTH - GAP;
      top = rect.top + rect.height / 2;
      break;
    case "right":
      left = rect.left + rect.width + GAP;
      top = rect.top + rect.height / 2;
      break;
    default:
      top = rect.top + rect.height + GAP;
  }

  // Clamp to viewport bounds with padding
  const PADDING = 16;
  left = Math.max(PADDING, Math.min(left, viewportWidth - TOOLTIP_WIDTH - PADDING));
  top = Math.max(PADDING, Math.min(top, viewportHeight - 200));

  const style: React.CSSProperties = { left, top };

  if (side === "top") {
    style.transform = "translateY(-100%)";
  }
  if (side === "left" || side === "right") {
    style.transform = "translateY(-50%)";
  }

  return style;
}
