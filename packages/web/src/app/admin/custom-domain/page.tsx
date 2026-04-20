"use client";

import { useState } from "react";
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
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import {
  CompactRow,
  DetailList,
  DetailRow,
  SectionHeading,
  Shell,
  StatusDot,
  type StatusKind,
} from "@/ui/components/admin/compact";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { combineMutationErrors } from "@/ui/lib/mutation-errors";
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
  XCircle,
} from "lucide-react";

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
  // Plan-gating is encoded as a structured `code` on 403/402 responses. Match
  // the machine-readable field, not the human message, so copy tweaks don't
  // accidentally flip this branch.
  const isPlanGated =
    addError?.code === "plan_required" ||
    addError?.code === "enterprise_required";

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
            statusLabel="Locked"
            action={
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  <Lock className="size-3" />
                  Locked
                </span>
                <Button variant="outline" size="sm" asChild>
                  <a href="/admin/usage">
                    View plan
                    <ArrowUpRight className="ml-1.5 size-3.5" />
                  </a>
                </Button>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  const mutationError = combineMutationErrors([verifyError, removeError]);
  function clearMutationError() {
    clearVerifyError();
    clearRemoveError();
  }

  function statusKindFor(d: CustomDomain): StatusKind {
    if (d.status === "verified") return "connected";
    if (d.status === "failed") return "unhealthy";
    return "transitioning";
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
          <MutationErrorSurface
            error={mutationError}
            feature="Custom Domain"
            onRetry={clearMutationError}
          />

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
              <Shell
                icon={Globe}
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
                <MutationErrorSurface error={addError} feature="Custom Domain" />
              </Shell>
            )}

            {domain && (
              <Shell
                icon={Globe}
                status={statusKindFor(domain)}
                title={<span className="font-mono">{domain.domain}</span>}
                titleText={domain.domain}
                description={
                  domain.status === "verified"
                    ? "TLS is issued — your domain is serving traffic."
                    : domain.status === "failed"
                      ? "Verification failed. Recheck your CNAME and try again."
                      : "Waiting for DNS. Add the CNAME below, then check status."
                }
                trailing={
                  domain.status === "failed" ? (
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-destructive",
                      )}
                    >
                      <StatusDot kind="unhealthy" />
                      Failed
                    </span>
                  ) : domain.status !== "verified" ? (
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-amber-600 dark:text-amber-400",
                      )}
                    >
                      <StatusDot kind="transitioning" />
                      Pending
                    </span>
                  ) : undefined
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
              </Shell>
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
