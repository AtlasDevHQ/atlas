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
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import type { FetchError } from "@/ui/lib/fetch-error";
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
  /**
   * Local-synthesized string error (e.g. bulk-failure summary). Takes effect
   * when `mutationError` is null. Rendered as a flat alert block — no
   * structured routing.
   */
  error?: string | null;
  /**
   * Structured mutation error from `useAdminMutation().error`. Takes
   * precedence over `error`. Routed through `MutationErrorSurface` so gated
   * failures render `EnterpriseUpsell` inline instead of the flat string
   * `friendlyError()` would produce.
   */
  mutationError?: FetchError | null;
  /**
   * Feature name for `MutationErrorSurface` routing when `mutationError` is
   * present. Should match the page's `AdminContentWrapper` feature.
   */
  feature?: string;
}

/**
 * Compliance-grade reason capture dialog shared across queue/moderation
 * surfaces. Records the reason in the audit log alongside the reviewer.
 *
 * **Caller contract:** pass the `reason` through to the audit log
 * unchanged. Substituting a hardcoded fallback (e.g. `reason || "Denied"`)
 * corrupts the trail — the empty string is semantically distinct from
 * "no reason given" only if callers preserve it. The dialog emits exactly
 * what the user typed, whitespace-trimmed, including the empty string.
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
  mutationError,
  feature,
}: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setLocalError(null);
    }
  }, [open]);

  // A fresh non-null caller-provided error clears any stale localError so
  // the caller's message wins. Without this, `localError ?? error` keeps
  // showing a prior-throw "Unexpected error: ..." and hides a real server
  // error that arrives later. Fires on every non-null caller error (string
  // or structured), not just the null→non-null transition, so sequential
  // retries each surface the latest caller-provided diagnosis.
  useEffect(() => {
    if (error != null || mutationError != null) setLocalError(null);
  }, [error, mutationError]);

  const trimmed = reason.trim();
  const canConfirm = required ? trimmed.length > 0 : true;

  async function handleConfirm() {
    if (!canConfirm) return;
    setLocalError(null);
    try {
      await onConfirm(trimmed);
    } catch (err) {
      // Caller bug — onConfirm rejected instead of resolving and
      // surfacing the failure through the parent's `error` prop. Show
      // it here so the dialog doesn't appear to stall, and log so
      // observability still sees it.
      const msg = err instanceof Error ? err.message : String(err);
      setLocalError(`Unexpected error: ${msg}`);
      console.warn("ReasonDialog: onConfirm threw", err);
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

        {/* Precedence: localError (dialog-internal onConfirm throw) >
            mutationError (structured, routed through MutationErrorSurface) >
            error (string, e.g. bulk-failure summary). All three branches
            expose role="alert" so screen readers announce changes — the
            mutationError branch wraps MutationErrorSurface because
            InlineError itself has no live-region semantics. */}
        {localError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {localError}
          </div>
        ) : mutationError ? (
          <div role="alert">
            <MutationErrorSurface
              error={mutationError}
              feature={feature ?? ""}
              variant="inline"
            />
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </div>
        ) : null}

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
