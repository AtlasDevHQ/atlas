"use client";

// Client half of the org-share auth-wall fix (#4718). Mounted by the shared
// page/embed RSCs ONLY when the SSR fetch hit the auth wall (`login-required` /
// `membership-required`) — public shares and every other failure keep the pure
// SSR path unchanged. On mount it re-resolves the share against the API with
// the viewer's REAL credentials (`org-share-client.ts`) and renders the exact
// success/error surfaces the SSR path renders, so the two paths are visually
// indistinguishable. On a same-origin deploy (where the SSR cookie forward
// already worked) the retry merely reconfirms the SSR verdict; on the SaaS
// cross-origin topology it is the only fetch that can carry the session at all.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { SharedDashboardView } from "./view";
import { ErrorShell } from "./error-shell";
import { resolveErrorContent } from "./error-content";
import { EmbedErrorView } from "./embed/embed";
import { resolveOrgShareClient } from "./org-share-client";
import type { FetchResult } from "./share-result";

export function OrgShareResolver({
  token,
  variant = "page",
  forcedDark,
}: {
  token: string;
  /** "embed" renders the iframe-appropriate, navigation-free error surface
   *  (`EmbedErrorView`) instead of the standalone `ErrorShell`. */
  variant?: "page" | "embed";
  /** Embed-only forced theme, threaded through to the tiles exactly as the
   *  embed RSC threads it on the SSR success path (see `view.tsx`). */
  forcedDark?: boolean;
}) {
  // `null` = resolution in flight. `resolveOrgShareClient` never rejects (it
  // maps thrown fetches to `network-error`), so no separate error state.
  const [result, setResult] = useState<FetchResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveOrgShareClient(token)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err: unknown) => {
        // Belt to the never-rejects suspenders above: an unexpected rejection
        // must surface as an error page, never strand the viewer on the spinner.
        console.error(
          "[shared-dashboard/client] org-share resolution rejected unexpectedly:",
          err instanceof Error ? err.message : String(err),
        );
        if (!cancelled) setResult({ ok: false, reason: "network-error" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (result === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-zinc-950 print:bg-white">
        <div
          role="status"
          className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Checking access&hellip;
        </div>
      </div>
    );
  }

  if (result.ok) {
    return <SharedDashboardView dashboard={result.data} forcedDark={forcedDark} />;
  }

  return variant === "embed" ? (
    <EmbedErrorView reason={result.reason} />
  ) : (
    <ErrorShell token={token} content={resolveErrorContent(result.reason)} />
  );
}
