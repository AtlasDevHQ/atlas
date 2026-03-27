"use client";

import { useState } from "react";
import { z } from "zod";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Badge } from "@/components/ui/badge";
import { Key, Plus, Copy, Check, Trash2, Loader2 } from "lucide-react";

// -- Types --

// Subset of Better Auth API key response — only fields rendered in the table.
interface ApiKey {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastRequest: string | null;
}

interface ListApiKeysResponse {
  apiKeys: ApiKey[];
  total: number;
}

interface CreateApiKeyResponse {
  key: string;
  id: string;
  name: string;
}

// -- Schema --

const createKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name must be 100 characters or fewer"),
});

// -- Helpers --

function formatDate(iso: string | null): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "\u2014";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Never";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function maskedKey(prefix: string | null, start: string | null): string {
  const p = prefix ?? "key";
  const s = start ? `${start}...` : "...";
  return `${p}_${s}`;
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

// -- Component --

export default function ApiKeysPage() {
  // List API keys
  const {
    data: listData,
    loading,
    error,
    refetch,
  } = useAdminFetch<ListApiKeysResponse>("/api/auth/api-key/list");
  const apiKeys = listData?.apiKeys ?? [];

  // Create mutation — no invalidates here because onSuccess captures
  // the key for display before triggering refetch manually.
  const createMutation = useAdminMutation<CreateApiKeyResponse>({
    path: "/api/auth/api-key/create",
    method: "POST",
  });

  // Delete mutation
  const deleteMutation = useAdminMutation<{ success: boolean }>({
    path: "/api/auth/api-key/delete",
    method: "POST",
    invalidates: refetch,
  });

  // -- Dialog state --
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  // -- Handlers --

  function openCreateDialog() {
    createMutation.reset();
    setCreatedKey(null);
    setCopied(false);
    setCreateOpen(true);
  }

  async function handleCreate(values: z.infer<typeof createKeySchema>) {
    await createMutation.mutate({
      body: { name: values.name },
      onSuccess: (data) => {
        setCreatedKey({ key: data.key, name: data.name ?? values.name });
        refetch();
      },
    });
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // intentionally ignored: clipboard API not available — user can select and copy manually
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    const result = await deleteMutation.mutate({
      body: { keyId: revokeTarget.id },
    });
    if (result.ok) {
      setRevokeTarget(null);
    }
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
          <p className="text-sm text-muted-foreground">
            Create and manage API keys for programmatic access
          </p>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus className="mr-1.5 size-4" />
          Create API Key
        </Button>
      </div>

      <ErrorBoundary>
        <div className="space-y-6">
          {deleteMutation.error && (
            <ErrorBanner message={deleteMutation.error} onRetry={deleteMutation.clearError} />
          )}

          <AdminContentWrapper
            loading={loading}
            error={error}
            feature="API Keys"
            onRetry={refetch}
            loadingMessage="Loading API keys..."
            emptyIcon={Key}
            emptyTitle="No API keys"
            emptyDescription="Create an API key for programmatic access to the Atlas API."
            emptyAction={{ label: "Create API Key", onClick: openCreateDialog }}
            isEmpty={apiKeys.length === 0}
          >
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last Used</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="w-[80px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeys.map((apiKey) => {
                    const expired = isExpired(apiKey.expiresAt);
                    return (
                      <TableRow key={apiKey.id}>
                        <TableCell className="font-medium">
                          {apiKey.name ?? "Unnamed key"}
                        </TableCell>
                        <TableCell>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {maskedKey(apiKey.prefix, apiKey.start)}
                          </code>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(apiKey.createdAt)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(apiKey.lastRequest)}
                        </TableCell>
                        <TableCell>
                          {expired ? (
                            <Badge variant="destructive">Expired</Badge>
                          ) : apiKey.expiresAt ? (
                            <span className="text-muted-foreground">
                              {formatDate(apiKey.expiresAt)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Never</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-8 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => { deleteMutation.reset(); setRevokeTarget(apiKey); }}
                            title="Revoke API key"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </AdminContentWrapper>
        </div>
      </ErrorBoundary>

      {/* Create dialog — result phase (show full key) */}
      {createdKey && (
        <Dialog
          open={createOpen && !!createdKey}
          onOpenChange={(open) => { if (!open) setCreateOpen(false); }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>
                Copy your API key now. You will not be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>API Key</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={createdKey.key}
                    className="h-9 font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0"
                    onClick={() => handleCopy(createdKey.key)}
                  >
                    {copied ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                <Key className="mt-0.5 size-4 text-amber-600 dark:text-amber-400" />
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Store this key securely. It will only be displayed once.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setCreateOpen(false)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Create dialog — form phase */}
      {!createdKey && (
        <FormDialog
          open={createOpen && !createdKey}
          onOpenChange={(open) => { if (!open) setCreateOpen(false); }}
          title="Create API key"
          description="Create a new API key for programmatic access. The key will be scoped to your current organization."
          schema={createKeySchema}
          defaultValues={{ name: "" }}
          onSubmit={handleCreate}
          submitLabel="Create"
          saving={createMutation.saving}
          serverError={createMutation.error}
          className="sm:max-w-md"
        >
          {(form) => (
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Production API"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </FormDialog>
      )}

      {/* Revoke confirmation dialog — uses Dialog (not AlertDialog) so we
          control open/close manually and can show inline errors on failure. */}
      <Dialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open && !deleteMutation.saving) setRevokeTarget(null); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke API key</DialogTitle>
            <DialogDescription>
              This will permanently revoke{" "}
              <strong>{revokeTarget?.name ?? "this API key"}</strong>.
              Any applications using this key will immediately lose access. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteMutation.error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteMutation.error}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={deleteMutation.saving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={deleteMutation.saving}
            >
              {deleteMutation.saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
