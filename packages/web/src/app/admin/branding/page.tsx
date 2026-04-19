"use client";

import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  AlertCircle,
  Eye,
  Globe,
  Image as ImageIcon,
  Loader2,
  Palette,
  Plus,
  RotateCcw,
  ShieldOff,
  Type,
} from "lucide-react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  CompactRow,
  InlineError,
  SectionHeading,
  Shell,
  type StatusKind,
  useDisclosure,
} from "@/ui/components/admin/compact";
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
import { WorkspaceBrandingSchema } from "@/ui/lib/admin-schemas";

const BrandingResponseSchema = z
  .object({ branding: WorkspaceBrandingSchema.nullable() })
  .transform((r) => r.branding);

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

type BrandingValues = z.infer<typeof brandingSchema>;

const EMPTY: BrandingValues = {
  logoUrl: "",
  logoText: "",
  primaryColor: "",
  faviconUrl: "",
  hideAtlasBranding: false,
};

// ── Helpers ───────────────────────────────────────────────────────

// Shared status-label overrides for CompactRow's sr-only status text. Branding
// semantics differ from the compact primitive defaults (Connected / Not
// connected / Unavailable) — customization is the operative concept here.
const BRANDING_STATUS_LABEL: Record<StatusKind, string> = {
  connected: "Customized",
  disconnected: "Default",
  unavailable: "Unavailable",
  // These three kinds aren't used by branding rows, but StatusKind is the
  // full union from compact.tsx — satisfy the Record shape for type-safety.
  ready: "Ready",
  transitioning: "Transitioning",
  unhealthy: "Unhealthy",
};

function truncateUrl(url: string, max = 44): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

function countCustomized(v: BrandingValues): number {
  let n = 0;
  if (v.logoUrl) n++;
  if (v.logoText) n++;
  if (v.primaryColor) n++;
  if (v.faviconUrl) n++;
  if (v.hideAtlasBranding) n++;
  return n;
}

// ── Page ──────────────────────────────────────────────────────────

export default function BrandingPage() {
  const { data, loading, error, refetch } = useAdminFetch(
    "/api/v1/admin/branding",
    { schema: BrandingResponseSchema },
  );
  const save = useAdminMutation({
    path: "/api/v1/admin/branding",
    invalidates: refetch,
  });
  const reset = useAdminMutation({
    path: "/api/v1/admin/branding",
    invalidates: refetch,
  });

  const form = useForm<BrandingValues>({
    resolver: zodResolver(brandingSchema),
    defaultValues: EMPTY,
  });

  // Reset form to server state whenever the fetched `data` changes — e.g.
  // after save/reset refetches. `form.reset` has a stable identity per RHF,
  // so it's omitted from deps deliberately; adding it would loop.
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
      form.reset(EMPTY);
    }
  }, [data, loading]);

  const values = form.watch();
  const customized = countCustomized(values);
  const colorValid = !values.primaryColor || HEX_RE.test(values.primaryColor);
  const isDirty = form.formState.isDirty;
  const busy = save.saving || reset.saving;

  async function handleSave(v: BrandingValues) {
    // saveError is surfaced by <MutationErrorSurface> below — no throw
    // needed; react-hook-form's handleSubmit would swallow it anyway.
    await save.mutate({
      method: "PUT",
      body: {
        logoUrl: v.logoUrl || null,
        logoText: v.logoText || null,
        primaryColor: v.primaryColor || null,
        faviconUrl: v.faviconUrl || null,
        hideAtlasBranding: v.hideAtlasBranding,
      },
    });
  }

  async function handleReset() {
    const result = await reset.mutate({ method: "DELETE" });
    if (result.ok) form.reset(EMPTY);
  }

  return (
    <ErrorBoundary>
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Hero customized={customized} />

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Branding"
          onRetry={refetch}
          loadingMessage="Loading branding settings..."
        >
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSave)}
              className="space-y-10"
            >
              <section>
                <SectionHeading
                  title="Identity"
                  description="Replace Atlas defaults with your own logo, type, and color"
                />
                <div className="space-y-2">
                  <LogoUrlRow />
                  <LogoTextRow />
                  <PrimaryColorRow />
                  <FaviconRow />
                </div>
              </section>

              <section>
                <SectionHeading
                  title="Attribution"
                  description="Control how Atlas is credited across the UI"
                />
                <AttributionRow />
              </section>

              <section>
                <SectionHeading
                  title="Preview"
                  description="How the sidebar header renders with your current values"
                />
                <PreviewShell values={values} colorValid={colorValid} />
              </section>

              <MutationErrorSurface
                error={save.error}
                feature="Branding"
                variant="inline"
                inlinePrefix="Save failed."
              />
              <MutationErrorSurface
                error={reset.error}
                feature="Branding"
                variant="inline"
                inlinePrefix="Reset failed."
              />
              {!colorValid && (
                <InlineError>
                  Primary color must be a 6-digit hex (e.g. #FF5500). Open
                  the Primary color row to fix.
                </InlineError>
              )}

              <footer className="flex items-center gap-2 border-t border-border/50 pt-5">
                <Button
                  type="submit"
                  disabled={busy || !colorValid || !isDirty}
                  size="sm"
                >
                  {save.saving && (
                    <Loader2 className="mr-1.5 size-3 animate-spin" />
                  )}
                  {isDirty ? "Save changes" : "Saved"}
                </Button>
                {data && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleReset}
                    disabled={busy}
                  >
                    {reset.saving ? (
                      <Loader2 className="mr-1.5 size-3 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-1.5 size-3" />
                    )}
                    Reset to defaults
                  </Button>
                )}
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {customized === 0
                    ? "Using Atlas defaults"
                    : `${customized} of 5 customized`}
                </span>
              </footer>
            </form>
          </Form>
        </AdminContentWrapper>
      </div>
    </ErrorBoundary>
  );
}

// ── Hero ──────────────────────────────────────────────────────────

function Hero({ customized }: { customized: number }) {
  const stat =
    customized === 0 ? "Default" : `${customized} / 5 customized`;
  return (
    <header className="mb-10 flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Atlas · Admin
      </p>
      <div className="flex items-baseline justify-between gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">Branding</h1>
        <p className="shrink-0 font-mono text-sm tabular-nums text-foreground">
          {stat}
        </p>
      </div>
      <p className="max-w-xl text-sm text-muted-foreground">
        Customize the look and feel of your workspace. Changes affect the admin
        console, chat UI, and widget embeds.
      </p>
    </header>
  );
}

// ── Rows ──────────────────────────────────────────────────────────

function LogoUrlRow() {
  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure();
  const value = useWatchField("logoUrl");
  const status: StatusKind = value ? "connected" : "disconnected";

  if (!expanded) {
    return (
      <CompactRow
        icon={ImageIcon}
        title="Logo image"
        description={value || "Replace the Atlas logo with your own image"}
        status={status}
        statusLabel={BRANDING_STATUS_LABEL[status]}
        action={
          <Button
            ref={triggerRef}
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            {value ? (
              "Edit"
            ) : (
              <>
                <Plus className="mr-1.5 size-3.5" />
                Set URL
              </>
            )}
          </Button>
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={ImageIcon}
      title="Logo image"
      description="PNG, SVG, or JPEG recommended. Served from your own origin."
      status="disconnected"
      onCollapse={collapse}
    >
      <FormField
        name="logoUrl"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="sr-only">Logo URL</FormLabel>
            <FormControl>
              <Input
                placeholder="https://example.com/logo.png"
                className="font-mono text-sm"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </Shell>
  );
}

function LogoTextRow() {
  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure();
  const value = useWatchField("logoText");
  const status: StatusKind = value ? "connected" : "disconnected";

  if (!expanded) {
    return (
      <CompactRow
        icon={Type}
        title="Logo text"
        description={value || "Displayed next to or instead of the logo"}
        status={status}
        statusLabel={BRANDING_STATUS_LABEL[status]}
        action={
          <Button
            ref={triggerRef}
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            {value ? (
              "Edit"
            ) : (
              <>
                <Plus className="mr-1.5 size-3.5" />
                Set text
              </>
            )}
          </Button>
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={Type}
      title="Logo text"
      description="Usually your company name. Shown in the sidebar header."
      status="disconnected"
      onCollapse={collapse}
    >
      <FormField
        name="logoText"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="sr-only">Logo text</FormLabel>
            <FormControl>
              <Input placeholder="Acme Corp" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </Shell>
  );
}

function PrimaryColorRow() {
  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure();
  const value = useWatchField("primaryColor");
  const valid = !value || HEX_RE.test(value);
  const swatchColor = valid && value ? value : null;
  const invalid = Boolean(value) && !valid;
  const status: StatusKind = invalid
    ? "unavailable"
    : value
      ? "connected"
      : "disconnected";

  // Compact's `icon` prop expects a ComponentType<{className?: string}>. For
  // the swatch case we wrap the colored span in a local component so the
  // outer tile's neutral grid frame keeps rendering uniformly; Palette falls
  // through as the lucide fallback.
  const SwatchIcon = swatchColor
    ? ({ className }: { className?: string }) => (
        <span
          aria-hidden
          className={`rounded-sm border border-border/60 ${className ?? ""}`}
          style={{ backgroundColor: swatchColor }}
        />
      )
    : Palette;

  if (!expanded) {
    return (
      <CompactRow
        icon={SwatchIcon}
        title="Primary color"
        description={
          invalid ? (
            <span className="text-destructive">
              Invalid hex — click Edit to fix
            </span>
          ) : value ? (
            <span className="font-mono text-[11px]">{value}</span>
          ) : (
            "Teal is the default accent"
          )
        }
        status={status}
        statusLabel={BRANDING_STATUS_LABEL[status]}
        action={
          <Button
            ref={triggerRef}
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            {value ? (
              "Edit"
            ) : (
              <>
                <Plus className="mr-1.5 size-3.5" />
                Set color
              </>
            )}
          </Button>
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={SwatchIcon}
      title="Primary color"
      description="6-digit hex (e.g. #FF5500). Used for buttons and accents."
      status="disconnected"
      onCollapse={collapse}
    >
      <FormField
        name="primaryColor"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="sr-only">Primary color</FormLabel>
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="size-10 shrink-0 rounded-md border"
                style={{
                  backgroundColor: swatchColor ?? "var(--muted)",
                }}
              />
              <FormControl>
                <Input
                  placeholder="#FF5500"
                  className="font-mono text-sm"
                  {...field}
                />
              </FormControl>
            </div>
            <FormMessage />
          </FormItem>
        )}
      />
    </Shell>
  );
}

function FaviconRow() {
  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure();
  const value = useWatchField("faviconUrl");
  const status: StatusKind = value ? "connected" : "disconnected";

  if (!expanded) {
    return (
      <CompactRow
        icon={Globe}
        title="Favicon"
        description={value ? truncateUrl(value) : "Shown in browser tabs and bookmarks"}
        status={status}
        statusLabel={BRANDING_STATUS_LABEL[status]}
        action={
          <Button
            ref={triggerRef}
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            {value ? (
              "Edit"
            ) : (
              <>
                <Plus className="mr-1.5 size-3.5" />
                Set URL
              </>
            )}
          </Button>
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={Globe}
      title="Favicon"
      description="Accepts .ico, .png, or .svg."
      status="disconnected"
      onCollapse={collapse}
    >
      <FormField
        name="faviconUrl"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="sr-only">Favicon URL</FormLabel>
            <FormControl>
              <Input
                placeholder="https://example.com/favicon.ico"
                className="font-mono text-sm"
                {...field}
              />
            </FormControl>
            <FormDescription className="text-[11px]">
              Browsers cache favicons aggressively; clear site data to verify.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </Shell>
  );
}

function AttributionRow() {
  return (
    <FormField
      name="hideAtlasBranding"
      render={({ field }) => {
        const status: StatusKind = field.value ? "connected" : "disconnected";
        return (
          <FormItem className="space-y-0">
            <CompactRow
              icon={ShieldOff}
              title="Hide Atlas branding"
              description={
                field.value
                  ? "“Atlas” and “Powered by Atlas” text are hidden"
                  : "Default — Atlas attribution remains visible"
              }
              status={status}
              statusLabel={BRANDING_STATUS_LABEL[status]}
              action={
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    aria-label="Hide Atlas branding"
                  />
                </FormControl>
              }
            />
          </FormItem>
        );
      }}
    />
  );
}

// ── Preview shell ─────────────────────────────────────────────────

function PreviewShell({
  values,
  colorValid,
}: {
  values: BrandingValues;
  colorValid: boolean;
}) {
  const { logoUrl, logoText, primaryColor, hideAtlasBranding } = values;
  const anyCustomized = countCustomized(values) > 0;
  const bg =
    primaryColor && colorValid ? primaryColor : "var(--sidebar-primary)";

  const [logoBroken, setLogoBroken] = useState(false);
  // Re-attempt the load whenever the URL changes so a typo fix clears the error
  useEffect(() => {
    setLogoBroken(false);
  }, [logoUrl]);

  return (
    <Shell
      icon={Eye}
      title="Sidebar header"
      description="Live preview — reflects unsaved edits."
      status={anyCustomized ? "connected" : "disconnected"}
    >
      <div className="rounded-lg border bg-background/60 p-4">
        <div className="flex items-center gap-3">
          {logoUrl && !logoBroken ? (
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- user-supplied URL, not in next.config remotePatterns */}
              <img
                src={logoUrl}
                alt="Logo preview"
                className="size-6 object-contain"
                onError={() => {
                  // Surface a signal to the user (AlertCircle fallback) +
                  // a debug trail so the admin can diagnose CORS / 404 / codec.
                  console.debug("[branding] logo preview failed to load", {
                    logoUrl,
                  });
                  setLogoBroken(true);
                }}
              />
            </div>
          ) : logoUrl && logoBroken ? (
            <div
              className="flex size-8 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive"
              title="Logo URL failed to load"
            >
              <AlertCircle className="size-4" />
            </div>
          ) : (
            <div
              className="flex size-8 items-center justify-center rounded-lg"
              style={{ backgroundColor: bg }}
            >
              <svg
                viewBox="0 0 256 256"
                fill="none"
                className="size-4 text-white"
                aria-hidden="true"
              >
                <path
                  d="M128 24 L232 208 L24 208 Z"
                  stroke="currentColor"
                  strokeWidth="20"
                  fill="none"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          )}
          <div className="grid min-w-0 text-left text-sm leading-tight">
            <span className="truncate font-semibold">
              {hideAtlasBranding ? logoText || "Your Brand" : logoText || "Atlas"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {hideAtlasBranding ? "" : "Admin Console"}
            </span>
          </div>
        </div>
      </div>
      {logoUrl && logoBroken && (
        <p className="text-[11px] leading-relaxed text-destructive">
          Logo failed to load. Check the URL is reachable and serves a valid
          image with permissive CORS headers.
        </p>
      )}
    </Shell>
  );
}

// ── Internal hook ─────────────────────────────────────────────────

function useWatchField<K extends keyof BrandingValues>(
  name: K,
): BrandingValues[K] {
  return useWatch({ name }) as BrandingValues[K];
}
