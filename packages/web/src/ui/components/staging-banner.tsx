"use client";

import { useEffect, useState } from "react";

import { getApiUrl } from "@/lib/api-url";
import { cn } from "@/lib/utils";
import { isStagingRegion } from "@/ui/lib/staging";
import type { DeployRegion } from "@/ui/lib/types";

/**
 * GitHub source for the staging runbook. The doc itself lands in a later
 * staging slice; the link is wired now so the banner is complete when it does.
 * It lives under the repo's `docs/development/` operator docs, not the published
 * docs.useatlas.dev site.
 */
const STAGING_RUNBOOK_URL =
  "https://github.com/AtlasDevHQ/atlas/blob/main/docs/development/staging-environment.md";

/** Minimal shape read from the public `GET /api/v1/health` response. */
interface HealthRegionResponse {
  region?: DeployRegion;
}

/**
 * Full-width amber marker shown at the top of every page when the API reports
 * it is the staging deploy, so a staging tab is never mistaken for production
 * during dogfood.
 *
 * Reads `region` from the public `GET /api/v1/health` endpoint (not the
 * auth-gated `/api/v1/mode`) so it renders before sign-in — login, signup, and
 * error pages included. Renders nothing on production (`us` | `eu` | `apac`) or
 * self-hosted/dev (no region), so there is no layout shift outside staging.
 */
export function StagingBanner() {
  const [region, setRegion] = useState<DeployRegion | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const base = getApiUrl().replace(/\/$/, "");

    fetch(`${base}/api/v1/health`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as HealthRegionResponse;
        setRegion(body.region);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Cosmetic marker: fail hidden (treated as non-staging) rather than
        // render a broken banner — but never swallow the error silently.
        console.debug(
          "[staging-banner] /api/v1/health probe failed:",
          err instanceof Error ? err.message : String(err),
        );
      });

    return () => controller.abort();
  }, []);

  if (!isStagingRegion(region)) return null;

  return (
    <div
      role="status"
      className={cn(
        "flex h-8 shrink-0 items-center justify-center gap-2 px-4",
        "bg-amber-500/90 text-amber-950 dark:bg-amber-500/80",
        "text-xs font-bold tracking-wider uppercase",
      )}
    >
      <span aria-hidden="true">&#9888;</span>
      <span>Staging environment</span>
      <span aria-hidden="true" className="text-amber-950/50">
        &middot;
      </span>
      <a
        href={STAGING_RUNBOOK_URL}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "rounded-sm underline underline-offset-2 hover:text-amber-900",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-950",
        )}
      >
        Runbook
      </a>
    </div>
  );
}
