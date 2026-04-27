"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
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

  useEffect(() => {
    const base = getApiBase();
    fetch(`${base}/api/v1/onboarding/regions`, { credentials: getCredentials() })
      .then((res) => {
        if (!res.ok) throw new Error(`Regions returned ${res.status}`);
        return res.json();
      })
      .then((raw) => RegionsResponseSchema.parse(raw))
      .then((data) => {
        if (!data.configured || data.availableRegions.length === 0) {
          // No residency configured — skip to connect
          setSkipping(true);
          router.replace("/signup/connect");
          return;
        }
        setRegions(data.availableRegions);
        setDefaultRegion(data.defaultRegion);
        // Pre-select the default region
        setSelected(data.defaultRegion);
        setLoading(false);
      })
      .catch((err: unknown) => {
        console.warn("Failed to fetch regions:", err instanceof Error ? err.message : String(err));
        // Show error instead of silently skipping — auto-skip only happens
        // when the API explicitly returns configured=false (200 response).
        setError("Unable to load region options. Please refresh the page or try again.");
        setLoading(false);
      });
  }, [router]);

  async function handleContinue() {
    if (!selected) return;

    setSaving(true);
    setError(null);

    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/v1/onboarding/assign-region`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: getCredentials(),
        body: JSON.stringify({ region: selected }),
      });

      let data: Record<string, unknown>;
      try {
        data = await res.json() as Record<string, unknown>;
      } catch (parseErr) {
        console.warn("Failed to parse assign-region response:", parseErr instanceof Error ? parseErr.message : String(parseErr));
        setError("Server returned an unexpected response. Please try again.");
        return;
      }

      if (!res.ok) {
        setError((data.message as string) ?? "Failed to assign region");
        return;
      }

      router.push("/signup/connect");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("Region assignment failed:", message);
      setError(
        err instanceof TypeError
          ? "Unable to reach the server. Check your connection and try again."
          : `Failed to assign region: ${message}`,
      );
    } finally {
      setSaving(false);
    }
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
    <SignupShell step="region" width="wide" back={{ href: "/signup/workspace" }}>
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
              Region assignment is permanent. Pick the region closest to your team — it
              affects metadata latency, not where your source database lives.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
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
