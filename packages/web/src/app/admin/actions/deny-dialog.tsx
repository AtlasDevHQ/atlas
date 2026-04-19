"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, X } from "lucide-react";
import type { ActionLogEntry } from "@/ui/lib/types";
import { ACTION_TYPE_LABELS } from "./labels";

interface DenyActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mutually exclusive with `bulkCount`. */
  action?: ActionLogEntry | null;
  /** Mutually exclusive with `action`. */
  bulkCount?: number;
  onConfirm: (reason: string) => Promise<void> | void;
  loading?: boolean;
  error?: string | null;
}

export function DenyActionDialog({
  open,
  onOpenChange,
  action,
  bulkCount,
  onConfirm,
  loading = false,
  error,
}: DenyActionDialogProps) {
  const [reason, setReason] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  const isBulk = bulkCount !== undefined && bulkCount > 0;
  const title = isBulk ? `Deny ${bulkCount} action${bulkCount === 1 ? "" : "s"}` : "Deny action";

  async function handleConfirm() {
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      console.error("DenyActionDialog: onConfirm threw", err);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!loading) void handleConfirm();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block close while in flight — prevents the cancel-doesn't-cancel
        // race where the operator believes they aborted but the request still
        // resolves server-side.
        if (!next && loading) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Recorded in the audit log alongside your account. Reason is optional but recommended for traceability.
          </DialogDescription>
        </DialogHeader>

        {action && !isBulk && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {ACTION_TYPE_LABELS[action.action_type] ?? action.action_type}
              </span>
              <span className="truncate font-mono text-muted-foreground">{action.target}</span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-muted-foreground/80">{action.summary}</p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="deny-reason" className="text-xs">
            Reason (optional)
          </Label>
          <Textarea
            ref={textareaRef}
            id="deny-reason"
            placeholder="e.g., Action conflicts with security policy"
            className="min-h-20 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          {!reason.trim() && (
            <p className="text-[11px] text-muted-foreground/70">
              No reason will be recorded. Audit history will show only the denier and timestamp.
            </p>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <X className="mr-1.5 size-3.5" />
            )}
            {isBulk ? `Deny ${bulkCount}` : "Deny"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
