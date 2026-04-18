"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { BillingStatusSchema } from "@/ui/lib/admin-schemas";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Bot,
  Coins,
  CreditCard,
  DollarSign,
  ExternalLink,
  Loader2,
  Plus,
  ServerOff,
  X,
  Zap,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface BillingStatus {
  workspaceId: string;
  plan: {
    tier: string;
    displayName: string;
    pricePerSeat: number;
    defaultModel: string;
    byot: boolean;
    trialEndsAt: string | null;
  };
  limits: {
    tokenBudgetPerSeat: number | null;
    totalTokenBudget: number | null;
    maxSeats: number | null;
    maxConnections: number | null;
  };
  usage: {
    queryCount: number;
    tokenCount: number;
    seatCount: number;
    tokenUsagePercent: number;
    tokenOverageStatus: string;
    periodStart: string;
    periodEnd: string;
  };
  seats?: {
    count: number;
    max: number | null;
  };
  connections?: {
    count: number;
    max: number | null;
  };
  currentModel?: string;
  overagePerMillionTokens?: number;
  subscription: {
    stripeSubscriptionId: string;
    plan: string;
    status: string;
  } | null;
}

// ── Shared Design Primitives ──────────────────────────────────────
//
// Lifted from admin/integrations after the first /revamp pass. If a third
// admin page adopts the same shape, extract these into
// packages/web/src/ui/components/admin/.

type StatusKind = "connected" | "disconnected" | "unavailable";

function StatusDot({ kind, className }: { kind: StatusKind; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,_var(--primary)_15%,_transparent)]",
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
  connected: "Connected",
  disconnected: "Not connected",
  unavailable: "Unavailable",
};

function BillingShell({
  id,
  icon: Icon,
  title,
  description,
  status,
  children,
  actions,
  onCollapse,
  panelRef,
}: {
  id?: string;
  icon: ComponentType<{ className?: string }>;
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
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-gradient-to-b from-transparent via-primary to-transparent opacity-70"
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
          <Icon className="size-4" />
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
  icon: Icon,
  title,
  description,
  status,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
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
        <Icon className="size-4" />
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

function DetailRow({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right",
          mono && "font-mono text-[11px]",
          truncate && "truncate",
          !mono && "font-medium",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function DetailList({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-1.5 divide-y divide-border/50">
      {children}
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

/**
 * Disclosure helper for progressive-disclosure rows. Moves focus into the
 * revealed panel on expand, restores it to the trigger on collapse, and
 * clears any owning mutation error when the user dismisses the panel.
 */
function useDisclosure(onCollapseCleanup?: () => void) {
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const prevExpanded = useRef(false);

  useEffect(() => {
    if (expanded && !prevExpanded.current) {
      const panel = panelRef.current;
      const first = panel?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), button[role="combobox"]:not([disabled])',
      );
      first?.focus();
    } else if (!expanded && prevExpanded.current) {
      triggerRef.current?.focus();
    }
    prevExpanded.current = expanded;
  }, [expanded]);

  const collapse = () => {
    setExpanded(false);
    onCollapseCleanup?.();
  };

  return { expanded, setExpanded, collapse, triggerRef, panelRef, panelId };
}

// ── Helpers ───────────────────────────────────────────────────────

function tierVariant(tier: string): "default" | "secondary" | "outline" {
  switch (tier) {
    case "business":
      return "default";
    case "pro":
    case "starter":
      return "secondary";
    default:
      return "outline";
  }
}

function overageColor(status: string): string {
  switch (status) {
    case "exceeded":
    case "hard_limit":
      return "text-destructive";
    case "warning":
    case "soft_limit":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

const MODEL_OPTIONS = [
  { value: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fastest, lowest cost" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "balanced" },
  { value: "claude-opus-4-6", label: "Opus 4.6", hint: "most capable" },
] as const;

function modelLabel(value: string): string {
  return MODEL_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

// ── Component ─────────────────────────────────────────────────────

export default function BillingPage() {
  const { data, loading, error, refetch } = useAdminFetch("/api/v1/billing", {
    schema: BillingStatusSchema,
  });

  // Framework-level 404 (billing routes not mounted) means self-hosted / no Stripe.
  // API-level 404s ("Workspace not found", "no internal database") have descriptive
  // messages and should surface as real errors, not the self-hosted card.
  const isSelfHosted =
    !loading &&
    !data &&
    error?.status === 404 &&
    (error.message === "Not Found" || error.message === "HTTP 404");

  if (isSelfHosted) {
    return (
      <ErrorBoundary>
        <div className="mx-auto max-w-3xl px-6 py-10">
          <Hero stat={null} />
          <SelfHostedEmptyState />
        </div>
      </ErrorBoundary>
    );
  }

  const stat = data ? heroStat(data) : null;

  return (
    <ErrorBoundary>
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Hero stat={stat} />

        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Billing"
          onRetry={refetch}
          loadingMessage="Loading billing details..."
        >
          {data && (
            <div className="space-y-10">
              <section>
                <SectionHeading
                  title="Plan"
                  description="Your current subscription and limits"
                />
                <PlanShell data={data} />
              </section>

              <section>
                <SectionHeading
                  title="Usage"
                  description={`Current period · ${formatDate(data.usage.periodStart)} – ${formatDate(data.usage.periodEnd)}`}
                />
                <UsageShell data={data} />
              </section>

              <section>
                <SectionHeading
                  title="Configuration"
                  description="Workspace-level defaults"
                />
                <div className="space-y-2">
                  <ModelRow data={data} onSaved={refetch} />
                  <ByotRow data={data} onToggled={refetch} />
                </div>
              </section>
            </div>
          )}
        </AdminContentWrapper>
      </div>
    </ErrorBoundary>
  );
}

// ── Hero ──────────────────────────────────────────────────────────

function heroStat(data: BillingStatus): string {
  const { plan, usage } = data;
  const seatCount = data.seats?.count ?? usage.seatCount;

  if (plan.tier === "trial" && plan.trialEndsAt) {
    return `Trial · ends ${formatDate(plan.trialEndsAt)}`;
  }
  if (plan.pricePerSeat > 0) {
    return `$${plan.pricePerSeat * seatCount}/mo`;
  }
  return plan.displayName;
}

function Hero({ stat }: { stat: string | null }) {
  return (
    <header className="mb-10 flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Atlas · Admin
      </p>
      <div className="flex items-baseline justify-between gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">Billing</h1>
        {stat && (
          <p className="shrink-0 font-mono text-sm tabular-nums text-foreground">
            {stat}
          </p>
        )}
      </div>
      <p className="max-w-xl text-sm text-muted-foreground">
        Manage your plan, view usage, and access billing settings.
      </p>
    </header>
  );
}

// ── Self-hosted empty state ───────────────────────────────────────

function SelfHostedEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border bg-card/40 py-14 text-center">
      <span className="grid size-10 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
        <ServerOff className="size-4" />
      </span>
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Self-hosted · no billing</h2>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          This instance has no Stripe subscription configured. All features are
          unlimited.
        </p>
      </div>
    </div>
  );
}

// ── Plan shell ────────────────────────────────────────────────────

function PlanShell({ data }: { data: BillingStatus }) {
  const [portalError, setPortalError] = useState<string | null>(null);
  const { plan, usage, subscription } = data;
  const seatCount = data.seats?.count ?? usage.seatCount;
  const totalMonthly = plan.pricePerSeat * seatCount;
  const overage = data.overagePerMillionTokens ?? 0;

  const { mutate, saving, error: portalMutationError } = useAdminMutation<{
    url?: string;
  }>({
    path: "/api/v1/billing/portal",
    method: "POST",
  });

  async function openBillingPortal() {
    setPortalError(null);
    const result = await mutate({ body: { returnUrl: window.location.href } });
    if (!result.ok) return;
    if (result.data?.url) {
      window.location.href = result.data.url;
    } else {
      console.warn("Billing portal: 200 response but no URL returned", result.data);
      setPortalError("Billing portal URL was not returned. Please contact support.");
    }
  }

  const combinedError = portalMutationError ?? portalError;
  const status: StatusKind = subscription?.status === "active" ? "connected" : "disconnected";

  return (
    <BillingShell
      icon={CreditCard}
      title={plan.displayName}
      description={
        plan.pricePerSeat > 0
          ? `$${plan.pricePerSeat}/seat/mo \u00B7 ${seatCount} ${seatCount === 1 ? "seat" : "seats"}`
          : "No charges — all features included"
      }
      status={status}
      actions={
        subscription ? (
          <Button onClick={openBillingPortal} disabled={saving} size="sm">
            <CreditCard className="mr-1.5 size-3.5" />
            {saving ? "Opening…" : "Open billing portal"}
            <ExternalLink className="ml-1.5 size-3" />
          </Button>
        ) : undefined
      }
    >
      <DetailList>
        <DetailRow
          label="Tier"
          value={
            <span className="inline-flex items-center gap-2">
              <Badge variant={tierVariant(plan.tier)} className="text-[10px]">
                {plan.tier}
              </Badge>
              {plan.byot && (
                <Badge
                  variant="outline"
                  className="border-violet-500/30 text-[10px] text-violet-600 dark:text-violet-400"
                >
                  BYOT
                </Badge>
              )}
            </span>
          }
        />
        {plan.pricePerSeat > 0 && (
          <DetailRow
            label="Monthly"
            value={
              <span>
                <span className="text-muted-foreground">{`$${plan.pricePerSeat} × ${seatCount} = `}</span>
                <span className="font-semibold">${totalMonthly}</span>
              </span>
            }
          />
        )}
        {plan.tier === "trial" && plan.trialEndsAt && (
          <DetailRow label="Trial ends" value={formatDate(plan.trialEndsAt)} />
        )}
        {subscription && (
          <DetailRow
            label="Subscription"
            value={
              <Badge
                variant={subscription.status === "active" ? "secondary" : "outline"}
                className="text-[10px]"
              >
                {subscription.status}
              </Badge>
            }
          />
        )}
        {overage > 0 && (
          <DetailRow
            label="Overage"
            value={
              <span className="inline-flex items-center gap-1">
                <DollarSign className="size-3 text-muted-foreground" />
                {overage.toFixed(2)}/M tokens
              </span>
            }
          />
        )}
      </DetailList>

      <InlineError>{combinedError}</InlineError>
      {!subscription && plan.pricePerSeat > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No active subscription — portal access opens after you subscribe.
        </p>
      )}
    </BillingShell>
  );
}

// ── Usage shell ───────────────────────────────────────────────────

function UsageShell({ data }: { data: BillingStatus }) {
  const { usage, limits, plan } = data;
  const seats = data.seats ?? {
    count: usage.seatCount,
    max: data.limits.maxSeats,
  };
  const connections = data.connections ?? {
    count: 0,
    max: data.limits.maxConnections,
  };

  return (
    <BillingShell
      icon={Coins}
      title="Token usage"
      description={
        plan.byot
          ? "Unlimited — using your own LLM API key"
          : limits.totalTokenBudget === null
          ? "Unlimited"
          : `${formatNumber(usage.tokenCount)} of ${formatNumber(limits.totalTokenBudget)} tokens used`
      }
      status={plan.byot ? "connected" : "disconnected"}
    >
      {plan.byot ? (
        <div className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-50/60 px-3 py-2 text-xs text-violet-700 dark:bg-violet-950/20 dark:text-violet-300">
          <Zap className="size-3.5" />
          <span>{formatNumber(usage.tokenCount)} tokens consumed this period</span>
        </div>
      ) : limits.totalTokenBudget === null ? (
        <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {formatNumber(usage.tokenCount)} tokens consumed · no cap
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Token budget</span>
            <span
              className={cn(
                "font-mono font-medium tabular-nums",
                overageColor(usage.tokenOverageStatus),
              )}
            >
              {formatNumber(usage.tokenCount)}
              <span className="opacity-50">{" / "}</span>
              {formatNumber(limits.totalTokenBudget)}
            </span>
          </div>
          <Progress
            value={Math.min(usage.tokenUsagePercent, 100)}
            className="h-1.5"
          />
          {limits.tokenBudgetPerSeat !== null && (
            <p className="text-[11px] text-muted-foreground">
              {formatNumber(limits.tokenBudgetPerSeat)} tokens/seat ×{" "}
              {seats.count} {seats.count === 1 ? "seat" : "seats"}
            </p>
          )}
        </div>
      )}

      <DetailList>
        <DetailRow label="Seats" value={<ResourceValue count={seats.count} max={seats.max} />} />
        <DetailRow
          label="Connections"
          value={<ResourceValue count={connections.count} max={connections.max} />}
        />
      </DetailList>
    </BillingShell>
  );
}

function ResourceValue({ count, max }: { count: number; max: number | null }) {
  if (max === null) {
    return <span className="text-muted-foreground">Unlimited</span>;
  }
  const percent = max === 0 ? 0 : Math.round((count / max) * 100);
  const warn = percent >= 90;
  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        warn && "text-amber-600 dark:text-amber-400",
      )}
    >
      {count}
      <span className="opacity-50">{" / "}</span>
      {max}
    </span>
  );
}

// ── Model row (progressive disclosure) ────────────────────────────

function ModelRow({ data, onSaved }: { data: BillingStatus; onSaved: () => void }) {
  const currentModel = data.currentModel ?? data.plan.defaultModel ?? "claude-sonnet-4-6";
  const currentLabel = modelLabel(currentModel);

  const { mutate, saving, error, clearError } = useAdminMutation({
    path: "/api/v1/admin/settings/ATLAS_MODEL",
    method: "PUT",
    invalidates: onSaved,
  });

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure(clearError);

  async function handleModelChange(value: string) {
    await mutate({ body: { value } });
  }

  if (!expanded) {
    return (
      <CompactRow
        icon={Bot}
        title="Default AI model"
        description={currentLabel}
        status="disconnected"
        action={
          <Button
            ref={triggerRef}
            size="sm"
            variant="outline"
            aria-expanded={false}
            aria-controls={panelId}
            onClick={() => setExpanded(true)}
          >
            <Plus className="mr-1.5 size-3.5" />
            Change
          </Button>
        }
      />
    );
  }

  return (
    <BillingShell
      id={panelId}
      panelRef={panelRef}
      icon={Bot}
      title="Default AI model"
      description="Applied to every chat unless a workspace member overrides it."
      status="disconnected"
      onCollapse={collapse}
    >
      <Select value={currentModel} onValueChange={handleModelChange} disabled={saving}>
        <SelectTrigger aria-label="AI model">
          <SelectValue placeholder="Select a model" />
        </SelectTrigger>
        <SelectContent>
          {MODEL_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              <span className="font-medium">{opt.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">— {opt.hint}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {saving && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Saving…
        </p>
      )}
      <InlineError>{error}</InlineError>
    </BillingShell>
  );
}

// ── BYOT row (inline switch) ──────────────────────────────────────

function ByotRow({
  data,
  onToggled,
}: {
  data: BillingStatus;
  onToggled: () => void;
}) {
  const { mutate, saving, error } = useAdminMutation<{
    workspaceId: string;
    byot: boolean;
  }>({
    path: "/api/v1/billing/byot",
    method: "POST",
    invalidates: onToggled,
  });

  async function handleToggle(enabled: boolean) {
    await mutate({ body: { enabled } });
  }

  return (
    <div className="space-y-2">
      <InlineError>{error}</InlineError>
      <CompactRow
        icon={Zap}
        title="Bring your own token"
        description={
          data.plan.byot
            ? "Workspace members supply their own LLM API keys"
            : "Use the platform-managed model (default)"
        }
        status={data.plan.byot ? "connected" : "disconnected"}
        action={
          <div className="flex items-center gap-2">
            {saving && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={data.plan.byot}
              onCheckedChange={handleToggle}
              disabled={saving}
              aria-label="Bring your own token"
            />
          </div>
        }
      />
    </div>
  );
}
