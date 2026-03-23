"use client";

import { useState } from "react";
import { Paintbrush, Loader2, RotateCcw, Eye } from "lucide-react";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { WorkspaceBranding } from "@/ui/lib/types";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export default function BrandingPage() {
  const { data, loading, error, refetch } = useAdminFetch<WorkspaceBranding | null>(
    "/api/v1/admin/branding",
    { transform: (json) => (json as { branding: WorkspaceBranding | null }).branding },
  );
  const { mutate, saving, error: saveError } = useAdminMutation({
    path: "/api/v1/admin/branding",
    invalidates: refetch,
  });

  const [logoUrl, setLogoUrl] = useState("");
  const [logoText, setLogoText] = useState("");
  const [primaryColor, setPrimaryColor] = useState("");
  const [faviconUrl, setFaviconUrl] = useState("");
  const [hideAtlasBranding, setHideAtlasBranding] = useState(false);
  const [synced, setSynced] = useState(false);

  // Sync form state when data loads
  if (data && !synced) {
    setLogoUrl(data.logoUrl ?? "");
    setLogoText(data.logoText ?? "");
    setPrimaryColor(data.primaryColor ?? "");
    setFaviconUrl(data.faviconUrl ?? "");
    setHideAtlasBranding(data.hideAtlasBranding);
    setSynced(true);
  }
  if (!loading && !data && !synced) {
    setSynced(true);
  }

  // Gate on 401/403/404
  if (!loading && error?.status && [401, 403, 404].includes(error.status)) {
    return <FeatureGate status={error.status as 401 | 403 | 404} feature="Branding" />;
  }

  const colorValid = !primaryColor || HEX_RE.test(primaryColor);

  async function handleSave() {
    await mutate({
      method: "PUT",
      body: {
        logoUrl: logoUrl || null,
        logoText: logoText || null,
        primaryColor: primaryColor || null,
        faviconUrl: faviconUrl || null,
        hideAtlasBranding,
      },
    });
  }

  async function handleReset() {
    await mutate({ method: "DELETE" });
    // Always reset form — 404 means no branding exists (already default)
    setLogoUrl("");
    setLogoText("");
    setPrimaryColor("");
    setFaviconUrl("");
    setHideAtlasBranding(false);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Branding</h2>
        <p className="text-sm text-muted-foreground">
          Customize the look and feel of your Atlas workspace. Replace the Atlas logo, colors, and favicon with your own brand.
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading branding settings...
        </div>
      )}

      {!loading && error && !([401, 403, 404].includes(error.status ?? 0)) && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {friendlyError(error)}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Form */}
          <Card className="shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Paintbrush className="size-4" />
                Workspace Branding
              </CardTitle>
              <CardDescription>
                Configure custom branding for this workspace. Changes affect the admin console, chat UI, and widget embeds.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Logo URL */}
              <div className="space-y-2">
                <Label htmlFor="logoUrl">Logo URL</Label>
                <Input
                  id="logoUrl"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://example.com/logo.png"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">URL to your custom logo image (PNG, SVG, or JPEG recommended).</p>
              </div>

              {/* Logo Text */}
              <div className="space-y-2">
                <Label htmlFor="logoText">Logo Text</Label>
                <Input
                  id="logoText"
                  value={logoText}
                  onChange={(e) => setLogoText(e.target.value)}
                  placeholder="Acme Corp"
                />
                <p className="text-xs text-muted-foreground">Text displayed next to or instead of the logo (e.g. your company name).</p>
              </div>

              {/* Primary Color */}
              <div className="space-y-2">
                <Label htmlFor="primaryColor">Primary Color</Label>
                <div className="flex items-center gap-3">
                  <div
                    className="size-10 rounded-md border"
                    style={{ backgroundColor: colorValid && primaryColor ? primaryColor : "#e5e5e5" }}
                  />
                  <Input
                    id="primaryColor"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    placeholder="#FF5500"
                    className="font-mono text-sm"
                  />
                </div>
                {primaryColor && !colorValid && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Must be a 6-digit hex color (e.g. <code className="rounded bg-muted px-1">#FF5500</code>).
                  </p>
                )}
              </div>

              {/* Favicon URL */}
              <div className="space-y-2">
                <Label htmlFor="faviconUrl">Favicon URL</Label>
                <Input
                  id="faviconUrl"
                  value={faviconUrl}
                  onChange={(e) => setFaviconUrl(e.target.value)}
                  placeholder="https://example.com/favicon.ico"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">URL to a custom favicon (.ico, .png, or .svg).</p>
              </div>

              {/* Hide Atlas Branding */}
              <div className="flex items-center gap-3">
                <Switch
                  id="hideAtlasBranding"
                  checked={hideAtlasBranding}
                  onCheckedChange={setHideAtlasBranding}
                />
                <Label htmlFor="hideAtlasBranding" className="cursor-pointer">
                  Hide Atlas branding
                </Label>
              </div>
              <p className="text-xs text-muted-foreground -mt-3">
                When enabled, removes &ldquo;Atlas&rdquo; and &ldquo;Powered by Atlas&rdquo; text from the UI.
              </p>

              {/* Error */}
              {saveError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {saveError}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <Button onClick={handleSave} disabled={saving || !colorValid} size="sm">
                  {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
                  Save
                </Button>
                {data && (
                  <Button variant="outline" size="sm" onClick={handleReset} disabled={saving}>
                    <RotateCcw className="mr-1 size-3" />
                    Reset to defaults
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Live Preview */}
          <Card className="shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Eye className="size-4" />
                Live Preview
              </CardTitle>
              <CardDescription>Preview how the sidebar header will look with your branding.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  {/* Logo preview */}
                  {logoUrl ? (
                    <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={logoUrl}
                        alt="Logo preview"
                        className="size-6 object-contain"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    </div>
                  ) : (
                    <div
                      className="flex size-8 items-center justify-center rounded-lg"
                      style={{ backgroundColor: primaryColor && colorValid ? primaryColor : "var(--sidebar-primary)" }}
                    >
                      <svg viewBox="0 0 256 256" fill="none" className="size-4 text-white" aria-hidden="true">
                        <path d="M128 24 L232 208 L24 208 Z" stroke="currentColor" strokeWidth="20" fill="none" strokeLinejoin="round" />
                      </svg>
                    </div>
                  )}
                  {/* Text preview */}
                  <div className="grid text-left text-sm leading-tight">
                    <span className="truncate font-semibold">
                      {hideAtlasBranding ? (logoText || "Your Brand") : (logoText || "Atlas")}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {hideAtlasBranding ? "" : "Admin Console"}
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
