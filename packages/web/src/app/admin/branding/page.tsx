"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Paintbrush, Loader2, RotateCcw, Eye } from "lucide-react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
} from "@/components/ui/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { WorkspaceBranding } from "@/ui/lib/types";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const brandingSchema = z.object({
  logoUrl: z.string(),
  logoText: z.string(),
  primaryColor: z.string().refine((v) => !v || HEX_RE.test(v), {
    message: "Must be a 6-digit hex color (e.g. #FF5500)",
  }),
  faviconUrl: z.string(),
  hideAtlasBranding: z.boolean(),
});

export default function BrandingPage() {
  const { data, loading, error, refetch } = useAdminFetch<WorkspaceBranding | null>(
    "/api/v1/admin/branding",
    { transform: (json) => (json as { branding: WorkspaceBranding | null }).branding },
  );
  const { mutate, saving, error: saveError } = useAdminMutation({
    path: "/api/v1/admin/branding",
    invalidates: refetch,
  });

  const form = useForm<z.infer<typeof brandingSchema>>({
    resolver: zodResolver(brandingSchema),
    defaultValues: { logoUrl: "", logoText: "", primaryColor: "", faviconUrl: "", hideAtlasBranding: false },
  });

  // Sync form when server data loads or changes
  useEffect(() => {
    if (loading) return;
    if (data) {
      form.reset({
        logoUrl: data.logoUrl ?? "",
        logoText: data.logoText ?? "",
        primaryColor: data.primaryColor ?? "",
        faviconUrl: data.faviconUrl ?? "",
        hideAtlasBranding: data.hideAtlasBranding,
      });
    } else {
      form.reset({ logoUrl: "", logoText: "", primaryColor: "", faviconUrl: "", hideAtlasBranding: false });
    }
  }, [data, loading]); // intentionally reset when data changes (after save/refetch)

  const primaryColor = form.watch("primaryColor");
  const logoUrl = form.watch("logoUrl");
  const logoText = form.watch("logoText");
  const hideAtlasBranding = form.watch("hideAtlasBranding");
  const colorValid = !primaryColor || HEX_RE.test(primaryColor);

  async function handleSave(values: z.infer<typeof brandingSchema>) {
    const result = await mutate({
      method: "PUT",
      body: {
        logoUrl: values.logoUrl || null,
        logoText: values.logoText || null,
        primaryColor: values.primaryColor || null,
        faviconUrl: values.faviconUrl || null,
        hideAtlasBranding: values.hideAtlasBranding,
      },
    });
    if (!result.ok) {
      throw new Error("Save failed");
    }
  }

  async function handleReset() {
    const result = await mutate({ method: "DELETE" });
    if (result.ok) {
      form.reset({ logoUrl: "", logoText: "", primaryColor: "", faviconUrl: "", hideAtlasBranding: false });
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Branding</h1>
        <p className="text-sm text-muted-foreground">
          Customize the look and feel of your Atlas workspace. Replace the Atlas logo, colors, and favicon with your own brand.
        </p>
      </div>

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Branding"
        onRetry={refetch}
        loadingMessage="Loading branding settings..."
      >
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
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(handleSave)} className="space-y-5">
                  {/* Logo URL */}
                  <FormField
                    control={form.control}
                    name="logoUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Logo URL</FormLabel>
                        <FormControl>
                          <Input placeholder="https://example.com/logo.png" className="font-mono text-sm" {...field} />
                        </FormControl>
                        <FormDescription>URL to your custom logo image (PNG, SVG, or JPEG recommended).</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Logo Text */}
                  <FormField
                    control={form.control}
                    name="logoText"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Logo Text</FormLabel>
                        <FormControl>
                          <Input placeholder="Acme Corp" {...field} />
                        </FormControl>
                        <FormDescription>Text displayed next to or instead of the logo (e.g. your company name).</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Primary Color */}
                  <FormField
                    control={form.control}
                    name="primaryColor"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Primary Color</FormLabel>
                        <div className="flex items-center gap-3">
                          <div
                            className="size-10 rounded-md border"
                            style={{ backgroundColor: colorValid && primaryColor ? primaryColor : "#e5e5e5" }}
                          />
                          <FormControl>
                            <Input placeholder="#FF5500" className="font-mono text-sm" {...field} />
                          </FormControl>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Favicon URL */}
                  <FormField
                    control={form.control}
                    name="faviconUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Favicon URL</FormLabel>
                        <FormControl>
                          <Input placeholder="https://example.com/favicon.ico" className="font-mono text-sm" {...field} />
                        </FormControl>
                        <FormDescription>URL to a custom favicon (.ico, .png, or .svg).</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Hide Atlas Branding */}
                  <FormField
                    control={form.control}
                    name="hideAtlasBranding"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-3 space-y-0">
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                        <FormLabel className="cursor-pointer">Hide Atlas branding</FormLabel>
                      </FormItem>
                    )}
                  />
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
                    <Button type="submit" disabled={saving || !colorValid} size="sm">
                      {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
                      Save
                    </Button>
                    {data && (
                      <Button type="button" variant="outline" size="sm" onClick={handleReset} disabled={saving}>
                        <RotateCcw className="mr-1 size-3" />
                        Reset to defaults
                      </Button>
                    )}
                  </div>
                </form>
              </Form>
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
      </AdminContentWrapper>
    </div>
  );
}
