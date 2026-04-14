"use client";

import { GitBranch } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ForkBranchWire } from "@/ui/lib/types";

interface ForkGutterIndicatorProps {
  /** Branches that fork from this cell's message ID. */
  branches: ForkBranchWire[];
}

export function ForkGutterIndicator({ branches }: ForkGutterIndicatorProps) {
  if (branches.length === 0) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="absolute -left-5 top-3 flex items-center"
            aria-label={`${branches.length} branch${branches.length === 1 ? "" : "es"} from this cell`}
          >
            <div className="flex size-4 items-center justify-center rounded-full border border-zinc-300 bg-white dark:border-zinc-600 dark:bg-zinc-900">
              <GitBranch className="size-2.5 text-zinc-500 dark:text-zinc-400" />
            </div>
            <div className="h-px w-2 bg-zinc-300 dark:bg-zinc-600" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p className="text-xs">
            {branches.length} branch{branches.length === 1 ? "" : "es"} from this cell
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
