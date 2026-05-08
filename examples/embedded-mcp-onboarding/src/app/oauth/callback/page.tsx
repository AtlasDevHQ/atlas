"use client";

import { useEffect, useState } from "react";

/**
 * Popup target for the `useMcpConnect` flow. The OAuth server redirects
 * here with `?code=` + `?state=` (or `?error=`); we forward those values
 * to `window.opener` via `postMessage` and close the popup. The opener's
 * `useMcpConnect` hook listens for the typed message and runs the
 * token exchange.
 *
 * Same-origin only: the hook's listener checks `event.origin` against
 * `window.location.origin` so this page MUST be hosted on the same
 * origin as the page that mounted `useMcpConnect`.
 */
export default function OauthCallbackPage() {
  const [message, setMessage] = useState<string>("Completing sign-in…");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.opener) {
      setMessage("This page must be opened from the embedding application.");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    const error_description = params.get("error_description");

    window.opener.postMessage(
      {
        type: "atlas-mcp-callback",
        ...(code ? { code } : {}),
        ...(state ? { state } : {}),
        ...(error ? { error } : {}),
        ...(error_description ? { error_description } : {}),
      },
      window.location.origin,
    );

    setMessage(
      error
        ? `Authorization failed: ${error}. You can close this tab.`
        : "Atlas is now connected. You can close this tab.",
    );

    // Try to close, but don't worry if the browser refuses — the user
    // can close the popup manually and the parent window's watchdog
    // will surface the right error if they bail out.
    const t = window.setTimeout(() => {
      try {
        window.close();
      } catch {
        // intentionally ignored: closing is a courtesy.
      }
    }, 1000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 380 }}>
        <p style={{ color: "#a1a1aa" }}>{message}</p>
      </div>
    </main>
  );
}
