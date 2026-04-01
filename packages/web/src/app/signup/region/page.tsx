"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";
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
import { Loader2, MapPin } from "lucide-react";

function getApiBase(): string {
  if (API_URL) return API_URL;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function getCredentials(): RequestCredentials {
  return IS_CROSS_ORIGIN ? "include" : "same-origin";
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
        setError("Server returned an unexpected response.");
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

  // Show nothing while loading or auto-skipping
  if (loading || skipping) {
    return (
      <Card className="w-full max-w-md">
        <CardContent className="flex items-center justify-center p-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <MapPin className="size-6 text-primary" />
        </div>
        <CardTitle className="text-2xl">Choose your data region</CardTitle>
        <CardDescription>
          Select where your workspace data will be stored. This choice is
          permanent and cannot be changed later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <RegionCardGrid
          regions={regions}
          selected={selected}
          onSelect={setSelected}
          disabled={saving}
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-col gap-2">
          <Button
            onClick={handleContinue}
            disabled={!selected || saving}
            className="w-full"
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Assigning...
              </>
            ) : (
              "Continue"
            )}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {defaultRegion && selected === defaultRegion
              ? "Using the default region. You can select a different one above."
              : "Region assignment is permanent and cannot be changed."}
          </p>
        </div>

        <div className="flex justify-center">
          <StepIndicator current={3} total={5} />
        </div>
      </CardContent>
    </Card>
  );
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i < current ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/30"
          }`}
        />
      ))}
    </div>
  );
}
