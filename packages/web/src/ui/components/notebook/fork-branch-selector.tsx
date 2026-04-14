"use client";

import { useState, useRef, useEffect } from "react";
import { GitBranch, ChevronDown, Pencil, Trash2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ForkInfo } from "./types";

/** Truncate a forkPointCellId (message UUID) for compact display in the branch selector. */
function formatForkPoint(forkPointCellId: string): string {
  return forkPointCellId.slice(0, 8);
}

interface ForkBranchSelectorProps {
  forkInfo: ForkInfo;
  onSwitchBranch: (conversationId: string) => void;
  onDeleteBranch?: (branchId: string) => Promise<void>;
  onRenameBranch?: (branchId: string, label: string) => Promise<void>;
}

export function ForkBranchSelector({
  forkInfo,
  onSwitchBranch,
  onDeleteBranch,
  onRenameBranch,
}: ForkBranchSelectorProps) {
  const isRoot = forkInfo.currentId === forkInfo.rootId;
  const totalBranches = forkInfo.branches.length + 1; // +1 for the root
  const branchIdx = forkInfo.branches.findIndex((b) => b.conversationId === forkInfo.currentId);
  const currentLabel = isRoot
    ? "Main"
    : branchIdx >= 0
      ? (forkInfo.branches[branchIdx].label || `Branch ${branchIdx + 1}`)
      : "Branch";

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  function startRename(branchId: string, currentLabel: string) {
    setEditingId(branchId);
    setEditValue(currentLabel);
  }

  async function commitRename() {
    if (!editingId || !editValue.trim() || !onRenameBranch) return;
    try {
      await onRenameBranch(editingId, editValue.trim());
      setEditingId(null);
    } catch {
      // Keep editing state open — the parent hook shows a warning toast
    }
  }

  function cancelRename() {
    setEditingId(null);
    setEditValue("");
  }

  return (
    <>
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
          <DropdownMenuContent align="start" className="min-w-[240px]">
            <DropdownMenuItem
              onClick={() => onSwitchBranch(forkInfo.rootId)}
              className={isRoot ? "bg-zinc-100 dark:bg-zinc-800" : ""}
            >
              <GitBranch className="mr-2 size-3.5" />
              <span className="flex-1">Main (root)</span>
              {isRoot && (
                <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  current
                </span>
              )}
            </DropdownMenuItem>
            {forkInfo.branches.length > 0 && <DropdownMenuSeparator />}
            {forkInfo.branches.map((branch, i) => {
              const isCurrent = branch.conversationId === forkInfo.currentId;
              const label = branch.label || `Branch ${i + 1}`;
              const isEditing = editingId === branch.conversationId;

              if (isEditing) {
                return (
                  <div
                    key={branch.conversationId}
                    className="flex items-center gap-1 px-2 py-1.5"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") cancelRename();
                    }}
                  >
                    <Input
                      ref={inputRef}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="h-7 flex-1 text-xs"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={commitRename}
                      aria-label="Save"
                    >
                      <Check className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={cancelRename}
                      aria-label="Cancel"
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                );
              }

              return (
                <DropdownMenuItem
                  key={branch.conversationId}
                  onClick={() => onSwitchBranch(branch.conversationId)}
                  className={isCurrent ? "bg-zinc-100 dark:bg-zinc-800" : ""}
                >
                  <GitBranch className="mr-2 size-3.5 shrink-0" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{label}</span>
                    <span className="text-[10px] text-zinc-400">
                      from {formatForkPoint(branch.forkPointCellId)}
                    </span>
                  </div>
                  {isCurrent && (
                    <span className="ml-2 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      current
                    </span>
                  )}
                  {onRenameBranch && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-1 size-6 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(branch.conversationId, label);
                      }}
                      aria-label="Rename branch"
                    >
                      <Pencil className="size-3" />
                    </Button>
                  )}
                  {onDeleteBranch && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 text-red-500 opacity-0 hover:text-red-600 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget({ id: branch.conversationId, label });
                      }}
                      aria-label="Delete branch"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete branch &quot;{deleteTarget?.label}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this branch and all its messages. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={async () => {
                if (deleteTarget && onDeleteBranch) {
                  await onDeleteBranch(deleteTarget.id);
                }
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
