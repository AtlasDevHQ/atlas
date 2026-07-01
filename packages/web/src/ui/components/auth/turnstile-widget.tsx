"use client";

/**
 * Cloudflare Turnstile widget for the interactive web signup (#4159).
 *
 * Proof-of-human moved OFF the headless MCP `start_trial` door (a CLI/AI-agent
 * caller can't solve a browser challenge) ONTO this interactive door. The
 * widget mints a token; the signup form forwards it as the `x-captcha-response`
 * header on `authClient.signUp.email`, which the server's Better Auth captcha
 * plugin (scoped to `/sign-up/email`) verifies against Cloudflare siteverify.
 *
 * Mirrors the mount discipline of `apps/www`'s talk-to-sales widget: lazy,
 * idempotent script load; explicit render; React 19 StrictMode double-mount
 * guard; cleanup on unmount. Remount (a fresh token after a rejected submit) is
 * driven by the parent changing this component's React `key`.
 *
 * When `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is unset (self-hosted / local dev, where
 * the server also registers no captcha plugin) the caller should not render this
 * widget at all — see `isTurnstileConfigured()`.
 */

import { useEffect, useRef } from "react";

const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

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

function getTurnstile(): TurnstileGlobal | undefined {
  return (window as unknown as { turnstile?: TurnstileGlobal }).turnstile;
}

/**
 * Whether a Turnstile site key is configured for this build. Read at call time
 * (not captured in a module-level const) so a test can override
 * `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and it isn't frozen at module load (#3939).
 *
 * When false the signup form skips the widget; the server *should* likewise run
 * no captcha plugin — but that is an **operator-discipline** assumption, not a
 * code-enforced invariant: the web key (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`) and
 * the server secret (`TURNSTILE_SECRET_KEY`) are independent env vars in
 * independent services. A secret-set / site-key-unset misconfig would gate the
 * server (400) while the web renders no widget — the signup page maps that 400
 * to an actionable message rather than leaving a bare vendor string.
 */
export function isTurnstileConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
}

export interface TurnstileWidgetProps {
  /**
   * Called with the solved token, or `null` when the challenge errors/expires
   * (the parent should clear any held token so a stale one can't be submitted).
   */
  onToken: (token: string | null) => void;
  /**
   * Called when the challenge can't run at all — the script was blocked or
   * failed to load — so the parent can surface an actionable message instead of
   * leaving the submit button silently disabled with no explanation.
   */
  onError?: (message: string) => void;
  /** Turnstile action label, surfaced in Cloudflare analytics. */
  action?: string;
  className?: string;
}

export function TurnstileWidget({ onToken, onError, action = "signup", className }: TurnstileWidgetProps) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Keep the latest callbacks without re-running the mount effect.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;

    const renderWidget = () => {
      // Guard the React 19 StrictMode double-mount (effects run twice in dev).
      if (widgetIdRef.current !== null) return;
      const ts = getTurnstile();
      if (!ts || !containerRef.current) return;
      widgetIdRef.current = ts.render(containerRef.current, {
        sitekey: siteKey,
        action,
        theme: "auto",
        callback: (token) => onTokenRef.current(token),
        "error-callback": () => {
          // A transient challenge error — Turnstile renders its own retry UI, so
          // this is not a dead-end. Clear any held token and log for operators.
          console.warn("Turnstile challenge errored");
          onTokenRef.current(null);
        },
        "expired-callback": () => {
          // The solved token aged out before submit; the widget auto-refreshes.
          console.warn("Turnstile token expired — awaiting a fresh challenge");
          onTokenRef.current(null);
        },
      });
    };

    // A blocked/failed script load is the true silent dead-end (#4159 review):
    // the widget never renders, none of the callbacks above ever fire, and the
    // submit button stays disabled with no explanation. Surface it so the parent
    // can tell the user to unblock challenges.cloudflare.com and reload. Stamp
    // the element so a later remount (fresh `key`) doesn't re-bind spent
    // `{ once: true }` listeners to an already-errored script — which would be
    // the same silent dead-end on the remount path.
    const markFailed = (el: HTMLElement) => {
      el.dataset.turnstileLoadFailed = "true";
    };
    const handleScriptError = () => {
      console.warn("Turnstile script failed to load (blocked by an extension or network?)");
      onTokenRef.current(null);
      onErrorRef.current?.(
        "Couldn't load the bot-protection check. Disable content or ad blockers for this page, then reload and try again.",
      );
    };

    // Idempotent script load — a second widget on the page shares the global.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
    );
    if (existing) {
      if (getTurnstile()) {
        renderWidget();
      } else if (existing.dataset.turnstileLoadFailed === "true") {
        // A prior load already failed; its once-listeners are spent and can't
        // re-fire. Surface the dead-end immediately rather than binding listeners
        // that will never call back.
        handleScriptError();
      } else {
        existing.addEventListener("load", renderWidget, { once: true });
        existing.addEventListener(
          "error",
          () => {
            markFailed(existing);
            handleScriptError();
          },
          { once: true },
        );
      }
    } else {
      const script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener("load", renderWidget, { once: true });
      script.addEventListener(
        "error",
        () => {
          markFailed(script);
          handleScriptError();
        },
        { once: true },
      );
      document.head.appendChild(script);
    }

    return () => {
      const ts = getTurnstile();
      const id = widgetIdRef.current;
      if (ts && id !== null) {
        try {
          ts.remove(id);
        } catch {
          // intentionally ignored: race during fast unmount under StrictMode's
          // dev double-effect — the widget re-inits on the next mount.
        }
      }
      widgetIdRef.current = null;
    };
  }, [siteKey, action]);

  if (!siteKey) return null;
  return <div ref={containerRef} className={className} />;
}
