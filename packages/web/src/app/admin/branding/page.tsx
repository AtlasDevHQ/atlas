"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Eye,
  Globe,
  Image as ImageIcon,
  Loader2,
  Palette,
  Plus,
  RotateCcw,
  ShieldOff,
  Type,
  X,
} from "lucide-react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
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
import { cn } from "@/lib/utils";

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

// ── Shared design primitives ──────────────────────────────────────
// Local copies of the admin/integrations + admin/billing primitives.
// Promote to @/ui/components/admin/ once a fourth page reuses them.

type StatusKind = "connected" | "disconnected" | "unavailable";

function StatusDot({
  kind,
  className,
}: {
  kind: StatusKind;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_15%,transparent)]",
        kind === "disconnected" && "bg-muted-foreground/40",
        kind === "unavailable" &&
          "bg-muted-foreground/20 outline-1 outline-dashed outline-muted-foreground/30",
        className,
      )}
    >
      {kind === "connected" && (
        <span className="absolute inset-0 rounded-full bg-primary/60 motion-safe:animate-ping" />
      )}
    </span>
  );
}

const STATUS_LABEL: Record<StatusKind, string> = {
  connected: "Customized",
  disconnected: "Default",
  unavailable: "Unavailable",
};

function BrandingShell({
  id,
  icon,
  title,
  description,
  status,
  children,
  actions,
  onCollapse,
  panelRef,
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  description: string;
  status: StatusKind;
  children?: ReactNode;
  actions?: ReactNode;
  onCollapse?: () => void;
  panelRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <section
      id={id}
      ref={panelRef}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-card/60 backdrop-blur-[1px] transition-colors",
        "hover:border-border/80",
        status === "connected" && "border-primary/20",
      )}
    >
      {status === "connected" && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-linear-to-b from-transparent via-primary to-transparent opacity-70"
        />
      )}

      <header className="flex items-start gap-3 p-4 pb-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40",
            status === "connected" && "border-primary/30 text-primary",
            status !== "connected" && "text-muted-foreground",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
              {title}
            </h3>
            {status === "connected" && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
                <StatusDot kind="connected" />
                Live
              </span>
            )}
            {status !== "connected" && onCollapse && (
              <button
                type="button"
                aria-label="Cancel"
                onClick={onCollapse}
                className="ml-auto -m-1 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {description}
          </p>
        </div>
      </header>

      {children != null && (
        <div className="flex-1 space-y-3 px-4 pb-3 text-sm">{children}</div>
      )}

      {actions && (
        <footer className="flex items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
          {actions}
        </footer>
      )}
    </section>
  );
}

function CompactRow({
  icon,
  title,
  description,
  status,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  status: StatusKind;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card/40 px-3.5 py-2.5 transition-colors",
        "hover:bg-card/70 hover:border-border/80",
        status === "unavailable" && "opacity-60",
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
            {title}
          </h3>
          <StatusDot kind={status} className="shrink-0" />
          <span className="sr-only">Status: {STATUS_LABEL[status]}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{description}</p>
    </div>
  );
}

function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {children}
    </div>
  );
}

/**
 * Disclosure helper for progressive-disclosure rows. Moves focus into the
 * revealed panel on expand, restores it to the trigger on collapse.
 */
function useDisclosure() {
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const prev = useRef(false);

  useEffect(() => {
    if (expanded && !prev.current) {
      const first = panelRef.current?.querySelector<HTMLElement>(
        "input:not([disabled]), textarea:not([disabled])",
      );
      first?.focus();
    } else if (!expanded && prev.current) {
      triggerRef.current?.focus();
    }
    prev.current = expanded;
  }, [expanded]);

  return {
    expanded,
    setExpanded,
    collapse: () => setExpanded(false),
    triggerRef,
    panelRef,
    panelId,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

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
  const {
    mutate,
    saving,
    error: saveError,
  } = useAdminMutation({
    path: "/api/v1/admin/branding",
    invalidates: refetch,
  });

  const form = useForm<BrandingValues>({
    resolver: zodResolver(brandingSchema),
    defaultValues: EMPTY,
  });

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
  }, [data, loading]); // intentionally reset when data changes

  const values = form.watch();
  const customized = countCustomized(values);
  const colorValid = !values.primaryColor || HEX_RE.test(values.primaryColor);
  const isDirty = form.formState.isDirty;

  async function handleSave(v: BrandingValues) {
    const result = await mutate({
      method: "PUT",
      body: {
        logoUrl: v.logoUrl || null,
        logoText: v.logoText || null,
        primaryColor: v.primaryColor || null,
        faviconUrl: v.faviconUrl || null,
        hideAtlasBranding: v.hideAtlasBranding,
      },
    });
    if (!result.ok) throw new Error("Save failed");
  }

  async function handleReset() {
    const result = await mutate({ method: "DELETE" });
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

              <InlineError>{saveError}</InlineError>

              <footer className="flex items-center gap-2 border-t border-border/50 pt-5">
                <Button
                  type="submit"
                  disabled={saving || !colorValid || !isDirty}
                  size="sm"
                >
                  {saving && <Loader2 className="mr-1.5 size-3 animate-spin" />}
                  {isDirty ? "Save changes" : "Saved"}
                </Button>
                {data && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleReset}
                    disabled={saving}
                  >
                    <RotateCcw className="mr-1.5 size-3" />
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

  if (!expanded) {
    return (
      <CompactRow
        icon={<ImageIcon className="size-4" />}
        title="Logo image"
        description={value || "Replace the Atlas logo with your own image"}
        status={value ? "connected" : "disconnected"}
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
    <BrandingShell
      id={panelId}
      panelRef={panelRef}
      icon={<ImageIcon className="size-4" />}
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
    </BrandingShell>
  );
}

function LogoTextRow() {
  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure();
  const value = useWatchField("logoText");

  if (!expanded) {
    return (
      <CompactRow
        icon={<Type className="size-4" />}
        title="Logo text"
        description={value || "Displayed next to or instead of the logo"}
        status={value ? "connected" : "disconnected"}
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
    <BrandingShell
      id={panelId}
      panelRef={panelRef}
      icon={<Type className="size-4" />}
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
    </BrandingShell>
  );
}

function PrimaryColorRow() {
  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure();
  const value = useWatchField("primaryColor");
  const valid = !value || HEX_RE.test(value);
  const swatchColor = valid && value ? value : null;
  const status: StatusKind = value ? "connected" : "disconnected";

  const swatchIcon = swatchColor ? (
    <span
      aria-hidden
      className="size-4 rounded-sm border border-border/60"
      style={{ backgroundColor: swatchColor }}
    />
  ) : (
    <Palette className="size-4" />
  );

  if (!expanded) {
    return (
      <CompactRow
        icon={swatchIcon}
        title="Primary color"
        description={
          value ? (
            <span className="font-mono text-[11px]">{value}</span>
          ) : (
            "Teal is the default accent"
          )
        }
        status={status}
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
    <BrandingShell
      id={panelId}
      panelRef={panelRef}
      icon={swatchIcon}
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
    </BrandingShell>
  );
}

function FaviconRow() {
  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure();
  const value = useWatchField("faviconUrl");

  if (!expanded) {
    return (
      <CompactRow
        icon={<Globe className="size-4" />}
        title="Favicon"
        description={value ? truncateUrl(value) : "Shown in browser tabs and bookmarks"}
        status={value ? "connected" : "disconnected"}
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
    <BrandingShell
      id={panelId}
      panelRef={panelRef}
      icon={<Globe className="size-4" />}
      title="Favicon"
      description="Accepts .ico, .png, or .svg. Browsers cache aggressively — expect a delay."
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
    </BrandingShell>
  );
}

function AttributionRow() {
  return (
    <FormField
      name="hideAtlasBranding"
      render={({ field }) => (
        <FormItem className="space-y-0">
          <CompactRow
            icon={<ShieldOff className="size-4" />}
            title="Hide Atlas branding"
            description={
              field.value
                ? "“Atlas” and “Powered by Atlas” text are hidden"
                : "Default — Atlas attribution remains visible"
            }
            status={field.value ? "connected" : "disconnected"}
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
      )}
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

  return (
    <BrandingShell
      icon={<Eye className="size-4" />}
      title="Sidebar header"
      description="Live preview — reflects unsaved edits."
      status={anyCustomized ? "connected" : "disconnected"}
    >
      <div className="rounded-lg border bg-background/60 p-4">
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logoUrl}
                alt="Logo preview"
                className="size-6 object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
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
    </BrandingShell>
  );
}

// ── Internal hook ─────────────────────────────────────────────────

function useWatchField<K extends keyof BrandingValues>(
  name: K,
): BrandingValues[K] {
  return useWatch({ name }) as BrandingValues[K];
}
