"use client";

/**
 * Talk-to-sales dialog wrapper (#2730, slice 3 of 1.6.0).
 *
 * Renders a trigger button + a modal dialog containing
 * `<TalkToSalesForm>`. Modeled on the existing
 * `sub-processor-webhook-button` — click-outside-to-close, Escape-to-
 * close, and a styled trigger that the caller wraps with any text.
 *
 * Use from a Server Component:
 *   <TalkToSalesDialog triggerLabel="or talk to sales" />
 */

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { TalkToSalesForm } from "./talk-to-sales-form";

export interface TalkToSalesDialogProps {
  /** Accessible name + visible label for the trigger button. */
  triggerLabel: string;
  /**
   * Optional decorative element rendered after the label (e.g. an arrow
   * glyph on a primary CTA). Presentational only — the component owns
   * placement; spacing is governed by the caller's `triggerClassName`.
   */
  triggerIcon?: ReactNode;
  /** Trigger button class — defaults to a subtle "secondary CTA" style. */
  triggerClassName?: string;
  /** Pre-select a plan in the dropdown (e.g. "Business" from /pricing). */
  initialPlanInterest?: string;
}

const DEFAULT_TRIGGER_CLASS =
  "inline-flex items-center justify-center rounded-md border border-transparent bg-transparent px-2 py-1 text-center font-mono text-[10.5px] tracking-wider text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function TalkToSalesDialog({
  triggerLabel,
  triggerIcon,
  triggerClassName,
  initialPlanInterest,
}: TalkToSalesDialogProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();

  // ── Escape-to-close + focus restore ───────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    // Restore focus to the trigger when the dialog closes — keyboard
    // users shouldn't lose their place in the page.
    if (!open && triggerRef.current) {
      triggerRef.current.focus();
    }
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className={triggerClassName ?? DEFAULT_TRIGGER_CLASS}
      >
        {triggerLabel}
        {triggerIcon}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-4 backdrop-blur-sm"
          onClick={(event) => {
            // Click-outside-to-close — only when clicking the overlay
            // itself, not the dialog content.
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-bg p-6 shadow-2xl"
          >
            <p className="mb-2 font-mono text-[10px] tracking-widest text-accent uppercase">
              // talk to sales
            </p>
            <h3
              id={headingId}
              className="mb-2 text-lg font-semibold tracking-tight text-fg"
            >
              Tell us what you&rsquo;re building
            </h3>
            <p className="mb-5 text-[13px] leading-relaxed text-fg-muted">
              Quick form — we&rsquo;ll reply within one business day. For
              security or procurement questions, mention them in the message
              and we&rsquo;ll loop in the right person.
            </p>

            <TalkToSalesForm
              initialPlanInterest={initialPlanInterest}
              onClose={() => setOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
