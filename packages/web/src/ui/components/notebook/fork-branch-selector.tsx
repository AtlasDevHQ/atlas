"use client";

import { GitBranch, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ForkInfo } from "./types";

interface ForkBranchSelectorProps {
  forkInfo: ForkInfo;
  onSwitchBranch: (conversationId: string) => void;
}

export function ForkBranchSelector({ forkInfo, onSwitchBranch }: ForkBranchSelectorProps) {
  const isRoot = forkInfo.currentId === forkInfo.rootId;
  const totalBranches = forkInfo.branches.length + 1; // +1 for the root
  const branchIdx = forkInfo.branches.findIndex((b) => b.conversationId === forkInfo.currentId);
  const currentLabel = isRoot
    ? "Main"
    : branchIdx >= 0
      ? (forkInfo.branches[branchIdx].label || `Branch ${branchIdx + 1}`)
      : "Branch";

  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <GitBranch className="size-4 text-zinc-500" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1 px-2 py-1 text-sm font-medium"
          >
            {currentLabel}
            <span className="text-zinc-400">({totalBranches} total)</span>
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onClick={() => onSwitchBranch(forkInfo.rootId)}
            className={isRoot ? "bg-zinc-100 dark:bg-zinc-800" : ""}
          >
            <GitBranch className="mr-2 size-3.5" />
            Main (root)
          </DropdownMenuItem>
          {forkInfo.branches.map((branch, i) => {
            const isCurrent = branch.conversationId === forkInfo.currentId;
            return (
              <DropdownMenuItem
                key={branch.conversationId}
                onClick={() => onSwitchBranch(branch.conversationId)}
                className={isCurrent ? "bg-zinc-100 dark:bg-zinc-800" : ""}
              >
                <GitBranch className="mr-2 size-3.5" />
                {branch.label || `Branch ${i + 1}`}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
