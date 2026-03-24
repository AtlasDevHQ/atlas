"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { FeatureGate } from "@/ui/components/admin/feature-disabled";
import { StatCard } from "@/ui/components/admin/stat-card";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import type { CustomDomain } from "@/ui/lib/types";
import {
  Globe,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Plus,
  Trash2,
  RefreshCw,
  Copy,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface DomainsResponse {
  domains: CustomDomain[];
}

// ── Helpers ───────────────────────────────────────────────────────

function statusBadge(status: CustomDomain["status"]) {
  switch (status) {
    case "verified":
      return (
        <Badge variant="default" className="bg-green-600 text-xs">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Verified
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
          Pending
        </Badge>
      );
  }
}

function certBadge(certStatus: string | null) {
  if (!certStatus) return <span className="text-muted-foreground">—</span>;
  switch (certStatus) {
    case "ISSUED":
      return <Badge variant="default" className="bg-green-600 text-xs">Issued</Badge>;
    case "FAILED":
      return <Badge variant="destructive" className="text-xs">Failed</Badge>;
    default:
      return <Badge variant="secondary" className="text-xs">Pending</Badge>;
  }
}

// ── Page ──────────────────────────────────────────────────────────

function DomainsPageContent() {
  const {
    data: domainsData,
    loading,
    error,
    refetch,
  } = useAdminFetch<DomainsResponse>("/api/v1/platform/domains");

  const { mutate: registerDomain, saving: registering, error: registerError, clearError: clearRegisterError } = useAdminMutation<CustomDomain>({
    invalidates: refetch,
  });

  const { mutate: verifyDomain, isMutating: isVerifying, error: verifyError, clearError: clearVerifyError } = useAdminMutation<CustomDomain>({
    invalidates: refetch,
  });

  const { mutate: removeDomain, saving: deleting, error: deleteError, clearError: clearDeleteError } = useAdminMutation<{ deleted: boolean }>({
    invalidates: refetch,
  });

  const [addDialog, setAddDialog] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newWorkspaceId, setNewWorkspaceId] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<CustomDomain | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Feature gate
  if (error?.status === 503) return <FeatureGate status={503} feature="Custom Domains" />;
  if (error?.status === 404) return <FeatureGate status={404} feature="Custom Domains" />;
  if (error?.status === 403) return <FeatureGate status={403} feature="Custom Domains" />;
  if (error?.status === 401) return <FeatureGate status={401} feature="Custom Domains" />;

  if (loading) return <LoadingState message="Loading domains..." />;
  if (error) return <ErrorBanner message={error.message} />;

  const domains = domainsData?.domains ?? [];
  const verifiedCount = domains.filter((d) => d.status === "verified").length;
  const pendingCount = domains.filter((d) => d.status === "pending").length;

  async function handleRegister() {
    if (!newDomain || !newWorkspaceId) return;
    const result = await registerDomain({
      path: "/api/v1/platform/domains",
      method: "POST",
      body: { workspaceId: newWorkspaceId, domain: newDomain },
    });
    if (result !== undefined) {
      setAddDialog(false);
      setNewDomain("");
      setNewWorkspaceId("");
    }
  }

  async function handleVerify(domainId: string) {
    clearVerifyError();
    await verifyDomain({
      path: `/api/v1/platform/domains/${domainId}/verify`,
      method: "POST",
      itemId: domainId,
    });
  }

  async function handleDelete(domainId: string) {
    const result = await removeDomain({
      path: `/api/v1/platform/domains/${domainId}`,
      method: "DELETE",
    });
    if (result !== undefined) {
      setDeleteConfirm(null);
    }
  }

  function copyToClipboard(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }, () => {
      // clipboard API not available — intentionally ignored: non-critical UI feature
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Custom Domains</h1>
          <p className="text-sm text-muted-foreground">
            Register custom domains for workspaces. Domains are provisioned via Railway with automatic TLS.
          </p>
        </div>
        <Button onClick={() => setAddDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Domain
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Total Domains"
          value={domains.length}
          icon={<Globe className="size-4" />}
        />
        <StatCard
          title="Verified"
          value={verifiedCount}
          icon={<CheckCircle2 className="size-4" />}
        />
        <StatCard
          title="Pending"
          value={pendingCount}
          icon={<Clock className="size-4" />}
        />
      </div>

      {/* Domains table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Workspace ID</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead>CNAME Target</TableHead>
                <TableHead className="text-center">TLS Certificate</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No custom domains registered. Click &quot;Add Domain&quot; to get started.
                  </TableCell>
                </TableRow>
              ) : (
                domains.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-sm">{d.domain}</TableCell>
                    <TableCell className="font-mono text-sm">{d.workspaceId}</TableCell>
                    <TableCell className="text-center">{statusBadge(d.status)}</TableCell>
                    <TableCell>
                      {d.cnameTarget ? (
                        <div className="flex items-center gap-1">
                          <code className="text-xs text-muted-foreground">{d.cnameTarget}</code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => copyToClipboard(d.cnameTarget!, d.id)}
                          >
                            {copiedId === d.id ? (
                              <CheckCircle2 className="h-3 w-3 text-green-500" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">{certBadge(d.certificateStatus)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(d.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {d.status !== "verified" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleVerify(d.id)}
                            disabled={isVerifying(d.id)}
                            title="Check verification status"
                          >
                            <RefreshCw className={`h-4 w-4 ${isVerifying(d.id) ? "animate-spin" : ""}`} />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => setDeleteConfirm(d)}
                          disabled={deleting}
                          title="Delete domain"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Verify/delete error banners */}
      {verifyError && <ErrorBanner message={verifyError} />}
      {deleteError && <ErrorBanner message={deleteError} />}

      {/* Add domain dialog */}
      <Dialog open={addDialog} onOpenChange={(open) => { if (!open) { setAddDialog(false); setNewDomain(""); setNewWorkspaceId(""); clearRegisterError(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Custom Domain</DialogTitle>
            <DialogDescription>
              Register a custom domain for a workspace. Railway will provision the domain and provide a CNAME target for DNS setup.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="workspace-id">Workspace ID</Label>
              <Input
                id="workspace-id"
                placeholder="org-abc123"
                value={newWorkspaceId}
                onChange={(e) => setNewWorkspaceId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="domain">Domain</Label>
              <Input
                id="domain"
                placeholder="data.customer.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
              />
            </div>
            {registerError && <ErrorBanner message={registerError} />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddDialog(false); setNewDomain(""); setNewWorkspaceId(""); clearRegisterError(); }}>
              Cancel
            </Button>
            <Button onClick={handleRegister} disabled={!newDomain || !newWorkspaceId || registering}>
              {registering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Register Domain
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) { setDeleteConfirm(null); clearDeleteError(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Domain</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <span className="font-mono font-semibold">{deleteConfirm?.domain}</span>?
              This will remove the domain from both Railway and Atlas. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => deleteConfirm && handleDelete(deleteConfirm.id)} disabled={deleting}>
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete Domain
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function DomainsPage() {
  return (
    <ErrorBoundary>
      <DomainsPageContent />
    </ErrorBoundary>
  );
}
