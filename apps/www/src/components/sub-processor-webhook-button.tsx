"use client";

import { useEffect, useId, useRef, useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_ATLAS_API_BASE ?? "https://app.useatlas.dev";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; id: string }
  | { kind: "error"; message: string; needsAuth: boolean };

export function SubProcessorWebhookButton() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function reset() {
    setUrl("");
    setToken("");
    setState({ kind: "idle" });
  }

  function close() {
    setOpen(false);
    // Defer reset so the closing animation doesn't flash empty fields back in.
    setTimeout(reset, 200);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ kind: "submitting" });

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/v1/sub-processor-subscriptions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, token }),
      });
    } catch (err) {
      // Browser fetch rejection is opaque ("Failed to fetch", "Load
      // failed", etc.) and not actionable for users. Log raw to console
      // for support, render an actionable message.
      console.error("[sub-processor-webhook] pre-flight fetch failed:", err);
      setState({
        kind: "error",
        message:
          "Couldn't reach Atlas — check your network connection or try again in a moment. If this persists, email legal@useatlas.dev.",
        needsAuth: false,
      });
      return;
    }

    if (res.status === 401) {
      setState({
        kind: "error",
        message: "Sign in to your Atlas account before registering a webhook.",
        needsAuth: true,
      });
      return;
    }

    if (!res.ok) {
      let message = `Server returned ${res.status}.`;
      try {
        const body = (await res.json()) as { message?: string };
        if (typeof body.message === "string") message = body.message;
      } catch {
        // intentionally ignored: non-JSON error body — keep the status-code fallback message
      }
      setState({ kind: "error", message, needsAuth: false });
      return;
    }

    // The 200 was sent by the API but the body might not be JSON
    // (proxy injecting an HTML maintenance page, truncated stream, etc).
    // The subscription was created server-side; surface that fact even
    // if we can't recover the id, so the user isn't stuck on the spinner.
    let body: { id?: string };
    try {
      body = (await res.json()) as { id?: string };
    } catch (err) {
      console.error("[sub-processor-webhook] success response was not JSON:", err);
      setState({
        kind: "success",
        id: "registered (id unavailable — email legal@useatlas.dev to look up)",
      });
      return;
    }
    setState({ kind: "success", id: body.id ?? "registered" });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-bg-sunken px-3 py-2 text-xs font-medium text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
      >
        Webhook
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-4 backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={dialogRef}
            className="w-full max-w-md rounded-2xl border border-border bg-bg p-6 shadow-2xl"
          >
            <p className="mb-2 font-mono text-[10px] tracking-widest text-accent uppercase">
              // register a webhook
            </p>
            <h3
              id={headingId}
              className="mb-2 text-lg font-semibold tracking-tight text-fg"
            >
              Receive sub-processor change notifications
            </h3>
            <p className="mb-5 text-[13px] leading-relaxed text-fg-muted">
              Atlas POSTs a JSON event to your URL on every add, change, or
              removal. Your token signs the request body via HMAC-SHA256
              (header <code className="font-mono text-fg">X-Webhook-Signature</code>).
              Verification details:{" "}
              <a
                className="text-accent underline underline-offset-2 hover:text-accent-hover"
                href="https://docs.useatlas.dev/integrations/sub-processor-feed"
              >
                docs
              </a>
              .
            </p>

            {state.kind === "success" ? (
              <div className="rounded-lg border border-emerald-600/30 bg-emerald-50 p-4">
                <p className="text-sm font-medium text-emerald-700">
                  Subscription registered.
                </p>
                <p className="mt-1 font-mono text-[11px] text-emerald-700/80">
                  id: {state.id}
                </p>
                <p className="mt-3 text-[13px] text-fg-muted">
                  Save your token securely — Atlas will not show it again.
                </p>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-md bg-fg px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-accent"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label
                    htmlFor="webhook-url"
                    className="mb-1 block font-mono text-[11px] tracking-wider text-fg-muted uppercase"
                  >
                    target url
                  </label>
                  <input
                    id="webhook-url"
                    type="url"
                    required
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://hooks.example.com/sub-processors"
                    className="w-full rounded-md border border-border bg-bg-sunken px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="webhook-token"
                    className="mb-1 block font-mono text-[11px] tracking-wider text-fg-muted uppercase"
                  >
                    hmac token
                  </label>
                  <input
                    id="webhook-token"
                    type="password"
                    required
                    minLength={16}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="At least 16 characters"
                    className="w-full rounded-md border border-border bg-bg-sunken px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-fg-faint">
                    Atlas stores this encrypted at rest and signs every
                    delivery with it.
                  </p>
                </div>

                {state.kind === "error" ? (
                  <div className="rounded-md border border-rose-400/50 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
                    {state.message}
                    {state.needsAuth ? (
                      <a
                        href="https://app.useatlas.dev"
                        className="ml-1 underline underline-offset-2"
                      >
                        Sign in →
                      </a>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-md border border-border px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={state.kind === "submitting"}
                    className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {state.kind === "submitting" ? "Registering…" : "Register"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
