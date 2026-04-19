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

/* ────────────────────────────────────────────────────────────────────────
 *  DenyActionDialog
 *
 *  Captures an optional reason at deny time. Used for both single-row
 *  deny and bulk deny so audit history records *why* an action was
 *  rejected — replacing the legacy hardcoded "Denied by admin" string.
 *
 *  Reason is optional (low-friction triage), but the dialog shape forces
 *  a deliberate moment for a consequential action and the empty-state
 *  hint warns operators that audit history will reflect the absence.
 * ──────────────────────────────────────────────────────────────────────── */

interface DenyActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Single-row deny target. Mutually exclusive with `bulkCount`. */
  action?: ActionLogEntry | null;
  /** Bulk deny count. Mutually exclusive with `action`. */
  bulkCount?: number;
  /** Fired with the reason (or empty string) when the user confirms. */
  onConfirm: (reason: string) => Promise<void> | void;
  /** Disables the confirm button while the parent fires the mutation. */
  loading?: boolean;
  /** Inline error to surface (server message, etc). */
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

  // Reset reason when the dialog closes so the next open starts clean.
  // Reset *after* close, not on open, so a re-fired Confirm during a
  // network hiccup keeps the operator's text.
  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  // Focus the textarea on open so the keyboard-driven flow is one step:
  // type reason (or skip) → Enter / Cmd+Enter to confirm.
  useEffect(() => {
    if (open) {
      // Defer to next tick — Dialog's open animation can intercept focus.
      const t = setTimeout(() => textareaRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const isBulk = bulkCount !== undefined && bulkCount > 0;
  const title = isBulk ? `Deny ${bulkCount} action${bulkCount === 1 ? "" : "s"}` : "Deny action";

  async function handleConfirm() {
    await onConfirm(reason.trim());
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd+Enter / Ctrl+Enter submits — matches the comment-textarea
    // convention used elsewhere in the admin console (chat composer,
    // approval comment box, etc.).
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!loading) handleConfirm();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
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
