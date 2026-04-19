"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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

interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Supporting copy under the title. Callers should explain the audit intent. */
  description?: ReactNode;
  /** Optional context block rendered above the textarea (e.g. the target summary). */
  context?: ReactNode;
  /** Call-to-action for the destructive confirm button. Default: "Deny". */
  confirmLabel?: string;
  /** Placeholder shown inside the textarea. */
  placeholder?: string;
  /** Whether a reason is required for the audit log. Default: false (optional). */
  required?: boolean;
  onConfirm: (reason: string) => Promise<void> | void;
  loading?: boolean;
  error?: string | null;
}

/**
 * Compliance-grade reason capture dialog shared across queue/moderation
 * surfaces. Records the reason in the audit log alongside the reviewer.
 *
 * **Never substitutes a hardcoded placeholder** — if the reason is empty
 * and `required: false`, the audit log must reflect "no reason given"
 * rather than fabricating one. Passing `onConfirm(reason || "Denied")`
 * silently corrupts the audit trail; callers must receive exactly what
 * the user typed (whitespace-trimmed), including the empty string.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  context,
  confirmLabel = "Deny",
  placeholder = "e.g., Conflicts with security policy",
  required = false,
  onConfirm,
  loading = false,
  error,
}: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  const trimmed = reason.trim();
  const canConfirm = required ? trimmed.length > 0 : true;

  async function handleConfirm() {
    if (!canConfirm) return;
    try {
      await onConfirm(trimmed);
    } catch (err) {
      // Never silently swallow — parent's loading/error state owns the
      // surface, but a throwing onConfirm is a bug in the caller, not the
      // dialog. Log so dev tools pick it up.
      console.error("ReasonDialog: onConfirm threw", err);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!loading && canConfirm) void handleConfirm();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block close while in flight — prevents the cancel-doesn't-cancel
        // race where the operator believes they aborted but the request
        // still resolves server-side.
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
          {/* Always render a description so `aria-describedby` is populated.
              Radix emits a dev warning when DialogContent has no description
              reachable, and screen-reader users expect one. */}
          <DialogDescription>
            {description ?? "Reason is optional but recommended for audit traceability."}
          </DialogDescription>
        </DialogHeader>

        {context && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
            {context}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="reason-dialog-reason" className="text-xs">
            Reason{required ? "" : " (optional)"}
          </Label>
          <Textarea
            ref={textareaRef}
            id="reason-dialog-reason"
            placeholder={placeholder}
            className="min-h-20 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            aria-required={required}
          />
          {!required && !trimmed && (
            <p className="text-[11px] text-muted-foreground/70">
              No reason will be recorded. Audit history will show only the
              reviewer and timestamp.
            </p>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={loading || !canConfirm}
          >
            {loading ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <X className="mr-1.5 size-3.5" />
            )}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
