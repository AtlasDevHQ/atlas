"use client";

/**
 * Talk-to-sales form (#2730, slice 3 of 1.6.0).
 *
 * Renders the form fields + Cloudflare Turnstile widget + privacy
 * notice; on submit POSTs the payload to `POST /api/v1/contact` on the
 * Atlas API host. Matches the existing `sub-processor-webhook-button`
 * styling (hand-rolled Tailwind, no shadcn) to keep apps/www's bundle
 * lean.
 *
 * Designed to render in either a parent dialog or a standalone page
 * (the Dialog wrapper lives in `talk-to-sales-dialog.tsx`). The form
 * itself is presentation-only — close behavior comes from the parent
 * via `onClose`.
 *
 * Cloudflare Turnstile is loaded lazily via the `<script>` tag on
 * first mount; the widget is rendered into a `<div className="cf-
 * turnstile">` keyed off `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. When the
 * key is unset (local dev), the widget is replaced with a dev-mode
 * notice and submissions are blocked with a clear message — fail
 * closed rather than ship a form with no bot protection.
 */

import { useEffect, useId, useRef, useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_ATLAS_API_BASE ?? "https://api.useatlas.dev";
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

const PRIVACY_HREF = "/privacy";

interface TurnstileGlobal {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback?: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
      action?: string;
    },
  ): string;
  remove(widgetId: string): void;
  reset(widgetId?: string): void;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export interface TalkToSalesFormProps {
  /** Pre-fill the plan-interest select (e.g. "Business" from /pricing CTA). */
  initialPlanInterest?: string;
  /** Called when the user clicks the dialog's Cancel button or after success. */
  onClose?: () => void;
}

const PLAN_OPTIONS = ["Starter", "Pro", "Business", "Not sure yet"] as const;

export function TalkToSalesForm({
  initialPlanInterest = "Business",
  onClose,
}: TalkToSalesFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [planInterest, setPlanInterest] = useState<string>(initialPlanInterest);
  const [message, setMessage] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const headingId = useId();

  // ── Cloudflare Turnstile widget mount ─────────────────────────────
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return; // dev mode — no script load
    if (!widgetRef.current) return;

    // Idempotent script load — multiple form mounts on the page share
    // the same global.
    const existing = document.querySelector(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
    );

    const renderWidget = () => {
      // Guard double-render under React 19 StrictMode (which mounts
      // effects twice in dev).
      if (widgetIdRef.current !== null) return;
      const ts = (window as unknown as { turnstile?: TurnstileGlobal })
        .turnstile;
      if (!ts || !widgetRef.current) return;
      widgetIdRef.current = ts.render(widgetRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action: "contact-sales",
        theme: "light",
        callback: (token) => setTurnstileToken(token),
        "error-callback": () => setTurnstileToken(null),
        "expired-callback": () => setTurnstileToken(null),
      });
    };

    if (existing) {
      // Already loaded — render immediately if global is ready, else
      // hook the existing script's load handler.
      const ts = (window as unknown as { turnstile?: TurnstileGlobal })
        .turnstile;
      if (ts) renderWidget();
      else existing.addEventListener("load", renderWidget, { once: true });
    } else {
      const script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener("load", renderWidget, { once: true });
      document.head.appendChild(script);
    }

    return () => {
      const ts = (window as unknown as { turnstile?: TurnstileGlobal })
        .turnstile;
      const id = widgetIdRef.current;
      if (ts && id !== null) {
        try {
          ts.remove(id);
        } catch {
          // intentionally ignored: race during fast unmount under
          // StrictMode dev double-effect — the script will re-init on
          // next mount.
        }
      }
      widgetIdRef.current = null;
    };
  }, []);

  function resetForm() {
    setName("");
    setEmail("");
    setCompany("");
    setPlanInterest(initialPlanInterest);
    setMessage("");
    setTurnstileToken(null);
    const ts = (window as unknown as { turnstile?: TurnstileGlobal })
      .turnstile;
    if (ts && widgetIdRef.current !== null) {
      try {
        ts.reset(widgetIdRef.current);
      } catch {
        // intentionally ignored: reset can race on unmount — the next
        // open re-renders the widget.
      }
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!TURNSTILE_SITE_KEY) {
      setState({
        kind: "error",
        message:
          "Bot protection is not configured in this build — set NEXT_PUBLIC_TURNSTILE_SITE_KEY in apps/www to enable submissions.",
      });
      return;
    }

    if (!turnstileToken) {
      setState({
        kind: "error",
        message:
          "Please complete the bot check below before submitting (it may take a second to load).",
      });
      return;
    }

    setState({ kind: "submitting" });

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/v1/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          company,
          planInterest,
          message,
          turnstileToken,
        }),
      });
    } catch (err) {
      // Browser fetch rejection is opaque ("Failed to fetch", "Load
      // failed", etc.) and not actionable for users. Log raw to console
      // for support, render an actionable message.
      console.error("[talk-to-sales] pre-flight fetch failed:", err);
      setState({
        kind: "error",
        message:
          "Couldn't reach Atlas — check your network connection or try again in a moment. If this persists, email sales@useatlas.dev.",
      });
      return;
    }

    if (res.status === 403) {
      setState({
        kind: "error",
        message:
          "Bot check failed. Refresh the page and try again — if this keeps happening, email sales@useatlas.dev.",
      });
      // Reset the Turnstile token so the user can retry.
      setTurnstileToken(null);
      const ts = (window as unknown as { turnstile?: TurnstileGlobal })
        .turnstile;
      if (ts && widgetIdRef.current !== null) {
        try {
          ts.reset(widgetIdRef.current);
        } catch {
          // intentionally ignored: see above
        }
      }
      return;
    }

    if (res.status === 404) {
      setState({
        kind: "error",
        message:
          "The contact form isn't available on this deployment. Email sales@useatlas.dev directly.",
      });
      return;
    }

    if (res.status === 429) {
      setState({
        kind: "error",
        message:
          "Too many submissions from your network. Please wait a minute and try again.",
      });
      return;
    }

    if (!res.ok) {
      let message = `Submission failed (HTTP ${res.status}).`;
      try {
        const body = (await res.json()) as { message?: string };
        if (typeof body.message === "string") message = body.message;
      } catch {
        // intentionally ignored: non-JSON error body — keep the status-code fallback message
      }
      setState({ kind: "error", message });
      return;
    }

    setState({ kind: "success" });
    // Don't auto-close the dialog — the success state shows confirmation
    // copy with a manual Done button so users can read it.
  }

  if (state.kind === "success") {
    return (
      <div
        className="rounded-lg border border-emerald-600/30 bg-emerald-50 p-5"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm font-medium text-emerald-700">
          Thanks — we got your note.
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
          Someone from our team will reach out within one business day. If
          you don&rsquo;t hear back, email us directly at{" "}
          <a
            className="text-emerald-700 underline underline-offset-2 hover:text-emerald-800"
            href="mailto:sales@useatlas.dev"
          >
            sales@useatlas.dev
          </a>
          .
        </p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => {
              resetForm();
              setState({ kind: "idle" });
              onClose?.();
            }}
            className="rounded-md bg-fg px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-accent"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-labelledby={headingId}>
      <h3 id={headingId} className="sr-only">
        Talk to sales
      </h3>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="ts-name" label="Name">
          <input
            id="ts-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="Alice Example"
            className={INPUT_CLASS}
          />
        </Field>

        <Field id="ts-email" label="Work email">
          <input
            id="ts-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="alice@company.com"
            className={INPUT_CLASS}
          />
        </Field>

        <Field id="ts-company" label="Company">
          <input
            id="ts-company"
            type="text"
            required
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            autoComplete="organization"
            placeholder="Acme Co"
            className={INPUT_CLASS}
          />
        </Field>

        <Field id="ts-plan" label="Plan interest">
          <select
            id="ts-plan"
            value={planInterest}
            onChange={(e) => setPlanInterest(e.target.value)}
            className={INPUT_CLASS}
          >
            {PLAN_OPTIONS.map((opt) => (
              <option key={opt} value={opt} className="bg-bg text-fg">
                {opt}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field id="ts-message" label="What are you looking for?">
        <textarea
          id="ts-message"
          required
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          maxLength={4000}
          placeholder="Tell us about your team size, the databases you'd like to connect, and anything that's blocking a self-serve trial."
          className={`${INPUT_CLASS} resize-y`}
        />
      </Field>

      {/* Cloudflare Turnstile container — the script renders the widget
          into this div once it loads. When site-key is unset (local dev)
          we show a dev-mode notice instead. */}
      {TURNSTILE_SITE_KEY ? (
        <div ref={widgetRef} className="flex justify-start" />
      ) : (
        <div className="rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          Dev mode — NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset, so the bot
          check is disabled. Submissions will be rejected by the API.
        </div>
      )}

      {state.kind === "error" ? (
        <div
          role="alert"
          className="rounded-md border border-rose-400/50 bg-rose-50 px-3 py-2 text-[13px] text-rose-700"
        >
          {state.message}
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] leading-relaxed text-fg-faint">
          By submitting, you agree to our{" "}
          <a
            href={PRIVACY_HREF}
            className="text-fg-muted underline underline-offset-2 hover:text-fg"
          >
            Privacy Policy
          </a>
          .
        </p>
        <div className="flex justify-end gap-2">
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="submit"
            disabled={state.kind === "submitting"}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {state.kind === "submitting" ? "Sending…" : "Send to sales"}
          </button>
        </div>
      </div>
    </form>
  );
}

const INPUT_CLASS =
  "w-full rounded-md border border-border bg-bg-sunken px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none";

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block font-mono text-[11px] tracking-wider text-fg-muted uppercase"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
