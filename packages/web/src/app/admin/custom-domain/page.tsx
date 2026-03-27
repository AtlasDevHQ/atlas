"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { formatDate } from "@/lib/format";
import type { CustomDomain } from "@/ui/lib/types";
import {
  Globe,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Trash2,
  RefreshCw,
  Copy,
  ArrowUpRight,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface DomainResponse {
  domain: CustomDomain | null;
}

// ── Helpers ───────────────────────────────────────────────────────

function statusBadge(status: CustomDomain["status"]) {
  switch (status) {
    case "verified":
      return (
        <Badge variant="default" className="bg-green-600 text-xs">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Active
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="text-xs">
          <XCircle className="mr-1 h-3 w-3" />
          Failed
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary" className="text-xs">
          <Clock className="mr-1 h-3 w-3" />
          Pending Verification
        </Badge>
      );
  }
}

// ── Page ──────────────────────────────────────────────────────────

function CustomDomainPageContent() {
  const {
    data,
    loading,
    error,
    refetch,
  } = useAdminFetch<DomainResponse>("/api/v1/admin/domain");

  const { mutate: addDomain, saving: adding, error: addError, clearError: clearAddError } = useAdminMutation<CustomDomain>({
    invalidates: refetch,
  });

  const { mutate: verifyDomain, saving: verifying, error: verifyError, clearError: clearVerifyError } = useAdminMutation<CustomDomain>({
    invalidates: refetch,
  });

  const { mutate: removeDomain, saving: removing, error: removeError, clearError: clearRemoveError } = useAdminMutation<{ deleted: boolean }>({
    invalidates: refetch,
  });

  const [newDomain, setNewDomain] = useState("");
  const [copied, setCopied] = useState(false);

  const domain = data?.domain ?? null;
  const isPlanGated =
    addError?.includes("plan_required") ||
    addError?.includes("Enterprise plan");

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

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, () => {
      // clipboard API not available — intentionally ignored: non-critical UI feature
    });
  }

  // Enterprise plan gate UI
  if (isPlanGated) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Custom Domain</h1>
          <p className="text-sm text-muted-foreground">
            Serve Atlas from your own domain (e.g. data.acme.com).
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              Enterprise Feature
            </CardTitle>
            <CardDescription>
              Custom domains require an Enterprise plan. Upgrade your workspace to configure a custom domain with automatic TLS.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" asChild>
              <a href="/admin/usage">
                View Plan & Usage
                <ArrowUpRight className="ml-2 h-4 w-4" />
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <AdminContentWrapper
      loading={loading}
      error={error}
      feature="Custom Domain"
      onRetry={refetch}
      loadingMessage="Loading domain configuration..."
    >
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Custom Domain</h1>
          <p className="text-sm text-muted-foreground">
            Serve Atlas from your own domain (e.g. data.acme.com) with automatic TLS.
          </p>
        </div>

        {domain ? (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2 font-mono text-lg">
                      <Globe className="h-5 w-5" />
                      {domain.domain}
                    </CardTitle>
                    <CardDescription>
                      Configured on {formatDate(domain.createdAt)}
                    </CardDescription>
                  </div>
                  {statusBadge(domain.status)}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* DNS instructions for pending domains */}
                {domain.status === "pending" && domain.cnameTarget && (
                  <Card className="border-amber-500/30 bg-amber-500/5">
                    <CardContent className="pt-6 space-y-3">
                      <p className="text-sm font-medium">DNS Configuration Required</p>
                      <p className="text-sm text-muted-foreground">
                        Add the following CNAME record to your DNS provider to verify domain ownership:
                      </p>
                      <div className="rounded-md bg-muted p-3">
                        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                          <span className="font-medium">Type</span>
                          <code>CNAME</code>
                          <span className="font-medium">Name</span>
                          <code>{domain.domain}</code>
                          <span className="font-medium">Value</span>
                          <div className="flex items-center gap-2">
                            <code className="break-all">{domain.cnameTarget}</code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              onClick={() => copyToClipboard(domain.cnameTarget!)}
                            >
                              {copied ? (
                                <CheckCircle2 className="h-3 w-3 text-green-500" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </Button>
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        DNS propagation may take up to 48 hours. Click &quot;Check Status&quot; to verify.
                      </p>
                    </CardContent>
                  </Card>
                )}

                {/* Failed domain info */}
                {domain.status === "failed" && (
                  <Card className="border-destructive/30 bg-destructive/5">
                    <CardContent className="pt-6">
                      <p className="text-sm text-destructive">
                        Domain verification failed. Check that your CNAME record is correctly configured and try again.
                      </p>
                    </CardContent>
                  </Card>
                )}

                {/* Verified domain confirmation */}
                {domain.status === "verified" && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    TLS certificate issued — your domain is active and serving traffic.
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 pt-2">
                  {domain.status !== "verified" && (
                    <Button
                      variant="outline"
                      onClick={handleVerify}
                      disabled={verifying}
                    >
                      {verifying ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      Check Status
                    </Button>
                  )}

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" disabled={removing}>
                        {removing ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="mr-2 h-4 w-4" />
                        )}
                        Remove Domain
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove custom domain?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will remove <span className="font-mono font-semibold">{domain.domain}</span> from
                          your workspace. Traffic will no longer be served on this domain. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleRemove}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Remove Domain
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>

                {verifyError && <ErrorBanner message={verifyError} onRetry={handleVerify} />}
                {removeError && <ErrorBanner message={removeError} />}
              </CardContent>
            </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5" />
                Add Custom Domain
              </CardTitle>
              <CardDescription>
                Enter the domain you want to use for this workspace. A CNAME record will be
                provided for DNS verification. TLS certificates are provisioned automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="domain">Domain</Label>
                <Input
                  id="domain"
                  placeholder="data.acme.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAdd();
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Use a subdomain (e.g. data.acme.com), not a root domain.
                </p>
              </div>
              {addError && <ErrorBanner message={addError} />}
              <Button onClick={handleAdd} disabled={!newDomain || adding}>
                {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Add Domain
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AdminContentWrapper>
  );
}

export default function CustomDomainPage() {
  return (
    <ErrorBoundary>
      <CustomDomainPageContent />
    </ErrorBoundary>
  );
}
