"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { getApiUrl, isCrossOrigin, applyRegionSignal } from "@/lib/api-url";
import { navigatePostAuth } from "@/lib/auth/post-auth-nav";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RegionCardGrid } from "@/ui/components/region-picker";
import { RegionPickerItemSchema } from "@/ui/lib/admin-schemas";
import type { RegionPickerItem } from "@/ui/lib/types";
import { Loader2, ShieldCheck } from "lucide-react";
import { SignupShell } from "@/ui/components/signup/signup-shell";

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function getCredentials(): RequestCredentials {
  return isCrossOrigin() ? "include" : "same-origin";
}

const RegionsResponseSchema = z.object({
  configured: z.boolean(),
  defaultRegion: z.string(),
  availableRegions: z.array(RegionPickerItemSchema),
});

export default function RegionPage() {
  const router = useRouter();
  const [regions, setRegions] = useState<RegionPickerItem[]>([]);
  const [defaultRegion, setDefaultRegion] = useState("");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  // Count consecutive load failures so a persistent outage swaps the generic
  // "retry" copy for an honest support path instead of a silent dead-end
  // (#3934). The initial load + one failed retry both failing => persistent.
  const [loadAttempts, setLoadAttempts] = useState(0);

  const loadRegions = useCallback(() => {
    setLoading(true);
    setError(null);
    const base = getApiBase();
    fetch(`${base}/api/v1/onboarding/regions`, { credentials: getCredentials() })
      .then((res) => {
        if (!res.ok) throw new Error(`Regions returned ${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((raw) => RegionsResponseSchema.parse(raw))
      .then((data) => {
        if (!data.configured || data.availableRegions.length === 0) {
          // No residency configured (self-hosted / single-region) — there's
          // nothing to pick and only one API base, so skip straight to account
          // creation on it. `replace` keeps this transient step out of history.
          setSkipping(true);
          router.replace("/signup/account");
          return;
        }
        setRegions(data.availableRegions);
        setDefaultRegion(data.defaultRegion);
        // Pre-select the default region
        setSelected(data.defaultRegion);
        // Reset on success so a later, unrelated failure (e.g. assign-region
        // in handleContinue) doesn't inherit the "persistent load outage" copy
        // — the count tracks region-*load* failures only.
        setLoadAttempts(0);
        setLoading(false);
      })
      .catch((err: unknown) => {
        console.warn("Failed to fetch regions:", err instanceof Error ? err.message : String(err));
        // Show error instead of silently skipping — auto-skip only happens
        // when the API explicitly returns configured=false (200 response), so a
        // transient failure can't push someone past a deploy's required region
        // pick. #3925 — pair the error with an in-place Retry so the user isn't
        // dead-ended on a disabled Continue with only the Back link.
        setLoadAttempts((n) => n + 1);
        setError("Unable to load region options.");
        setLoading(false);
      });
  }, [router]);

  useEffect(() => {
    loadRegions();
  }, [loadRegions]);

  function handleContinue() {
    if (!selected) return;

    setSaving(true);
    setError(null);

    // Under ADR-0024 §4 the region is chosen BEFORE the first identity write,
    // so there is no session yet and nothing to POST to a server. Instead, the
    // selection repoints the browser at the region's API base and persists the
    // `atlas_region` cookie (`applyRegionSignal`, #3971). The org's region is
    // then stamped from the ambient `ATLAS_API_REGION` when the workspace is
    // created on that regional API (#3969) — no post-hoc `assign-region`.
    const region = regions.find((r) => r.id === selected);
    const apiUrl = region?.apiUrl;

    if (apiUrl) {
      if (!applyRegionSignal(selected, apiUrl)) {
        // applyRegionSignal logged the rejected base; surface it rather than
        // hard-navigate to a region we couldn't actually point the browser at,
        // which would silently create the account in the default (US) region.
        setError("We couldn't route you to the selected region. Please try again or contact support.");
        setSaving(false);
        return;
      }
    } else if (!region?.isDefault) {
      // A *non-default* selectable region with no apiUrl is a deploy
      // misconfiguration: there's nothing to repoint to, so falling through
      // would create the account on the default (US) base — the exact silent
      // wrong-region dead-end this flow exists to kill (#3967/#3971). Refuse,
      // the same as a rejected signal, instead of proceeding on a warning.
      console.error(`Region "${selected}" is selectable but has no apiUrl; refusing to fall back to the default region.`);
      setError("This region isn't fully configured for signup yet. Please contact support.");
      setSaving(false);
      return;
    }
    // Only path left without a repoint: the DEFAULT region on a single-region /
    // local deploy (its own apiUrl omitted) — the same-origin base IS that one
    // region, so creating the account on it is correct, not a fallback.

    // HARD navigation (full reload via navigatePostAuth), not router.push:
    // `@/lib/auth/client`'s Better-Auth singleton captured its baseURL at module
    // import, so only a fresh page load re-reads the `atlas_region` cookie and
    // rebuilds the client against the regional base. A soft nav would create the
    // account on the pre-region (default) API. The account step then runs
    // entirely in-region.
    navigatePostAuth("/signup/account");
  }

  if (loading || skipping) {
    return (
      <SignupShell step="region" width="wide">
        <Card>
          <CardContent className="flex items-center justify-center p-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </SignupShell>
    );
  }

  return (
    <SignupShell step="region" width="wide" back={{ href: "/signup" }}>
      <Card>
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl tracking-tight">Choose your data region</CardTitle>
          <CardDescription className="mx-auto max-w-md">
            Where Atlas stores workspace metadata, audit logs, and saved queries.
            Your connected database stays where it lives — Atlas only reads from it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <RegionCardGrid
            regions={regions}
            selected={selected}
            onSelect={setSelected}
            disabled={saving}
          />

          <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <p>
              Pick the region closest to your team — it affects metadata latency, not
              where your source database lives. Region can be migrated later via the
              admin console (Data Residency) if your team relocates.
            </p>
          </div>

          {error && (
            <div role="alert" className="space-y-3 text-sm text-destructive">
              <p>
                {loadAttempts >= 2
                  ? "We're still unable to load region options. This is usually a temporary network issue — retry, or contact support if it keeps happening."
                  : error}
              </p>
              {/* Load failure leaves no region to select, so Continue stays
                  disabled — offer an in-place retry instead of a dead end whose
                  only escape is the Back link. After repeated failures the copy
                  swaps to a support path so a persistent outage isn't a silent
                  dead-end (#3934). (#3925) */}
              {regions.length === 0 && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={loadRegions}
                    disabled={saving}
                    className="w-full"
                  >
                    Retry
                  </Button>
                  {loadAttempts >= 2 && (
                    <Button asChild type="button" variant="ghost" className="w-full">
                      <a href="mailto:support@useatlas.dev?subject=Trouble%20loading%20signup%20regions">
                        Contact support
                      </a>
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          <Button
            onClick={handleContinue}
            disabled={!selected || saving}
            className="w-full"
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Assigning region...
              </>
            ) : selected && selected === defaultRegion ? (
              "Continue with default region"
            ) : (
              "Continue"
            )}
          </Button>
        </CardContent>
      </Card>
    </SignupShell>
  );
}
