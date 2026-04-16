"use client";

import { useMode } from "@/ui/hooks/use-mode";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Code, ArrowRight } from "lucide-react";

/**
 * Stripe-style amber banner shown at the very top of every page when an admin
 * is in developer mode. Provides a one-click switch back to published mode.
 *
 * Renders nothing when the session is loading, the user is not an admin, or
 * the current mode is `published`.
 */
export function ModeBanner() {
  const { mode, setMode, isAdmin, isLoading } = useMode();

  if (isLoading || !isAdmin || mode !== "developer") return null;

  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center justify-between bg-amber-500/90 px-4 text-amber-950 dark:bg-amber-500/80 dark:text-amber-950"
    >
      <div className="flex items-center gap-2">
        <Code className="size-3.5 shrink-0" />
        <Badge
          variant="outline"
          className="border-amber-700/30 bg-amber-600/20 px-1.5 py-0 text-[10px] font-bold tracking-wider text-amber-950"
        >
          DEVELOPER MODE
        </Badge>
        <span className="hidden text-xs font-medium sm:inline">
          Unpublished changes are visible
        </span>
      </div>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setMode("published")}
        className="gap-1 text-amber-950 hover:bg-amber-600/30 hover:text-amber-950"
      >
        <span className="text-xs font-medium">Switch to published</span>
        <ArrowRight className="size-3" />
      </Button>
    </div>
  );
}
