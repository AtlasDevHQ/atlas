"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { DomainResponseSchema } from "@/ui/lib/admin-schemas";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import type { CustomDomain } from "@/ui/lib/types";
import {
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Copy,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";

// ── Design primitives ─────────────────────────────────────────────

type StatusKind = "connected" | "pending" | "failed" | "disconnected" | "unavailable";

function StatusDot({ kind }: { kind: StatusKind }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_15%,transparent)]",
        kind === "pending" && "bg-amber-500/80",
        kind === "failed" && "bg-destructive",
        kind === "disconnected" && "bg-muted-foreground/40",
        kind === "unavailable" && "bg-muted-foreground/30",
      )}
    >
      {kind === "connected" && (
        <span className="absolute inset-0 rounded-full bg-primary/60 motion-safe:animate-ping" />
      )}
    </span>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{description}</p>
    </div>
  );
}

function CompactRow({
  icon: Icon,
  title,
  description,
  status,
  trailingLabel,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: StatusKind;
  trailingLabel?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-xl border bg-card/40 px-3.5 py-2.5 transition-colors hover:bg-card/70 hover:border-border/80">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">{title}</h3>
          <StatusDot kind={status} />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {trailingLabel && (
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {trailingLabel}
        </span>
      )}
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function DomainShell({
  status,
  title,
  description,
  mono,
  trailing,
  onCollapse,
  children,
  actions,
}: {
  status: StatusKind;
  title: string;
  description: string;
  mono?: boolean;
  trailing?: ReactNode;
  onCollapse?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-card/60 transition-colors",
        status === "connected" && "border-primary/20",
        status === "failed" && "border-destructive/30",
        status === "pending" && "border-amber-500/30",
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
            status === "pending" && "border-amber-500/30 text-amber-600 dark:text-amber-400",
            status === "failed" && "border-destructive/30 text-destructive",
            (status === "disconnected" || status === "unavailable") && "text-muted-foreground",
          )}
        >
          <Globe className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3
              className={cn(
                "truncate text-sm font-semibold leading-tight tracking-tight",
                mono && "font-mono text-sm",
              )}
            >
              {title}
            </h3>
            {trailing ? (
              <div className="ml-auto flex items-center gap-1.5">{trailing}</div>
            ) : status === "connected" ? (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
                <StatusDot kind="connected" />
                Live
              </span>
            ) : onCollapse ? (
              <button
                type="button"
                aria-label="Cancel"
                onClick={onCollapse}
                className="ml-auto -m-1 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
        </div>
      </header>
      {children != null && <div className="flex-1 space-y-4 px-4 pb-3 text-sm">{children}</div>}
      {actions && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
          {actions}
        </footer>
      )}
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-right", mono ? "font-mono text-[11px]" : "font-medium")}>
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

function StatusPill({ kind, label }: { kind: StatusKind; label: string }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em]",
        kind === "connected" && "text-primary",
        kind === "pending" && "text-amber-600 dark:text-amber-400",
        kind === "failed" && "text-destructive",
        (kind === "disconnected" || kind === "unavailable") && "text-muted-foreground",
      )}
    >
      <StatusDot kind={kind} />
      {label}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────

function CustomDomainPageContent() {
  const { data, loading, error, refetch } = useAdminFetch("/api/v1/admin/domain", {
    schema: DomainResponseSchema,
  });

  const {
    mutate: addDomain,
    saving: adding,
    error: addError,
    clearError: clearAddError,
  } = useAdminMutation<CustomDomain>({ invalidates: refetch });

  const {
    mutate: verifyDomain,
    saving: verifying,
    error: verifyError,
    clearError: clearVerifyError,
  } = useAdminMutation<CustomDomain>({ invalidates: refetch });

  const {
    mutate: removeDomain,
    saving: removing,
    error: removeError,
    clearError: clearRemoveError,
  } = useAdminMutation<{ deleted: boolean }>({ invalidates: refetch });

  const [newDomain, setNewDomain] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const domain = data?.domain ?? null;
  const isPlanGated =
    addError?.includes("plan_required") || addError?.includes("Enterprise plan");

  async function handleAdd() {
    if (!newDomain) return;
    clearAddError();
    const result = await addDomain({
      path: "/api/v1/admin/domain",
      method: "POST",
      body: { domain: newDomain },
    });
    if (result.ok) {
      setNewDomain("");
      setExpanded(false);
    }
  }

  async function handleVerify() {
    clearVerifyError();
    await verifyDomain({
      path: "/api/v1/admin/domain/verify",
      method: "POST",
    });
  }

  async function handleRemove() {
    clearRemoveError();
    await removeDomain({
      path: "/api/v1/admin/domain",
      method: "DELETE",
    });
  }

  function handleCollapse() {
    setExpanded(false);
    setNewDomain("");
    clearAddError();
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // clipboard API unavailable — intentionally ignored: non-critical UI feature
      },
    );
  }

  if (isPlanGated) {
    return (
      <div className="p-6">
        <div className="mx-auto mb-8 max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight">Custom Domain</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Serve Atlas from your own domain (e.g. data.acme.com) with automatic TLS.
          </p>
        </div>
        <div className="mx-auto max-w-3xl">
          <CompactRow
            icon={Globe}
            title="Custom domains are an Enterprise feature"
            description="Upgrade to serve Atlas from a subdomain you control with automatic TLS."
            status="unavailable"
            trailingLabel={
              <span className="flex items-center gap-1">
                <Lock className="size-3" />
                Locked
              </span>
            }
            action={
              <Button variant="outline" size="sm" asChild>
                <a href="/admin/usage">
                  View plan
                  <ArrowUpRight className="ml-1.5 size-3.5" />
                </a>
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const mutationError = verifyError ?? removeError;
  function clearMutationError() {
    clearVerifyError();
    clearRemoveError();
  }

  function statusKindFor(d: CustomDomain): StatusKind {
    if (d.status === "verified") return "connected";
    if (d.status === "failed") return "failed";
    return "pending";
  }

  return (
    <div className="p-6">
      <div className="mx-auto mb-8 max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Custom Domain</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Serve Atlas from your own domain (e.g. data.acme.com) with automatic TLS.
        </p>
      </div>

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Custom Domain"
        onRetry={refetch}
        loadingMessage="Loading domain configuration..."
      >
        <div className="mx-auto max-w-3xl space-y-8">
          {mutationError && (
            <ErrorBanner
              message={mutationError}
              onRetry={clearMutationError}
              actionLabel="Dismiss"
            />
          )}

          <section>
            <SectionHeading
              title="Workspace domain"
              description="One subdomain per workspace. A CNAME points it here; TLS is automatic."
            />

            {!domain && !expanded && (
              <CompactRow
                icon={Globe}
                title="Point your own domain at this workspace"
                description="Use a subdomain like data.acme.com — root domains aren't supported."
                status="disconnected"
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setExpanded(true)}
                  >
                    + Add domain
                  </Button>
                }
              />
            )}

            {!domain && expanded && (
              <DomainShell
                status="disconnected"
                title="Add a custom domain"
                description="We'll give you a CNAME target to add at your DNS provider."
                onCollapse={handleCollapse}
                actions={
                  <Button type="button" onClick={handleAdd} disabled={!newDomain || adding}>
                    {adding && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                    Add domain
                  </Button>
                }
              >
                <div className="space-y-1">
                  <Label htmlFor="domain">Domain</Label>
                  <Input
                    id="domain"
                    placeholder="data.acme.com"
                    className="font-mono text-sm"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                    }}
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    Use a subdomain like <span className="font-mono">data.acme.com</span>, not a
                    root domain.
                  </p>
                </div>
                {addError && <ErrorBanner message={addError} />}
              </DomainShell>
            )}

            {domain && (
              <DomainShell
                status={statusKindFor(domain)}
                title={domain.domain}
                description={
                  domain.status === "verified"
                    ? "TLS is issued — your domain is serving traffic."
                    : domain.status === "failed"
                      ? "Verification failed. Recheck your CNAME and try again."
                      : "Waiting for DNS. Add the CNAME below, then check status."
                }
                mono
                trailing={
                  domain.status === "verified" ? (
                    <StatusPill kind="connected" label="Live" />
                  ) : domain.status === "failed" ? (
                    <StatusPill kind="failed" label="Failed" />
                  ) : (
                    <StatusPill kind="pending" label="Pending" />
                  )
                }
                actions={
                  <>
                    {domain.status !== "verified" && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleVerify}
                        disabled={verifying}
                      >
                        {verifying ? (
                          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1.5 size-3.5" />
                        )}
                        Check status
                      </Button>
                    )}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className="text-muted-foreground"
                          disabled={removing}
                        >
                          {removing ? (
                            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="mr-1.5 size-3.5" />
                          )}
                          Remove
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove custom domain?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This removes{" "}
                            <span className="font-mono font-semibold">{domain.domain}</span> from
                            your workspace. Traffic will stop serving on this domain. This cannot
                            be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={handleRemove}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Remove domain
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                }
              >
                <DetailList>
                  <DetailRow label="Domain" value={domain.domain} mono />
                  <DetailRow
                    label="Status"
                    value={
                      domain.status === "verified"
                        ? "Verified"
                        : domain.status === "failed"
                          ? "Failed"
                          : "Pending verification"
                    }
                  />
                  <DetailRow label="Added" value={formatDateTime(domain.createdAt)} />
                </DetailList>

                {domain.status === "pending" && domain.cnameTarget && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      <Clock className="size-3" />
                      DNS record to add
                    </div>
                    <DetailList>
                      <DetailRow label="Type" value="CNAME" mono />
                      <DetailRow label="Name" value={domain.domain} mono />
                      <DetailRow
                        label="Value"
                        value={
                          <span className="inline-flex items-center gap-2">
                            <span className="truncate font-mono text-[11px]">
                              {domain.cnameTarget}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-5 shrink-0"
                              onClick={() => copyToClipboard(domain.cnameTarget!)}
                              aria-label="Copy CNAME target"
                            >
                              {copied ? (
                                <CheckCircle2 className="size-3 text-primary" />
                              ) : (
                                <Copy className="size-3" />
                              )}
                            </Button>
                          </span>
                        }
                      />
                    </DetailList>
                    <p className="text-xs text-muted-foreground">
                      DNS propagation can take up to 48 hours.
                    </p>
                  </div>
                )}

                {domain.status === "failed" && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    <XCircle className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Verification failed. Check that the CNAME for{" "}
                      <span className="font-mono">{domain.domain}</span> resolves to the target
                      above, then click <strong>Check status</strong>.
                    </span>
                  </div>
                )}
              </DomainShell>
            )}
          </section>
        </div>
      </AdminContentWrapper>
    </div>
  );
}

export default function CustomDomainPage() {
  return (
    <ErrorBoundary>
      <CustomDomainPageContent />
    </ErrorBoundary>
  );
}
